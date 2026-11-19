from __future__ import annotations

import time
from email.utils import formatdate

import pytest
from conftest import MEET, FakeResponse, FakeSession, connection_error, created, rate_limited

from dispatcher.client import MeetStreamClient, MeetStreamError, RateLimitGate

PAYLOAD = {"meeting_link": MEET, "bot_name": "Notetaker"}


def make_client(responses, sleeper, **kwargs):
    session = FakeSession(responses)
    kwargs.setdefault("max_retries", 3)
    kwargs.setdefault("backoff_base", 1.0)
    client = MeetStreamClient(
        api_key="ms_test_key",
        base_url="https://api.meetstream.ai/api/v1",
        session=session,
        sleeper=sleeper,
        clock=sleeper.clock,
        jitter=lambda: 1.0,
        **kwargs
    )
    return client, session


def test_create_bot_returns_the_bot_id(sleeper):
    client, session = make_client([created("bot-abc")], sleeper)
    result = client.create_bot(PAYLOAD)
    assert result.bot_id == "bot-abc"
    assert result.status == "Active"
    assert result.attempts == 1
    assert sleeper.waits == []


def test_create_bot_sends_the_token_header_and_payload(sleeper):
    client, session = make_client([created()], sleeper)
    client.create_bot(PAYLOAD)
    call = session.calls[0]
    assert call["url"] == "https://api.meetstream.ai/api/v1/bots/create_bot"
    assert call["headers"]["Authorization"] == "Token ms_test_key"
    assert call["json"] == PAYLOAD


def test_rate_limit_is_retried_honouring_retry_after(sleeper):
    client, session = make_client([rate_limited(retry_after=7), created()], sleeper)
    result = client.create_bot(PAYLOAD)
    assert result.bot_id == "bot-123"
    assert result.attempts == 2
    assert sleeper.waits == [7.0]
    assert len(session.calls) == 2


def test_rate_limit_without_retry_after_backs_off_exponentially(sleeper):
    client, session = make_client(
        [rate_limited(), rate_limited(), created()], sleeper, backoff_base=2.0
    )
    client.create_bot(PAYLOAD)
    assert sleeper.waits == [2.0, 4.0]


def test_retry_after_as_an_http_date_is_honoured(sleeper):
    when = formatdate(timeval=time.time() + 30, usegmt=True)
    client, _ = make_client(
        [FakeResponse(429, {"message": "slow down"}, headers={"Retry-After": when}), created()],
        sleeper,
    )
    client.create_bot(PAYLOAD)
    assert sleeper.waits[0] == pytest.approx(30, abs=2)


def test_retry_after_is_capped_at_max_backoff(sleeper):
    client, _ = make_client([rate_limited(retry_after=3600), created()], sleeper, max_backoff=60.0)
    client.create_bot(PAYLOAD)
    assert sleeper.waits == [60.0]


def test_exhausted_rate_limit_retries_fail_with_a_clear_reason(sleeper):
    client, session = make_client(
        [rate_limited(retry_after=1) for _ in range(4)], sleeper, max_retries=3
    )
    with pytest.raises(MeetStreamError) as excinfo:
        client.create_bot(PAYLOAD)
    error = excinfo.value
    assert error.kind == "rate_limited"
    assert error.status_code == 429
    assert error.attempts == 4
    assert "rate limited" in error.reason
    assert len(session.calls) == 4


def test_a_rate_limited_worker_holds_back_the_others(sleeper):
    client, _ = make_client([rate_limited(retry_after=5), created()], sleeper)
    gate_at_sleep = []
    sleeper.on_sleep = lambda: gate_at_sleep.append(client.gate.remaining())

    client.create_bot(PAYLOAD)

    # The shared gate is already held when this worker starts waiting, so any
    # other worker entering create_bot waits out the same window.
    assert gate_at_sleep == [5.0]
    assert client.gate.remaining() == 0.0  # released once the window passed


def test_bad_request_is_not_retried(sleeper):
    client, session = make_client(
        [FakeResponse(400, {"message": "meeting_link is invalid"})], sleeper
    )
    with pytest.raises(MeetStreamError) as excinfo:
        client.create_bot(PAYLOAD)
    assert len(session.calls) == 1
    assert excinfo.value.kind == "api_error"
    assert "meeting_link is invalid" in excinfo.value.reason
    assert sleeper.waits == []


def test_unauthorized_is_reported_as_an_auth_failure(sleeper):
    client, session = make_client([FakeResponse(401, {"detail": "Invalid token"})], sleeper)
    with pytest.raises(MeetStreamError) as excinfo:
        client.create_bot(PAYLOAD)
    assert excinfo.value.kind == "auth"
    assert "MEETSTREAM_API_KEY" in excinfo.value.reason
    assert len(session.calls) == 1


def test_server_errors_are_retried_then_reported(sleeper):
    client, session = make_client(
        [FakeResponse(503, {"message": "upstream unavailable"}) for _ in range(3)],
        sleeper,
        max_retries=2,
    )
    with pytest.raises(MeetStreamError) as excinfo:
        client.create_bot(PAYLOAD)
    assert excinfo.value.kind == "server_error"
    assert excinfo.value.attempts == 3
    assert len(session.calls) == 3


def test_server_error_then_success(sleeper):
    client, _ = make_client([FakeResponse(500, {"message": "boom"}), created("bot-xyz")], sleeper)
    assert client.create_bot(PAYLOAD).bot_id == "bot-xyz"


def test_network_errors_are_retried_then_reported(sleeper):
    client, session = make_client(
        [connection_error(), connection_error(), connection_error()], sleeper, max_retries=2
    )
    with pytest.raises(MeetStreamError) as excinfo:
        client.create_bot(PAYLOAD)
    assert excinfo.value.kind == "network"
    assert "connection reset" in excinfo.value.reason
    assert len(session.calls) == 3


def test_network_error_then_success(sleeper):
    client, _ = make_client([connection_error(), created()], sleeper)
    assert client.create_bot(PAYLOAD).bot_id == "bot-123"


def test_success_without_a_bot_id_is_a_failure(sleeper):
    client, _ = make_client([FakeResponse(201, {"status": "Active"})], sleeper)
    with pytest.raises(MeetStreamError) as excinfo:
        client.create_bot(PAYLOAD)
    assert excinfo.value.kind == "unexpected_response"


def test_non_json_success_body_is_a_failure(sleeper):
    client, _ = make_client([FakeResponse(201, None, text="<html>nope</html>")], sleeper)
    with pytest.raises(MeetStreamError) as excinfo:
        client.create_bot(PAYLOAD)
    assert excinfo.value.kind == "unexpected_response"


def test_capacity_error_is_retried_and_labelled(sleeper):
    client, session = make_client(
        [FakeResponse(507, {"message": "no capacity"}) for _ in range(2)], sleeper, max_retries=1
    )
    with pytest.raises(MeetStreamError) as excinfo:
        client.create_bot(PAYLOAD)
    assert excinfo.value.kind == "capacity"
    assert len(session.calls) == 2


def test_rate_limit_gate_waits_until_the_deadline():
    now = [0.0]
    slept = []

    def sleeper_fn(seconds):
        slept.append(seconds)
        now[0] += seconds

    gate = RateLimitGate(clock=lambda: now[0], sleeper=sleeper_fn)
    gate.hold(10.0)
    gate.wait()
    assert slept == [10.0]
    # Already past the deadline: no further waiting.
    gate.wait()
    assert slept == [10.0]


def test_rate_limit_gate_keeps_the_longest_hold():
    now = [0.0]
    gate = RateLimitGate(clock=lambda: now[0], sleeper=lambda seconds: now.__setitem__(0, now[0] + seconds))
    gate.hold(5.0)
    gate.hold(2.0)
    gate.wait()
    assert now[0] == 5.0
