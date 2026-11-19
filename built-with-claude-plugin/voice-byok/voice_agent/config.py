"""Settings for the MeetStream voice agent, loaded from the environment."""

from dataclasses import dataclass, field
from typing import List, Mapping, Optional

DEFAULT_BASE_URL = "https://api.meetstream.ai/api/v1"

DEFAULT_SYSTEM_PROMPT = (
    "You are a friendly meeting assistant on a live call. Answer questions out "
    "loud, briefly and warmly - two or three sentences unless asked for more. "
    "If you do not know something that was said in this meeting, say so instead "
    "of guessing."
)

DEFAULT_WAKE_WORDS = ("hey assistant", "ok assistant", "assistant")

DEFAULT_FIRST_MESSAGE = (
    "Hi everyone, I'm an AI meeting assistant. Say \"hey assistant\" and I'll "
    "answer out loud."
)

# Required before the agent can run: the MeetStream key authenticates every
# call here, and the three provider keys are the ones MeetStream uses for the
# STT / LLM / TTS layers of the pipeline.
REQUIRED_VARS = (
    "MEETSTREAM_API_KEY",
    "OPENAI_API_KEY",
    "DEEPGRAM_API_KEY",
    "ELEVENLABS_API_KEY",
)


class ConfigError(ValueError):
    """Raised when the environment is missing or malformed."""


@dataclass(frozen=True)
class Settings:
    meetstream_api_key: str
    openai_api_key: str
    deepgram_api_key: str
    elevenlabs_api_key: str
    base_url: str = DEFAULT_BASE_URL
    meeting_link: Optional[str] = None
    bot_name: str = "Meeting Assistant"
    agent_name: str = "Meeting Assistant"
    openai_model: str = "gpt-4.1"
    llm_temperature: float = 0.7
    deepgram_model: str = "nova-3"
    language: str = "en"
    boostwords: List[str] = field(default_factory=list)
    elevenlabs_voice_id: str = ""
    elevenlabs_voice_speed: float = 1.0
    system_prompt: str = DEFAULT_SYSTEM_PROMPT
    first_message: str = DEFAULT_FIRST_MESSAGE
    enable_interruptions: bool = True
    user_away_timeout: int = 30
    wake_word_enabled: bool = True
    wake_words: List[str] = field(default_factory=lambda: list(DEFAULT_WAKE_WORDS))
    wake_word_timeout: int = 30

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "Settings":
        missing = [name for name in REQUIRED_VARS if not (env.get(name) or "").strip()]
        if missing:
            raise ConfigError(
                "Missing required environment variables: "
                + ", ".join(missing)
                + ". Copy .env.example to .env and fill them in."
            )

        voice_id = (env.get("ELEVENLABS_VOICE_ID") or "").strip()
        if not voice_id:
            raise ConfigError(
                "ELEVENLABS_VOICE_ID is required - pick a voice at "
                "https://elevenlabs.io/app/voice-library"
            )

        wake_word_enabled = _as_bool(env.get("WAKE_WORD_ENABLED"), True)
        raw_wake_words = env.get("WAKE_WORDS")
        wake_words = _split_list(raw_wake_words)
        if wake_word_enabled and not wake_words:
            # Unset falls back to the default phrase; set-but-empty is a
            # misconfiguration - a wake-word agent with no phrase never speaks.
            if raw_wake_words is None:
                wake_words = list(DEFAULT_WAKE_WORDS)
            else:
                raise ConfigError("WAKE_WORD_ENABLED is true but WAKE_WORDS is empty.")

        return cls(
            meetstream_api_key=env["MEETSTREAM_API_KEY"].strip(),
            openai_api_key=env["OPENAI_API_KEY"].strip(),
            deepgram_api_key=env["DEEPGRAM_API_KEY"].strip(),
            elevenlabs_api_key=env["ELEVENLABS_API_KEY"].strip(),
            base_url=(env.get("MEETSTREAM_BASE_URL") or DEFAULT_BASE_URL).rstrip("/"),
            meeting_link=_optional(env.get("MEETING_LINK")),
            bot_name=(env.get("BOT_NAME") or "Meeting Assistant").strip(),
            agent_name=(env.get("AGENT_NAME") or "Meeting Assistant").strip(),
            openai_model=(env.get("OPENAI_MODEL") or "gpt-4.1").strip(),
            llm_temperature=_as_float(env.get("LLM_TEMPERATURE"), 0.7, "LLM_TEMPERATURE"),
            deepgram_model=(env.get("DEEPGRAM_MODEL") or "nova-3").strip(),
            language=(env.get("TRANSCRIBE_LANGUAGE") or "en").strip(),
            boostwords=_split_list(env.get("TRANSCRIBE_BOOSTWORDS")),
            elevenlabs_voice_id=voice_id,
            elevenlabs_voice_speed=_as_float(
                env.get("ELEVENLABS_VOICE_SPEED"), 1.0, "ELEVENLABS_VOICE_SPEED"
            ),
            system_prompt=(env.get("AGENT_SYSTEM_PROMPT") or DEFAULT_SYSTEM_PROMPT).strip(),
            first_message=(env.get("AGENT_FIRST_MESSAGE") or DEFAULT_FIRST_MESSAGE).strip(),
            enable_interruptions=_as_bool(env.get("ENABLE_INTERRUPTIONS"), True),
            user_away_timeout=_as_int(env.get("USER_AWAY_TIMEOUT"), 30, "USER_AWAY_TIMEOUT"),
            wake_word_enabled=wake_word_enabled,
            wake_words=wake_words,
            wake_word_timeout=_as_int(
                env.get("WAKE_WORD_TIMEOUT"), 30, "WAKE_WORD_TIMEOUT"
            ),
        )


def _optional(value: Optional[str]) -> Optional[str]:
    value = (value or "").strip()
    return value or None


def _split_list(value: Optional[str]) -> List[str]:
    return [item.strip() for item in (value or "").split(",") if item.strip()]


def _as_bool(value: Optional[str], default: bool) -> bool:
    if value is None or not value.strip():
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def _as_float(value: Optional[str], default: float, name: str) -> float:
    if value is None or not value.strip():
        return default
    try:
        return float(value)
    except ValueError:
        raise ConfigError("{} must be a number, got {!r}".format(name, value))


def _as_int(value: Optional[str], default: int, name: str) -> int:
    if value is None or not value.strip():
        return default
    try:
        return int(value)
    except ValueError:
        raise ConfigError("{} must be an integer, got {!r}".format(name, value))
