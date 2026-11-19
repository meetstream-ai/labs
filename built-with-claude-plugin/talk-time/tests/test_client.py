from __future__ import annotations

import io
import urllib.error

import pytest

from talk_time.client import (
    ApiError,
    MissingApiKey,
    open_speaker_timeline,
    open_timeline_link,
    redact_url,
    speaker_timeline_url,
)
from talk_time.config import Config


class FakeResponse(io.BytesIO):
    def __init__(self, body=b"[]", status=200):
        super().__init__(body)
        self.status = status


def fake_opener(response, captured):
    def _open(request, timeout=None):
        captured["request"] = request
        captured["timeout"] = timeout
        return response

    return _open


def test_url_is_the_documented_endpoint():
    url = speaker_timeline_url("https://api.meetstream.ai/api/v1", "bot-123")
    assert url == "https://api.meetstream.ai/api/v1/bots/bot-123/get_speaker_timeline"


@pytest.mark.parametrize("bot_id", ["", "../../bots", "bot 123", "bot/../x", "a" * 129])
def test_bad_bot_ids_are_rejected(bot_id):
    with pytest.raises(ApiError):
        speaker_timeline_url("https://api.meetstream.ai/api/v1", bot_id)


def test_missing_api_key_is_a_clear_error():
    with pytest.raises(MissingApiKey) as excinfo:
        open_speaker_timeline("bot-123", Config(api_key=None))
    assert "MEETSTREAM_API_KEY" in str(excinfo.value)


def test_request_carries_the_token_header():
    captured = {}
    response = FakeResponse(b'[{"speaker":"A","start_byte":0,"end_byte":96000}]')
    stream = open_speaker_timeline(
        "bot-123",
        Config(api_key="ms_test_key"),
        opener=fake_opener(response, captured),
    )
    request = captured["request"]
    assert request.get_full_url().endswith("/bots/bot-123/get_speaker_timeline")
    assert request.get_header("Authorization") == "Token ms_test_key"
    assert request.get_method() == "GET"
    assert stream.read().startswith(b"[")


def test_timeline_not_ready_yet():
    captured = {}
    with pytest.raises(ApiError) as excinfo:
        open_speaker_timeline(
            "bot-123", Config(api_key="k"), opener=fake_opener(FakeResponse(status=202), captured)
        )
    assert "not ready" in str(excinfo.value)


def test_http_error_is_wrapped():
    def _open(request, timeout=None):
        raise urllib.error.HTTPError(request.get_full_url(), 401, "Unauthorized", {}, None)

    with pytest.raises(ApiError) as excinfo:
        open_speaker_timeline("bot-123", Config(api_key="k"), opener=_open)
    assert "401" in str(excinfo.value)


def test_connection_error_is_wrapped():
    def _open(request, timeout=None):
        raise urllib.error.URLError("no route to host")

    with pytest.raises(ApiError) as excinfo:
        open_speaker_timeline("bot-123", Config(api_key="k"), opener=_open)
    assert "could not reach" in str(excinfo.value)


def test_timeline_link_is_fetched_without_the_api_key():
    captured = {}
    response = FakeResponse(b'[{"speaker":"A","start_byte":0,"end_byte":96000}]')
    stream = open_timeline_link(
        "https://media.example.com/t/abc.json?X-Amz-Signature=deadbeef",
        opener=fake_opener(response, captured),
    )
    request = captured["request"]
    assert request.get_full_url().endswith("abc.json?X-Amz-Signature=deadbeef")
    # Pre-signed link: our token must not travel to storage.
    assert request.get_header("Authorization") is None
    assert stream.read().startswith(b"[")


@pytest.mark.parametrize(
    "url",
    [
        "http://media.example.com/t/abc.json",
        "file:///etc/passwd",
        "ftp://media.example.com/abc.json",
        "/t/abc.json",
        "",
    ],
)
def test_only_https_timeline_links_are_followed(url):
    def _open(request, timeout=None):  # pragma: no cover - must never run
        raise AssertionError("opened {}".format(url))

    with pytest.raises(ApiError) as excinfo:
        open_timeline_link(url, opener=_open)
    assert "refusing to follow" in str(excinfo.value)


def test_timeline_link_errors_are_wrapped():
    captured = {}
    with pytest.raises(ApiError) as excinfo:
        open_timeline_link(
            "https://media.example.com/t/abc.json?sig=secret",
            opener=fake_opener(FakeResponse(status=403), captured),
        )
    message = str(excinfo.value)
    assert "403" in message
    # The signature stays out of anything we print.
    assert "secret" not in message


def test_redact_url_drops_the_signature():
    assert redact_url("https://media.example.com/t/abc.json?X-Amz-Signature=deadbeef") == (
        "https://media.example.com/t/abc.json"
    )
