import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from chat_responder.config import Config  # noqa: E402


@pytest.fixture
def agenda_file(tmp_path) -> Path:
    path = tmp_path / "agenda.md"
    path.write_text("# Agenda\n\n1. Intros\n2. Demo\n", encoding="utf-8")
    return path


@pytest.fixture
def config(agenda_file) -> Config:
    return Config(
        api_key="ms_test_key",
        base_url="https://api.meetstream.ai/api/v1",
        bot_id="bot-123",
        bot_name="Meeting Assistant",
        agenda_path=agenda_file,
        poll_interval_seconds=5.0,
        sender_cooldown_seconds=5.0,
        max_replies_per_minute=12,
        max_message_chars=2000,
        max_agenda_bytes=8192,
        request_timeout_seconds=10.0,
        log_level="INFO",
    )


class FakeResponse:
    def __init__(self, status_code: int = 200, payload: Any = None, text: str = ""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self) -> Any:
        if self._payload is None:
            raise ValueError("no json body")
        return self._payload


class FakeSession:
    """Stands in for requests.Session - records calls, returns queued responses."""

    def __init__(self, responses: Optional[Dict[str, Any]] = None):
        self.responses = responses or {}
        self.calls: List[Dict[str, Any]] = []

    def request(self, method, url, headers=None, json=None, timeout=None):
        self.calls.append(
            {
                "method": method,
                "url": url,
                "headers": headers,
                "json": json,
                "timeout": timeout,
            }
        )
        for suffix, response in self.responses.items():
            if url.endswith(suffix):
                if callable(response):
                    return response(self.calls[-1])
                return response
        return FakeResponse(200, {})
