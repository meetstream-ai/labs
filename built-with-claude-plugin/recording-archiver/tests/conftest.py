from __future__ import annotations

from pathlib import Path

import pytest

from recording_archiver.config import Settings

BASE_URL = "https://api.test.invalid/api/v1"
MEDIA_HOST = "https://media.test.invalid"
BOT_ID = "bot-123"


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        api_key="test-key",
        base_url=BASE_URL,
        archive_dir=tmp_path / "archive",
        include_video=True,
        include_participant_audio=True,
        poll_interval_seconds=1,
        request_timeout_seconds=5,
        max_list_pages=5,
    )


@pytest.fixture
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "MEETSTREAM_API_KEY",
        "MEETSTREAM_BASE_URL",
        "ARCHIVE_DIR",
        "ARCHIVE_INCLUDE_VIDEO",
        "ARCHIVE_INCLUDE_PARTICIPANT_AUDIO",
        "ARCHIVE_POLL_INTERVAL_SECONDS",
        "ARCHIVE_REQUEST_TIMEOUT_SECONDS",
        "ARCHIVE_MAX_LIST_PAGES",
    ):
        monkeypatch.delenv(name, raising=False)


def detail_payload(
    status: str = "Done",
    audio_status: str = "Success",
    bot_id: str = BOT_ID,
) -> dict:
    return {
        "bot_details": {
            "BotID": bot_id,
            "BotUsername": "Archiver",
            "MeetingLink": "https://meet.google.com/abc-defg-hij",
            "Platform": "google_meet",
            "Status": status,
            "AudioStatus": audio_status,
            "TranscriptStatus": "Success",
            "StartTime": "2026-11-18T10:00:00Z",
            "EndTime": "2026-11-18T10:30:00Z",
            "Duration": 1800,
        }
    }
