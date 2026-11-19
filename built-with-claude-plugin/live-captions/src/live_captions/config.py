"""Configuration, read from the environment (populated from .env)."""

from dataclasses import dataclass
from typing import Mapping, Optional

from dotenv import dotenv_values

DEFAULT_BASE_URL = "https://api.meetstream.ai/api/v1"
LIVE_TRANSCRIPT_PATH = "/live-transcript"
WEBHOOK_PATH = "/webhook"

_TRUTHY = {"1", "true", "yes", "on"}
_FALSY = {"0", "false", "no", "off", ""}


class ConfigError(RuntimeError):
    """Raised when the environment is missing or malformed."""


@dataclass(frozen=True)
class Settings:
    api_key: Optional[str] = None
    base_url: str = DEFAULT_BASE_URL
    public_base_url: Optional[str] = None
    host: str = "127.0.0.1"
    port: int = 8080
    bot_name: str = "Live Captions"
    webhook_secret: Optional[str] = None
    retention_hours: int = 24
    color: bool = True

    def require_api_key(self) -> str:
        if not self.api_key:
            raise ConfigError(
                "MEETSTREAM_API_KEY is not set. Add it to .env "
                "(create a key at https://app.meetstream.ai/api-keys)."
            )
        return self.api_key

    def require_public_base_url(self) -> str:
        if not self.public_base_url:
            raise ConfigError(
                "PUBLIC_BASE_URL is not set. MeetStream needs a public HTTPS URL "
                "that forwards to this server, e.g. from "
                "`cloudflared tunnel --url http://127.0.0.1:%d`." % self.port
            )
        return self.public_base_url

    @property
    def live_transcript_url(self) -> str:
        """Where the bot POSTs live transcript chunks."""
        return self.require_public_base_url() + LIVE_TRANSCRIPT_PATH

    @property
    def callback_url(self) -> str:
        """Where the bot POSTs lifecycle events."""
        return self.require_public_base_url() + WEBHOOK_PATH


def _as_bool(value: Optional[str], default: bool, name: str) -> bool:
    if value is None:
        return default
    lowered = value.strip().lower()
    if lowered in _TRUTHY:
        return True
    if lowered in _FALSY:
        return False
    raise ConfigError("%s must be a boolean (1/0, true/false), got %r" % (name, value))


def _as_int(value: Optional[str], default: int, name: str, minimum: int, maximum: int) -> int:
    if value is None or value.strip() == "":
        return default
    try:
        parsed = int(value)
    except ValueError:
        raise ConfigError("%s must be an integer, got %r" % (name, value)) from None
    if not minimum <= parsed <= maximum:
        raise ConfigError("%s must be between %d and %d, got %d" % (name, minimum, maximum, parsed))
    return parsed


def _clean(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def load_settings(
    env: Optional[Mapping[str, str]] = None,
    dotenv_path: Optional[str] = None,
) -> Settings:
    """Build Settings from a mapping, or from .env plus the real environment.

    Tests pass `env` directly so they never touch the developer's machine.
    """
    if env is None:
        import os

        values = dict(dotenv_values(dotenv_path) if dotenv_path else dotenv_values())
        values.update({k: v for k, v in os.environ.items() if v is not None})
        env = values

    public_base_url = _clean(env.get("PUBLIC_BASE_URL"))
    if public_base_url:
        public_base_url = public_base_url.rstrip("/")
        if not public_base_url.startswith("https://"):
            raise ConfigError(
                "PUBLIC_BASE_URL must be an https:// URL — MeetStream does not "
                "deliver webhooks over http. Got %r" % public_base_url
            )

    base_url = _clean(env.get("MEETSTREAM_BASE_URL")) or DEFAULT_BASE_URL

    return Settings(
        api_key=_clean(env.get("MEETSTREAM_API_KEY")),
        base_url=base_url.rstrip("/"),
        public_base_url=public_base_url,
        host=_clean(env.get("CAPTIONS_HOST")) or "127.0.0.1",
        port=_as_int(env.get("CAPTIONS_PORT"), 8080, "CAPTIONS_PORT", 1, 65535),
        bot_name=_clean(env.get("BOT_NAME")) or "Live Captions",
        webhook_secret=_clean(env.get("MEETSTREAM_WEBHOOK_SECRET")),
        retention_hours=_as_int(env.get("RETENTION_HOURS"), 24, "RETENTION_HOURS", 1, 8760),
        color=_as_bool(env.get("CAPTIONS_COLOR"), True, "CAPTIONS_COLOR"),
    )
