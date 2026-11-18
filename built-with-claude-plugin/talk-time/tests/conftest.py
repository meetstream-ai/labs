from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    """Keep the developer's own MeetStream settings out of the tests."""
    for key in list(os.environ):
        if key.startswith(("MEETSTREAM_", "TALK_TIME_")):
            monkeypatch.delenv(key, raising=False)


@pytest.fixture
def fixtures() -> Path:
    return FIXTURES


@pytest.fixture
def write_timeline(tmp_path):
    """Write a timeline document to a temp file and return its path."""

    def _write(document, name="timeline.json") -> Path:
        path = tmp_path / name
        path.write_text(json.dumps(document), encoding="utf-8")
        return path

    return _write
