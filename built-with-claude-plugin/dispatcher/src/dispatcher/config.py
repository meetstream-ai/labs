"""Configuration, loaded from a .env file (see .env.example)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Dict, Mapping, Optional

from dotenv import dotenv_values

DEFAULT_BASE_URL = "https://api.meetstream.ai/api/v1"
DEFAULT_BOT_NAME = "MeetStream Notetaker"

# Post-call transcript providers this tool knows how to configure. Each entry is
# the provider block sent under recording_config.transcript.provider; every field
# the API marks required is filled in here.
TRANSCRIPT_PROVIDERS = {
    "none": lambda language: None,
    "meetstream": lambda language: {"meetstream": {"language": language, "translate": False}},
    "deepgram": lambda language: {"deepgram": {"model": "nova-3", "language": language}},
}

# Recommended timeouts (seconds). Keep the bot patient enough for real meetings.
AUTOMATIC_LEAVE = {
    "waiting_room_timeout": 600,
    "everyone_left_timeout": 600,
    "voice_inactivity_timeout": 600,
    "in_call_recording_timeout": 14400,
    "recording_permission_denied_timeout": 300,
}


class ConfigError(Exception):
    """Raised when the environment cannot produce a usable config."""


@dataclass(frozen=True)
class Config:
    """Everything the dispatcher needs that does not come from the CLI."""

    api_key: str
    base_url: str = DEFAULT_BASE_URL
    bot_name: str = DEFAULT_BOT_NAME
    callback_url: Optional[str] = None
    transcript_provider: str = "none"
    transcript_language: str = "en"
    request_timeout: float = 30.0
    max_retries: int = 4
    backoff_base: float = 1.0
    max_backoff: float = 60.0
    concurrency: int = 4
    retention_hours: Optional[int] = None
    custom_attributes: Dict[str, str] = field(default_factory=dict)

    def bot_payload(self, meeting_link: str, bot_name: str) -> Dict[str, Any]:
        """Build the create_bot request body for one meeting."""
        payload: Dict[str, Any] = {
            "meeting_link": meeting_link,
            "bot_name": bot_name,
            # Audio only unless somebody asks for video: cheaper to process and
            # store, and transcripts/summaries do not need it.
            "video_required": False,
            "automatic_leave": dict(AUTOMATIC_LEAVE),
        }
        if self.callback_url:
            payload["callback_url"] = self.callback_url

        recording_config: Dict[str, Any] = {}
        provider = TRANSCRIPT_PROVIDERS[self.transcript_provider](self.transcript_language)
        if provider is not None:
            recording_config["transcript"] = {"provider": provider}
        if self.retention_hours is not None:
            recording_config["retention"] = {"type": "timed", "hours": self.retention_hours}
        if recording_config:
            payload["recording_config"] = recording_config

        if self.custom_attributes:
            payload["custom_attributes"] = dict(self.custom_attributes)
        return payload


def _as_int(values: Mapping[str, Optional[str]], key: str, default: Optional[int]) -> Optional[int]:
    raw = values.get(key)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        raise ConfigError("{0} must be an integer, got {1!r}".format(key, raw))


def _as_float(values: Mapping[str, Optional[str]], key: str, default: float) -> float:
    raw = values.get(key)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        raise ConfigError("{0} must be a number, got {1!r}".format(key, raw))


def load_config(
    env_file: Optional[str] = ".env",
    environ: Optional[Mapping[str, str]] = None,
    require_api_key: bool = True,
) -> Config:
    """Read config from ``env_file``, with real environment variables winning."""
    values: Dict[str, Optional[str]] = {}
    if env_file and os.path.exists(env_file):
        values.update(dotenv_values(env_file))
    environ = os.environ if environ is None else environ
    for key, value in environ.items():
        if key.startswith("MEETSTREAM_"):
            values[key] = value

    api_key = (values.get("MEETSTREAM_API_KEY") or "").strip()
    if require_api_key and not api_key:
        raise ConfigError(
            "MEETSTREAM_API_KEY is not set. Copy .env.example to .env and fill it in, "
            "or run with --dry-run to validate links without calling the API."
        )

    provider = (values.get("MEETSTREAM_TRANSCRIPT_PROVIDER") or "none").strip().lower()
    if provider not in TRANSCRIPT_PROVIDERS:
        raise ConfigError(
            "MEETSTREAM_TRANSCRIPT_PROVIDER must be one of {0}, got {1!r}".format(
                ", ".join(sorted(TRANSCRIPT_PROVIDERS)), provider
            )
        )

    callback_url = (values.get("MEETSTREAM_CALLBACK_URL") or "").strip() or None
    if callback_url and not callback_url.startswith("https://"):
        raise ConfigError("MEETSTREAM_CALLBACK_URL must be an https:// URL")

    concurrency = _as_int(values, "MEETSTREAM_CONCURRENCY", 4)
    if concurrency < 1:
        raise ConfigError("MEETSTREAM_CONCURRENCY must be at least 1")

    max_retries = _as_int(values, "MEETSTREAM_MAX_RETRIES", 4)
    if max_retries < 0:
        raise ConfigError("MEETSTREAM_MAX_RETRIES must be zero or more")

    return Config(
        api_key=api_key,
        base_url=(values.get("MEETSTREAM_BASE_URL") or DEFAULT_BASE_URL).rstrip("/"),
        bot_name=(values.get("MEETSTREAM_BOT_NAME") or DEFAULT_BOT_NAME).strip(),
        callback_url=callback_url,
        transcript_provider=provider,
        transcript_language=(values.get("MEETSTREAM_TRANSCRIPT_LANGUAGE") or "en").strip(),
        request_timeout=_as_float(values, "MEETSTREAM_REQUEST_TIMEOUT", 30.0),
        max_retries=max_retries,
        backoff_base=_as_float(values, "MEETSTREAM_BACKOFF_BASE", 1.0),
        max_backoff=_as_float(values, "MEETSTREAM_MAX_BACKOFF", 60.0),
        concurrency=concurrency,
        retention_hours=_as_int(values, "MEETSTREAM_RETENTION_HOURS", None),
    )
