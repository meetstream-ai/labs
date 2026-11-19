"""Render a :class:`~talk_time.stats.TalkTimeReport` as a table and as JSON."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from .stats import TalkTimeReport
from .timeline import BYTES, ParseReport

DERIVED_NOTE = (
    "get_speaker_timeline returns byte offsets, not time. Shares and turn counts are "
    "exact; seconds are derived with bytes_per_second and are only as right as that value."
)


def format_hms(seconds: float) -> str:
    """Format a duration as H:MM:SS, keeping hours for long meetings."""
    total = int(round(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    return "{:d}:{:02d}:{:02d}".format(hours, minutes, secs)


def build_payload(
    report: TalkTimeReport,
    parse: ParseReport,
    bytes_per_second: int,
    source: Dict[str, Any],
    unattributed_labels: Optional[List[str]] = None,
    bot_id: Optional[str] = None,
) -> Dict[str, Any]:
    basis = parse.unit or "unknown"
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "bot_id": bot_id,
        "source": source,
        "units": {
            "timeline_basis": basis,
            "bytes_per_second": bytes_per_second if basis == BYTES else None,
            "seconds_are_derived": basis == BYTES,
            "note": DERIVED_NOTE if basis == BYTES else None,
        },
        "settings": {
            "turn_gap_seconds": report.turn_gap_seconds,
            "unattributed_labels": sorted(unattributed_labels or []),
        },
        "totals": {
            "speaker_count": len(report.speakers),
            "total_speech_seconds": round(report.total_speech_seconds, 3),
            "meeting_span_seconds": round(report.meeting_span_seconds, 3),
            "unattributed_seconds": round(report.unattributed_seconds, 3),
        },
        "parsing": {
            "chunks_read": parse.chunks_read,
            "chunks_used": parse.chunks_used,
            "skipped_no_speaker_field": parse.skipped_no_speaker_field,
            "skipped_no_timing": parse.skipped_no_timing,
            "skipped_negative_duration": parse.skipped_negative_duration,
            "out_of_order_chunks": report.out_of_order_chunks,
            "field_mapping": parse.field_mapping,
        },
        "speakers": [
            {
                "speaker": speaker.speaker,
                "total_seconds": round(speaker.total_seconds, 3),
                "total_hms": format_hms(speaker.total_seconds),
                "share": round(speaker.share, 6),
                "share_percent": round(speaker.share * 100, 2),
                "turns": speaker.turns,
                "longest_stretch_seconds": round(speaker.longest_stretch_seconds, 3),
                "longest_stretch_hms": format_hms(speaker.longest_stretch_seconds),
                "first_spoke_at_seconds": (
                    None
                    if speaker.first_spoke_at is None
                    else round(speaker.first_spoke_at - report.timeline_start, 3)
                ),
                "last_spoke_at_seconds": (
                    None
                    if speaker.last_spoke_at is None
                    else round(speaker.last_spoke_at - report.timeline_start, 3)
                ),
            }
            for speaker in report.speakers
        ],
    }


def render_table(payload: Dict[str, Any]) -> str:
    """Build the printable table from the same payload that goes to JSON."""
    headers = ("Speaker", "Talk time", "Share", "Turns", "Longest")
    rows = [
        (
            speaker["speaker"],
            speaker["total_hms"],
            "{:.1f}%".format(speaker["share_percent"]),
            str(speaker["turns"]),
            speaker["longest_stretch_hms"],
        )
        for speaker in payload["speakers"]
    ]

    totals = payload["totals"]
    total_row = (
        "TOTAL ({} speakers)".format(totals["speaker_count"]),
        format_hms(totals["total_speech_seconds"]),
        "100.0%" if rows else "0.0%",
        str(sum(speaker["turns"] for speaker in payload["speakers"])),
        "",
    )

    widths = [len(header) for header in headers]
    for row in list(rows) + [total_row]:
        for index, cell in enumerate(row):
            widths[index] = max(widths[index], len(cell))

    def line(cells, pad=" ") -> str:
        out = [cells[0].ljust(widths[0], pad)]
        out.extend(cell.rjust(widths[index + 1], pad) for index, cell in enumerate(cells[1:]))
        return "  ".join(out).rstrip()

    lines = [line(headers), line(tuple("" for _ in headers), pad="-")]
    if rows:
        lines.extend(line(row) for row in rows)
    else:
        lines.append("(no speakers found in the timeline)")
    lines.append(line(tuple("" for _ in headers), pad="-"))
    lines.append(line(total_row))

    lines.append("")
    lines.append("Meeting span: {}".format(format_hms(totals["meeting_span_seconds"])))
    if totals["unattributed_seconds"] > 0:
        lines.append(
            "Unattributed audio: {} (speaker label in {})".format(
                format_hms(totals["unattributed_seconds"]),
                ", ".join(payload["settings"]["unattributed_labels"]) or "-",
            )
        )
    lines.append(
        "Turns merge pauses shorter than {:g}s. Shares are of total talk time, "
        "which exceeds the meeting span when people overlap.".format(
            payload["settings"]["turn_gap_seconds"]
        )
    )
    if payload["units"]["seconds_are_derived"]:
        lines.append(
            "Timeline is in byte offsets: seconds derived at {} bytes/s. "
            "Shares and turn counts do not depend on that.".format(
                payload["units"]["bytes_per_second"]
            )
        )

    parsing = payload["parsing"]
    skipped = (
        parsing["skipped_no_speaker_field"]
        + parsing["skipped_no_timing"]
        + parsing["skipped_negative_duration"]
    )
    if skipped:
        lines.append(
            "Skipped {} of {} chunks ({} without a speaker, {} without timing, "
            "{} ending before they start).".format(
                skipped,
                parsing["chunks_read"],
                parsing["skipped_no_speaker_field"],
                parsing["skipped_no_timing"],
                parsing["skipped_negative_duration"],
            )
        )
    if parsing["out_of_order_chunks"]:
        lines.append(
            "{} chunks arrived out of order and were folded into the open turn.".format(
                parsing["out_of_order_chunks"]
            )
        )
    return "\n".join(lines)


def write_json(payload: Dict[str, Any], path: Path) -> Path:
    path = Path(path)
    if path.parent and not path.parent.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    return path
