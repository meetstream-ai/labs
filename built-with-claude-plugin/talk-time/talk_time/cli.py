"""Command line entry point: talk-time <timeline.json> [--json-out out.json]."""

from __future__ import annotations

import argparse
import contextlib
import dataclasses
import sys
from pathlib import Path
from typing import Any, Dict, Optional, Sequence

from .client import ApiError, open_speaker_timeline, open_timeline_link, redact_url
from .config import Config, ConfigError, load_config
from .report import build_payload, render_table, write_json
from .stats import aggregate
from .timeline import AUTO, UNITS, ParseReport, TimelineElsewhere, TimelineError, read_chunks


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="talk-time",
        description=(
            "Per-speaker talk-time for a finished MeetStream bot: total seconds, share "
            "of the meeting, turns and longest uninterrupted stretch."
        ),
    )
    parser.add_argument(
        "timeline",
        nargs="?",
        help="speaker timeline JSON saved from GET /bots/{bot_id}/get_speaker_timeline ('-' for stdin)",
    )
    parser.add_argument(
        "--bot-id",
        help="fetch the timeline from the MeetStream API instead of reading a file (needs MEETSTREAM_API_KEY)",
    )
    parser.add_argument("--json-out", help="where to write the JSON report (default: TALK_TIME_OUTPUT)")
    parser.add_argument(
        "--unit",
        choices=UNITS,
        default=AUTO,
        help="how to read the chunk offsets; 'auto' infers from the field names (default: auto)",
    )
    parser.add_argument(
        "--turn-gap",
        type=float,
        help="seconds of silence that end a speaker's turn (default: TALK_TIME_TURN_GAP_SECONDS)",
    )
    parser.add_argument("--sample-rate", type=int, help="override TALK_TIME_SAMPLE_RATE for byte offsets")
    parser.add_argument("--sample-width", type=int, help="override TALK_TIME_SAMPLE_WIDTH (bytes per sample)")
    parser.add_argument("--channels", type=int, help="override TALK_TIME_CHANNELS")
    parser.add_argument("--env-file", default=".env", help="path to the .env file (default: .env)")
    parser.add_argument(
        "--no-follow-links",
        dest="follow_links",
        action="store_false",
        help="fail instead of fetching a timeline the API returned as links (long meetings)",
    )
    parser.add_argument("--quiet", action="store_true", help="write the JSON but do not print the table")
    return parser


def _apply_overrides(config: Config, args: argparse.Namespace) -> Config:
    changes: Dict[str, Any] = {}
    for name, value in (
        ("sample_rate", args.sample_rate),
        ("sample_width", args.sample_width),
        ("channels", args.channels),
    ):
        if value is not None:
            if value <= 0:
                raise ConfigError("--{} must be greater than 0".format(name.replace("_", "-")))
            changes[name] = value
    if args.turn_gap is not None:
        if args.turn_gap < 0:
            raise ConfigError("--turn-gap must not be negative")
        changes["turn_gap_seconds"] = args.turn_gap
    if args.json_out:
        changes["output_path"] = args.json_out
    return dataclasses.replace(config, **changes) if changes else config


def _aggregate_streams(streams, args: argparse.Namespace, config: Config, report: ParseReport):
    """Fold every stream of the timeline, in order, through one parse report."""

    def chunks():
        for stream in streams:
            for chunk in read_chunks(
                stream,
                bytes_per_second=config.bytes_per_second,
                unit=args.unit,
                report=report,
            ):
                yield chunk

    return aggregate(
        chunks(),
        turn_gap_seconds=config.turn_gap_seconds,
        unattributed_labels=config.unattributed_labels,
    )


def _run(args: argparse.Namespace, config: Config, out) -> int:
    source: Dict[str, Any]
    parse_report = ParseReport()

    with contextlib.ExitStack() as stack:
        if args.bot_id:
            stream = stack.enter_context(contextlib.closing(open_speaker_timeline(args.bot_id, config)))
            source = {"type": "api", "bot_id": args.bot_id}
        elif args.timeline == "-":
            stream = sys.stdin.buffer
            source = {"type": "stdin"}
        else:
            path = Path(args.timeline)
            if not path.is_file():
                raise TimelineError("no such timeline file: {}".format(path))
            stream = stack.enter_context(path.open("rb"))
            source = {"type": "file", "path": str(path)}

        try:
            report = _aggregate_streams([stream], args, config, parse_report)
        except TimelineElsewhere as elsewhere:
            # A long meeting answers 200 with links to the timeline instead of
            # the chunks. Nothing was yielded before this, so reading the links
            # from the start is the same pass, one hop further out.
            if not args.follow_links:
                raise TimelineError("{} - drop --no-follow-links to fetch them".format(elsewhere))
            links = [
                stack.enter_context(contextlib.closing(open_timeline_link(url)))
                for url in elsewhere.urls
            ]
            # Pre-signed links sign themselves in the query string: record the
            # address only, never the signature.
            source = dict(source, timeline_links=[redact_url(url) for url in elsewhere.urls])
            parse_report = ParseReport()
            try:
                report = _aggregate_streams(links, args, config, parse_report)
            except TimelineElsewhere as nested:
                raise TimelineError(
                    "the linked timeline holds no chunks either, only more links "
                    "({}) - stopping rather than following them in a loop".format(
                        ", ".join(redact_url(url) for url in nested.urls)
                    )
                )

    payload = build_payload(
        report,
        parse_report,
        bytes_per_second=config.bytes_per_second,
        source=source,
        unattributed_labels=list(config.unattributed_labels),
        bot_id=args.bot_id,
    )
    destination = write_json(payload, Path(config.output_path))
    if not args.quiet:
        print(render_table(payload), file=out)
        print("\nJSON written to {}".format(destination), file=out)
    return 0


def main(argv: Optional[Sequence[str]] = None, out=None) -> int:
    out = out or sys.stdout
    parser = build_parser()
    args = parser.parse_args(argv)

    if bool(args.timeline) == bool(args.bot_id):
        parser.error("give either a timeline JSON file or --bot-id, not both")

    try:
        config = _apply_overrides(load_config(Path(args.env_file)), args)
        return _run(args, config, out)
    except (ConfigError, TimelineError, ApiError) as exc:
        print("talk-time: {}".format(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
