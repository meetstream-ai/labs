from __future__ import annotations

import io
import json

import pytest
from conftest import (
    MEET,
    TEAMS,
    ZOOM,
    FakeResponse,
    FakeSession,
    RecordingSleeper,
    created,
    rate_limited,
)

from dispatcher import cli
from dispatcher.client import MeetStreamClient


@pytest.fixture
def workspace(tmp_path):
    """A links file and a .env, both inside the test's own tmp dir."""
    links_file = tmp_path / "links.txt"
    links_file.write_text(
        "\n".join(
            [
                "# Monday calls",
                MEET,
                "{0},Pricing Call".format(ZOOM),
                TEAMS,
                "https://example.com/not-a-meeting",
                "",
            ]
        ),
        encoding="utf-8",
    )
    env_file = tmp_path / ".env"
    env_file.write_text("MEETSTREAM_API_KEY=ms_test_key\n", encoding="utf-8")
    return {"links": str(links_file), "env": str(env_file)}


def invoke(argv, stdin=""):
    args = cli.build_parser().parse_args(argv)
    stdout, stderr = io.StringIO(), io.StringIO()
    code = cli.run(args, stdout, stderr, io.StringIO(stdin))
    return code, stdout.getvalue(), stderr.getvalue()


def fake_client_factory(responses, recorder):
    """Replaces MeetStreamClient with one backed by a queued fake session."""

    def factory(**kwargs):
        session = FakeSession(responses)
        recorder.append(session)
        sleeper = RecordingSleeper()
        return MeetStreamClient(
            session=session,
            sleeper=sleeper,
            clock=sleeper.clock,
            **kwargs
        )

    return factory


def test_dry_run_validates_without_an_api_key(workspace, tmp_path):
    empty_env = tmp_path / "empty.env"
    empty_env.write_text("", encoding="utf-8")

    code, out, err = invoke(
        [workspace["links"], "--dry-run", "--env-file", str(empty_env)]
    )

    assert code == cli.EXIT_INCOMPLETE  # the bad link is still reported
    assert "DRY RUN - no bots were created." in out
    assert "Summary: 3 dispatched, 0 failed, 1 skipped (of 4 links)" in out
    assert err == ""


def test_missing_api_key_without_dry_run_is_a_usage_error(workspace, tmp_path):
    empty_env = tmp_path / "empty.env"
    empty_env.write_text("", encoding="utf-8")

    code, out, err = invoke([workspace["links"], "--env-file", str(empty_env)])

    assert code == cli.EXIT_USAGE
    assert "MEETSTREAM_API_KEY" in err
    assert out == ""


def test_full_run_reports_dispatched_and_failed(workspace, monkeypatch):
    sessions = []
    responses = [
        created("bot-1"),
        FakeResponse(403, {"message": "Zoom app not approved for external meetings"}),
        created("bot-3"),
    ]
    monkeypatch.setattr(cli, "MeetStreamClient", fake_client_factory(responses, sessions))

    code, out, err = invoke(
        [workspace["links"], "--env-file", workspace["env"], "--concurrency", "1"]
    )

    assert code == cli.EXIT_INCOMPLETE
    assert "bot_id=bot-1" in out
    assert "Zoom app not approved" in out
    assert "not a recognised" in out
    assert "Summary: 2 dispatched, 1 failed, 1 skipped (of 4 links)" in out
    assert len(sessions[0].calls) == 3


def test_everything_dispatched_exits_zero(tmp_path, monkeypatch):
    links_file = tmp_path / "links.txt"
    links_file.write_text(MEET + "\n", encoding="utf-8")
    env_file = tmp_path / ".env"
    env_file.write_text("MEETSTREAM_API_KEY=ms_test_key\n", encoding="utf-8")
    monkeypatch.setattr(cli, "MeetStreamClient", fake_client_factory([created("bot-9")], []))

    code, out, _ = invoke([str(links_file), "--env-file", str(env_file)])

    assert code == cli.EXIT_OK
    assert "Summary: 1 dispatched, 0 failed, 0 skipped (of 1 links)" in out


def test_rate_limited_meeting_is_retried_then_reported_as_dispatched(tmp_path, monkeypatch):
    links_file = tmp_path / "links.txt"
    links_file.write_text(MEET + "\n", encoding="utf-8")
    env_file = tmp_path / ".env"
    env_file.write_text("MEETSTREAM_API_KEY=ms_test_key\n", encoding="utf-8")
    sessions = []
    monkeypatch.setattr(
        cli,
        "MeetStreamClient",
        fake_client_factory([rate_limited(retry_after=1), created("bot-late")], sessions),
    )

    code, out, _ = invoke([str(links_file), "--env-file", str(env_file)])

    assert code == cli.EXIT_OK
    assert "bot_id=bot-late after 2 attempts" in out
    assert len(sessions[0].calls) == 2


def test_json_output(workspace, monkeypatch):
    monkeypatch.setattr(
        cli, "MeetStreamClient", fake_client_factory([created("b1"), created("b2"), created("b3")], [])
    )

    code, out, _ = invoke([workspace["links"], "--env-file", workspace["env"], "--json"])

    payload = json.loads(out)
    assert code == cli.EXIT_INCOMPLETE
    assert payload["counts"] == {"dispatched": 3, "failed": 0, "skipped": 1}
    assert payload["results"][1]["bot_name"] == "Pricing Call"
    assert payload["results"][3]["status"] == "skipped"


def test_links_can_be_piped_on_stdin(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("MEETSTREAM_API_KEY=ms_test_key\n", encoding="utf-8")
    monkeypatch.setattr(cli, "MeetStreamClient", fake_client_factory([created("bot-pipe")], []))

    code, out, _ = invoke(["-", "--env-file", str(env_file)], stdin=MEET + "\n")

    assert code == cli.EXIT_OK
    assert "bot_id=bot-pipe" in out


def test_bot_name_override_wins_over_the_env_file(workspace, monkeypatch):
    sessions = []
    monkeypatch.setattr(
        cli,
        "MeetStreamClient",
        fake_client_factory([created("b1"), created("b2"), created("b3")], sessions),
    )

    invoke(
        [
            workspace["links"],
            "--env-file",
            workspace["env"],
            "--bot-name",
            "Deal Desk",
            "--concurrency",
            "1",
        ]
    )

    names = [call["json"]["bot_name"] for call in sessions[0].calls]
    # The per-line name still wins for the meeting that set one.
    assert names == ["Deal Desk", "Pricing Call", "Deal Desk"]


def test_missing_links_file_is_a_usage_error(tmp_path, workspace):
    code, out, err = invoke(
        [str(tmp_path / "nope.txt"), "--dry-run", "--env-file", workspace["env"]]
    )
    assert code == cli.EXIT_USAGE
    assert "cannot read" in err


def test_empty_links_file_is_a_usage_error(tmp_path, workspace):
    empty = tmp_path / "empty.txt"
    empty.write_text("# nothing here\n", encoding="utf-8")

    code, out, err = invoke([str(empty), "--dry-run", "--env-file", workspace["env"]])

    assert code == cli.EXIT_USAGE
    assert "no meeting links" in err


@pytest.mark.parametrize(
    "extra,expected",
    [
        (["--concurrency", "0"], "--concurrency"),
        (["--max-retries", "-1"], "--max-retries"),
        (["--callback-url", "http://insecure.example.com/hook"], "--callback-url"),
    ],
)
def test_invalid_options_are_usage_errors(workspace, extra, expected):
    code, _, err = invoke([workspace["links"], "--dry-run", "--env-file", workspace["env"]] + extra)
    assert code == cli.EXIT_USAGE
    assert expected in err
