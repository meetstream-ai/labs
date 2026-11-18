"""Thin MeetStream REST client - only the endpoints this service needs."""

import hashlib
import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import requests

logger = logging.getLogger(__name__)

# get_chats is documented as "in-meeting chat" without a pinned response shape,
# so read it defensively: hunt for the chat entries wherever they sit in the
# payload rather than assuming one wrapper key, and accept the common key
# spellings for each field.
_MAX_NESTING = 4
# How far down to hunt for the entries. Deeper than any wrapper we have seen,
# and cheap: get_chats payloads are small and the search stops at the first
# level that holds chat lines.
_MAX_SEARCH_DEPTH = 6
_ID_KEYS = ("id", "message_id", "messageId", "chat_id", "chatId", "uuid")
_SENDER_KEYS = (
    "sender",
    "sender_name",
    "senderName",
    "speaker",
    "speakerName",
    "participant",
    "participant_name",
    "displayName",
    "display_name",
    "fullName",
    "full_name",
    "author",
    "name",
    "from",
    "user",
    "username",
    "user_name",
)
_TEXT_KEYS = (
    "message",
    "text",
    "content",
    "chat_message",
    "chatMessage",
    "message_text",
    "messageText",
    "chat_text",
    "chatText",
    "body",
    "msg",
    # Last resort: some payloads nest the line under a "chat" object, so this
    # is tried only once the direct spellings above have all missed.
    "chat",
)
_TIME_KEYS = ("timestamp", "time", "created_at", "createdAt", "sent_at", "sentAt")

# Shapes we have already complained about, so a wrong guess costs one warning
# per process rather than one per poll.
_warned_shapes = set()


class MeetStreamError(RuntimeError):
    """A MeetStream API call failed."""


@dataclass(frozen=True)
class ChatMessage:
    key: str
    sender: str
    text: str
    timestamp: Optional[str]


def _first_str(entry: Dict[str, Any], keys, depth: int = 0) -> Optional[str]:
    for key in keys:
        value = entry.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            return str(value)
        # A field can be an object ({"message": {"text": "..."}}); look for the
        # same kind of field inside it, not for a sender.
        if isinstance(value, dict) and depth < _MAX_NESTING:
            nested = _first_str(value, keys, depth + 1)
            if nested:
                return nested
    return None


def _looks_like_entry(value: Any) -> bool:
    """A chat line carries text plus at least one of sender / id / timestamp."""
    if not isinstance(value, dict):
        return False
    if _first_str(value, _TEXT_KEYS) is None:
        return False
    return any(
        _first_str(value, keys) is not None
        for keys in (_SENDER_KEYS, _ID_KEYS, _TIME_KEYS)
    )


def _find_entries(payload: Any) -> Optional[List[Any]]:
    """Locate the chat entries however the payload wraps them.

    Returns None when nothing in the payload looks like chat - which is a
    different problem from a meeting where nobody has typed yet.
    """
    level = [payload]
    saw_empty_container = False
    for _ in range(_MAX_SEARCH_DEPTH):
        deeper: List[Any] = []
        for node in level:
            if isinstance(node, list):
                if any(_looks_like_entry(item) for item in node):
                    return node
                if not node:
                    saw_empty_container = True
                deeper.extend(i for i in node if isinstance(i, (list, dict)))
            elif isinstance(node, dict):
                if _looks_like_entry(node):
                    return [node]
                values = list(node.values())
                # A map keyed by message id is a list of entries in disguise.
                if values and all(_looks_like_entry(v) for v in values):
                    return values
                if not values:
                    saw_empty_container = True
                deeper.extend(v for v in values if isinstance(v, (list, dict)))
        level = deeper
    return [] if saw_empty_container else None


def _shape_of(value: Any) -> str:
    """Describe a payload by its key names only - never its values."""
    if isinstance(value, dict):
        return "dict keys: " + (", ".join(sorted(value)[:12]) or "<none>")
    if isinstance(value, list):
        return "list of {}".format(type(value[0]).__name__ if value else "nothing")
    return type(value).__name__


def _warn_once(reason: str, value: Any) -> None:
    shape = _shape_of(value)
    if shape in _warned_shapes:
        return
    _warned_shapes.add(shape)
    logger.warning("%s - %s (raw payload logs at DEBUG)", reason, shape)


def _message_key(entry: Dict[str, Any], sender: str, text: str) -> str:
    explicit = _first_str(entry, _ID_KEYS)
    if explicit:
        return explicit
    stamp = _first_str(entry, _TIME_KEYS) or ""
    digest = hashlib.sha256(
        "|".join((sender, stamp, text)).encode("utf-8", "replace")
    ).hexdigest()
    return "sha256:" + digest[:32]


def normalize_chats(payload: Any) -> List[ChatMessage]:
    """Turn whatever get_chats returned into a list of ChatMessage."""
    entries = _find_entries(payload)
    if entries is None:
        # Reading the chat is the whole job, so a payload we cannot read is
        # worth a warning: the key names point straight at the right fix.
        _warn_once("no chat entries found in get_chats payload", payload)
        return []

    messages = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        text = _first_str(entry, _TEXT_KEYS)
        if not text:
            continue
        sender = _first_str(entry, _SENDER_KEYS) or "unknown"
        messages.append(
            ChatMessage(
                key=_message_key(entry, sender, text),
                sender=sender,
                text=text,
                timestamp=_first_str(entry, _TIME_KEYS),
            )
        )

    if entries and not messages:
        _warn_once("get_chats entries carried no readable text", entries[0])
    return messages


class MeetStreamClient:
    def __init__(
        self,
        api_key: str,
        base_url: str,
        session: Optional[Any] = None,
        timeout: float = 10.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._session = session if session is not None else requests.Session()
        self._headers = {
            "Authorization": "Token {}".format(api_key),
            "Content-Type": "application/json",
        }

    def _request(self, method: str, path: str, json_body: Optional[dict] = None) -> Any:
        url = "{}{}".format(self._base_url, path)
        try:
            response = self._session.request(
                method,
                url,
                headers=self._headers,
                json=json_body,
                timeout=self._timeout,
            )
        except Exception as exc:  # network layer: requests.RequestException and friends
            raise MeetStreamError("{} {} failed: {}".format(method, path, exc))

        status = getattr(response, "status_code", 0)
        if status >= 400:
            body = (getattr(response, "text", "") or "")[:200]
            raise MeetStreamError(
                "{} {} returned HTTP {}: {}".format(method, path, status, body)
            )
        try:
            return response.json()
        except ValueError:
            return None

    def get_chats(self, bot_id: str) -> List[ChatMessage]:
        payload = self._request("GET", "/bots/{}/get_chats".format(bot_id))
        logger.debug("get_chats payload: %r", payload)
        return normalize_chats(payload)

    def send_message(self, bot_id: str, message: str) -> Any:
        return self._request(
            "POST",
            "/bots/{}/send_message".format(bot_id),
            {"message": message, "metadata": {"message_type": "text"}},
        )

    def get_bot_detail(self, bot_id: str) -> Dict[str, Any]:
        payload = self._request("GET", "/bots/{}/detail".format(bot_id))
        return payload if isinstance(payload, dict) else {}

    def create_bot(self, meeting_link: str, bot_name: str, bot_message: Optional[str] = None) -> Any:
        body: Dict[str, Any] = {
            "meeting_link": meeting_link,
            "bot_name": bot_name,
            # Chat commands need no recording artefacts: skip video entirely and
            # keep the audio MeetStream captures anyway for one day only.
            "video_required": False,
            "recording_config": {"retention": {"type": "timed", "hours": 24}},
            "automatic_leave": {
                "waiting_room_timeout": 600,
                "everyone_left_timeout": 600,
                "voice_inactivity_timeout": 600,
                "in_call_recording_timeout": 14400,
                "recording_permission_denied_timeout": 300,
            },
        }
        if bot_message:
            body["bot_message"] = bot_message
        return self._request("POST", "/bots/create_bot", body)
