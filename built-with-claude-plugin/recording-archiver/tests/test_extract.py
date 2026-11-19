"""The media endpoints are documented by behaviour, not by an exact JSON key,
so the extractors accept every shape the API is known to return."""

from __future__ import annotations

import pytest

from recording_archiver.extract import extract_media_url, extract_participant_streams

URL = "https://s3.example.com/bot-123/audio.mp3?X-Amz-Signature=abc"


@pytest.mark.parametrize(
    "payload",
    [
        URL,
        {"url": URL},
        {"audio_url": URL},
        {"download_url": URL},
        {"presigned_url": URL},
        {"data": {"url": URL}},
        {"result": {"audio": {"download_url": URL}}},
        [{"url": URL}],
    ],
)
def test_extract_media_url_handles_known_shapes(payload: object) -> None:
    assert extract_media_url(payload) == URL


def test_specific_key_wins_over_generic_key() -> None:
    payload = {"url": "https://other.example.com/x.mp3", "audio_url": URL}

    assert extract_media_url(payload) == URL


@pytest.mark.parametrize(
    "payload",
    [None, {}, [], {"message": "not ready"}, {"url": "not-a-url"}, 42],
)
def test_extract_media_url_returns_none_when_absent(payload: object) -> None:
    assert extract_media_url(payload) is None


def test_extract_media_url_ignores_deeply_nested_garbage() -> None:
    payload: dict = {"a": {"b": {"c": {"d": {"e": {"f": {"g": {"url": URL}}}}}}}}

    assert extract_media_url(payload) is None


def test_participant_streams_from_participants_list() -> None:
    payload = {
        "participants": [
            {"name": "Alice", "url": "https://s3/a.webm"},
            {"name": "Bob", "url": "https://s3/b.webm"},
        ]
    }

    streams = extract_participant_streams(payload)

    assert [s.participant for s in streams] == ["Alice", "Bob"]
    assert streams[0].segments == ["https://s3/a.webm"]


def test_participant_streams_with_multiple_segments() -> None:
    payload = {
        "audio_streams": [
            {
                "displayName": "Alice",
                "segments": [
                    {"url": "https://s3/a1.webm"},
                    {"url": "https://s3/a2.webm"},
                ],
            }
        ]
    }

    streams = extract_participant_streams(payload)

    assert len(streams) == 1
    assert streams[0].segments == ["https://s3/a1.webm", "https://s3/a2.webm"]


def test_one_object_per_segment_is_merged_per_participant() -> None:
    payload = [
        {"participant_name": "Alice", "url": "https://s3/a1.webm"},
        {"participant_name": "Bob", "url": "https://s3/b1.webm"},
        {"participant_name": "Alice", "url": "https://s3/a2.webm"},
    ]

    streams = extract_participant_streams(payload)

    assert [s.participant for s in streams] == ["Alice", "Bob"]
    assert streams[0].segments == ["https://s3/a1.webm", "https://s3/a2.webm"]


def test_participant_streams_from_name_keyed_mapping() -> None:
    payload = {"participants": {"Alice": ["https://s3/a1.webm", "https://s3/a2.webm"]}}

    streams = extract_participant_streams(payload)

    assert streams[0].participant == "Alice"
    assert streams[0].segments == ["https://s3/a1.webm", "https://s3/a2.webm"]


def test_participant_falls_back_to_device_id_then_index() -> None:
    payload = {
        "participants": [
            {"deviceId": "device-7", "url": "https://s3/a.webm"},
            {"url": "https://s3/b.webm"},
        ]
    }

    streams = extract_participant_streams(payload)

    assert [s.participant for s in streams] == ["device-7", "participant-2"]


def test_entries_without_urls_are_dropped() -> None:
    payload = {"participants": [{"name": "Ghost"}, {"name": "Alice", "url": "https://s3/a.webm"}]}

    streams = extract_participant_streams(payload)

    assert [s.participant for s in streams] == ["Alice"]


def test_duplicate_urls_are_not_downloaded_twice() -> None:
    payload = {"participants": [{"name": "Alice", "segments": ["https://s3/a.webm"] * 3}]}

    assert extract_participant_streams(payload)[0].segments == ["https://s3/a.webm"]


@pytest.mark.parametrize("payload", [{}, {"participants": []}, None, {"message": "no streams"}])
def test_no_participant_streams(payload: object) -> None:
    assert extract_participant_streams(payload) == []
