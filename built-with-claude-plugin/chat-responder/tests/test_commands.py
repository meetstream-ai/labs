from dataclasses import replace

import pytest

from chat_responder.commands import (
    AGENDA_UNAVAILABLE,
    COMMANDS,
    UNKNOWN_START,
    CommandContext,
    find_command,
    format_duration,
    handle_agenda,
    handle_help,
    handle_time,
)


@pytest.mark.parametrize(
    "text,expected",
    [
        ("!help", "!help"),
        ("!HELP", "!help"),
        ("hey bot, !agenda please", "!agenda"),
        ("(!time)", "!time"),
        ("!help.", "!help"),
        ("what's the !agenda?", "!agenda"),
        ("line one\n!time", "!time"),
    ],
)
def test_finds_command_anywhere_in_the_message(text, expected):
    command = find_command(text)
    assert command is not None and command.keyword == expected


@pytest.mark.parametrize(
    "text",
    [
        "",
        "just chatting",
        "help",
        "email me at a!help.com",
        "!!help",
        "!helpme",
        "!unknown",
    ],
)
def test_non_commands_are_ignored(text):
    assert find_command(text) is None


def test_only_the_first_command_wins():
    command = find_command("!time then !agenda then !help")
    assert command is not None and command.keyword == "!time"


def test_help_lists_every_command(config):
    ctx = CommandContext(config=config, now=0.0, meeting_started_at=None)
    reply = handle_help(ctx)
    for keyword in COMMANDS:
        assert keyword in reply


def test_agenda_returns_file_contents(config):
    ctx = CommandContext(config=config, now=0.0, meeting_started_at=None)
    reply = handle_agenda(ctx)
    assert "1. Intros" in reply
    assert "2. Demo" in reply


def test_agenda_missing_file_is_a_friendly_message(config, tmp_path):
    missing = replace(config, agenda_path=tmp_path / "nope.md")
    ctx = CommandContext(config=missing, now=0.0, meeting_started_at=None)
    assert handle_agenda(ctx) == AGENDA_UNAVAILABLE


def test_time_without_a_known_start(config):
    ctx = CommandContext(config=config, now=100.0, meeting_started_at=None)
    assert handle_time(ctx) == UNKNOWN_START


def test_time_reports_elapsed(config):
    ctx = CommandContext(config=config, now=1000.0, meeting_started_at=1000.0 - 3725)
    assert "1h 2m 5s" in handle_time(ctx)


@pytest.mark.parametrize(
    "seconds,expected",
    [(0, "0s"), (9.7, "9s"), (65, "1m 5s"), (3600, "1h 0m 0s"), (-5, "0s")],
)
def test_format_duration(seconds, expected):
    assert format_duration(seconds) == expected
