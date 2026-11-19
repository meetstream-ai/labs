import logging

import pytest
from conftest import FakeResponse, FakeSession

from chat_responder import client as client_module
from chat_responder.client import MeetStreamClient, MeetStreamError, normalize_chats

BASE = "https://api.meetstream.ai/api/v1"


@pytest.fixture(autouse=True)
def forget_warned_shapes():
    """The unreadable-payload warning fires once per shape per process."""
    client_module._warned_shapes.clear()
    yield
    client_module._warned_shapes.clear()


def make_client(session, timeout=10.0):
    return MeetStreamClient("ms_test_key", BASE, session=session, timeout=timeout)


def test_send_message_request_shape():
    session = FakeSession({"/send_message": FakeResponse(200, {"status": "ok"})})
    make_client(session).send_message("bot-123", "hello")

    call = session.calls[0]
    assert call["method"] == "POST"
    assert call["url"] == BASE + "/bots/bot-123/send_message"
    assert call["headers"]["Authorization"] == "Token ms_test_key"
    assert call["json"] == {"message": "hello", "metadata": {"message_type": "text"}}
    assert call["timeout"] == 10.0


def test_get_chats_request_shape():
    session = FakeSession({"/get_chats": FakeResponse(200, [])})
    make_client(session).get_chats("bot-123")

    call = session.calls[0]
    assert call["method"] == "GET"
    assert call["url"] == BASE + "/bots/bot-123/get_chats"
    assert call["json"] is None


def test_create_bot_keeps_video_off_and_retention_short():
    session = FakeSession({"/create_bot": FakeResponse(201, {"bot_id": "bot-9"})})
    created = make_client(session).create_bot("https://meet.google.com/abc", "Assistant")

    body = session.calls[0]["json"]
    assert created == {"bot_id": "bot-9"}
    assert body["video_required"] is False
    assert body["bot_name"] == "Assistant"
    assert body["recording_config"]["retention"] == {"type": "timed", "hours": 24}
    assert "bot_message" not in body


def test_http_error_raises():
    session = FakeSession({"/get_chats": FakeResponse(403, None, text="forbidden")})
    with pytest.raises(MeetStreamError) as excinfo:
        make_client(session).get_chats("bot-123")
    assert "403" in str(excinfo.value)


def test_network_error_raises_meetstream_error():
    class ExplodingSession:
        def request(self, *args, **kwargs):
            raise OSError("connection reset")

    with pytest.raises(MeetStreamError):
        make_client(ExplodingSession()).get_chats("bot-123")


def test_non_json_body_is_tolerated():
    session = FakeSession({"/send_message": FakeResponse(200, None)})
    assert make_client(session).send_message("bot-123", "hi") is None


def test_bot_detail_returns_dict_only():
    session = FakeSession({"/detail": FakeResponse(200, ["unexpected"])})
    assert make_client(session).get_bot_detail("bot-123") == {}


@pytest.mark.parametrize(
    "payload",
    [
        # Shapes the parser already handled.
        [{"sender": "Alice", "message": "!help"}],
        {"chats": [{"sender": "Alice", "message": "!help"}]},
        {"data": {"messages": [{"speaker": "Alice", "text": "!help"}]}},
        {"chats": [{"sender": {"name": "Alice"}, "content": "!help"}]},
        # Shapes that used to come back empty, which is how a room full of
        # people typing !help produced no replies at all.
        {"chats": [{"sender": "Alice", "message": {"text": "!help"}}]},
        {"chats": [{"sender": "Alice", "chat": {"message": "!help"}}]},
        {"chat_history": [{"sender": "Alice", "message": "!help"}]},
        {"result": {"data": {"chat": {"messages": [{"sender": "Alice", "message": "!help"}]}}}},
        {"m-1": {"sender": "Alice", "message": "!help"}},
        {"sender": "Alice", "message": "!help", "timestamp": "t1"},
        [{"displayName": "Alice", "chatMessage": "!help", "messageId": "m-1"}],
    ],
)
def test_normalize_chats_handles_shape_variants(payload):
    messages = normalize_chats(payload)
    assert len(messages) == 1
    assert messages[0].sender == "Alice"
    assert messages[0].text == "!help"


def test_normalize_chats_keeps_message_order():
    messages = normalize_chats(
        {
            "chats": [
                {"sender": "Alice", "message": "!help", "id": "m-1"},
                {"sender": "Bob", "message": "!agenda", "id": "m-2"},
            ]
        }
    )
    assert [(m.sender, m.text) for m in messages] == [
        ("Alice", "!help"),
        ("Bob", "!agenda"),
    ]


@pytest.mark.parametrize("payload", [[], {}, {"chats": []}, {"data": {"messages": []}}])
def test_normalize_chats_is_quiet_when_nobody_has_typed(payload, caplog):
    """An empty chat is the normal case - it must not warn on every poll."""
    with caplog.at_level(logging.WARNING, logger="chat_responder.client"):
        assert normalize_chats(payload) == []
    assert caplog.records == []


def test_normalize_chats_warns_with_key_names_when_unreadable(caplog):
    with caplog.at_level(logging.WARNING, logger="chat_responder.client"):
        assert normalize_chats({"lines": [{"who": "Alice", "says": "!help"}]}) == []

    assert len(caplog.records) == 1
    message = caplog.records[0].getMessage()
    assert "lines" in message  # the key names point at the fix
    assert "Alice" not in message and "!help" not in message  # values stay at DEBUG


def test_unreadable_payload_warns_once_per_shape(caplog):
    with caplog.at_level(logging.WARNING, logger="chat_responder.client"):
        for _ in range(5):
            normalize_chats({"lines": [{"who": "Alice", "says": "!help"}]})
    assert len(caplog.records) == 1


def test_normalize_chats_skips_junk_entries():
    messages = normalize_chats(
        [
            "not a dict",
            {"sender": "Alice"},  # no text
            {"message": "   "},  # blank text
            {"sender": "Bob", "message": "!time"},
        ]
    )
    assert [m.text for m in messages] == ["!time"]
    assert messages[0].sender == "Bob"


def test_normalize_chats_on_unusable_payload():
    assert normalize_chats(None) == []
    assert normalize_chats("nonsense") == []
    assert normalize_chats({"unexpected": 1}) == []


def test_message_key_prefers_an_id():
    message = normalize_chats([{"id": "m-1", "sender": "A", "message": "hi"}])[0]
    assert message.key == "m-1"


def test_message_key_falls_back_to_a_content_hash():
    first = normalize_chats([{"sender": "A", "message": "hi", "timestamp": "t1"}])[0]
    same = normalize_chats([{"sender": "A", "message": "hi", "timestamp": "t1"}])[0]
    later = normalize_chats([{"sender": "A", "message": "hi", "timestamp": "t2"}])[0]
    assert first.key == same.key
    assert first.key != later.key
    assert first.key.startswith("sha256:")
