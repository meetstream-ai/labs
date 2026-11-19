"""Request bodies for the MIA agent config and the bot that carries it."""

from typing import Any, Dict

from .config import Settings

# Recommended defaults: long enough that the bot does not drop out of a real
# meeting that starts late, runs long, or goes quiet during a demo.
AUTOMATIC_LEAVE = {
    "waiting_room_timeout": 600,
    "everyone_left_timeout": 600,
    "voice_inactivity_timeout": 600,
    "in_call_recording_timeout": 14400,
    "recording_permission_denied_timeout": 300,
}


def build_agent_config(settings: Settings) -> Dict[str, Any]:
    """Build the POST /mia body for a pipeline agent: Deepgram -> OpenAI -> ElevenLabs."""
    payload: Dict[str, Any] = {
        "agent_name": settings.agent_name,
        "mode": "pipeline",
        "model": {
            "provider": "openai",
            "model": settings.openai_model,
            "system_prompt": settings.system_prompt,
            "first_message": settings.first_message,
            "temperature": settings.llm_temperature,
        },
        "voice": {
            "provider": "elevenlabs",
            "voice_id": settings.elevenlabs_voice_id,
            "speed": settings.elevenlabs_voice_speed,
        },
        "transcriber": {
            "provider": "deepgram",
            "model": settings.deepgram_model,
            "language": settings.language,
            "boostwords": list(settings.boostwords),
        },
        "agent": {
            "response_modality": "voice",
            "tools": [],
            "mcp_servers": [],
            "enable_interruptions": settings.enable_interruptions,
            "user_away_timeout": settings.user_away_timeout,
        },
        "audio": {"sample_rate": 48000, "num_channels": 1},
    }

    if settings.wake_word_enabled:
        payload["wake_word"] = {
            "enabled": True,
            "words": list(settings.wake_words),
            "timeout": settings.wake_word_timeout,
        }

    return payload


def build_bot_request(
    meeting_link: str, bot_name: str, agent_config_id: str
) -> Dict[str, Any]:
    """Build the POST /bots/create_bot body that attaches the agent to a bot.

    MeetStream hosts the MIA bridge, so the agent is attached with
    agent_config_id alone - never with socket_connection_url or
    live_audio_required, which point at a bridge you host yourself.
    """
    return {
        "meeting_link": meeting_link,
        "bot_name": bot_name,
        "agent_config_id": agent_config_id,
        "video_required": False,
        "automatic_leave": dict(AUTOMATIC_LEAVE),
    }
