"""MeetStream API client for create_bot, with retry and rate-limit handling."""

from __future__ import annotations

import logging
import random
import threading
import time
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Dict, Optional

import requests

logger = logging.getLogger(__name__)

# Status codes worth retrying: transient capacity, rate limiting and upstream faults.
RETRYABLE_STATUS = frozenset({408, 429, 500, 502, 503, 504, 507})

# Short, human-readable reason per status code; anything else falls back to the
# API's own message.
STATUS_REASONS = {
    400: "rejected by the API (bad request)",
    401: "authentication failed - check MEETSTREAM_API_KEY",
    403: "forbidden - the API key may not have access to this meeting or platform",
    404: "not found - check the meeting link and any signed-in login settings",
    409: "conflict - a bot may already be assigned to this meeting or login",
    422: "rejected by the API (unprocessable request)",
    429: "rate limited - retries exhausted",
    507: "MeetStream capacity unavailable - retries exhausted",
}

# Failure kind per status code, used to group the final summary.
STATUS_KINDS = {
    401: "auth",
    403: "auth",
    429: "rate_limited",
    507: "capacity",
}


class MeetStreamError(Exception):
    """A create_bot attempt that did not produce a bot."""

    def __init__(
        self,
        reason: str,
        kind: str = "api_error",
        status_code: Optional[int] = None,
        attempts: int = 1,
    ) -> None:
        super().__init__(reason)
        self.reason = reason
        self.kind = kind
        self.status_code = status_code
        self.attempts = attempts


@dataclass(frozen=True)
class CreatedBot:
    """A successful create_bot response."""

    bot_id: str
    status: Optional[str]
    attempts: int


class RateLimitGate:
    """A shared "hold off until" barrier.

    When one worker is told to back off by the API, every other worker waits too.
    Without this, N threads keep hammering a rate-limited endpoint and burn the
    retry budget on guaranteed 429s.
    """

    def __init__(self, clock: Callable[[], float], sleeper: Callable[[float], None]) -> None:
        self._clock = clock
        self._sleeper = sleeper
        self._lock = threading.Lock()
        self._until = 0.0

    def hold(self, seconds: float) -> None:
        deadline = self._clock() + seconds
        with self._lock:
            self._until = max(self._until, deadline)

    def remaining(self) -> float:
        with self._lock:
            return max(self._until - self._clock(), 0.0)

    def wait(self) -> None:
        while True:
            remaining = self.remaining()
            if remaining <= 0:
                return
            self._sleeper(remaining)


class MeetStreamClient:
    """Creates bots one meeting at a time, retrying what is worth retrying."""

    def __init__(
        self,
        api_key: str,
        base_url: str,
        session: Optional[requests.Session] = None,
        timeout: float = 30.0,
        max_retries: int = 4,
        backoff_base: float = 1.0,
        max_backoff: float = 60.0,
        sleeper: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        jitter: Callable[[], float] = random.random,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.session = session or requests.Session()
        self.timeout = timeout
        self.max_retries = max_retries
        self.backoff_base = backoff_base
        self.max_backoff = max_backoff
        self._sleeper = sleeper
        self._jitter = jitter
        self.gate = RateLimitGate(clock, sleeper)

    def create_bot(self, payload: Dict[str, Any]) -> CreatedBot:
        """POST /bots/create_bot, retrying transient failures.

        Raises ``MeetStreamError`` when the bot could not be created.
        """
        url = "{0}/bots/create_bot".format(self.base_url)
        headers = {
            "Authorization": "Token {0}".format(self.api_key),
            "Content-Type": "application/json",
        }
        last_error: Optional[MeetStreamError] = None

        for attempt in range(1, self.max_retries + 2):
            self.gate.wait()
            try:
                response = self.session.post(
                    url, json=payload, headers=headers, timeout=self.timeout
                )
            except requests.RequestException as exc:
                last_error = MeetStreamError(
                    "network error: {0}".format(exc),
                    kind="network",
                    attempts=attempt,
                )
                if attempt > self.max_retries:
                    break
                self._sleeper(self._backoff(attempt))
                continue

            if response.status_code in (200, 201):
                return self._parse_created(response, attempt)

            last_error = self._error_for(response, attempt)
            if response.status_code not in RETRYABLE_STATUS or attempt > self.max_retries:
                break

            delay = self._retry_delay(response, attempt)
            if response.status_code == 429:
                # Everybody waits, not just this worker.
                self.gate.hold(delay)
                logger.warning(
                    "rate limited on %s; holding all workers for %.1fs (attempt %d)",
                    payload.get("meeting_link"),
                    delay,
                    attempt,
                )
            else:
                logger.warning(
                    "retryable %d on %s in %.1fs (attempt %d)",
                    response.status_code,
                    payload.get("meeting_link"),
                    delay,
                    attempt,
                )
            self._sleeper(delay)

        assert last_error is not None  # loop always runs at least once
        raise last_error

    def _parse_created(self, response: requests.Response, attempt: int) -> CreatedBot:
        try:
            body = response.json()
        except ValueError:
            raise MeetStreamError(
                "API returned {0} with a non-JSON body".format(response.status_code),
                kind="unexpected_response",
                status_code=response.status_code,
                attempts=attempt,
            )
        bot_id = body.get("bot_id") if isinstance(body, dict) else None
        if not bot_id:
            raise MeetStreamError(
                "API returned {0} without a bot_id".format(response.status_code),
                kind="unexpected_response",
                status_code=response.status_code,
                attempts=attempt,
            )
        return CreatedBot(
            bot_id=bot_id,
            status=body.get("status"),
            attempts=attempt,
        )

    def _error_for(self, response: requests.Response, attempt: int) -> MeetStreamError:
        status = response.status_code
        detail = self._message_of(response)
        reason = STATUS_REASONS.get(status, "API returned HTTP {0}".format(status))
        if detail:
            reason = "{0}: {1}".format(reason, detail)
        kind = STATUS_KINDS.get(status)
        if kind is None:
            kind = "server_error" if status >= 500 else "api_error"
        return MeetStreamError(reason, kind=kind, status_code=status, attempts=attempt)

    @staticmethod
    def _message_of(response: requests.Response) -> str:
        """Pull the API's own error text out of the response, if there is one."""
        try:
            body = response.json()
        except ValueError:
            return (response.text or "").strip()[:300]
        if isinstance(body, dict):
            for key in ("message", "detail", "error"):
                value = body.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()[:300]
        return str(body)[:300]

    def _retry_delay(self, response: requests.Response, attempt: int) -> float:
        """Honour Retry-After when the API sends one, else exponential backoff."""
        retry_after = _parse_retry_after(response.headers.get("Retry-After"))
        if retry_after is not None:
            return min(max(retry_after, 0.0), self.max_backoff)
        return self._backoff(attempt)

    def _backoff(self, attempt: int) -> float:
        delay = self.backoff_base * (2 ** (attempt - 1))
        return min(delay, self.max_backoff) * (0.5 + self._jitter() / 2)


def _parse_retry_after(value: Optional[str]) -> Optional[float]:
    """Parse a Retry-After header in either seconds or HTTP-date form."""
    if not value:
        return None
    value = value.strip()
    try:
        return float(value)
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    return max(when.timestamp() - time.time(), 0.0)
