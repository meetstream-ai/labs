from __future__ import annotations

import io
import json

import pytest

from talk_time.timeline import (
    BYTES,
    ISO,
    MILLISECONDS,
    SECONDS,
    ParseReport,
    TimelineElsewhere,
    TimelineError,
    read_chunks,
)

BPS = 96000


def chunks_of(document, **kwargs):
    stream = io.BytesIO(json.dumps(document).encode("utf-8"))
    kwargs.setdefault("bytes_per_second", BPS)
    return list(read_chunks(stream, **kwargs))


def test_byte_offsets_become_seconds():
    chunks = chunks_of([{"speaker": "Alice", "start_byte": 0, "end_byte": 960000}])
    assert len(chunks) == 1
    assert chunks[0].speaker == "Alice"
    assert chunks[0].duration == pytest.approx(10.0)


def test_unit_is_detected_from_the_field_name():
    report = ParseReport()
    chunks_of([{"speaker": "A", "start_byte": 0, "end_byte": 96000}], report=report)
    assert report.unit == BYTES

    report = ParseReport()
    chunks_of([{"speaker": "A", "start_time": 0.0, "end_time": 1.0}], report=report)
    assert report.unit == SECONDS

    report = ParseReport()
    chunks_of([{"speaker": "A", "start_ms": 0, "end_ms": 1500}], report=report)
    assert report.unit == MILLISECONDS

    report = ParseReport()
    chunks_of(
        [{"speaker": "A", "absolute_start_time": "2026-11-18T10:00:00Z", "absolute_end_time": "2026-11-18T10:00:05Z"}],
        report=report,
    )
    assert report.unit == ISO


def test_milliseconds_and_iso_convert_to_seconds():
    assert chunks_of([{"speaker": "A", "start_ms": 500, "end_ms": 2000}])[0].duration == pytest.approx(1.5)

    iso = chunks_of(
        [
            {
                "speaker": "A",
                "absolute_start_time": "2026-11-18T10:00:00Z",
                "absolute_end_time": "2026-11-18T10:00:05.500Z",
            }
        ]
    )
    assert iso[0].duration == pytest.approx(5.5)


def test_forced_unit_overrides_detection():
    # Field is named "start" but the values really are byte offsets.
    chunks = chunks_of([{"speaker": "A", "start": 0, "end": 192000}], unit=BYTES)
    assert chunks[0].duration == pytest.approx(2.0)


def test_object_wrapper_and_nested_array_are_found():
    wrapped = chunks_of({"bot_id": "abc", "speaker_timeline": [{"speaker": "A", "start_time": 1, "end_time": 3}]})
    assert [c.speaker for c in wrapped] == ["A"]

    deeper = chunks_of({"data": {"timeline": [{"speaker": "B", "start_time": 0, "end_time": 2}]}})
    assert [c.speaker for c in deeper] == ["B"]


def test_nested_participant_name_is_used():
    chunks = chunks_of([{"participant": {"name": "Deepa"}, "start_time": 0, "end_time": 4}])
    assert chunks[0].speaker == "Deepa"


def test_start_plus_duration_is_supported():
    chunks = chunks_of([{"speaker": "A", "start_time": 10.0, "duration": 2.5}])
    assert chunks[0].end == pytest.approx(12.5)

    by_bytes = chunks_of([{"speaker": "A", "start_byte": 0, "byte_length": 480000}])
    assert by_bytes[0].duration == pytest.approx(5.0)


def test_quoted_numbers_are_accepted():
    chunks = chunks_of([{"speaker": "A", "start_time": "1.5", "end_time": "4.5"}])
    assert chunks[0].duration == pytest.approx(3.0)


def test_words_array_inside_a_chunk_is_ignored():
    chunks = chunks_of(
        [
            {
                "speaker": "A",
                "start_time": 0,
                "end_time": 2,
                "words": [{"word": "hi", "start": 0.1, "end": 0.2}, {"word": "there", "start": 0.3, "end": 0.6}],
            }
        ]
    )
    assert len(chunks) == 1
    assert chunks[0].duration == pytest.approx(2.0)


def test_unusable_chunks_are_counted_not_guessed():
    report = ParseReport()
    chunks = chunks_of(
        [
            {"speaker": "A", "start_time": 0, "end_time": 5},
            {"start_time": 5, "end_time": 6},
            {"speaker": "   ", "start_time": 6, "end_time": 7},
            {"speaker": "B"},
            {"speaker": "B", "start_time": 10, "end_time": 9},
        ],
        report=report,
    )
    assert len(chunks) == 1
    assert report.chunks_read == 5
    assert report.chunks_used == 1
    assert report.skipped_no_speaker_field == 2
    assert report.skipped_no_timing == 1
    assert report.skipped_negative_duration == 1


def test_field_mapping_is_recorded():
    report = ParseReport()
    chunks_of([{"speakerName": "A", "start_byte": 0, "end_byte": 96000}], report=report)
    # Reported as the API spelled them, not as the matcher normalised them.
    assert report.field_mapping["speaker"] == "speakerName"
    assert report.field_mapping["start"] == "start_byte"
    assert report.field_mapping["end"] == "end_byte"
    assert report.field_mapping["length"] == ""


def test_zero_length_chunk_is_kept():
    chunks = chunks_of([{"speaker": "A", "start_time": 3, "end_time": 3}])
    assert chunks[0].duration == 0.0


def test_json_without_chunks_raises():
    with pytest.raises(TimelineError) as excinfo:
        chunks_of({"message": "Timeline is still being processed"})
    # What the API said is carried through, not dropped for a generic message.
    assert "Timeline is still being processed" in str(excinfo.value)
    assert "message" in str(excinfo.value)
    with pytest.raises(TimelineError):
        chunks_of([1, 2, 3])


def test_a_link_to_the_timeline_is_raised_as_such():
    # Long meetings: 200, but the chunks live behind a link.
    with pytest.raises(TimelineElsewhere) as excinfo:
        chunks_of(
            {
                "bot_id": "2f0f3f4c",
                "chunk_count": 115000,
                "speaker_timeline_url": "https://media.example.com/t/abc.json?X-Amz-Signature=deadbeef",
            }
        )
    assert excinfo.value.urls == ["https://media.example.com/t/abc.json?X-Amz-Signature=deadbeef"]
    assert "speaker_timeline_url" in excinfo.value.keys
    # Still a TimelineError, so callers that only know the old type keep working.
    assert isinstance(excinfo.value, TimelineError)


def test_several_timeline_parts_keep_their_order():
    with pytest.raises(TimelineElsewhere) as excinfo:
        chunks_of(
            {
                "speaker_timeline_parts": [
                    "https://media.example.com/t/part-1.json",
                    "https://media.example.com/t/part-2.json",
                ],
                "documentation_url": "https://docs.meetstream.ai/speaker-timeline",
            }
        )
    # Only the parts, in document order - the docs link is not timeline data.
    assert excinfo.value.urls == [
        "https://media.example.com/t/part-1.json",
        "https://media.example.com/t/part-2.json",
    ]


def test_a_nested_link_is_found():
    with pytest.raises(TimelineElsewhere) as excinfo:
        chunks_of({"data": {"timeline": {"url": "https://media.example.com/t/abc.json"}}})
    assert excinfo.value.urls == ["https://media.example.com/t/abc.json"]


def test_an_unlabelled_link_is_still_followed():
    with pytest.raises(TimelineElsewhere) as excinfo:
        chunks_of({"message": "timeline too large to inline", "url": "https://media.example.com/x.json"})
    assert excinfo.value.urls == ["https://media.example.com/x.json"]


def test_chunks_win_over_links_when_the_body_has_both():
    chunks = chunks_of(
        {
            "speaker_timeline_url": "https://media.example.com/t/abc.json",
            "speaker_timeline": [{"speaker": "A", "start_time": 0, "end_time": 2}],
        }
    )
    assert [c.speaker for c in chunks] == ["A"]


def test_unknown_unit_raises():
    with pytest.raises(TimelineError):
        chunks_of([{"speaker": "A", "start_time": 0, "end_time": 1}], unit="furlongs")


def test_unparseable_timestamp_raises():
    with pytest.raises(TimelineError):
        chunks_of([{"speaker": "A", "start_time": "half past ten", "end_time": "eleven"}])
