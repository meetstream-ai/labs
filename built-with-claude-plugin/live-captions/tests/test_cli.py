import pytest

from live_captions import cli
from live_captions.captions import UNKNOWN_SPEAKER
from live_captions.demo import run_demo


def test_demo_renders_the_sample_meeting(printer, output):
    run_demo(printer, delay=0)

    printed = output.getvalue()
    assert "Priya: Okay, so where are we on the live captions app?" in printed
    assert "Sam: The bot joins and streams chunks straight to a local server." in printed
    assert "%s: (background noise)" % UNKNOWN_SPEAKER in printed
    # Interim fragments never settle into the scrollback.
    assert "Okay, so where are we on\n" not in printed


def test_demo_command_runs_without_api_credentials(monkeypatch, capsys):
    monkeypatch.setattr(cli, "load_settings", lambda: cli.Settings())

    assert cli.main(["demo", "--delay", "0"]) == 0
    assert "Priya:" in capsys.readouterr().out


def test_join_requires_an_api_key(monkeypatch, capsys):
    monkeypatch.setattr(
        cli, "load_settings", lambda: cli.Settings(public_base_url="https://tunnel.example.com")
    )

    assert cli.main(["join", "https://meet.google.com/abc", "--yes"]) == 2
    assert "MEETSTREAM_API_KEY" in capsys.readouterr().err


def test_join_requires_a_public_url(monkeypatch, capsys):
    monkeypatch.setattr(cli, "load_settings", lambda: cli.Settings(api_key="ms_test_key"))

    assert cli.main(["join", "https://meet.google.com/abc", "--yes"]) == 2
    assert "PUBLIC_BASE_URL" in capsys.readouterr().err


def test_join_aborts_when_the_prompt_is_declined(monkeypatch, capsys, settings):
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr("builtins.input", lambda *_: "n")

    def fail(*_args, **_kwargs):  # pragma: no cover - must not run
        raise AssertionError("create_bot must not be called after declining")

    monkeypatch.setattr(cli.MeetStreamClient, "create_bot", fail)

    assert cli.main(["join", "https://meet.google.com/abc"]) == 1
    assert "Cancelled" in capsys.readouterr().out


def test_join_creates_the_bot_when_confirmed(monkeypatch, capsys, settings):
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(
        cli.MeetStreamClient,
        "create_bot",
        lambda self, link: {"bot_id": "bot-123", "status": "Active"},
    )

    assert cli.main(["join", "https://meet.google.com/abc", "--yes"]) == 0
    assert "bot-123" in capsys.readouterr().out


def test_leave_removes_the_bot(monkeypatch, capsys, settings):
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(
        cli.MeetStreamClient, "remove_bot", lambda self, bot_id: {"message": "Bot removed"}
    )

    assert cli.main(["leave", "bot-123"]) == 0
    assert "Bot removed" in capsys.readouterr().out


def test_a_command_is_required():
    with pytest.raises(SystemExit):
        cli.main([])
