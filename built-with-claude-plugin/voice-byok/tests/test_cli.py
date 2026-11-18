import json

from conftest import BASE_ENV, FakeResponse, FakeSession, ExplodingSession

from voice_agent import cli
from voice_agent.config import Settings

MEETING_LINK = "https://meet.google.com/abc-defg-hij"


def test_dry_run_sends_nothing(settings, capsys):
    result = cli.run(settings, MEETING_LINK, dry_run=True, session=ExplodingSession())

    assert result["dry_run"] is True
    out = capsys.readouterr().out
    assert "/mia" in out
    assert "/bots/create_bot" in out
    assert "Dry run" in out


def test_dry_run_prints_valid_json_payloads(settings, capsys):
    cli.run(settings, MEETING_LINK, dry_run=True, session=ExplodingSession())
    out = capsys.readouterr().out
    first_block = out[out.index("{") : out.index("POST", out.index("{"))].strip()
    assert json.loads(first_block)["mode"] == "pipeline"


def test_run_creates_the_agent_then_the_bot(settings):
    session = FakeSession(
        [
            FakeResponse(200, {"agent_config_id": "agent-123"}),
            FakeResponse(201, {"bot_id": "bot-9", "status": "Active"}),
        ]
    )

    result = cli.run(settings, MEETING_LINK, session=session)

    assert result["agent_config_id"] == "agent-123"
    assert result["bot"]["bot_id"] == "bot-9"
    assert [call["url"].rsplit("/api/v1", 1)[1] for call in session.calls] == [
        "/mia",
        "/bots/create_bot",
    ]


def test_bot_carries_the_agent_config_id_from_the_first_call(settings):
    session = FakeSession(
        [
            FakeResponse(200, {"agent_config_id": "agent-123"}),
            FakeResponse(201, {"bot_id": "bot-9", "status": "Active"}),
        ]
    )

    cli.run(settings, MEETING_LINK, session=session)

    bot_payload = session.calls[1]["json"]
    assert bot_payload["agent_config_id"] == "agent-123"
    assert bot_payload["meeting_link"] == MEETING_LINK
    assert bot_payload["bot_name"] == "Meeting Assistant"


def test_main_dry_run_exits_zero(env, capsys):
    assert cli.main(["--dry-run"], env=env) == 0
    assert "Dry run" in capsys.readouterr().out


def test_main_meeting_link_argument_wins_over_env(env, capsys):
    override = "https://meet.google.com/zzz-zzzz-zzz"
    cli.main(["--dry-run", "--meeting-link", override], env=env)
    assert override in capsys.readouterr().out


def test_main_without_a_meeting_link_fails_cleanly(env, capsys):
    env.pop("MEETING_LINK")
    assert cli.main(["--dry-run"], env=env) == 2
    assert "No meeting link" in capsys.readouterr().err


def test_main_with_bad_config_fails_cleanly(env, capsys):
    env.pop("OPENAI_API_KEY")
    assert cli.main(["--dry-run"], env=env) == 2
    assert "OPENAI_API_KEY" in capsys.readouterr().err


def test_main_reports_api_errors_and_exits_one(env, monkeypatch, capsys):
    from voice_agent.client import MeetStreamError

    def boom(*args, **kwargs):
        raise MeetStreamError("POST", "/mia", 401, "unauthorized")

    monkeypatch.setattr(cli.MeetStreamClient, "create_agent_config", boom)
    assert cli.main([], env=env) == 1
    assert "MeetStream API error" in capsys.readouterr().err


def test_main_remove_calls_remove_bot(env, monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(
        cli.MeetStreamClient,
        "remove_bot",
        lambda self, bot_id: calls.append(bot_id) or {"message": "removed"},
    )
    assert cli.main(["--remove", "bot-9"], env=env) == 0
    assert calls == ["bot-9"]


def test_main_status_calls_get_bot_status(env, monkeypatch, capsys):
    monkeypatch.setattr(
        cli.MeetStreamClient, "get_bot_status", lambda self, bot_id: {"status": "Recording"}
    )
    assert cli.main(["--status", "bot-9"], env=env) == 0
    assert "Recording" in capsys.readouterr().out


def test_load_env_prefers_the_exported_environment(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("MEETSTREAM_API_KEY=from_file\nBOT_NAME=From File\n")
    monkeypatch.setenv("MEETSTREAM_API_KEY", "from_shell")

    values = cli.load_env(str(env_file))

    assert values["MEETSTREAM_API_KEY"] == "from_shell"
    assert values["BOT_NAME"] == "From File"


def test_load_env_without_a_file_still_works(tmp_path):
    values = cli.load_env(str(tmp_path / "missing.env"))
    assert isinstance(values, dict)


def test_settings_from_a_dotenv_file_build_a_full_agent(tmp_path, monkeypatch):
    monkeypatch.setattr(cli.os, "environ", {})
    lines = ["{}={}".format(key, value) for key, value in BASE_ENV.items()]
    env_file = tmp_path / ".env"
    env_file.write_text("\n".join(lines) + "\n")

    settings = Settings.from_env(cli.load_env(str(env_file)))

    assert settings.elevenlabs_voice_id == BASE_ENV["ELEVENLABS_VOICE_ID"]
    assert settings.bot_name == "Meeting Assistant"
