"""Long-meeting behaviour: memory must not grow with the size of the timeline."""

from __future__ import annotations

import io
import json
import tracemalloc

import pytest

from talk_time.stats import aggregate
from talk_time.timeline import ParseReport, read_chunks

BYTES_PER_SECOND = 96000
CHUNK_SECONDS = 0.25
SPEAKERS = ("Alice", "Bob", "Chi", "Deepa", "Eli")


def write_long_timeline(path, hours=4.0):
    """A four-hour meeting chunked every 250 ms, speakers taking 30 s turns."""
    chunks_per_turn = int(30 / CHUNK_SECONDS)
    total_chunks = int(hours * 3600 / CHUNK_SECONDS)
    with path.open("w", encoding="utf-8") as handle:
        handle.write('{"speaker_timeline": [')
        for index in range(total_chunks):
            speaker = SPEAKERS[(index // chunks_per_turn) % len(SPEAKERS)]
            start = int(index * CHUNK_SECONDS * BYTES_PER_SECOND)
            end = start + int(CHUNK_SECONDS * BYTES_PER_SECOND)
            if index:
                handle.write(",")
            handle.write(
                json.dumps({"speaker": speaker, "start_byte": start, "end_byte": end})
            )
        handle.write("]}")
    return total_chunks


@pytest.mark.parametrize("hours", [4.0])
def test_four_hour_meeting_streams_in_constant_memory(tmp_path, hours):
    path = tmp_path / "long-timeline.json"
    total_chunks = write_long_timeline(path, hours=hours)
    assert path.stat().st_size > 3_000_000  # a few MB of JSON

    parse = ParseReport()
    tracemalloc.start()
    try:
        with path.open("rb") as handle:
            report = aggregate(
                read_chunks(handle, bytes_per_second=BYTES_PER_SECOND, report=parse),
                turn_gap_seconds=1.0,
            )
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert parse.chunks_read == total_chunks
    assert parse.chunks_used == total_chunks

    # Nothing is accumulated per chunk, so the peak stays far below the file size.
    assert peak < 2_000_000, "peaked at {} bytes for {} chunks".format(peak, total_chunks)

    assert report.total_speech_seconds == pytest.approx(hours * 3600)
    assert report.meeting_span_seconds == pytest.approx(hours * 3600)
    assert len(report.speakers) == len(SPEAKERS)
    # 4 h / 30 s = 480 turns, dealt round-robin between five speakers.
    assert sum(speaker.turns for speaker in report.speakers) == 480
    for speaker in report.speakers:
        assert speaker.turns == 96
        assert speaker.total_seconds == pytest.approx(96 * 30)
        assert speaker.longest_stretch_seconds == pytest.approx(30.0)
        assert speaker.share == pytest.approx(0.2)


def test_many_speakers_do_not_break_the_report():
    document = [
        {"speaker": "Speaker {}".format(index), "start_byte": index * 96000, "end_byte": (index + 1) * 96000}
        for index in range(500)
    ]
    stream = io.BytesIO(json.dumps(document).encode("utf-8"))
    report = aggregate(read_chunks(stream, bytes_per_second=BYTES_PER_SECOND))
    assert len(report.speakers) == 500
    assert report.total_speech_seconds == pytest.approx(500.0)
