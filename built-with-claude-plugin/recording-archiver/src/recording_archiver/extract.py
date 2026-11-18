"""Pull media URLs out of MeetStream media responses.

The media endpoints are documented by behaviour ("returns a pre-signed S3 URL",
"per-segment URLs") rather than by an exact JSON key, so these helpers accept any
of the shapes the API is known to use instead of hard-coding one field name. Every
shape handled here has a test in tests/test_extract.py.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# Checked in order, so a specific key wins over a generic one.
URL_KEYS = (
    "audio_url",
    "video_url",
    "download_url",
    "presigned_url",
    "signed_url",
    "media_url",
    "recording_url",
    "s3_url",
    "url",
    "link",
    "href",
)

# Wrappers the payload may be nested inside.
CONTAINER_KEYS = ("data", "result", "results", "recording", "audio", "video", "media")

# Keys that hold a list of per-participant entries.
PARTICIPANT_LIST_KEYS = (
    "participants",
    "audio_streams",
    "streams",
    "recording_streams",
    "tracks",
)

# Keys that hold a list of segments within one participant entry.
SEGMENT_LIST_KEYS = ("segments", "streams", "urls", "files", "chunks", "parts", "audio")

NAME_KEYS = (
    "participant_name",
    "display_name",
    "displayName",
    "speaker_name",
    "full_name",
    "fullName",
    "speaker",
    "participant",
    "name",
)

ID_KEYS = ("participant_id", "device_id", "deviceId", "stream_id", "streamId", "id")

_MAX_DEPTH = 6


def _is_url(value: Any) -> bool:
    return isinstance(value, str) and value.startswith(("http://", "https://"))


def extract_media_url(payload: Any, _depth: int = 0) -> str | None:
    """Return the first pre-signed media URL in a get_audio / get_video response."""
    if _is_url(payload):
        return payload
    if _depth >= _MAX_DEPTH:
        return None

    if isinstance(payload, dict):
        for key in URL_KEYS:
            if _is_url(payload.get(key)):
                return payload[key]
        for key in CONTAINER_KEYS:
            if key in payload:
                found = extract_media_url(payload[key], _depth + 1)
                if found:
                    return found
        for value in payload.values():
            if isinstance(value, (dict, list)):
                found = extract_media_url(value, _depth + 1)
                if found:
                    return found
        return None

    if isinstance(payload, list):
        for item in payload:
            found = extract_media_url(item, _depth + 1)
            if found:
                return found
    return None


@dataclass
class ParticipantStream:
    """One participant's audio, as one or more ordered segment URLs."""

    participant: str
    segments: list[str] = field(default_factory=list)


def _label_from(entry: Any) -> str | None:
    if not isinstance(entry, dict):
        return None
    for key in NAME_KEYS + ID_KEYS:
        value = entry.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        # A nested {"participant": {"name": ...}} still gives us a label.
        nested = _label_from(value)
        if nested:
            return nested
    return None


def _participant_label(entry: Any, index: int) -> str:
    return _label_from(entry) or f"participant-{index + 1}"


def _segment_urls(entry: Any) -> list[str]:
    """Collect every URL belonging to one participant entry, in order."""
    urls: list[str] = []

    def add(value: Any) -> None:
        if _is_url(value):
            if value not in urls:
                urls.append(value)
        elif isinstance(value, dict):
            found = extract_media_url(value)
            if found and found not in urls:
                urls.append(found)
        elif isinstance(value, list):
            for item in value:
                add(item)

    if _is_url(entry):
        return [entry]
    if not isinstance(entry, dict):
        return urls

    for key in SEGMENT_LIST_KEYS:
        if key in entry:
            add(entry[key])
    if not urls:
        for key in URL_KEYS:
            if key in entry:
                add(entry[key])
    return urls


def extract_participant_streams(payload: Any) -> list[ParticipantStream]:
    """Normalise a get_audio_streams response into one entry per participant.

    Entries with no usable URL are dropped. Participants that appear more than
    once (one object per segment) are merged, preserving segment order.
    """
    entries = _participant_entries(payload)

    merged: dict[str, ParticipantStream] = {}
    order: list[str] = []
    for index, entry in enumerate(entries):
        urls = _segment_urls(entry)
        if not urls:
            continue
        label = _participant_label(entry, index)
        stream = merged.get(label)
        if stream is None:
            stream = ParticipantStream(participant=label)
            merged[label] = stream
            order.append(label)
        for url in urls:
            if url not in stream.segments:
                stream.segments.append(url)
    return [merged[label] for label in order]


def _participant_entries(payload: Any) -> list[Any]:
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []

    for key in PARTICIPANT_LIST_KEYS:
        value = payload.get(key)
        if isinstance(value, list):
            return value
        if isinstance(value, dict):
            # {"participants": {"Alice": [...], "Bob": [...]}}
            return [_labelled(name, item) for name, item in value.items()]

    for key in CONTAINER_KEYS:
        if key in payload:
            entries = _participant_entries(payload[key])
            if entries:
                return entries
    return []


def _labelled(name: str, value: Any) -> dict[str, Any]:
    entry: dict[str, Any] = {"name": name}
    if isinstance(value, dict):
        entry.update(value)
    else:
        entry["segments"] = value
    return entry
