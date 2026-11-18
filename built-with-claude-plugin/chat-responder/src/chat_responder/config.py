"""Configuration, read from the environment (populated from .env)."""

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Optional

from dotenv import load_dotenv

DEFAULT_BASE_URL = "https://api.meetstream.ai/api/v1"

_DEFAULTS = {
    "MEETSTREAM_BASE_URL": DEFAULT_BASE_URL,
    "MEETSTREAM_BOT_ID": "",
    "BOT_NAME": "Meeting Assistant",
    "AGENDA_PATH": "agenda.md",
    "POLL_INTERVAL_SECONDS": "5",
    "SENDER_COOLDOWN_SECONDS": "5",
    "MAX_REPLIES_PER_MINUTE": "12",
    "MAX_MESSAGE_CHARS": "2000",
    "MAX_AGENDA_BYTES": "8192",
    "REQUEST_TIMEOUT_SECONDS": "10",
    "LOG_LEVEL": "INFO",
}

# name -> (minimum, maximum). Bounds keep a typo in .env from either hammering
# the API or making the bot look dead.
_NUMERIC_BOUNDS = {
    "POLL_INTERVAL_SECONDS": (1.0, 300.0),
    "SENDER_COOLDOWN_SECONDS": (0.0, 3600.0),
    "MAX_REPLIES_PER_MINUTE": (1, 600),
    "MAX_MESSAGE_CHARS": (16, 10000),
    "MAX_AGENDA_BYTES": (64, 262144),
    "REQUEST_TIMEOUT_SECONDS": (1.0, 120.0),
}


class ConfigError(Exception):
    """Raised when the environment cannot produce a usable Config."""


@dataclass(frozen=True)
class Config:
    api_key: str
    base_url: str
    bot_id: str
    bot_name: str
    agenda_path: Path
    poll_interval_seconds: float
    sender_cooldown_seconds: float
    max_replies_per_minute: int
    max_message_chars: int
    max_agenda_bytes: int
    request_timeout_seconds: float
    log_level: str

    def require_bot_id(self) -> str:
        if not self.bot_id:
            raise ConfigError(
                "No bot id. Set MEETSTREAM_BOT_ID in .env or pass --bot-id. "
                "`chat-responder join <meeting-link>` prints one."
            )
        return self.bot_id


def _number(env: Mapping[str, str], name: str, cast):
    raw = env.get(name) or _DEFAULTS[name]
    try:
        value = cast(raw)
    except (TypeError, ValueError):
        raise ConfigError("{} must be a number, got {!r}".format(name, raw))
    low, high = _NUMERIC_BOUNDS[name]
    if not low <= value <= high:
        raise ConfigError(
            "{} must be between {} and {}, got {}".format(name, low, high, value)
        )
    return value


def load_config(
    env: Optional[Mapping[str, str]] = None,
    dotenv_path: Optional[Path] = None,
) -> Config:
    """Build a Config. Reads .env into os.environ unless `env` is supplied."""
    if env is None:
        load_dotenv(dotenv_path=dotenv_path, override=False)
        env = os.environ

    api_key = (env.get("MEETSTREAM_API_KEY") or "").strip()
    if not api_key:
        raise ConfigError(
            "MEETSTREAM_API_KEY is not set. Copy .env.example to .env and fill it in."
        )

    agenda_path = Path((env.get("AGENDA_PATH") or _DEFAULTS["AGENDA_PATH"]).strip())

    return Config(
        api_key=api_key,
        base_url=(env.get("MEETSTREAM_BASE_URL") or _DEFAULTS["MEETSTREAM_BASE_URL"]).rstrip("/"),
        bot_id=(env.get("MEETSTREAM_BOT_ID") or "").strip(),
        bot_name=(env.get("BOT_NAME") or _DEFAULTS["BOT_NAME"]).strip(),
        agenda_path=agenda_path,
        poll_interval_seconds=_number(env, "POLL_INTERVAL_SECONDS", float),
        sender_cooldown_seconds=_number(env, "SENDER_COOLDOWN_SECONDS", float),
        max_replies_per_minute=_number(env, "MAX_REPLIES_PER_MINUTE", int),
        max_message_chars=_number(env, "MAX_MESSAGE_CHARS", int),
        max_agenda_bytes=_number(env, "MAX_AGENDA_BYTES", int),
        request_timeout_seconds=_number(env, "REQUEST_TIMEOUT_SECONDS", float),
        log_level=(env.get("LOG_LEVEL") or _DEFAULTS["LOG_LEVEL"]).strip().upper(),
    )
