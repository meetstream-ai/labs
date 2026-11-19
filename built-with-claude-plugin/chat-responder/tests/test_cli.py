import pytest

from chat_responder import cli
from chat_responder.client import MeetStreamError


@pytest.fixture
def env(monkeypatch, config):
    """Make cli.main() use the test Config instead of the real environment."""
    monkeypatch.setattr(cli, "load_config", lambda: config)
    return config


class RecordingClient:
    def __init__(self):
        self.created = None
        self.chats = []

    def create_bot(self, meeting_link, bot_name, bot_message=None):
        self.created = (meeting_link, bot_name, bot_message)
        return {"bot_id": "bot-new"}

    def get_chats(self, bot_id):
        return list(self.chats)

    def get_bot_detail(self, bot_id):
        return {}

    def send_message(self, bot_id, message):
        raise AssertionError("not expected in these tests")


def test_check_reports_a_readable_agenda(env, capsys):
    assert cli.main(["check"]) == 0
    out = capsys.readouterr().out
    assert "!help" in out and "!agenda" in out and "!time" in out
    assert env.api_key not in out  # the key itself is never printed


def test_check_fails_when_the_agenda_is_missing(env, monkeypatch, tmp_path, capsys):
    from dataclasses import replace

    monkeypatch.setattr(cli, "load_config", lambda: replace(env, agenda_path=tmp_path / "x.md"))
    assert cli.main(["check"]) == 1
    assert "UNAVAILABLE" in capsys.readouterr().out


def test_run_once_polls_and_exits(env, monkeypatch, capsys):
    client = RecordingClient()
    monkeypatch.setattr(cli, "_build_client", lambda config: client)
    assert cli.main(["run", "--once", "--bot-id", "bot-999"]) == 0
    assert "sent 0 replies" in capsys.readouterr().out


def test_run_without_a_bot_id_fails(monkeypatch, config, capsys):
    from dataclasses import replace

    monkeypatch.setattr(cli, "load_config", lambda: replace(config, bot_id=""))
    monkeypatch.setattr(cli, "_build_client", lambda config: RecordingClient())
    assert cli.main(["run"]) == 1


def test_join_requires_confirmation(env, monkeypatch, capsys):
    client = RecordingClient()
    monkeypatch.setattr(cli, "_build_client", lambda config: client)
    monkeypatch.setattr("builtins.input", lambda prompt="": "n")
    assert cli.main(["join", "https://meet.google.com/abc-defg-hij"]) == 1
    assert client.created is None


def test_join_creates_a_bot_when_confirmed(env, monkeypatch, capsys):
    client = RecordingClient()
    monkeypatch.setattr(cli, "_build_client", lambda config: client)
    assert cli.main(["join", "https://meet.google.com/abc-defg-hij", "--yes"]) == 0
    assert client.created == ("https://meet.google.com/abc-defg-hij", env.bot_name, None)
    assert "bot-new" in capsys.readouterr().out


def test_join_reports_api_errors(env, monkeypatch):
    class BrokenClient(RecordingClient):
        def create_bot(self, *args, **kwargs):
            raise MeetStreamError("401 unauthorized")

    monkeypatch.setattr(cli, "_build_client", lambda config: BrokenClient())
    assert cli.main(["join", "https://meet.google.com/abc", "--yes"]) == 1


def test_config_error_exits_with_two(monkeypatch, capsys):
    from chat_responder.config import ConfigError

    def boom():
        raise ConfigError("MEETSTREAM_API_KEY is not set")

    monkeypatch.setattr(cli, "load_config", boom)
    assert cli.main(["check"]) == 2
    assert "MEETSTREAM_API_KEY" in capsys.readouterr().err
