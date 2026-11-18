"""Shared test doubles. No test in this suite touches the network."""

from __future__ import annotations

import json as jsonlib
import os
import threading

import pytest
import requests

MEET = "https://meet.google.com/abc-defg-hij"
ZOOM = "https://us02web.zoom.us/j/81234567890?pwd=abc123"
TEAMS = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0"


@pytest.fixture(autouse=True)
def clean_environment(monkeypatch):
    """Keep a developer's own MEETSTREAM_* variables out of the tests."""
    for key in list(os.environ):
        if key.startswith("MEETSTREAM_"):
            monkeypatch.delenv(key, raising=False)


class FakeResponse:
    def __init__(self, status_code, body=None, headers=None, text=None):
        self.status_code = status_code
        self._body = body
        self.headers = headers or {}
        self.text = text if text is not None else (jsonlib.dumps(body) if body else "")

    def json(self):
        if self._body is None:
            raise ValueError("no JSON body")
        return self._body


class FakeSession:
    """Returns queued responses (or raises queued exceptions) in order."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []
        self._lock = threading.Lock()

    def post(self, url, json=None, headers=None, timeout=None):
        with self._lock:
            self.calls.append(
                {"url": url, "json": json, "headers": headers, "timeout": timeout}
            )
            if not self._responses:
                raise AssertionError("FakeSession ran out of responses")
            nxt = self._responses.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt


class RecordingSleeper:
    """Stands in for time.sleep: records each wait and advances a virtual clock.

    The virtual clock is what the client's rate-limit gate reads, so waiting is
    instant in tests but still ordered correctly.
    """

    def __init__(self, start=1000.0):
        self.waits = []
        self.now = start
        self.on_sleep = None

    def __call__(self, seconds):
        self.waits.append(seconds)
        if self.on_sleep is not None:
            self.on_sleep()
        self.now += seconds

    def clock(self):
        return self.now


@pytest.fixture
def sleeper():
    return RecordingSleeper()


def rate_limited(retry_after=None, message="Too many requests"):
    headers = {"Retry-After": str(retry_after)} if retry_after is not None else {}
    return FakeResponse(429, {"message": message}, headers=headers)


def created(bot_id="bot-123"):
    return FakeResponse(201, {"bot_id": bot_id, "status": "Active", "transcript_id": None})


def connection_error(message="connection reset"):
    return requests.ConnectionError(message)
