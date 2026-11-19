"""Poll the meeting chat, answer commands, stay quiet otherwise."""

import logging
import re
import time
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional

from .client import ChatMessage, MeetStreamClient, MeetStreamError
from .commands import CommandContext, find_command
from .config import Config
from .ratelimit import RateLimiter
from .sanitize import clean_inbound, clean_outbound

logger = logging.getLogger(__name__)

_MAX_SEEN = 2000
_START_TIME_KEYS = ("StartTime", "start_time", "PlatformCreatedAt", "CreatedAt", "created_at")
_LONG_FRACTION = re.compile(r"(\.\d{6})\d+")


def parse_timestamp(value: Any) -> Optional[float]:
    """Parse an ISO-8601 string into a UTC epoch, or None if unusable."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    text = _LONG_FRACTION.sub(r"\1", text)
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


class ChatResponder:
    def __init__(
        self,
        config: Config,
        client: MeetStreamClient,
        bot_id: Optional[str] = None,
        clock: Callable[[], float] = time.time,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        self._config = config
        self._client = client
        self._bot_id = bot_id or config.require_bot_id()
        self._clock = clock
        self._sleep = sleeper
        self._seen: "OrderedDict[str, None]" = OrderedDict()
        self._meeting_started_at: Optional[float] = None
        self._limiter = RateLimiter(
            config.sender_cooldown_seconds, config.max_replies_per_minute
        )

    @property
    def meeting_started_at(self) -> Optional[float]:
        return self._meeting_started_at

    def prime(self) -> None:
        """Swallow the chat backlog so a restart doesn't re-answer old commands."""
        self._refresh_meeting_start()
        try:
            for message in self._client.get_chats(self._bot_id):
                self._mark_seen(message.key)
        except MeetStreamError as exc:
            logger.warning("could not read chat backlog for %s: %s", self._bot_id, exc)

    def poll_once(self) -> int:
        """One poll. Returns how many replies were sent."""
        try:
            messages = self._client.get_chats(self._bot_id)
        except MeetStreamError as exc:
            logger.warning("chat poll failed for %s: %s", self._bot_id, exc)
            return 0

        replies = 0
        for message in messages:
            if self._mark_seen(message.key):
                continue
            if self._reply_to(message):
                replies += 1
        return replies

    def run_forever(self) -> None:
        logger.info(
            "watching chat for bot %s every %.1fs",
            self._bot_id,
            self._config.poll_interval_seconds,
        )
        self.prime()
        while True:
            try:
                self.poll_once()
            except Exception:  # one bad poll must not kill the service
                logger.exception("unexpected error during poll")
            self._sleep(self._config.poll_interval_seconds)

    def _reply_to(self, message: ChatMessage) -> bool:
        if self._is_self(message.sender):
            return False

        text = clean_inbound(message.text, self._config.max_message_chars)
        command = find_command(text)
        if command is None:
            logger.debug("no command in message from %s: %r", message.sender, text)
            return False

        now = self._clock()
        if not self._limiter.allow(message.sender, now):
            logger.info("throttled %s from a participant", command.keyword)
            return False

        if command.keyword == "!time" and self._meeting_started_at is None:
            self._refresh_meeting_start()

        context = CommandContext(
            config=self._config, now=now, meeting_started_at=self._meeting_started_at
        )
        reply = clean_outbound(command.handler(context), self._config.max_message_chars)
        if not reply:
            return False

        try:
            self._client.send_message(self._bot_id, reply)
        except MeetStreamError as exc:
            logger.error(
                "could not post %s reply for bot %s: %s", command.keyword, self._bot_id, exc
            )
            return False

        logger.info("answered %s", command.keyword)
        return True

    def _refresh_meeting_start(self) -> None:
        try:
            detail = self._client.get_bot_detail(self._bot_id)
        except MeetStreamError as exc:
            logger.warning("could not read detail for %s: %s", self._bot_id, exc)
            return

        details: Dict[str, Any] = detail.get("bot_details") or detail
        if not isinstance(details, dict):
            return
        for key in _START_TIME_KEYS:
            started = parse_timestamp(details.get(key))
            if started is not None:
                self._meeting_started_at = started
                return

    def _is_self(self, sender: str) -> bool:
        candidate = sender.strip().casefold()
        return candidate in (
            self._config.bot_name.strip().casefold(),
            self._bot_id.strip().casefold(),
        )

    def _mark_seen(self, key: str) -> bool:
        """Record a message key. Returns True if it was already seen."""
        if key in self._seen:
            return True
        self._seen[key] = None
        while len(self._seen) > _MAX_SEEN:
            self._seen.popitem(last=False)
        return False
