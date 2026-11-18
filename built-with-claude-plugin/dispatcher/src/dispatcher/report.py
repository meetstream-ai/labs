"""Rendering of the end-of-run summary."""

from __future__ import annotations

import json
from typing import List

from .dispatch import DISPATCHED, FAILED, SKIPPED, Report

STATUS_MARKS = {
    DISPATCHED: "OK  ",
    FAILED: "FAIL",
    SKIPPED: "SKIP",
}


def render_text(report: Report) -> str:
    """A summary you can read at a glance: what went out, what did not, and why."""
    lines: List[str] = []
    if report.dry_run:
        lines.append("DRY RUN - no bots were created.")
        lines.append("")

    dispatched = report.of_status(DISPATCHED)
    lines.append("Dispatched ({0})".format(len(dispatched)))
    if dispatched:
        for result in dispatched:
            lines.append(
                "  {0} {1:<12} {2}".format(
                    STATUS_MARKS[DISPATCHED], result.platform or "-", result.url
                )
            )
            if result.bot_id:
                retried = (
                    " after {0} attempts".format(result.attempts) if result.attempts > 1 else ""
                )
                lines.append("       bot_id={0}{1}".format(result.bot_id, retried))
    else:
        lines.append("  none")

    for status in (FAILED, SKIPPED):
        results = report.of_status(status)
        if not results:
            continue
        heading = "Failed" if status == FAILED else "Skipped"
        lines.append("")
        lines.append("{0} ({1})".format(heading, len(results)))
        for result in results:
            retried = " after {0} attempts".format(result.attempts) if result.attempts > 1 else ""
            lines.append(
                "  {0} line {1}  {2}".format(STATUS_MARKS[status], result.line_number, result.url)
            )
            lines.append("       {0}{1}".format(result.reason or "unknown reason", retried))

    counts = report.counts
    lines.append("")
    lines.append(
        "Summary: {0} dispatched, {1} failed, {2} skipped (of {3} links)".format(
            counts[DISPATCHED], counts[FAILED], counts[SKIPPED], len(report.results)
        )
    )
    return "\n".join(lines)


def render_json(report: Report) -> str:
    return json.dumps(report.as_dict(), indent=2)
