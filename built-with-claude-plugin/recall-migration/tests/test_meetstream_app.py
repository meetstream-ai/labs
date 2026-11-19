import pytest

import meetstream_app


class FakeResp:
    def __init__(self, data, status_code=200):
        self._d = data
        self.status_code = status_code

    def json(self):
        return self._d

    def raise_for_status(self):
        if self.status_code >= 400:
            raise AssertionError(f"HTTP {self.status_code}")


class FakeSession:
    """Stands in for `requests`; records every call so tests can assert on them.

    Response shapes here are MeetStream's real ones: bot detail wraps everything in
    `bot_details`, and get_transcript answers with a top-level array of segments.
    """

    def __init__(self, transcript_status="Success", transcript_id="tr_456"):
        self.calls = []
        self.transcript_status = transcript_status
        self.transcript_id = transcript_id

    def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append(("POST", url, json, headers))
        return FakeResp({"bot_id": "bot_123"}, status_code=201)

    def get(self, url, headers=None, timeout=None):
        self.calls.append(("GET", url, None, headers))
        if url.endswith("/bots/bot_123/detail"):
            return FakeResp(
                {
                    "bot_details": {
                        "BotID": "bot_123",
                        "TranscriptStatus": self.transcript_status,
                        "transcript_id": self.transcript_id,
                    }
                }
            )
        if url.endswith(f"/transcript/{self.transcript_id}/get_transcript"):
            return FakeResp(
                [
                    {"speaker": "Ana", "transcript": "hello all", "start_time": 0.5},
                    {"speaker": "Ben", "transcript": "hi Ana", "start_time": 3.4},
                ]
            )
        raise AssertionError(f"unexpected GET {url}")


@pytest.fixture(autouse=True)
def api_key(monkeypatch):
    monkeypatch.setenv("MEETSTREAM_API_KEY", "k")


@pytest.fixture
def session():
    return FakeSession()


def test_send_bot_hits_meetstream_create_bot(session):
    assert meetstream_app.send_bot("https://meet.google.com/abc-defg-hij", session=session) == "bot_123"
    method, url, _, _ = session.calls[0]
    assert method == "POST"
    assert url == "https://api.meetstream.ai/api/v1/bots/create_bot"


def test_send_bot_maps_recall_fields_to_meetstream(session):
    meetstream_app.send_bot("https://meet.google.com/abc-defg-hij", bot_name="Scribe", session=session)
    body = session.calls[0][2]
    assert body["meeting_link"] == "https://meet.google.com/abc-defg-hij"
    assert body["bot_name"] == "Scribe"
    assert "meeting_url" not in body


def test_send_bot_defaults_to_audio_only(session):
    """Migrated bots default to video off; video costs more and Recall's default was audio."""
    meetstream_app.send_bot("https://meet.google.com/abc-defg-hij", session=session)
    assert session.calls[0][2]["video_required"] is False


def test_send_bot_sets_callback_url_only_when_given(session):
    meetstream_app.send_bot("https://meet.google.com/abc-defg-hij", session=session)
    assert "callback_url" not in session.calls[0][2]

    meetstream_app.send_bot(
        "https://meet.google.com/abc-defg-hij", webhook_url="https://example.test/webhooks/meetstream", session=session
    )
    assert session.calls[1][2]["callback_url"] == "https://example.test/webhooks/meetstream"


def test_auth_header_uses_token_scheme(session):
    meetstream_app.send_bot("https://meet.google.com/abc-defg-hij", session=session)
    assert session.calls[0][3]["Authorization"] == "Token k"


def test_missing_api_key_raises(monkeypatch, session):
    monkeypatch.delenv("MEETSTREAM_API_KEY")
    with pytest.raises(KeyError):
        meetstream_app.send_bot("https://meet.google.com/abc-defg-hij", session=session)


def test_send_bot_sends_full_meetstream_provider_config(session):
    """The `meetstream` post-call provider requires language and translate."""
    meetstream_app.send_bot("https://meet.google.com/abc-defg-hij", session=session)
    provider = session.calls[0][2]["recording_config"]["transcript"]["provider"]
    assert provider == {"meetstream": {"language": "en", "translate": False}}


def test_get_transcript_resolves_transcript_id_from_bot_detail(session):
    assert meetstream_app.get_transcript("bot_123", session=session) == "Ana: hello all\nBen: hi Ana"
    urls = [url for _, url, _, _ in session.calls]
    assert urls == [
        "https://api.meetstream.ai/api/v1/bots/bot_123/detail",
        "https://api.meetstream.ai/api/v1/transcript/tr_456/get_transcript",
    ]


def test_get_transcript_labels_unknown_speaker(session, monkeypatch):
    monkeypatch.setattr(
        session,
        "get",
        lambda url, headers=None, timeout=None: FakeResp({"bot_details": {"transcript_id": "tr_456"}})
        if url.endswith("/detail")
        else FakeResp([{"speaker": None, "transcript": "who said this"}]),
    )
    assert meetstream_app.get_transcript("bot_123", session=session) == "Unknown: who said this"


def test_get_transcript_raises_on_failed_transcription():
    """TranscriptStatus is authoritative: the fetch would answer 202 forever instead."""
    session = FakeSession(transcript_status="Failed")
    with pytest.raises(meetstream_app.TranscriptFailed):
        meetstream_app.get_transcript("bot_123", session=session)
    assert len(session.calls) == 1  # never reached get_transcript


def test_get_transcript_raises_when_transcript_id_missing():
    session = FakeSession(transcript_id=None)
    with pytest.raises(meetstream_app.TranscriptNotReady):
        meetstream_app.get_transcript("bot_123", session=session)


def test_get_transcript_raises_on_202_still_processing(session, monkeypatch):
    monkeypatch.setattr(
        session,
        "get",
        lambda url, headers=None, timeout=None: FakeResp({"bot_details": {"transcript_id": "tr_456"}})
        if url.endswith("/detail")
        else FakeResp({"message": "Transcript is still being processed."}, status_code=202),
    )
    with pytest.raises(meetstream_app.TranscriptNotReady):
        meetstream_app.get_transcript("bot_123", session=session)


def test_base_url_is_overridable(monkeypatch, session):
    monkeypatch.setattr(meetstream_app, "BASE", "https://staging.example.test/api/v1")
    meetstream_app.send_bot("https://meet.google.com/abc-defg-hij", session=session)
    assert session.calls[0][1] == "https://staging.example.test/api/v1/bots/create_bot"


# --- webhook ---------------------------------------------------------------


@pytest.fixture
def client(monkeypatch):
    meetstream_app.SAVED.clear()
    monkeypatch.setattr(meetstream_app, "get_transcript", lambda bot_id: f"transcript for {bot_id}")
    meetstream_app.app.config["TESTING"] = True
    with meetstream_app.app.test_client() as c:
        yield c


def bot_done(**extra):
    """A real MeetStream bot.done delivery: flat envelope, bot_id at the top level."""
    return {
        "event": "bot.done",
        "bot_event": "bot.done",
        "bot_id": "bot_123",
        "bot_status": "Done",
        "message": "Bot has completed processing",
        "status_code": 200,
        "custom_attributes": {},
        "timestamp": "2026-11-18T06:28:14.445Z",
        **extra,
    }


def test_webhook_saves_transcript_on_bot_done(client):
    resp = client.post("/webhooks/meetstream", json=bot_done())
    assert resp.status_code == 200
    assert resp.get_json() == {"ok": True}
    assert meetstream_app.SAVED == {"bot_123": "transcript for bot_123"}


def test_webhook_reads_flat_bot_id_not_recall_nesting(client):
    """Regression: the handler used to read evt["data"]["bot_id"] and 500 on every event."""
    resp = client.post("/webhooks/meetstream", json=bot_done())
    assert resp.status_code == 200
    assert "bot_123" in meetstream_app.SAVED


def test_webhook_ignores_other_events(client):
    client.post(
        "/webhooks/meetstream",
        json={"event": "bot.stopped", "bot_event": "bot.kicked", "bot_id": "bot_123", "bot_status": "Stopped"},
    )
    assert meetstream_app.SAVED == {}


def test_webhook_ignores_lifecycle_events(client):
    for event in ("bot.joining", "bot.recording", "bot.in_waiting_room", "transcription.processed"):
        client.post("/webhooks/meetstream", json={"event": event, "bot_id": "bot_123"})
    assert meetstream_app.SAVED == {}


def test_legacy_recall_webhook_path_still_works(client):
    client.post("/webhooks/recall", json=bot_done())
    assert meetstream_app.SAVED == {"bot_123": "transcript for bot_123"}


def test_webhook_tolerates_empty_body(client):
    assert client.post("/webhooks/meetstream", data="{}", content_type="application/json").status_code == 200
    assert client.post("/webhooks/meetstream", data="", content_type="application/json").status_code == 200


def test_webhook_tolerates_bot_done_without_bot_id(client):
    assert client.post("/webhooks/meetstream", json={"event": "bot.done"}).status_code == 200
    assert meetstream_app.SAVED == {}


def test_webhook_returns_200_when_transcript_fetch_fails(client, monkeypatch):
    """MeetStream never retries a webhook, so a fetch failure must not surface as a 500."""

    def boom(bot_id):
        raise meetstream_app.TranscriptNotReady(bot_id)

    monkeypatch.setattr(meetstream_app, "get_transcript", boom)
    resp = client.post("/webhooks/meetstream", json=bot_done())
    assert resp.status_code == 200
    assert meetstream_app.SAVED == {}


def test_webhook_end_to_end_against_real_payload_shapes(monkeypatch, api_key):
    """Whole path with get_transcript unstubbed: flat webhook -> /detail -> transcript array."""
    session = FakeSession()
    meetstream_app.SAVED.clear()
    real_get_transcript = meetstream_app.get_transcript
    monkeypatch.setattr(meetstream_app, "get_transcript", lambda bot_id: real_get_transcript(bot_id, session))
    meetstream_app.app.config["TESTING"] = True
    with meetstream_app.app.test_client() as c:
        assert c.post("/webhooks/meetstream", json=bot_done()).status_code == 200
    assert meetstream_app.SAVED == {"bot_123": "Ana: hello all\nBen: hi Ana"}
    assert [url for _, url, _, _ in session.calls] == [
        "https://api.meetstream.ai/api/v1/bots/bot_123/detail",
        "https://api.meetstream.ai/api/v1/transcript/tr_456/get_transcript",
    ]
