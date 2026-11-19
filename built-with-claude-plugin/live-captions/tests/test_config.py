import pytest

from live_captions.config import DEFAULT_BASE_URL, ConfigError, load_settings


def test_defaults_when_env_is_empty():
    settings = load_settings(env={})

    assert settings.api_key is None
    assert settings.public_base_url is None
    assert settings.base_url == DEFAULT_BASE_URL
    assert settings.host == "127.0.0.1"
    assert settings.port == 8080
    assert settings.bot_name == "Live Captions"
    assert settings.retention_hours == 24
    assert settings.color is True


def test_webhook_urls_are_built_from_public_base_url(settings):
    assert settings.live_transcript_url == "https://tunnel.example.com/live-transcript"
    assert settings.callback_url == "https://tunnel.example.com/webhook"


def test_trailing_slash_is_stripped():
    settings = load_settings(env={"PUBLIC_BASE_URL": "https://tunnel.example.com/"})

    assert settings.live_transcript_url == "https://tunnel.example.com/live-transcript"


def test_http_public_base_url_is_rejected():
    with pytest.raises(ConfigError, match="https"):
        load_settings(env={"PUBLIC_BASE_URL": "http://localhost:8080"})


def test_missing_api_key_raises_with_guidance():
    with pytest.raises(ConfigError, match="MEETSTREAM_API_KEY"):
        load_settings(env={}).require_api_key()


def test_missing_public_base_url_raises():
    with pytest.raises(ConfigError, match="PUBLIC_BASE_URL"):
        load_settings(env={}).callback_url


def test_blank_values_fall_back_to_defaults():
    settings = load_settings(env={"MEETSTREAM_API_KEY": "   ", "BOT_NAME": ""})

    assert settings.api_key is None
    assert settings.bot_name == "Live Captions"


@pytest.mark.parametrize("value,expected", [("0", False), ("false", False), ("yes", True)])
def test_color_flag_parsing(value, expected):
    assert load_settings(env={"CAPTIONS_COLOR": value}).color is expected


def test_bad_boolean_is_rejected():
    with pytest.raises(ConfigError, match="CAPTIONS_COLOR"):
        load_settings(env={"CAPTIONS_COLOR": "maybe"})


@pytest.mark.parametrize("value", ["0", "70000", "not-a-port"])
def test_bad_port_is_rejected(value):
    with pytest.raises(ConfigError, match="CAPTIONS_PORT"):
        load_settings(env={"CAPTIONS_PORT": value})
