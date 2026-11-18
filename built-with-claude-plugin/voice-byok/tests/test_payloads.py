import json

from conftest import PROVIDER_SECRETS

from voice_agent.config import Settings
from voice_agent.payloads import AUTOMATIC_LEAVE, build_agent_config, build_bot_request


def test_pipeline_mode_wires_the_three_providers(settings):
    payload = build_agent_config(settings)
    assert payload["mode"] == "pipeline"
    assert payload["transcriber"]["provider"] == "deepgram"
    assert payload["transcriber"]["model"] == "nova-3"
    assert payload["model"]["provider"] == "openai"
    assert payload["model"]["model"] == "gpt-4.1"
    assert payload["voice"]["provider"] == "elevenlabs"
    assert payload["voice"]["voice_id"] == "21m00Tcm4TlvDq8ikWAM"


def test_agent_speaks_and_discloses_itself(settings):
    payload = build_agent_config(settings)
    assert payload["agent"]["response_modality"] == "voice"
    assert "AI" in payload["model"]["first_message"]


def test_boostwords_are_passed_to_the_transcriber(settings):
    assert build_agent_config(settings)["transcriber"]["boostwords"] == [
        "MeetStream",
        "MIA",
        "Deepgram",
    ]


def test_wake_word_block_present_when_enabled(settings):
    wake_word = build_agent_config(settings)["wake_word"]
    assert wake_word["enabled"] is True
    assert wake_word["words"] == ["hey assistant", "ok assistant"]
    assert wake_word["timeout"] == 30


def test_wake_word_block_omitted_when_disabled(env):
    env["WAKE_WORD_ENABLED"] = "false"
    assert "wake_word" not in build_agent_config(Settings.from_env(env))


def test_provider_keys_never_appear_in_the_agent_payload(settings):
    """BYOK keys live on the MeetStream account, not in the request body."""
    serialized = json.dumps(build_agent_config(settings))
    for secret in PROVIDER_SECRETS:
        assert secret not in serialized


def test_agent_payload_is_not_shared_between_calls(settings):
    first = build_agent_config(settings)
    first["transcriber"]["boostwords"].append("mutated")
    assert "mutated" not in build_agent_config(settings)["transcriber"]["boostwords"]


def test_bot_request_attaches_the_agent_by_id_only():
    payload = build_bot_request("https://meet.google.com/abc", "Assistant", "agent-123")
    assert payload["meeting_link"] == "https://meet.google.com/abc"
    assert payload["bot_name"] == "Assistant"
    assert payload["agent_config_id"] == "agent-123"
    # MeetStream hosts the MIA bridge; these two would point it at our own
    # server and silence the agent.
    assert "socket_connection_url" not in payload
    assert "live_audio_required" not in payload


def test_bot_request_does_not_record_video_by_default():
    assert build_bot_request("https://meet.google.com/abc", "A", "id")["video_required"] is False


def test_automatic_leave_respects_api_limits():
    leave = build_bot_request("https://meet.google.com/abc", "A", "id")["automatic_leave"]
    assert leave["in_call_recording_timeout"] >= 600
    assert 60 <= leave["recording_permission_denied_timeout"] <= 300


def test_automatic_leave_defaults_are_not_mutated():
    payload = build_bot_request("https://meet.google.com/abc", "A", "id")
    payload["automatic_leave"]["waiting_room_timeout"] = 1
    assert AUTOMATIC_LEAVE["waiting_room_timeout"] == 600
