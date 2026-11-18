from __future__ import annotations

import pytest

from talk_time.config import ConfigError, load_config


def write_env(tmp_path, body):
    path = tmp_path / ".env"
    path.write_text(body, encoding="utf-8")
    return path


def test_defaults_when_no_env_file(tmp_path):
    config = load_config(tmp_path / "missing.env", environ={})
    assert config.api_key is None
    assert config.base_url == "https://api.meetstream.ai/api/v1"
    assert config.bytes_per_second == 96000  # PCM16, 48 kHz, mono
    assert config.turn_gap_seconds == 1.0
    assert config.unattributed_labels == frozenset({"NoSpeaker", "Unknown"})


def test_reads_values_from_env_file(tmp_path):
    path = write_env(
        tmp_path,
        "MEETSTREAM_API_KEY=ms_test_key\n"
        "TALK_TIME_SAMPLE_RATE=16000\n"
        "TALK_TIME_CHANNELS=2\n"
        "TALK_TIME_TURN_GAP_SECONDS=2.5\n"
        "TALK_TIME_UNATTRIBUTED_LABELS=NoSpeaker, Silence \n"
        "TALK_TIME_OUTPUT=out/report.json\n",
    )
    config = load_config(path, environ={})
    assert config.api_key == "ms_test_key"
    assert config.bytes_per_second == 16000 * 2 * 2
    assert config.turn_gap_seconds == 2.5
    assert config.unattributed_labels == frozenset({"NoSpeaker", "Silence"})
    assert config.output_path == "out/report.json"


def test_process_environment_overrides_the_file(tmp_path):
    path = write_env(tmp_path, "TALK_TIME_SAMPLE_RATE=16000\nMEETSTREAM_API_KEY=from_file\n")
    config = load_config(path, environ={"TALK_TIME_SAMPLE_RATE": "48000", "MEETSTREAM_API_KEY": "from_shell"})
    assert config.sample_rate == 48000
    assert config.api_key == "from_shell"


def test_blank_api_key_is_none(tmp_path):
    path = write_env(tmp_path, "MEETSTREAM_API_KEY=   \n")
    assert load_config(path, environ={}).api_key is None


def test_base_url_trailing_slash_is_dropped(tmp_path):
    path = write_env(tmp_path, "MEETSTREAM_BASE_URL=https://api.meetstream.ai/api/v1/\n")
    assert load_config(path, environ={}).base_url == "https://api.meetstream.ai/api/v1"


@pytest.mark.parametrize(
    "body",
    [
        "TALK_TIME_SAMPLE_RATE=not-a-number\n",
        "TALK_TIME_SAMPLE_RATE=0\n",
        "TALK_TIME_CHANNELS=-1\n",
        "TALK_TIME_TURN_GAP_SECONDS=-0.5\n",
        "TALK_TIME_TURN_GAP_SECONDS=soon\n",
    ],
)
def test_unusable_settings_raise(tmp_path, body):
    path = write_env(tmp_path, body)
    with pytest.raises(ConfigError):
        load_config(path, environ={})
