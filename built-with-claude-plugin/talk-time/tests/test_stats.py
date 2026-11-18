from __future__ import annotations

import pytest

from talk_time.stats import aggregate
from talk_time.timeline import Chunk


def by_name(report):
    return {speaker.speaker: speaker for speaker in report.speakers}


def test_totals_shares_and_ordering():
    report = aggregate(
        [
            Chunk("Alice", 0, 30),
            Chunk("Bob", 40, 50),
            Chunk("Alice", 60, 70),
        ]
    )
    stats = by_name(report)
    assert stats["Alice"].total_seconds == pytest.approx(40.0)
    assert stats["Bob"].total_seconds == pytest.approx(10.0)
    assert stats["Alice"].share == pytest.approx(0.8)
    assert stats["Bob"].share == pytest.approx(0.2)
    assert report.total_speech_seconds == pytest.approx(50.0)
    assert report.meeting_span_seconds == pytest.approx(70.0)
    assert [speaker.speaker for speaker in report.speakers] == ["Alice", "Bob"]


def test_adjacent_chunks_merge_into_one_turn():
    # 40 chunks of 250 ms, back to back: one turn, not forty.
    chunks = [Chunk("Alice", i * 0.25, (i + 1) * 0.25) for i in range(40)]
    stats = by_name(aggregate(chunks))["Alice"]
    assert stats.turns == 1
    assert stats.total_seconds == pytest.approx(10.0)
    assert stats.longest_stretch_seconds == pytest.approx(10.0)


def test_gap_longer_than_threshold_starts_a_new_turn():
    chunks = [Chunk("Alice", 0, 5), Chunk("Alice", 5.5, 8), Chunk("Alice", 20, 23)]
    stats = by_name(aggregate(chunks, turn_gap_seconds=1.0))["Alice"]
    assert stats.turns == 2
    assert stats.total_seconds == pytest.approx(10.5)
    # The 0.5 s pause stays inside the first turn, so the stretch is 0 -> 8.
    assert stats.longest_stretch_seconds == pytest.approx(8.0)


def test_turn_gap_is_configurable():
    chunks = [Chunk("Alice", 0, 5), Chunk("Alice", 7, 9)]
    assert by_name(aggregate(chunks, turn_gap_seconds=1.0))["Alice"].turns == 2
    assert by_name(aggregate(chunks, turn_gap_seconds=5.0))["Alice"].turns == 1


def test_longest_stretch_is_the_longest_turn():
    chunks = [
        Chunk("Alice", 0, 4),
        Chunk("Bob", 10, 12),
        Chunk("Alice", 20, 35),
        Chunk("Alice", 35, 38),
        Chunk("Alice", 60, 62),
    ]
    stats = by_name(aggregate(chunks))["Alice"]
    assert stats.turns == 3
    assert stats.longest_stretch_seconds == pytest.approx(18.0)


def test_overlapping_chunks_for_one_speaker_are_counted_once():
    chunks = [Chunk("Alice", 0, 10), Chunk("Alice", 5, 15), Chunk("Alice", 6, 8)]
    stats = by_name(aggregate(chunks))["Alice"]
    assert stats.total_seconds == pytest.approx(15.0)
    assert stats.turns == 1


def test_cross_talk_keeps_shares_at_one_hundred_percent():
    report = aggregate([Chunk("Alice", 0, 10), Chunk("Bob", 5, 15)])
    assert sum(speaker.share for speaker in report.speakers) == pytest.approx(1.0)
    # Talk time exceeds the wall clock because they spoke over each other.
    assert report.total_speech_seconds == pytest.approx(20.0)
    assert report.meeting_span_seconds == pytest.approx(15.0)


def test_unattributed_audio_is_reported_separately():
    report = aggregate(
        [Chunk("Alice", 0, 10), Chunk("NoSpeaker", 10, 14), Chunk("Bob", 14, 24)],
        unattributed_labels=["NoSpeaker"],
    )
    assert [speaker.speaker for speaker in report.speakers] == ["Alice", "Bob"]
    assert report.unattributed_seconds == pytest.approx(4.0)
    assert report.total_speech_seconds == pytest.approx(20.0)
    assert report.meeting_span_seconds == pytest.approx(24.0)


def test_unattributed_labels_are_case_insensitive():
    report = aggregate([Chunk("nospeaker", 0, 5), Chunk("Alice", 5, 10)], unattributed_labels=["NoSpeaker"])
    assert [speaker.speaker for speaker in report.speakers] == ["Alice"]


def test_first_and_last_spoke_at():
    report = aggregate([Chunk("Alice", 3, 9), Chunk("Bob", 10, 12), Chunk("Alice", 30, 31)])
    stats = by_name(report)
    assert stats["Alice"].first_spoke_at == pytest.approx(3.0)
    assert stats["Alice"].last_spoke_at == pytest.approx(31.0)
    assert report.timeline_start == pytest.approx(3.0)


def test_out_of_order_chunks_are_counted_and_kept():
    report = aggregate([Chunk("Alice", 10, 20), Chunk("Alice", 5, 9.5)])
    stats = by_name(report)["Alice"]
    assert report.out_of_order_chunks == 1
    assert stats.total_seconds == pytest.approx(14.5)
    assert stats.turns == 1


def test_empty_timeline():
    report = aggregate([])
    assert report.speakers == []
    assert report.total_speech_seconds == 0.0
    assert report.meeting_span_seconds == 0.0


def test_speakers_with_no_speech_still_appear():
    report = aggregate([Chunk("Alice", 5, 5)])
    stats = by_name(report)["Alice"]
    assert stats.total_seconds == 0.0
    assert stats.turns == 1
    assert stats.share == 0.0
