from dataclasses import replace
from datetime import datetime, timezone

import pytest

from chat_responder.client import MeetStreamError
from chat_responder.commands import UNKNOWN_START
from chat_responder.responder import ChatResponder, parse_timestamp


class FakeClient:
    """Chat transport stub: queue of poll results, records what we sent."""

    def __init__(self, polls=None, detail=None):
        self.polls = list(polls or [])
        self.detail = detail or {}
        self.sent = []
        self.fail_send = False

    def get_chats(self, bot_id):
        from chat_responder.client import normalize_chats

        if not self.polls:
            return []
        return normalize_chats(self.polls.pop(0))

    def send_message(self, bot_id, message):
        if self.fail_send:
            raise MeetStreamError("send failed")
        self.sent.append((bot_id, message))
        return {"status": "ok"}

    def get_bot_detail(self, bot_id):
        return self.detail


def chat(sender, message, id=None, timestamp="2026-11-18T10:00:00Z"):
    entry = {"sender": sender, "message": message, "timestamp": timestamp}
    if id:
        entry["id"] = id
    return entry


def build(config, client, now=1000.0):
    return ChatResponder(config, client, bot_id="bot-123", clock=lambda: now)


def test_replies_to_help(config):
    client = FakeClient([[chat("Alice", "!help", id="m1")]])
    assert build(config, client).poll_once() == 1
    assert "!agenda" in client.sent[0][1]


def test_replies_with_the_agenda(config):
    client = FakeClient([[chat("Alice", "can we see the !agenda?", id="m1")]])
    build(config, client).poll_once()
    assert "1. Intros" in client.sent[0][1]


def test_time_uses_the_meeting_start_from_bot_detail(config):
    client = FakeClient(
        [[chat("Alice", "!time", id="m1")]],
        detail={"bot_details": {"StartTime": "2026-11-18T10:00:00Z"}},
    )
    started = parse_timestamp("2026-11-18T10:00:00Z")
    responder = ChatResponder(
        config, client, bot_id="bot-123", clock=lambda: started + 125
    )
    responder.poll_once()
    assert "2m 5s" in client.sent[0][1]


def test_time_without_a_start_time_says_so(config):
    client = FakeClient([[chat("Alice", "!time", id="m1")]], detail={})
    build(config, client).poll_once()
    assert client.sent[0][1] == UNKNOWN_START


def test_ignores_chatter(config):
    client = FakeClient([[chat("Alice", "morning everyone", id="m1")]])
    assert build(config, client).poll_once() == 0
    assert client.sent == []


def test_ignores_its_own_messages(config):
    client = FakeClient([[chat(config.bot_name, "!help", id="m1")]])
    assert build(config, client).poll_once() == 0


def test_ignores_messages_sent_under_the_bot_id(config):
    client = FakeClient([[chat("bot-123", "!help", id="m1")]])
    assert build(config, client).poll_once() == 0


def test_each_message_is_answered_once(config):
    history = [chat("Alice", "!help", id="m1")]
    client = FakeClient([history, history, history])
    responder = build(config, client)
    assert responder.poll_once() == 1
    assert responder.poll_once() == 0
    assert responder.poll_once() == 0


def test_one_message_triggers_one_reply(config):
    client = FakeClient([[chat("Alice", "!help !agenda !time", id="m1")]])
    assert build(config, client).poll_once() == 1


def test_prime_swallows_the_backlog(config):
    client = FakeClient(
        [[chat("Alice", "!help", id="m1")], [chat("Alice", "!help", id="m1")]]
    )
    responder = build(config, client)
    responder.prime()
    assert responder.poll_once() == 0
    assert client.sent == []


def test_spam_from_one_sender_is_throttled(config):
    burst = [chat("Mallory", "!help", id="m{}".format(i)) for i in range(10)]
    client = FakeClient([burst])
    assert build(config, client).poll_once() == 1


def test_a_crowd_is_capped_per_minute(config):
    crowd = [
        chat("person{}".format(i), "!help", id="m{}".format(i)) for i in range(30)
    ]
    client = FakeClient([crowd])
    tight = replace(config, sender_cooldown_seconds=0.0, max_replies_per_minute=5)
    responder = ChatResponder(tight, client, bot_id="bot-123", clock=lambda: 1000.0)
    assert responder.poll_once() == 5


def test_long_message_does_not_break_parsing(config):
    noisy = "x" * 50000 + " !help"
    client = FakeClient([[chat("Alice", noisy, id="m1")]])
    # The command sits past max_message_chars, so it is cut off, not answered.
    assert build(config, client).poll_once() == 0


def test_hidden_characters_do_not_block_a_command(config):
    client = FakeClient([[chat("Alice", "!he​lp", id="m1")]])
    assert build(config, client).poll_once() == 1


def test_reply_never_exceeds_the_message_cap(config, tmp_path):
    big = tmp_path / "agenda.md"
    big.write_text("\n".join("item {}".format(i) for i in range(2000)), encoding="utf-8")
    small = replace(config, agenda_path=big, max_message_chars=300, max_agenda_bytes=100000)
    client = FakeClient([[chat("Alice", "!agenda", id="m1")]])
    responder = ChatResponder(small, client, bot_id="bot-123", clock=lambda: 1000.0)
    responder.poll_once()
    assert len(client.sent[0][1]) <= 300


def test_poll_survives_an_api_failure(config):
    class BrokenClient(FakeClient):
        def get_chats(self, bot_id):
            raise MeetStreamError("502 bad gateway")

    assert build(config, BrokenClient()).poll_once() == 0


def test_send_failure_is_not_counted(config):
    client = FakeClient([[chat("Alice", "!help", id="m1")]])
    client.fail_send = True
    assert build(config, client).poll_once() == 0


def test_malformed_chat_entries_are_skipped(config):
    client = FakeClient([[None, 42, {"nothing": "useful"}, chat("Alice", "!help", id="m1")]])
    assert build(config, client).poll_once() == 1


def test_messages_without_ids_are_deduped_by_content(config):
    entry = {"sender": "Alice", "message": "!help", "timestamp": "2026-11-18T10:00:00Z"}
    client = FakeClient([[entry], [entry]])
    responder = build(config, client)
    assert responder.poll_once() == 1
    assert responder.poll_once() == 0


def test_run_forever_polls_then_sleeps(config):
    # prime() consumes the first (empty) backlog, then two polls run.
    client = FakeClient([[], [chat("Alice", "!help", id="m1")], []])
    responder = ChatResponder(config, client, bot_id="bot-123", clock=lambda: 1000.0)

    sleeps = []

    def sleeper(seconds):
        sleeps.append(seconds)
        if len(sleeps) == 2:
            raise KeyboardInterrupt

    responder._sleep = sleeper
    with pytest.raises(KeyboardInterrupt):
        responder.run_forever()
    assert sleeps == [config.poll_interval_seconds] * 2
    assert len(client.sent) == 1


@pytest.mark.parametrize(
    "value",
    ["2026-11-18T10:00:00Z", "2026-11-18T10:00:00+00:00", "2026-11-18T10:00:00"],
)
def test_parse_timestamp_variants(value):
    expected = datetime(2026, 11, 18, 10, 0, tzinfo=timezone.utc).timestamp()
    assert parse_timestamp(value) == pytest.approx(expected)


def test_parse_timestamp_handles_long_fractions():
    expected = datetime(2026, 11, 18, 10, 0, tzinfo=timezone.utc).timestamp()
    assert parse_timestamp("2026-11-18T10:00:00.123456789Z") == pytest.approx(
        expected + 0.123456, abs=1e-5
    )


@pytest.mark.parametrize("value", [None, "", "not a date", 17634600, "2026-13-45"])
def test_parse_timestamp_rejects_junk(value):
    assert parse_timestamp(value) is None
