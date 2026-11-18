import json

import httpx
import pytest

from live_captions.config import ConfigError, load_settings
from live_captions.meetstream import AUTOMATIC_LEAVE, MeetStreamClient, MeetStreamError


def transport(handler):
    return httpx.MockTransport(handler)


def test_payload_uses_meetstream_streaming_and_no_video(settings):
    payload = MeetStreamClient(settings).build_create_bot_payload("https://meet.google.com/abc")

    assert payload["meeting_link"] == "https://meet.google.com/abc"
    assert payload["bot_name"] == "Live Captions"
    assert payload["video_required"] is False
    provider = payload["recording_config"]["transcript"]["provider"]
    assert provider == {"meetstream_streaming": {}}
    assert "deepgram_streaming" not in provider and "assemblyai_streaming" not in provider


def test_payload_points_both_webhooks_at_the_local_server(settings):
    payload = MeetStreamClient(settings).build_create_bot_payload("https://meet.google.com/abc")

    assert payload["live_transcription_required"] == {
        "webhook_url": "https://tunnel.example.com/live-transcript"
    }
    assert payload["callback_url"] == "https://tunnel.example.com/webhook"


def test_payload_carries_retention_and_leave_timeouts(settings):
    payload = MeetStreamClient(settings).build_create_bot_payload("https://meet.google.com/abc")

    assert payload["recording_config"]["retention"] == {"type": "timed", "hours": 24}
    assert payload["automatic_leave"] == AUTOMATIC_LEAVE
    assert AUTOMATIC_LEAVE["in_call_recording_timeout"] >= 600
    assert 60 <= AUTOMATIC_LEAVE["recording_permission_denied_timeout"] <= 300


def test_payload_has_no_per_participant_streams(settings):
    payload = MeetStreamClient(settings).build_create_bot_payload("https://meet.google.com/abc")

    assert "video_separate_streams" not in payload
    assert "video_separate_streams" not in payload["recording_config"]
    assert "audio_separate_streams" not in payload


def test_create_bot_sends_the_token_header_and_returns_the_body(settings):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["Authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(201, json={"bot_id": "bot-123", "status": "Active"})

    client = MeetStreamClient(settings, transport=transport(handler))
    result = client.create_bot("https://meet.google.com/abc")

    assert result == {"bot_id": "bot-123", "status": "Active"}
    assert seen["url"] == "https://api.meetstream.ai/api/v1/bots/create_bot"
    assert seen["auth"] == "Token ms_test_key"
    assert seen["body"]["video_required"] is False


def test_create_bot_raises_on_api_error(settings):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text="no streaming provider found")

    client = MeetStreamClient(settings, transport=transport(handler))
    with pytest.raises(MeetStreamError) as exc:
        client.create_bot("https://meet.google.com/abc")

    assert exc.value.status_code == 400
    assert "no streaming provider" in exc.value.body


def test_network_failure_is_wrapped(settings):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("tunnel down")

    client = MeetStreamClient(settings, transport=transport(handler))
    with pytest.raises(MeetStreamError, match="could not reach MeetStream"):
        client.create_bot("https://meet.google.com/abc")


def test_remove_bot_calls_the_remove_endpoint(settings):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"message": "Bot removed"})

    result = MeetStreamClient(settings, transport=transport(handler)).remove_bot("bot-123")

    assert result == {"message": "Bot removed"}
    assert seen["method"] == "GET"
    assert seen["url"].endswith("/bots/bot-123/remove_bot")


def test_client_refuses_to_call_without_an_api_key():
    settings = load_settings(env={"PUBLIC_BASE_URL": "https://tunnel.example.com"})

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover - must not run
        raise AssertionError("the API must not be called without a key")

    with pytest.raises(ConfigError, match="MEETSTREAM_API_KEY"):
        MeetStreamClient(settings, transport=transport(handler)).create_bot("https://meet/abc")
