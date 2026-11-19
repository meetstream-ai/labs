from __future__ import annotations

import threading

import pytest
from conftest import MEET, TEAMS, ZOOM

from dispatcher.client import CreatedBot, MeetStreamError
from dispatcher.config import Config
from dispatcher.dispatch import DISPATCHED, FAILED, SKIPPED, dispatch
from dispatcher.links import parse_links
from dispatcher.report import render_json, render_text

CONFIG = Config(api_key="ms_test_key", bot_name="Notetaker", concurrency=3)


class FakeClient:
    """Returns a bot id per meeting link, or raises what the test queued up."""

    def __init__(self, outcomes=None, default_bot_id="bot-default"):
        self.outcomes = outcomes or {}
        self.default_bot_id = default_bot_id
        self.payloads = []
        self.max_in_flight = 0
        self._in_flight = 0
        self._lock = threading.Lock()

    def create_bot(self, payload):
        with self._lock:
            self.payloads.append(payload)
            self._in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self._in_flight)
        try:
            outcome = self.outcomes.get(payload["meeting_link"])
            if isinstance(outcome, Exception):
                raise outcome
            if isinstance(outcome, CreatedBot):
                return outcome
            return CreatedBot(bot_id=self.default_bot_id, status="Active", attempts=1)
        finally:
            with self._lock:
                self._in_flight -= 1


def test_dispatch_sends_one_bot_per_link():
    links, rejected = parse_links([MEET, ZOOM, TEAMS])
    client = FakeClient(
        outcomes={
            MEET: CreatedBot("bot-meet", "Active", 1),
            ZOOM: CreatedBot("bot-zoom", "Active", 2),
            TEAMS: CreatedBot("bot-teams", "Active", 1),
        }
    )

    report = dispatch(links, rejected, CONFIG, client=client)

    assert report.counts == {DISPATCHED: 3, FAILED: 0, SKIPPED: 0}
    assert [r.bot_id for r in report.results] == ["bot-meet", "bot-zoom", "bot-teams"]
    assert report.exit_code == 0
    assert len(client.payloads) == 3


def test_dispatch_uses_the_configured_bot_names():
    links, rejected = parse_links(["{0},Board Call".format(MEET), ZOOM])
    client = FakeClient()

    report = dispatch(links, rejected, CONFIG, client=client)

    names = {payload["meeting_link"]: payload["bot_name"] for payload in client.payloads}
    assert names == {MEET: "Board Call", ZOOM: "Notetaker"}
    assert [r.bot_name for r in report.results] == ["Board Call", "Notetaker"]


def test_dispatch_records_failures_with_their_reason():
    links, rejected = parse_links([MEET, ZOOM])
    client = FakeClient(
        outcomes={
            ZOOM: MeetStreamError(
                "rate limited - retries exhausted", kind="rate_limited", status_code=429, attempts=5
            )
        }
    )

    report = dispatch(links, rejected, CONFIG, client=client)

    assert report.counts == {DISPATCHED: 1, FAILED: 1, SKIPPED: 0}
    failure = report.of_status(FAILED)[0]
    assert failure.url == ZOOM
    assert failure.kind == "rate_limited"
    assert failure.attempts == 5
    assert "rate limited" in failure.reason
    assert report.exit_code == 1


def test_bad_links_are_skipped_without_an_api_call():
    links, rejected = parse_links([MEET, "https://example.com/nope", MEET])
    client = FakeClient()

    report = dispatch(links, rejected, CONFIG, client=client)

    assert report.counts == {DISPATCHED: 1, FAILED: 0, SKIPPED: 2}
    assert len(client.payloads) == 1
    assert [r.line_number for r in report.results] == [1, 2, 3]
    assert [r.status for r in report.results] == [DISPATCHED, SKIPPED, SKIPPED]
    assert all(r.kind == "invalid_link" for r in report.of_status(SKIPPED))


def test_results_stay_in_input_order_under_concurrency():
    urls = ["https://zoom.us/j/10000000{0}".format(i) for i in range(9)]
    links, rejected = parse_links(urls)
    client = FakeClient()

    report = dispatch(links, rejected, CONFIG, client=client)

    assert [r.url for r in report.results] == urls
    assert client.max_in_flight <= CONFIG.concurrency


def test_dry_run_makes_no_api_calls():
    links, rejected = parse_links([MEET, "not-a-url"])
    client = FakeClient()

    report = dispatch(links, rejected, CONFIG, client=client, dry_run=True)

    assert client.payloads == []
    assert report.dry_run is True
    assert report.counts == {DISPATCHED: 1, FAILED: 0, SKIPPED: 1}
    assert report.of_status(DISPATCHED)[0].bot_id is None


def test_dispatch_without_a_client_is_a_programming_error():
    links, rejected = parse_links([MEET])
    with pytest.raises(ValueError):
        dispatch(links, rejected, CONFIG, client=None)


def test_text_summary_shows_every_outcome():
    links, rejected = parse_links([MEET, ZOOM, "https://example.com/nope"])
    client = FakeClient(
        outcomes={
            MEET: CreatedBot("bot-meet", "Active", 1),
            ZOOM: MeetStreamError("rate limited - retries exhausted", "rate_limited", 429, 5),
        }
    )
    report = dispatch(links, rejected, CONFIG, client=client)

    text = render_text(report)

    assert "bot_id=bot-meet" in text
    assert "rate limited - retries exhausted" in text
    assert "after 5 attempts" in text
    assert "not a recognised" in text
    assert "Summary: 1 dispatched, 1 failed, 1 skipped (of 3 links)" in text


def test_json_summary_is_machine_readable():
    import json

    links, rejected = parse_links([MEET])
    report = dispatch(links, rejected, CONFIG, client=FakeClient(default_bot_id="bot-1"))

    payload = json.loads(render_json(report))

    assert payload["counts"] == {"dispatched": 1, "failed": 0, "skipped": 0}
    assert payload["results"][0]["bot_id"] == "bot-1"
    assert payload["results"][0]["platform"] == "google_meet"
