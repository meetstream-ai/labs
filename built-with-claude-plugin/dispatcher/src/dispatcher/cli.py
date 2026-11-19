"""Command-line entry point: dispatch-bots."""

from __future__ import annotations

import argparse
import dataclasses
import logging
import sys
from typing import IO, List, Optional, Sequence

from .client import MeetStreamClient
from .config import Config, ConfigError, load_config
from .dispatch import Report, dispatch
from .links import parse_links
from .report import render_json, render_text

EXIT_OK = 0
EXIT_INCOMPLETE = 1
EXIT_USAGE = 2

logger = logging.getLogger("dispatcher")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dispatch-bots",
        description=(
            "Send a MeetStream bot to every meeting link in a file "
            "(Zoom, Google Meet and Teams, mixed)."
        ),
        epilog=(
            "Input format: one meeting URL per line, optionally followed by "
            "',<bot name>'. Blank lines and # comments are ignored. "
            "Exit code 0 when every link got a bot, 1 when any failed or was "
            "skipped, 2 on a usage or config error."
        ),
    )
    parser.add_argument(
        "links_file",
        help="file of meeting links, or - to read them from stdin",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="validate links and show what would be sent, without calling the API",
    )
    parser.add_argument("--bot-name", help="bot display name (overrides MEETSTREAM_BOT_NAME)")
    parser.add_argument(
        "--callback-url", help="webhook URL for bot events (overrides MEETSTREAM_CALLBACK_URL)"
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        help="how many bots to create in parallel (overrides MEETSTREAM_CONCURRENCY)",
    )
    parser.add_argument(
        "--max-retries",
        type=int,
        help="retries per link for rate limits and transient errors "
        "(overrides MEETSTREAM_MAX_RETRIES)",
    )
    parser.add_argument(
        "--allow-duplicates",
        action="store_true",
        help="send a bot for every line, even if the same link appears twice",
    )
    parser.add_argument("--env-file", default=".env", help="path to the .env file (default: .env)")
    parser.add_argument("--json", action="store_true", help="print the summary as JSON")
    parser.add_argument(
        "-v", "--verbose", action="store_true", help="log each dispatch to stderr"
    )
    return parser


def _read_lines(path: str, stdin: IO[str]) -> List[str]:
    if path == "-":
        return stdin.read().splitlines()
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read().splitlines()


def _apply_overrides(config: Config, args: argparse.Namespace) -> Config:
    overrides = {}
    if args.bot_name:
        overrides["bot_name"] = args.bot_name
    if args.callback_url:
        overrides["callback_url"] = args.callback_url
    if args.concurrency is not None:
        overrides["concurrency"] = args.concurrency
    if args.max_retries is not None:
        overrides["max_retries"] = args.max_retries
    return dataclasses.replace(config, **overrides) if overrides else config


def run(args: argparse.Namespace, stdout: IO[str], stderr: IO[str], stdin: IO[str]) -> int:
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s %(message)s",
        stream=stderr,
    )

    if args.concurrency is not None and args.concurrency < 1:
        stderr.write("--concurrency must be at least 1\n")
        return EXIT_USAGE
    if args.max_retries is not None and args.max_retries < 0:
        stderr.write("--max-retries must be zero or more\n")
        return EXIT_USAGE

    try:
        config = load_config(env_file=args.env_file, require_api_key=not args.dry_run)
    except ConfigError as exc:
        stderr.write("{0}\n".format(exc))
        return EXIT_USAGE
    config = _apply_overrides(config, args)

    if args.callback_url and not args.callback_url.startswith("https://"):
        stderr.write("--callback-url must be an https:// URL\n")
        return EXIT_USAGE

    try:
        lines = _read_lines(args.links_file, stdin)
    except OSError as exc:
        stderr.write("cannot read {0}: {1}\n".format(args.links_file, exc))
        return EXIT_USAGE

    links, rejected = parse_links(lines, allow_duplicates=args.allow_duplicates)
    if not links and not rejected:
        stderr.write("no meeting links found in {0}\n".format(args.links_file))
        return EXIT_USAGE

    client = None
    if not args.dry_run:
        client = MeetStreamClient(
            api_key=config.api_key,
            base_url=config.base_url,
            timeout=config.request_timeout,
            max_retries=config.max_retries,
            backoff_base=config.backoff_base,
            max_backoff=config.max_backoff,
        )

    report = dispatch(links, rejected, config, client=client, dry_run=args.dry_run)
    _write_report(report, stdout, as_json=args.json)
    return EXIT_INCOMPLETE if report.exit_code else EXIT_OK


def _write_report(report: Report, stdout: IO[str], as_json: bool) -> None:
    rendered = render_json(report) if as_json else render_text(report)
    stdout.write(rendered + "\n")


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    return run(args, sys.stdout, sys.stderr, sys.stdin)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
