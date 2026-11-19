import os
from pathlib import Path

import pytest

from chat_responder.config import DEFAULT_BASE_URL, ConfigError, load_config

MINIMAL = {"MEETSTREAM_API_KEY": "ms_test_key"}


def test_defaults_are_applied():
    config = load_config(env=MINIMAL)
    assert config.base_url == DEFAULT_BASE_URL
    assert config.agenda_path == Path("agenda.md")
    assert config.poll_interval_seconds == 5.0
    assert config.bot_id == ""


def test_api_key_is_required():
    with pytest.raises(ConfigError) as excinfo:
        load_config(env={})
    assert "MEETSTREAM_API_KEY" in str(excinfo.value)


def test_blank_api_key_is_rejected():
    with pytest.raises(ConfigError):
        load_config(env={"MEETSTREAM_API_KEY": "   "})


def test_bot_id_is_required_only_when_running():
    config = load_config(env=MINIMAL)
    with pytest.raises(ConfigError):
        config.require_bot_id()
    assert load_config(env={**MINIMAL, "MEETSTREAM_BOT_ID": "bot-7"}).require_bot_id() == "bot-7"


def test_trailing_slash_is_trimmed_from_base_url():
    config = load_config(env={**MINIMAL, "MEETSTREAM_BASE_URL": DEFAULT_BASE_URL + "/"})
    assert config.base_url == DEFAULT_BASE_URL


def test_non_numeric_value_is_rejected():
    with pytest.raises(ConfigError) as excinfo:
        load_config(env={**MINIMAL, "POLL_INTERVAL_SECONDS": "soon"})
    assert "POLL_INTERVAL_SECONDS" in str(excinfo.value)


@pytest.mark.parametrize(
    "name,value",
    [
        ("POLL_INTERVAL_SECONDS", "0.1"),
        ("POLL_INTERVAL_SECONDS", "9999"),
        ("MAX_REPLIES_PER_MINUTE", "0"),
        ("MAX_AGENDA_BYTES", "1"),
        ("REQUEST_TIMEOUT_SECONDS", "0"),
    ],
)
def test_out_of_range_values_are_rejected(name, value):
    with pytest.raises(ConfigError):
        load_config(env={**MINIMAL, name: value})


def test_reads_a_dotenv_file(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "MEETSTREAM_API_KEY=ms_from_file\nMEETSTREAM_BOT_ID=bot-42\nBOT_NAME=Agenda Bot\n",
        encoding="utf-8",
    )
    # Give load_dotenv a throwaway environment so the real one is untouched.
    sandbox = {
        name: value
        for name, value in os.environ.items()
        if name not in ("MEETSTREAM_API_KEY", "MEETSTREAM_BOT_ID", "BOT_NAME")
    }
    monkeypatch.setattr(os, "environ", sandbox)

    config = load_config(dotenv_path=env_file)
    assert config.api_key == "ms_from_file"
    assert config.bot_id == "bot-42"
    assert config.bot_name == "Agenda Bot"


def test_env_example_documents_every_setting():
    example = Path(__file__).resolve().parents[1] / ".env.example"
    names = {
        line.split("=", 1)[0]
        for line in example.read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#")
    }
    assert "MEETSTREAM_API_KEY" in names
    assert "POLL_INTERVAL_SECONDS" in names
    assert "AGENDA_PATH" in names
