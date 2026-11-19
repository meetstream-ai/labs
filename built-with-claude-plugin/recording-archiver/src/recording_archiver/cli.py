"""Command line entry point: sweep once, or keep sweeping on an interval."""

from __future__ import annotations

import argparse
import logging
import sys
import time
from dataclasses import replace
from pathlib import Path

from .archive import Archiver, SweepResult
from .client import MeetStreamClient, MeetStreamError
from .config import ConfigError, Settings, load_settings

log = logging.getLogger("recording_archiver")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="recording-archiver",
        description=(
            "Download finished MeetStream recordings - mixed audio, video, and "
            "per-participant audio when the bot captured it - to a local directory."
        ),
    )
    parser.add_argument(
        "--bot-id",
        action="append",
        dest="bot_ids",
        metavar="BOT_ID",
        help="Archive only this bot. Repeatable. Default: sweep every bot on the account.",
    )
    parser.add_argument(
        "--watch",
        action="store_true",
        help="Keep sweeping until interrupted, pausing ARCHIVE_POLL_INTERVAL_SECONDS between runs.",
    )
    parser.add_argument(
        "--interval",
        type=int,
        metavar="SECONDS",
        help="Override the poll interval for --watch.",
    )
    parser.add_argument(
        "--archive-dir",
        type=Path,
        metavar="DIR",
        help="Override ARCHIVE_DIR for this run.",
    )
    parser.add_argument(
        "--env-file",
        type=Path,
        metavar="PATH",
        help="Read settings from this .env file instead of ./.env.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would be downloaded without writing any media.",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Enable debug logging.")
    return parser


def _report(result: SweepResult, dry_run: bool) -> None:
    verb = "would archive" if dry_run else "archived"
    log.info(
        "Sweep finished: %s bot(s) checked, %s %s file(s) across %s bot(s)",
        result.bots_seen,
        verb,
        result.files_archived,
        result.bots_archived,
    )
    for error in result.errors:
        log.error("  %s", error)


def run(settings: Settings, args: argparse.Namespace) -> int:
    interval = args.interval or settings.poll_interval_seconds
    exit_code = 0
    with MeetStreamClient(settings) as client:
        archiver = Archiver(settings, client)
        while True:
            try:
                result = archiver.sweep(bot_ids=args.bot_ids, dry_run=args.dry_run)
            except MeetStreamError as exc:
                log.error("Sweep failed: %s", exc)
                if not args.watch:
                    return 1
                exit_code = 1
            else:
                _report(result, args.dry_run)
                if result.errors:
                    exit_code = 1
            if not args.watch:
                return exit_code
            log.info("Sleeping %ss until the next sweep (Ctrl-C to stop)", interval)
            time.sleep(interval)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    try:
        settings = load_settings(args.env_file)
    except ConfigError as exc:
        log.error("%s", exc)
        return 2

    if args.archive_dir:
        settings = replace(settings, archive_dir=args.archive_dir)

    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    log.info("Archiving into %s", settings.archive_dir.resolve())

    try:
        return run(settings, args)
    except KeyboardInterrupt:
        log.info("Stopped.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
