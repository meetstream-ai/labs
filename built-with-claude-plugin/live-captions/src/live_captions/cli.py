"""Command line entry point: serve, join, leave, demo."""

import argparse
import logging
import sys
from typing import Optional, Sequence

from .captions import CaptionPrinter
from .config import ConfigError, Settings, load_settings
from .demo import run_demo
from .meetstream import MeetStreamClient, MeetStreamError


def _printer(settings: Settings) -> CaptionPrinter:
    # color=None lets the printer decide from the terminal; False forces it off.
    return CaptionPrinter(color=None if settings.color else False)


def cmd_serve(args: argparse.Namespace, settings: Settings) -> int:
    import uvicorn

    from .server import create_app

    printer = _printer(settings)
    app = create_app(printer, settings)
    printer.status(
        "listening on http://%s:%d — point PUBLIC_BASE_URL at this through a tunnel"
        % (settings.host, settings.port)
    )
    uvicorn.run(app, host=settings.host, port=settings.port, log_level=args.log_level)
    return 0


def cmd_join(args: argparse.Namespace, settings: Settings) -> int:
    settings.require_api_key()
    client = MeetStreamClient(settings)
    payload = client.build_create_bot_payload(args.meeting_link)
    print("Sending %r to %s" % (payload["bot_name"], args.meeting_link))
    print("  live transcript -> %s" % payload["live_transcription_required"]["webhook_url"])
    print("  lifecycle       -> %s" % payload["callback_url"])
    if not args.yes:
        answer = input("This joins a live meeting. Continue? [y/N] ").strip().lower()
        if answer not in ("y", "yes"):
            print("Cancelled.")
            return 1
    bot = client.create_bot(args.meeting_link)
    print("Bot %s is on its way (status: %s)" % (bot.get("bot_id"), bot.get("status")))
    print("Captions will appear in the terminal running `live-captions serve`.")
    return 0


def cmd_leave(args: argparse.Namespace, settings: Settings) -> int:
    settings.require_api_key()
    result = MeetStreamClient(settings).remove_bot(args.bot_id)
    print(result.get("message", "Bot %s removed." % args.bot_id))
    return 0


def cmd_demo(args: argparse.Namespace, settings: Settings) -> int:
    run_demo(_printer(settings), delay=args.delay)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="live-captions",
        description="Speaker-labelled live meeting captions in your terminal.",
    )
    parser.add_argument("--log-level", default="warning", help="uvicorn/log level")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="run the local server that receives captions")
    serve.set_defaults(func=cmd_serve)

    join = sub.add_parser("join", help="send a bot to a meeting with live transcription on")
    join.add_argument("meeting_link", help="Google Meet / Zoom / Teams URL")
    join.add_argument("-y", "--yes", action="store_true", help="skip the confirmation prompt")
    join.set_defaults(func=cmd_join)

    leave = sub.add_parser("leave", help="remove a bot from its meeting")
    leave.add_argument("bot_id")
    leave.set_defaults(func=cmd_leave)

    demo = sub.add_parser("demo", help="replay a sample stream locally, no API key needed")
    demo.add_argument("--delay", type=float, default=0.6, help="seconds between chunks")
    demo.set_defaults(func=cmd_demo)

    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(list(argv) if argv is not None else None)
    logging.basicConfig(level=args.log_level.upper(), format="%(levelname)s %(name)s: %(message)s")
    try:
        settings = load_settings()
        return args.func(args, settings)
    except (ConfigError, MeetStreamError) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
