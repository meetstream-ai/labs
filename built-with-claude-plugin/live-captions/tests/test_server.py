import hashlib
import hmac
import json

import pytest
from fastapi.testclient import TestClient

from live_captions.config import load_settings
from live_captions.server import create_app, verify_signature

SECRET = "whsec_test"


@pytest.fixture
def client(printer, settings):
    return TestClient(create_app(printer, settings))


def sign(body: bytes, secret: str = SECRET) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_healthz(client):
    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_live_chunk_is_printed(client, output):
    response = client.post(
        "/live-transcript",
        json={"speakerName": "Alice", "transcript": "Let's begin.", "is_final": True},
    )

    assert response.status_code == 200
    assert "Alice: Let's begin." in output.getvalue()


def test_interim_chunk_is_accepted_without_printing(client, output):
    response = client.post(
        "/live-transcript",
        json={"speakerName": "Alice", "transcript": "Let's", "is_final": False},
    )

    assert response.status_code == 200
    assert output.getvalue() == ""


def test_malformed_body_is_rejected_without_crashing(client, output):
    response = client.post("/live-transcript", content=b"not json")

    assert response.status_code == 400
    assert output.getvalue() == ""


def test_json_that_is_not_an_object_is_rejected(client):
    assert client.post("/live-transcript", content=b"[1, 2]").status_code == 400


def test_lifecycle_events_print_human_status_lines(client, output):
    for event in ("bot.joining", "bot.inmeeting", "bot.recording"):
        response = client.post(
            "/webhook",
            json={"event": event, "bot_event": event, "bot_id": "b1", "timestamp": event},
        )
        assert response.status_code == 200

    printed = output.getvalue()
    assert "bot is joining the meeting" in printed
    assert "bot joined the meeting" in printed
    assert "recording started" in printed


def test_terminal_reason_comes_from_bot_event(client, output):
    client.post(
        "/webhook",
        json={
            "event": "bot.stopped",
            "bot_event": "bot.notallowed",
            "bot_id": "b1",
            "timestamp": "t1",
        },
    )

    assert "never admitted" in output.getvalue()


def test_duplicate_lifecycle_events_are_printed_once(client, output):
    event = {"event": "bot.recording", "bot_event": "bot.recording", "bot_id": "b1", "timestamp": "t"}
    client.post("/webhook", json=event)
    client.post("/webhook", json=event)

    assert output.getvalue().count("recording started") == 1


def test_unknown_lifecycle_event_is_acknowledged_quietly(client, output):
    response = client.post("/webhook", json={"event": "bot.uploading", "bot_id": "b1"})

    assert response.status_code == 200
    assert output.getvalue() == ""


def test_signed_delivery_is_accepted(printer, output):
    settings = load_settings(
        env={"PUBLIC_BASE_URL": "https://tunnel.example.com", "MEETSTREAM_WEBHOOK_SECRET": SECRET}
    )
    client = TestClient(create_app(printer, settings))
    body = json.dumps({"speakerName": "Alice", "transcript": "Hi.", "is_final": True}).encode()

    response = client.post(
        "/live-transcript",
        content=body,
        headers={"X-MeetStream-Signature": sign(body), "Content-Type": "application/json"},
    )

    assert response.status_code == 200
    assert "Alice: Hi." in output.getvalue()


def test_badly_signed_delivery_is_rejected(printer, output):
    settings = load_settings(
        env={"PUBLIC_BASE_URL": "https://tunnel.example.com", "MEETSTREAM_WEBHOOK_SECRET": SECRET}
    )
    client = TestClient(create_app(printer, settings))
    body = json.dumps({"speakerName": "Alice", "transcript": "Hi.", "is_final": True}).encode()

    response = client.post(
        "/live-transcript",
        content=body,
        headers={"X-MeetStream-Signature": sign(body, "wrong-secret")},
    )

    assert response.status_code == 401
    assert output.getvalue() == ""


def test_signature_is_not_required_when_no_secret_is_configured(client, output):
    response = client.post(
        "/live-transcript",
        json={"speakerName": "Alice", "transcript": "Hi.", "is_final": True},
    )

    assert response.status_code == 200


def test_verify_signature_accepts_both_header_forms():
    body = b'{"a": 1}'
    digest = hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()

    assert verify_signature(SECRET, body, "sha256=" + digest)
    assert verify_signature(SECRET, body, digest)
    assert not verify_signature(SECRET, body, "sha256=deadbeef")
    assert not verify_signature(SECRET, body, None)
    assert not verify_signature(SECRET, b'{"a": 2}', digest)
