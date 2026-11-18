from __future__ import annotations

import pytest
from conftest import MEET

from dispatcher.config import AUTOMATIC_LEAVE, Config, ConfigError, load_config


def write_env(tmp_path, body):
    env_file = tmp_path / ".env"
    env_file.write_text(body, encoding="utf-8")
    return str(env_file)


def test_load_config_reads_the_env_file(tmp_path):
    env_file = write_env(
        tmp_path,
        "MEETSTREAM_API_KEY=ms_test_key\n"
        "MEETSTREAM_BOT_NAME=Ops Notetaker\n"
        "MEETSTREAM_CONCURRENCY=8\n"
        "MEETSTREAM_RETENTION_HOURS=168\n",
    )
    config = load_config(env_file=env_file, environ={})
    assert config.api_key == "ms_test_key"
    assert config.bot_name == "Ops Notetaker"
    assert config.concurrency == 8
    assert config.retention_hours == 168


def test_environment_variables_win_over_the_env_file(tmp_path):
    env_file = write_env(tmp_path, "MEETSTREAM_API_KEY=from_file\n")
    config = load_config(env_file=env_file, environ={"MEETSTREAM_API_KEY": "from_env"})
    assert config.api_key == "from_env"


def test_missing_api_key_is_an_error(tmp_path):
    env_file = write_env(tmp_path, "MEETSTREAM_BOT_NAME=Nameless\n")
    with pytest.raises(ConfigError) as excinfo:
        load_config(env_file=env_file, environ={})
    assert "MEETSTREAM_API_KEY" in str(excinfo.value)


def test_api_key_is_optional_for_a_dry_run(tmp_path):
    env_file = write_env(tmp_path, "")
    config = load_config(env_file=env_file, environ={}, require_api_key=False)
    assert config.api_key == ""


def test_missing_env_file_is_tolerated_when_the_key_is_in_the_environment(tmp_path):
    config = load_config(
        env_file=str(tmp_path / "nope.env"), environ={"MEETSTREAM_API_KEY": "ms_key"}
    )
    assert config.api_key == "ms_key"


@pytest.mark.parametrize(
    "body",
    [
        "MEETSTREAM_API_KEY=k\nMEETSTREAM_TRANSCRIPT_PROVIDER=whisper\n",
        "MEETSTREAM_API_KEY=k\nMEETSTREAM_CALLBACK_URL=http://insecure.example.com/hook\n",
        "MEETSTREAM_API_KEY=k\nMEETSTREAM_CONCURRENCY=0\n",
        "MEETSTREAM_API_KEY=k\nMEETSTREAM_CONCURRENCY=lots\n",
        "MEETSTREAM_API_KEY=k\nMEETSTREAM_MAX_RETRIES=-1\n",
    ],
)
def test_invalid_settings_are_rejected(tmp_path, body):
    with pytest.raises(ConfigError):
        load_config(env_file=write_env(tmp_path, body), environ={})


def test_bot_payload_defaults_to_audio_only_with_leave_timeouts():
    payload = Config(api_key="k").bot_payload(MEET, "Notetaker")
    assert payload["meeting_link"] == MEET
    assert payload["bot_name"] == "Notetaker"
    assert payload["video_required"] is False
    assert payload["automatic_leave"] == AUTOMATIC_LEAVE
    assert "recording_config" not in payload
    assert "callback_url" not in payload


def test_bot_payload_includes_transcript_retention_and_callback():
    config = Config(
        api_key="k",
        callback_url="https://hooks.example.com/meetstream",
        transcript_provider="deepgram",
        transcript_language="en",
        retention_hours=48,
    )
    payload = config.bot_payload(MEET, "Notetaker")
    assert payload["callback_url"] == "https://hooks.example.com/meetstream"
    assert payload["recording_config"]["transcript"]["provider"] == {
        "deepgram": {"model": "nova-3", "language": "en"}
    }
    assert payload["recording_config"]["retention"] == {"type": "timed", "hours": 48}


def test_bot_payload_does_not_share_mutable_defaults():
    config = Config(api_key="k")
    first = config.bot_payload(MEET, "A")
    first["automatic_leave"]["waiting_room_timeout"] = 1
    second = config.bot_payload(MEET, "B")
    assert second["automatic_leave"] == AUTOMATIC_LEAVE
