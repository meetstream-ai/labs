"""Command line entry point: check config, send a bot in, watch the chat."""

import argparse
import logging
import sys
from typing import List, Optional

from .agenda import AgendaError, load_agenda
from .client import MeetStreamClient, MeetStreamError
from .commands import COMMANDS
from .config import Config, ConfigError, load_config
from .responder import ChatResponder

logger = logging.getLogger("chat_responder")


def _configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def _build_client(config: Config) -> MeetStreamClient:
    return MeetStreamClient(
        api_key=config.api_key,
        base_url=config.base_url,
        timeout=config.request_timeout_seconds,
    )


def _cmd_check(config: Config, args: argparse.Namespace) -> int:
    print("base url:      {}".format(config.base_url))
    print("api key:       set ({} chars)".format(len(config.api_key)))
    print("bot id:        {}".format(config.bot_id or "(not set)"))
    print("bot name:      {}".format(config.bot_name))
    print("poll interval: {}s".format(config.poll_interval_seconds))
    print("commands:      {}".format(", ".join(COMMANDS)))
    try:
        agenda = load_agenda(
            config.agenda_path, config.max_agenda_bytes, config.max_message_chars
        )
    except AgendaError as exc:
        print("agenda:        UNAVAILABLE - {}".format(exc))
        return 1
    print("agenda:        {} ({} chars)".format(config.agenda_path, len(agenda)))
    return 0


def _cmd_join(config: Config, args: argparse.Namespace) -> int:
    if not args.yes:
        answer = input(
            "Send a bot named {!r} into {}? [y/N] ".format(args.bot_name or config.bot_name, args.meeting_link)
        )
        if answer.strip().lower() not in ("y", "yes"):
            print("Cancelled.")
            return 1
    client = _build_client(config)
    try:
        created = client.create_bot(
            meeting_link=args.meeting_link,
            bot_name=args.bot_name or config.bot_name,
            bot_message=args.message,
        )
    except MeetStreamError as exc:
        logger.error("create_bot failed: %s", exc)
        return 1

    bot_id = (created or {}).get("bot_id") if isinstance(created, dict) else None
    print("bot_id: {}".format(bot_id or created))
    print("Put it in .env as MEETSTREAM_BOT_ID, then run: chat-responder run")
    return 0


def _cmd_run(config: Config, args: argparse.Namespace) -> int:
    try:
        bot_id = args.bot_id or config.require_bot_id()
    except ConfigError as exc:
        logger.error("%s", exc)
        return 1

    responder = ChatResponder(config, _build_client(config), bot_id=bot_id)
    if args.once:
        responder.prime()
        replies = responder.poll_once()
        print("sent {} repl{}".format(replies, "y" if replies == 1 else "ies"))
        return 0

    try:
        responder.run_forever()
    except KeyboardInterrupt:
        logger.info("stopped")
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="chat-responder",
        description="MeetStream bot that answers !help / !agenda / !time in the meeting chat.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("check", help="validate .env and the agenda file")

    join = subparsers.add_parser("join", help="send a bot into a meeting")
    join.add_argument("meeting_link")
    join.add_argument("--bot-name", default=None)
    join.add_argument("--message", default=None, help="message the bot posts on join")
    join.add_argument("--yes", action="store_true", help="skip the confirmation prompt")

    run = subparsers.add_parser("run", help="watch the chat and answer commands")
    run.add_argument("--bot-id", default=None)
    run.add_argument("--once", action="store_true", help="poll a single time and exit")

    return parser


_HANDLERS = {"check": _cmd_check, "join": _cmd_join, "run": _cmd_run}


def main(argv: Optional[List[str]] = None) -> int:
    args = _parser().parse_args(argv)
    try:
        config = load_config()
    except ConfigError as exc:
        print("Config error: {}".format(exc), file=sys.stderr)
        return 2
    _configure_logging(config.log_level)
    return _HANDLERS[args.command](config, args)


if __name__ == "__main__":
    sys.exit(main())
