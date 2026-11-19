"""Aggregate timeline chunks into per-speaker talk-time stats.

Single pass, O(number of speakers) memory, so a multi-hour meeting costs the
same as a ten-minute one.

Definitions used here:

* **total seconds** - the union of a speaker's chunks. Overlapping or duplicated
  chunks for the same speaker are counted once.
* **turn** - a run of that speaker's chunks separated by less than
  ``turn_gap_seconds``. Raw timelines chunk every ~250 ms, so without this
  merge every chunk would read as its own turn.
* **longest stretch** - the longest such run, measured end-to-start, i.e. how
  long they held the floor without a pause longer than the gap threshold.
* **share** - total seconds over the sum of every speaker's total seconds. When
  people talk over each other the shares still add to 100%, but the sum of
  talk-time exceeds the wall-clock length of the meeting.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional

from .timeline import Chunk


@dataclass
class SpeakerStats:
    speaker: str
    total_seconds: float = 0.0
    turns: int = 0
    longest_stretch_seconds: float = 0.0
    first_spoke_at: Optional[float] = None
    last_spoke_at: Optional[float] = None
    share: float = 0.0


@dataclass
class _Run:
    start: float
    end: float
    speech: float


@dataclass
class TalkTimeReport:
    speakers: List[SpeakerStats] = field(default_factory=list)
    total_speech_seconds: float = 0.0
    meeting_span_seconds: float = 0.0
    timeline_start: float = 0.0
    unattributed_seconds: float = 0.0
    out_of_order_chunks: int = 0
    turn_gap_seconds: float = 1.0


class _Accumulator:
    """Per-speaker running state: the open run plus the totals so far."""

    __slots__ = ("stats", "run")

    def __init__(self, speaker: str) -> None:
        self.stats = SpeakerStats(speaker=speaker)
        self.run: Optional[_Run] = None

    def add(self, start: float, end: float, turn_gap: float) -> bool:
        """Fold one chunk in. Returns True if the chunk arrived out of order."""
        out_of_order = False
        stats = self.stats
        if stats.first_spoke_at is None or start < stats.first_spoke_at:
            stats.first_spoke_at = start
        if stats.last_spoke_at is None or end > stats.last_spoke_at:
            stats.last_spoke_at = end

        run = self.run
        if run is None:
            self.run = _Run(start=start, end=end, speech=end - start)
            return out_of_order

        if start < run.start:
            # The timeline is meant to be ordered; tolerate a stray chunk by
            # folding it into the open run rather than losing it.
            out_of_order = True
        if start <= run.end + turn_gap:
            # Count only the part that extends the run, on either side, so
            # overlapping or repeated chunks are not double counted.
            run.speech += max(0.0, min(end, run.start) - start) + max(0.0, end - max(start, run.end))
            run.start = min(run.start, start)
            run.end = max(run.end, end)
        else:
            self._close(run)
            self.run = _Run(start=start, end=end, speech=end - start)
        return out_of_order

    def _close(self, run: _Run) -> None:
        stats = self.stats
        stats.turns += 1
        stats.total_seconds += run.speech
        stretch = run.end - run.start
        if stretch > stats.longest_stretch_seconds:
            stats.longest_stretch_seconds = stretch

    def finish(self) -> SpeakerStats:
        if self.run is not None:
            self._close(self.run)
            self.run = None
        return self.stats


def aggregate(
    chunks: Iterable[Chunk],
    turn_gap_seconds: float = 1.0,
    unattributed_labels: Iterable[str] = (),
) -> TalkTimeReport:
    """Fold a stream of chunks into a :class:`TalkTimeReport`."""
    ignored = {label.casefold() for label in unattributed_labels}
    accumulators: Dict[str, _Accumulator] = {}
    unattributed = _Accumulator("__unattributed__")
    report = TalkTimeReport(turn_gap_seconds=turn_gap_seconds)
    earliest: Optional[float] = None
    latest: Optional[float] = None

    for chunk in chunks:
        if earliest is None or chunk.start < earliest:
            earliest = chunk.start
        if latest is None or chunk.end > latest:
            latest = chunk.end

        if chunk.speaker.casefold() in ignored:
            unattributed.add(chunk.start, chunk.end, turn_gap_seconds)
            continue

        accumulator = accumulators.get(chunk.speaker)
        if accumulator is None:
            accumulator = _Accumulator(chunk.speaker)
            accumulators[chunk.speaker] = accumulator
        if accumulator.add(chunk.start, chunk.end, turn_gap_seconds):
            report.out_of_order_chunks += 1

    speakers = [accumulator.finish() for accumulator in accumulators.values()]
    report.unattributed_seconds = unattributed.finish().total_seconds
    report.total_speech_seconds = sum(speaker.total_seconds for speaker in speakers)
    if report.total_speech_seconds > 0:
        for speaker in speakers:
            speaker.share = speaker.total_seconds / report.total_speech_seconds
    if earliest is not None and latest is not None:
        report.meeting_span_seconds = latest - earliest
        report.timeline_start = earliest

    speakers.sort(key=lambda s: (-s.total_seconds, s.speaker))
    report.speakers = speakers
    return report
