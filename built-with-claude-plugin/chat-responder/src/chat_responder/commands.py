"""The chat commands and how a message is matched to one."""

import logging
import re
from dataclasses import dataclass
from typing import Callable, Dict, Optional

from .agenda import AgendaError, load_agenda
from .config import Config

logger = logging.getLogger(__name__)

# A command token is a bare "!word" - not glued to other text ("foo!help") and
# not part of a run of bangs ("!!help"). Trailing punctuation is fine.
_TOKEN = re.compile(r"(?<![\w!])(![a-z]+)")

AGENDA_UNAVAILABLE = "I couldn't read the agenda file. Ask the organiser to check it."
UNKNOWN_START = "I don't know when the meeting started yet - ask me again shortly."


@dataclass(frozen=True)
class CommandContext:
    config: Config
    now: float
    meeting_started_at: Optional[float]


@dataclass(frozen=True)
class Command:
    keyword: str
    description: str
    handler: Callable[["CommandContext"], str]


def format_duration(seconds: float) -> str:
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return "{}h {}m {}s".format(hours, minutes, secs)
    if minutes:
        return "{}m {}s".format(minutes, secs)
    return "{}s".format(secs)


def handle_help(ctx: CommandContext) -> str:
    lines = ["Commands you can type in this chat:"]
    lines.extend(
        "  {} - {}".format(command.keyword, command.description)
        for command in COMMANDS.values()
    )
    return "\n".join(lines)


def handle_agenda(ctx: CommandContext) -> str:
    try:
        return load_agenda(
            ctx.config.agenda_path,
            ctx.config.max_agenda_bytes,
            ctx.config.max_message_chars,
        )
    except AgendaError as exc:
        logger.error("agenda unavailable: %s", exc)
        return AGENDA_UNAVAILABLE


def handle_time(ctx: CommandContext) -> str:
    if ctx.meeting_started_at is None:
        return UNKNOWN_START
    return "This meeting has been running for {}.".format(
        format_duration(ctx.now - ctx.meeting_started_at)
    )


COMMANDS: Dict[str, Command] = {
    "!help": Command("!help", "list these commands", handle_help),
    "!agenda": Command("!agenda", "post the agenda", handle_agenda),
    "!time": Command("!time", "how long the meeting has been running", handle_time),
}


def find_command(text: str) -> Optional[Command]:
    """Return the first command mentioned in `text`, if any.

    One message triggers at most one reply, so "!help !agenda !time" does not
    turn into three chat posts.
    """
    for match in _TOKEN.finditer(text.lower()):
        command = COMMANDS.get(match.group(1))
        if command is not None:
            return command
    return None
