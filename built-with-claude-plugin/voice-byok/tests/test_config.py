import pytest

from voice_agent.config import DEFAULT_BASE_URL, DEFAULT_WAKE_WORDS, ConfigError, Settings


def test_loads_every_field(settings):
    assert settings.meetstream_api_key == "ms_test_key"
    assert settings.base_url == DEFAULT_BASE_URL
    assert settings.meeting_link == "https://meet.google.com/abc-defg-hij"
    assert settings.openai_model == "gpt-4.1"
    assert settings.deepgram_model == "nova-3"
    assert settings.elevenlabs_voice_id == "21m00Tcm4TlvDq8ikWAM"
    assert settings.llm_temperature == 0.7


def test_missing_required_vars_are_all_reported():
    with pytest.raises(ConfigError) as exc:
        Settings.from_env({"MEETSTREAM_API_KEY": "ms_test_key"})
    message = str(exc.value)
    assert "OPENAI_API_KEY" in message
    assert "DEEPGRAM_API_KEY" in message
    assert "ELEVENLABS_API_KEY" in message
    assert "MEETSTREAM_API_KEY" not in message


def test_blank_value_counts_as_missing(env):
    env["DEEPGRAM_API_KEY"] = "   "
    with pytest.raises(ConfigError, match="DEEPGRAM_API_KEY"):
        Settings.from_env(env)


def test_comma_lists_are_split_and_stripped(settings):
    assert settings.boostwords == ["MeetStream", "MIA", "Deepgram"]
    assert settings.wake_words == ["hey assistant", "ok assistant"]


def test_defaults_apply_when_optional_vars_absent():
    minimal = {
        "MEETSTREAM_API_KEY": "k",
        "OPENAI_API_KEY": "k",
        "DEEPGRAM_API_KEY": "k",
        "ELEVENLABS_API_KEY": "k",
        "ELEVENLABS_VOICE_ID": "v",
    }
    settings = Settings.from_env(minimal)
    assert settings.base_url == DEFAULT_BASE_URL
    assert settings.meeting_link is None
    assert settings.bot_name == "Meeting Assistant"
    assert settings.boostwords == []
    assert settings.wake_word_enabled is True
    assert settings.wake_words == list(DEFAULT_WAKE_WORDS)
    assert settings.enable_interruptions is True


@pytest.mark.parametrize(
    "raw,expected",
    [("true", True), ("TRUE", True), ("1", True), ("yes", True), ("false", False), ("no", False)],
)
def test_bool_parsing(env, raw, expected):
    env["ENABLE_INTERRUPTIONS"] = raw
    assert Settings.from_env(env).enable_interruptions is expected


def test_base_url_trailing_slash_is_stripped(env):
    env["MEETSTREAM_BASE_URL"] = "https://api.meetstream.ai/api/v1/"
    assert Settings.from_env(env).base_url == "https://api.meetstream.ai/api/v1"


def test_voice_id_is_required(env):
    env["ELEVENLABS_VOICE_ID"] = ""
    with pytest.raises(ConfigError, match="ELEVENLABS_VOICE_ID"):
        Settings.from_env(env)


def test_wake_word_enabled_without_words_is_rejected(env):
    env["WAKE_WORDS"] = ""
    with pytest.raises(ConfigError, match="WAKE_WORDS"):
        Settings.from_env(env)


def test_wake_word_disabled_allows_empty_words(env):
    env["WAKE_WORD_ENABLED"] = "false"
    env["WAKE_WORDS"] = ""
    settings = Settings.from_env(env)
    assert settings.wake_word_enabled is False
    assert settings.wake_words == []


def test_non_numeric_temperature_is_rejected(env):
    env["LLM_TEMPERATURE"] = "warm"
    with pytest.raises(ConfigError, match="LLM_TEMPERATURE"):
        Settings.from_env(env)


def test_non_integer_timeout_is_rejected(env):
    env["WAKE_WORD_TIMEOUT"] = "30s"
    with pytest.raises(ConfigError, match="WAKE_WORD_TIMEOUT"):
        Settings.from_env(env)
