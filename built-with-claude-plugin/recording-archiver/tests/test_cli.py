from __future__ import annotations

from pathlib import Path

import pytest
import responses

from conftest import BASE_URL, BOT_ID, detail_payload
from recording_archiver import cli

AUDIO_URL = "https://s3.example.com/bot-123/audio.mp3?sig=1"


@pytest.fixture
def env_file(tmp_path: Path, clean_env: None) -> Path:
    path = tmp_path / ".env"
    path.write_text(
        f"MEETSTREAM_API_KEY=test-key\n"
        f"MEETSTREAM_BASE_URL={BASE_URL}\n"
        f"ARCHIVE_DIR={tmp_path / 'archive'}\n"
        f"ARCHIVE_POLL_INTERVAL_SECONDS=1\n"
    )
    return path


def test_missing_config_exits_with_a_message(tmp_path: Path, clean_env: None) -> None:
    empty = tmp_path / ".env"
    empty.write_text("")

    assert cli.main(["--env-file", str(empty)]) == 2


@responses.activate
def test_cli_archives_a_named_bot(env_file: Path, tmp_path: Path) -> None:
    responses.get(f"{BASE_URL}/bots/{BOT_ID}/detail", json=detail_payload())
    responses.get(f"{BASE_URL}/bots/{BOT_ID}/get_audio", json={"url": AUDIO_URL})
    responses.get(f"{BASE_URL}/bots/{BOT_ID}/get_video", status=404, json={})
    responses.get(f"{BASE_URL}/bots/{BOT_ID}/get_audio_streams", json={"participants": []})
    responses.get(AUDIO_URL, body=b"mixed-audio")

    exit_code = cli.main(["--env-file", str(env_file), "--bot-id", BOT_ID])

    assert exit_code == 0
    assert (tmp_path / "archive" / BOT_ID / "audio.mp3").read_bytes() == b"mixed-audio"
    # --bot-id means we never list the account's bots.
    assert all("/bots/" in call.request.url or "s3." in call.request.url
               for call in responses.calls)


@responses.activate
def test_cli_dry_run_writes_no_media(env_file: Path, tmp_path: Path) -> None:
    responses.get(f"{BASE_URL}/bots/{BOT_ID}/detail", json=detail_payload())
    responses.get(f"{BASE_URL}/bots/{BOT_ID}/get_audio", json={"url": AUDIO_URL})
    responses.get(f"{BASE_URL}/bots/{BOT_ID}/get_video", status=404, json={})
    responses.get(f"{BASE_URL}/bots/{BOT_ID}/get_audio_streams", json={"participants": []})

    exit_code = cli.main(
        ["--env-file", str(env_file), "--bot-id", BOT_ID, "--dry-run"]
    )

    assert exit_code == 0
    assert list((tmp_path / "archive").rglob("*.mp3")) == []


@responses.activate
def test_cli_reports_failure_with_a_nonzero_exit(env_file: Path) -> None:
    responses.get(f"{BASE_URL}/bots/{BOT_ID}/detail", status=500, body="boom")

    assert cli.main(["--env-file", str(env_file), "--bot-id", BOT_ID]) == 1


@responses.activate
def test_archive_dir_flag_overrides_the_env_file(env_file: Path, tmp_path: Path) -> None:
    responses.get(f"{BASE_URL}/bots/{BOT_ID}/detail", json=detail_payload())
    responses.get(f"{BASE_URL}/bots/{BOT_ID}/get_audio", json={"url": AUDIO_URL})
    responses.get(f"{BASE_URL}/bots/{BOT_ID}/get_video", status=404, json={})
    responses.get(f"{BASE_URL}/bots/{BOT_ID}/get_audio_streams", json={"participants": []})
    responses.get(AUDIO_URL, body=b"mixed-audio")
    override = tmp_path / "elsewhere"

    cli.main(["--env-file", str(env_file), "--bot-id", BOT_ID, "--archive-dir", str(override)])

    assert (override / BOT_ID / "audio.mp3").exists()


@responses.activate
def test_watch_mode_sweeps_repeatedly_then_stops(
    env_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    responses.get(f"{BASE_URL}/bots", json={"bots": [], "hasNextPage": False})
    sleeps: list[int] = []

    def fake_sleep(seconds: int) -> None:
        sleeps.append(seconds)
        if len(sleeps) == 2:
            raise KeyboardInterrupt

    monkeypatch.setattr(cli.time, "sleep", fake_sleep)

    exit_code = cli.main(["--env-file", str(env_file), "--watch", "--interval", "7"])

    assert exit_code == 0
    assert sleeps == [7, 7]
