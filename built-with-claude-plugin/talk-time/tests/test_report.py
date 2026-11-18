from __future__ import annotations

import json

import pytest

from talk_time.report import build_payload, format_hms, render_table, write_json
from talk_time.stats import aggregate
from talk_time.timeline import BYTES, SECONDS, Chunk, ParseReport


@pytest.mark.parametrize(
    "seconds,expected",
    [(0, "0:00:00"), (9.4, "0:00:09"), (90, "0:01:30"), (3600, "1:00:00"), (13784, "3:49:44")],
)
def test_format_hms(seconds, expected):
    assert format_hms(seconds) == expected


def make_payload(unit=BYTES, chunks=None, **kwargs):
    chunks = chunks if chunks is not None else [Chunk("Alice", 0, 30), Chunk("Bob", 40, 50)]
    parse = ParseReport(chunks_read=len(chunks), chunks_used=len(chunks), unit=unit)
    report = aggregate(chunks)
    return build_payload(
        report,
        parse,
        bytes_per_second=96000,
        source={"type": "file", "path": "timeline.json"},
        unattributed_labels=["NoSpeaker"],
        **kwargs
    )


def test_payload_shape():
    payload = make_payload(bot_id="bot-1")
    assert payload["bot_id"] == "bot-1"
    assert payload["source"] == {"type": "file", "path": "timeline.json"}
    assert payload["totals"]["speaker_count"] == 2
    assert payload["totals"]["total_speech_seconds"] == pytest.approx(40.0)
    assert payload["settings"]["turn_gap_seconds"] == 1.0
    alice = payload["speakers"][0]
    assert alice["speaker"] == "Alice"
    assert alice["total_seconds"] == pytest.approx(30.0)
    assert alice["share_percent"] == pytest.approx(75.0)
    assert alice["total_hms"] == "0:00:30"
    assert alice["turns"] == 1
    assert alice["first_spoke_at_seconds"] == 0.0


def test_byte_based_reports_flag_that_seconds_are_derived():
    payload = make_payload(unit=BYTES)
    assert payload["units"]["seconds_are_derived"] is True
    assert payload["units"]["bytes_per_second"] == 96000
    assert "byte offsets" in payload["units"]["note"]


def test_time_based_reports_do_not_claim_a_conversion():
    payload = make_payload(unit=SECONDS)
    assert payload["units"]["seconds_are_derived"] is False
    assert payload["units"]["bytes_per_second"] is None
    assert payload["units"]["note"] is None


def test_first_spoke_at_is_relative_to_the_timeline_start():
    payload = make_payload(chunks=[Chunk("Alice", 1000, 1010), Chunk("Bob", 1020, 1030)])
    assert payload["speakers"][0]["first_spoke_at_seconds"] == pytest.approx(0.0)
    assert payload["speakers"][1]["first_spoke_at_seconds"] == pytest.approx(20.0)


def test_table_lists_every_speaker_and_the_total():
    table = render_table(make_payload())
    assert "Speaker" in table and "Talk time" in table and "Longest" in table
    assert "Alice" in table and "Bob" in table
    assert "75.0%" in table and "25.0%" in table
    assert "TOTAL (2 speakers)" in table
    assert "Meeting span: 0:00:50" in table
    assert "bytes/s" in table


def test_table_columns_line_up_even_when_the_total_label_is_widest():
    lines = render_table(make_payload()).splitlines()
    header, separator, alice, bob = lines[0], lines[1], lines[2], lines[3]
    assert len(separator) == len(header)
    assert len(alice) == len(header) and len(bob) == len(header)
    total = lines[5]
    assert total.startswith("TOTAL (2 speakers)")
    # The total row stops after the Turns column, which must end where the header's does.
    assert len(total) == header.index("Turns") + len("Turns")


def test_table_reports_skipped_chunks():
    parse = ParseReport(chunks_read=10, chunks_used=8, skipped_no_timing=2, unit=SECONDS)
    payload = build_payload(
        aggregate([Chunk("Alice", 0, 5)]),
        parse,
        bytes_per_second=96000,
        source={"type": "stdin"},
    )
    assert "Skipped 2 of 10 chunks" in render_table(payload)


def test_table_handles_an_empty_timeline():
    parse = ParseReport(chunks_read=0, chunks_used=0)
    payload = build_payload(aggregate([]), parse, bytes_per_second=96000, source={"type": "stdin"})
    table = render_table(payload)
    assert "(no speakers found in the timeline)" in table


def test_write_json_creates_parent_directories(tmp_path):
    payload = make_payload()
    destination = write_json(payload, tmp_path / "nested" / "report.json")
    assert destination.is_file()
    assert json.loads(destination.read_text(encoding="utf-8"))["speakers"][0]["speaker"] == "Alice"
