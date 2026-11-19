"""Settings loaded from the environment / a .env file."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

DEFAULT_BASE_URL = "https://api.meetstream.ai/api/v1"

_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}


class ConfigError(RuntimeError):
    """Raised when the environment is missing or has an unusable value."""


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    value = raw.strip().lower()
    if value in _TRUE:
        return True
    if value in _FALSE:
        return False
    raise ConfigError(f"{name} must be a boolean (true/false), got {raw!r}")


def _positive_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw.strip())
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from exc
    if value <= 0:
        raise ConfigError(f"{name} must be greater than zero, got {value}")
    return value


@dataclass(frozen=True)
class Settings:
    api_key: str
    base_url: str
    archive_dir: Path
    include_video: bool
    include_participant_audio: bool
    poll_interval_seconds: int
    request_timeout_seconds: int
    max_list_pages: int


def load_settings(env_file: Path | str | None = None) -> Settings:
    """Read settings from a .env file (if present) plus the process environment.

    Real environment variables win over .env values, so an operator can override
    a single setting for one run without editing the file.
    """
    if env_file is None:
        load_dotenv(override=False)
    else:
        load_dotenv(env_file, override=False)

    api_key = (os.environ.get("MEETSTREAM_API_KEY") or "").strip()
    if not api_key:
        raise ConfigError(
            "MEETSTREAM_API_KEY is not set. Copy .env.example to .env and add your "
            "key from https://app.meetstream.ai/api-keys"
        )

    base_url = (os.environ.get("MEETSTREAM_BASE_URL") or DEFAULT_BASE_URL).strip()
    base_url = base_url.rstrip("/")
    if not base_url.startswith(("http://", "https://")):
        raise ConfigError(f"MEETSTREAM_BASE_URL must be an http(s) URL, got {base_url!r}")

    archive_dir = Path(
        (os.environ.get("ARCHIVE_DIR") or "./archive").strip() or "./archive"
    ).expanduser()

    return Settings(
        api_key=api_key,
        base_url=base_url,
        archive_dir=archive_dir,
        include_video=_bool("ARCHIVE_INCLUDE_VIDEO", True),
        include_participant_audio=_bool("ARCHIVE_INCLUDE_PARTICIPANT_AUDIO", True),
        poll_interval_seconds=_positive_int("ARCHIVE_POLL_INTERVAL_SECONDS", 300),
        request_timeout_seconds=_positive_int("ARCHIVE_REQUEST_TIMEOUT_SECONDS", 60),
        max_list_pages=_positive_int("ARCHIVE_MAX_LIST_PAGES", 20),
    )
