"""Streaming reader for a MeetStream speaker timeline.

``GET /bots/{bot_id}/get_speaker_timeline`` returns chunks carrying **byte
offsets into the recorded audio**, not seconds. Shares and turn counts are exact
either way; seconds are derived with ``bytes_per_second``. Saved timelines from
other tools sometimes carry seconds, milliseconds or ISO timestamps instead, so
the unit is detected from the field names and can be forced.

Parsing is event-based (ijson), so a multi-hour timeline is never held in
memory: one chunk dict at a time, whatever the file size.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterator, Optional, Tuple

import ijson

BYTES = "bytes"
SECONDS = "seconds"
MILLISECONDS = "milliseconds"
ISO = "iso8601"
AUTO = "auto"

UNITS = (AUTO, BYTES, SECONDS, MILLISECONDS, ISO)

# Checked in order; first key present on the chunk wins.
SPEAKER_KEYS = (
    "speakername",
    "speaker",
    "participantname",
    "participant.name",
    "participant.displayname",
    "participant.fullname",
    "participant.speakername",
    "displayname",
    "fullname",
    "name",
    "participant",
)
START_KEYS = (
    "startbyte",
    "startbytes",
    "bytestart",
    "startoffset",
    "offsetstart",
    "startms",
    "startmillis",
    "starttime",
    "absolutestarttime",
    "start",
    "begin",
    "from",
    "offset",
)
END_KEYS = (
    "endbyte",
    "endbytes",
    "byteend",
    "endoffset",
    "offsetend",
    "endms",
    "endmillis",
    "endtime",
    "absoluteendtime",
    "end",
    "stop",
    "to",
)
LENGTH_KEYS = (
    "bytelength",
    "lengthbytes",
    "numbytes",
    "nbytes",
    "bytes",
    "durationms",
    "durationmillis",
    "durationseconds",
    "duration",
    "length",
    "size",
)

_BYTEISH = ("byte", "offset", "bytes", "size", "nbytes")
_MILLISISH = ("ms", "millis")

# A long meeting's timeline comes back as links to the chunks rather than the
# chunks themselves. Keys whose path mentions one of these hold the timeline;
# anything else in the envelope (a docs link, a support URL) is left alone.
_TIMELINE_LINK_TOKENS = ("timeline", "chunk", "segment", "part")
_MESSAGE_KEYS = ("message", "detail", "error", "reason")
# Caps so a hostile or runaway body cannot grow the envelope summary unbounded.
MAX_TIMELINE_LINKS = 64
_MAX_ENVELOPE_KEYS = 20


class TimelineError(ValueError):
    """The timeline could not be read as a speaker timeline."""


class TimelineElsewhere(TimelineError):
    """The JSON held no chunks, but said where they are.

    ``get_speaker_timeline`` answers 200 for a long meeting with an envelope
    carrying one or more links to the timeline JSON instead of the chunks
    inline. ``urls`` is the ordered list of links to read in sequence.
    """

    def __init__(self, urls, keys):
        self.urls = list(urls)
        self.keys = list(keys)
        super().__init__(
            "the JSON holds no timeline chunks, only {} link(s) to them "
            "(top-level keys: {})".format(len(self.urls), ", ".join(self.keys) or "-")
        )


@dataclass
class Chunk:
    speaker: str
    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


@dataclass
class ParseReport:
    """Counters filled in while the timeline streams past."""

    chunks_read: int = 0
    chunks_used: int = 0
    skipped_no_speaker_field: int = 0
    skipped_no_timing: int = 0
    skipped_negative_duration: int = 0
    unit: Optional[str] = None
    field_mapping: Dict[str, str] = field(default_factory=dict)


def _normalise_key(key: str) -> str:
    return key.lower().replace("_", "").replace("-", "").strip()


def _infer_unit(key: str, value: Any) -> str:
    """Guess the unit a timing field is expressed in, from its name and value."""
    if isinstance(value, str):
        try:
            float(value.strip())
        except ValueError:
            return ISO
        # A number that arrived quoted: fall through to the name-based rules.
    if any(token in key for token in _BYTEISH):
        return BYTES
    if any(key.endswith(token) for token in _MILLISISH):
        return MILLISECONDS
    return SECONDS


def _parse_iso(value: str) -> float:
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        raise TimelineError("could not read {!r} as an ISO-8601 timestamp".format(value))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def _to_seconds(value: Any, unit: str, bytes_per_second: int) -> float:
    if unit == ISO:
        if not isinstance(value, str):
            raise TimelineError("expected an ISO-8601 timestamp, got {!r}".format(value))
        return _parse_iso(value)
    if isinstance(value, str):
        # A number that arrived quoted, or an ISO timestamp in a numeric-looking field.
        try:
            value = float(value)
        except ValueError:
            return _parse_iso(value)
    number = float(value)
    if unit == BYTES:
        return number / bytes_per_second
    if unit == MILLISECONDS:
        return number / 1000.0
    return number


def _pick(record: Dict[str, Any], candidates: Tuple[str, ...]) -> Optional[Tuple[str, Any]]:
    for candidate in candidates:
        if candidate in record and record[candidate] is not None:
            return candidate, record[candidate]
    return None


def _select_links(links: Tuple[Tuple[str, str], ...]) -> list:
    """Pick the links that point at the timeline itself, in document order."""
    for token in _TIMELINE_LINK_TOKENS:
        matching = [url for key, url in links if token in _normalise_key(key)]
        if matching:
            return matching[:MAX_TIMELINE_LINKS]
    return [url for _, url in links][:MAX_TIMELINE_LINKS]


def _iter_records(stream) -> Iterator[Tuple[Dict[str, Any], Dict[str, str]]]:
    """Yield each object of the first array of objects found in the JSON stream.

    Handles both documented shapes - a top-level array, and an object wrapping
    the array under any key (``speaker_timeline``, ``timeline``, ...) at any
    depth - in a single pass, holding one record at a time.

    Each record comes with a map from the normalised key back to the key as the
    API spelled it, so the report can show which fields were actually read.

    When the document turns out to hold no chunks at all, whatever the envelope
    did carry - links, a message - is raised rather than lost: a long meeting
    answers with links to the chunks instead of the chunks.
    """
    target: Optional[str] = None
    record: Optional[Dict[str, Any]] = None
    raw_keys: Dict[str, str] = {}
    links: list = []
    envelope_keys: list = []
    message: Optional[str] = None

    for prefix, event, value in ijson.parse(stream):
        if event == "start_map":
            if target is None and (prefix == "item" or prefix.endswith(".item")):
                target = prefix
            if prefix == target:
                record = {}
                raw_keys = {}
            continue
        if target is None:
            # Still outside any array of objects: remember what the envelope says.
            if prefix and len(envelope_keys) < _MAX_ENVELOPE_KEYS:
                top = prefix.split(".")[0]
                if top not in envelope_keys:
                    envelope_keys.append(top)
            if event == "string":
                if value.startswith(("https://", "http://")) and len(links) < MAX_TIMELINE_LINKS * 4:
                    links.append((prefix, value))
                elif message is None and _normalise_key(prefix.split(".")[-1]) in _MESSAGE_KEYS:
                    message = value
            continue
        if record is None:
            continue
        if prefix == target and event == "end_map":
            yield record, raw_keys
            record = None
            continue
        if event in ("string", "number", "boolean", "null") and prefix.startswith(target + "."):
            raw_key = prefix[len(target) + 1 :]
            normalised = _normalise_key(raw_key)
            record[normalised] = value
            raw_keys[normalised] = raw_key

    if target is None:
        if links:
            raise TimelineElsewhere(_select_links(tuple(links)), envelope_keys)
        detail = ""
        if envelope_keys:
            detail += " (top-level keys: {})".format(", ".join(envelope_keys))
        if message:
            detail += " - the API said: {}".format(message)
        raise TimelineError(
            "no array of timeline chunks found in the JSON - expected a top-level array, "
            "or an object with the chunks under a key such as 'speaker_timeline'" + detail
        )


def read_chunks(
    stream,
    bytes_per_second: int,
    unit: str = AUTO,
    report: Optional[ParseReport] = None,
) -> Iterator[Chunk]:
    """Stream ``stream`` and yield :class:`Chunk` objects with times in seconds."""
    if unit not in UNITS:
        raise TimelineError("unknown unit {!r}, expected one of {}".format(unit, ", ".join(UNITS)))
    report = report if report is not None else ParseReport()
    resolved = None if unit == AUTO else unit

    for record, raw_keys in _iter_records(stream):
        report.chunks_read += 1

        speaker_field = _pick(record, SPEAKER_KEYS)
        if speaker_field is None:
            report.skipped_no_speaker_field += 1
            continue
        speaker_key, speaker_value = speaker_field
        speaker = str(speaker_value).strip()
        if not speaker:
            report.skipped_no_speaker_field += 1
            continue

        start_field = _pick(record, START_KEYS)
        if start_field is None:
            report.skipped_no_timing += 1
            continue
        start_key, start_value = start_field

        if resolved is None:
            resolved = _infer_unit(start_key, start_value)
            report.unit = resolved
        elif report.unit is None:
            report.unit = resolved

        end_field = _pick(record, END_KEYS)
        length_field = None
        if end_field is None:
            length_field = _pick(record, LENGTH_KEYS)
            if length_field is None:
                report.skipped_no_timing += 1
                continue

        if not report.field_mapping:
            report.field_mapping = {
                "speaker": raw_keys.get(speaker_key, speaker_key),
                "start": raw_keys.get(start_key, start_key),
                "end": raw_keys.get(end_field[0], end_field[0]) if end_field else "",
                "length": raw_keys.get(length_field[0], length_field[0]) if length_field else "",
            }

        start = _to_seconds(start_value, resolved, bytes_per_second)
        if end_field is not None:
            end = _to_seconds(end_field[1], resolved, bytes_per_second)
        else:
            length_key, length_value = length_field  # type: ignore[misc]
            length_unit = resolved if unit != AUTO else _infer_unit(length_key, length_value)
            end = start + _to_seconds(length_value, length_unit, bytes_per_second)

        if end < start:
            report.skipped_negative_duration += 1
            continue

        report.chunks_used += 1
        yield Chunk(speaker=speaker, start=start, end=end)
