from __future__ import annotations

from pathlib import Path

import pytest

from recording_archiver.config import DEFAULT_BASE_URL, ConfigError, load_settings


def write_env(tmp_path: Path, body: str) -> Path:
    path = tmp_path / ".env"
    path.write_text(body)
    return path


def test_loads_from_env_file(tmp_path: Path, clean_env: None) -> None:
    env = write_env(
        tmp_path,
        "MEETSTREAM_API_KEY=ms_from_file\n"
        "ARCHIVE_DIR=./recordings\n"
        "ARCHIVE_INCLUDE_VIDEO=false\n"
        "ARCHIVE_POLL_INTERVAL_SECONDS=60\n",
    )
    settings = load_settings(env)

    assert settings.api_key == "ms_from_file"
    assert settings.base_url == DEFAULT_BASE_URL
    assert settings.archive_dir == Path("./recordings")
    assert settings.include_video is False
    assert settings.include_participant_audio is True
    assert settings.poll_interval_seconds == 60


def test_process_env_overrides_env_file(
    tmp_path: Path, clean_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = write_env(tmp_path, "MEETSTREAM_API_KEY=from_file\n")
    monkeypatch.setenv("MEETSTREAM_API_KEY", "from_shell")

    assert load_settings(env).api_key == "from_shell"


def test_missing_api_key_is_a_clear_error(tmp_path: Path, clean_env: None) -> None:
    env = write_env(tmp_path, "ARCHIVE_DIR=./recordings\n")

    with pytest.raises(ConfigError, match="MEETSTREAM_API_KEY"):
        load_settings(env)


def test_base_url_trailing_slash_is_trimmed(tmp_path: Path, clean_env: None) -> None:
    env = write_env(
        tmp_path,
        "MEETSTREAM_API_KEY=k\nMEETSTREAM_BASE_URL=https://api.example.com/api/v1/\n",
    )

    assert load_settings(env).base_url == "https://api.example.com/api/v1"


def test_non_http_base_url_is_rejected(tmp_path: Path, clean_env: None) -> None:
    env = write_env(tmp_path, "MEETSTREAM_API_KEY=k\nMEETSTREAM_BASE_URL=ftp://nope\n")

    with pytest.raises(ConfigError, match="http"):
        load_settings(env)


def test_bad_boolean_is_rejected(tmp_path: Path, clean_env: None) -> None:
    env = write_env(tmp_path, "MEETSTREAM_API_KEY=k\nARCHIVE_INCLUDE_VIDEO=sometimes\n")

    with pytest.raises(ConfigError, match="ARCHIVE_INCLUDE_VIDEO"):
        load_settings(env)


def test_non_positive_interval_is_rejected(tmp_path: Path, clean_env: None) -> None:
    env = write_env(tmp_path, "MEETSTREAM_API_KEY=k\nARCHIVE_POLL_INTERVAL_SECONDS=0\n")

    with pytest.raises(ConfigError, match="greater than zero"):
        load_settings(env)


def test_env_example_documents_every_setting() -> None:
    example = (Path(__file__).resolve().parents[1] / ".env.example").read_text()
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
        assert f"{name}=" in example
