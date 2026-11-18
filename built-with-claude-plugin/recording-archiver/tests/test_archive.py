from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest
import responses

from conftest import BASE_URL, BOT_ID, detail_payload
from recording_archiver.archive import Archiver, extension_for, slugify
from recording_archiver.client import MeetStreamClient
from recording_archiver.config import Settings

AUDIO_URL = "https://s3.example.com/bot-123/audio.mp3?sig=1"
VIDEO_URL = "https://s3.example.com/bot-123/video.mp4?sig=1"
ALICE_URL = "https://s3.example.com/bot-123/alice.webm?sig=1"
BOB_URL = "https://s3.example.com/bot-123/bob.webm?sig=1"


@pytest.fixture
def archiver(settings: Settings):
    with MeetStreamClient(settings) as client:
        yield Archiver(settings, client)


def stub_detail(status: str = "Done", audio_status: str = "Success") -> None:
    responses.get(
        f"{BASE_URL}/bots/{BOT_ID}/detail", json=detail_payload(status, audio_status)
    )


def stub_media(
    audio: object = None,
    video: object = None,
    streams: object = None,
    video_status: int = 200,
    streams_status: int = 200,
) -> None:
    responses.get(f"{BASE_URL}/bots/{BOT_ID}/get_audio", json=audio or {"url": AUDIO_URL})
    responses.get(
        f"{BASE_URL}/bots/{BOT_ID}/get_video",
        json=video if video is not None else {"url": VIDEO_URL},
        status=video_status,
    )
    responses.get(
        f"{BASE_URL}/bots/{BOT_ID}/get_audio_streams",
        json=streams if streams is not None else {"participants": []},
        status=streams_status,
    )
    responses.get(AUDIO_URL, body=b"mixed-audio")
    responses.get(VIDEO_URL, body=b"video-bytes")
    responses.get(ALICE_URL, body=b"alice-audio")
    responses.get(BOB_URL, body=b"bob-audio")


# -- slug / extension helpers ------------------------------------------------


@pytest.mark.parametrize(
    "value,expected",
    [
        ("Alice Smith", "alice-smith"),
        ("  Bob  ", "bob"),
        ("Ana María", "ana-mar-a"),
        ("../../etc/passwd", "etc-passwd"),
        ("....//....//x", "x"),
        ("", "participant"),
        ("!!!", "participant"),
    ],
)
def test_slugify_keeps_names_inside_the_archive(value: str, expected: str) -> None:
    slug = slugify(value)

    assert slug == expected
    assert "/" not in slug and ".." not in slug


def test_slugify_bounds_length() -> None:
    assert len(slugify("x" * 500)) == 64


@pytest.mark.parametrize(
    "url,default,expected",
    [
        ("https://s3/a/audio.mp3?sig=1", ".mp3", ".mp3"),
        ("https://s3/a/audio.wav", ".mp3", ".wav"),
        ("https://s3/a/track.webm?X-Amz-Date=x", ".webm", ".webm"),
        ("https://s3/a/object-with-no-extension", ".mp3", ".mp3"),
        ("https://s3/a/weird.exe", ".mp3", ".mp3"),
    ],
)
def test_extension_for(url: str, default: str, expected: str) -> None:
    assert extension_for(url, default) == expected


# -- readiness ---------------------------------------------------------------


@responses.activate
def test_bot_still_in_meeting_is_skipped(archiver: Archiver) -> None:
    stub_detail(status="Recording")

    result = archiver.archive_bot(BOT_ID)

    assert result.archived == []
    assert result.complete is False
    assert any("not finished" in reason for reason in result.skipped)
    # No media endpoint should have been touched.
    assert len(responses.calls) == 1


@responses.activate
def test_stopped_bot_waits_for_processing(archiver: Archiver) -> None:
    """`Stopped` means the bot left; audio is still being produced."""
    stub_detail(status="Stopped", audio_status="Processing")

    result = archiver.archive_bot(BOT_ID)

    assert result.archived == []
    assert len(responses.calls) == 1


@responses.activate
def test_audio_not_ready_is_skipped_without_downloading(
    archiver: Archiver, settings: Settings
) -> None:
    """Other media may still be archived; the bot stays incomplete so audio retries."""
    stub_detail(status="Done", audio_status="Processing")
    stub_media()

    result = archiver.archive_bot(BOT_ID)

    assert "audio.mp3" not in result.archived
    assert not (settings.archive_dir / BOT_ID / "audio.mp3").exists()
    assert result.complete is False
    assert any("audio not ready" in reason for reason in result.skipped)
    requested = {call.request.url.split("/")[-1].split("?")[0] for call in responses.calls}
    assert "get_audio" not in requested


@responses.activate
def test_bot_that_never_recorded_is_settled_once(archiver: Archiver) -> None:
    stub_detail(status="NotAllowed", audio_status="")

    result = archiver.archive_bot(BOT_ID)

    assert result.complete is True
    manifest = archiver.read_manifest(BOT_ID)
    assert manifest["complete"] is True
    assert "no recording" in manifest["note"]


# -- downloading -------------------------------------------------------------


@responses.activate
def test_archives_audio_video_and_participant_tracks(
    archiver: Archiver, settings: Settings
) -> None:
    stub_detail()
    stub_media(
        streams={
            "participants": [
                {"name": "Alice Smith", "url": ALICE_URL},
                {"name": "Bob", "url": BOB_URL},
            ]
        }
    )

    result = archiver.archive_bot(BOT_ID)

    bot_dir = settings.archive_dir / BOT_ID
    assert (bot_dir / "audio.mp3").read_bytes() == b"mixed-audio"
    assert (bot_dir / "video.mp4").read_bytes() == b"video-bytes"
    assert (bot_dir / "participants" / "alice-smith.webm").read_bytes() == b"alice-audio"
    assert (bot_dir / "participants" / "bob.webm").read_bytes() == b"bob-audio"
    assert result.complete is True
    assert result.errors == []


@responses.activate
def test_manifest_records_what_landed_on_disk(
    archiver: Archiver, settings: Settings
) -> None:
    stub_detail()
    stub_media(streams={"participants": [{"name": "Alice", "url": ALICE_URL}]})

    archiver.archive_bot(BOT_ID)

    manifest = json.loads((settings.archive_dir / BOT_ID / "manifest.json").read_text())
    assert manifest["bot_id"] == BOT_ID
    assert manifest["schema_version"] == 1
    assert manifest["complete"] is True
    assert manifest["bot"]["MeetingLink"] == "https://meet.google.com/abc-defg-hij"
    assert manifest["artifacts"]["audio"]["path"] == "audio.mp3"
    assert manifest["artifacts"]["audio"]["bytes"] == len(b"mixed-audio")
    assert manifest["artifacts"]["participant_audio"][0]["participant"] == "Alice"


@responses.activate
def test_multi_segment_participant_audio_is_numbered(
    archiver: Archiver, settings: Settings
) -> None:
    stub_detail()
    stub_media(
        streams={"participants": [{"name": "Alice", "segments": [ALICE_URL, BOB_URL]}]}
    )

    archiver.archive_bot(BOT_ID)

    participants = settings.archive_dir / BOT_ID / "participants"
    assert sorted(p.name for p in participants.iterdir()) == [
        "alice-001.webm",
        "alice-002.webm",
    ]


@responses.activate
def test_participant_name_cannot_escape_the_archive_directory(
    archiver: Archiver, settings: Settings
) -> None:
    stub_detail()
    stub_media(streams={"participants": [{"name": "../../../evil", "url": ALICE_URL}]})

    archiver.archive_bot(BOT_ID)

    written = list(settings.archive_dir.rglob("*.webm"))
    assert len(written) == 1
    assert settings.archive_dir.resolve() in written[0].resolve().parents


# -- "when it's available" ---------------------------------------------------


@responses.activate
def test_no_per_participant_audio_still_completes(
    archiver: Archiver, settings: Settings
) -> None:
    """Bots created without `audio_separate_streams` have no per-speaker tracks."""
    stub_detail()
    stub_media(streams={"participants": []})

    result = archiver.archive_bot(BOT_ID)

    assert result.complete is True
    assert not (settings.archive_dir / BOT_ID / "participants").exists()
    assert archiver.read_manifest(BOT_ID)["artifacts"]["participant_audio"] == "unavailable"


@responses.activate
def test_participant_audio_202_keeps_the_bot_open_for_a_retry(archiver: Archiver) -> None:
    stub_detail()
    stub_media(streams_status=202, streams={})

    result = archiver.archive_bot(BOT_ID)

    assert result.complete is False
    assert archiver.read_manifest(BOT_ID)["complete"] is False


@responses.activate
def test_audio_only_bot_completes_without_video(
    archiver: Archiver, settings: Settings
) -> None:
    stub_detail()
    stub_media(video_status=404, video={})

    result = archiver.archive_bot(BOT_ID)

    assert result.complete is True
    assert (settings.archive_dir / BOT_ID / "audio.mp3").exists()
    assert not (settings.archive_dir / BOT_ID / "video.mp4").exists()
    assert archiver.read_manifest(BOT_ID)["artifacts"]["video"] == "unavailable"


@responses.activate
def test_expired_audio_is_settled_not_retried_forever(archiver: Archiver) -> None:
    stub_detail()
    responses.get(f"{BASE_URL}/bots/{BOT_ID}/get_audio", status=404, json={})
    responses.get(f"{BASE_URL}/bots/{BOT_ID}/get_video", status=404, json={})
    responses.get(f"{BASE_URL}/bots/{BOT_ID}/get_audio_streams", status=404, json={})

    result = archiver.archive_bot(BOT_ID)

    assert result.complete is True
    assert archiver.read_manifest(BOT_ID)["artifacts"]["audio"] == "unavailable"


@responses.activate
def test_config_can_turn_off_video_and_participant_audio(settings: Settings) -> None:
    settings = replace(settings, include_video=False, include_participant_audio=False)
    stub_detail()
    stub_media()

    with MeetStreamClient(settings) as client:
        result = Archiver(settings, client).archive_bot(BOT_ID)

    assert result.complete is True
    assert (settings.archive_dir / BOT_ID / "audio.mp3").exists()
    assert not (settings.archive_dir / BOT_ID / "video.mp4").exists()
    requested = {call.request.url.split("/")[-1].split("?")[0] for call in responses.calls}
    assert "get_video" not in requested
    assert "get_audio_streams" not in requested


# -- idempotency -------------------------------------------------------------


@responses.activate
def test_second_run_does_not_redownload(archiver: Archiver, settings: Settings) -> None:
    stub_detail()
    stub_media(streams={"participants": [{"name": "Alice", "url": ALICE_URL}]})
    archiver.archive_bot(BOT_ID)
    downloads_after_first = len([c for c in responses.calls if "s3.example.com" in c.request.url])

    second = archiver.archive_bot(BOT_ID)

    assert second.archived == []
    downloads_total = len([c for c in responses.calls if "s3.example.com" in c.request.url])
    assert downloads_total == downloads_after_first


@responses.activate
def test_deleted_file_is_fetched_again(archiver: Archiver, settings: Settings) -> None:
    stub_detail()
    stub_media(streams={"participants": []})
    archiver.archive_bot(BOT_ID)
    (settings.archive_dir / BOT_ID / "audio.mp3").unlink()

    result = archiver.archive_bot(BOT_ID)

    assert "audio.mp3" in result.archived
    assert (settings.archive_dir / BOT_ID / "audio.mp3").exists()


@responses.activate
def test_sweep_skips_bots_already_marked_complete(
    archiver: Archiver, settings: Settings
) -> None:
    responses.get(
        f"{BASE_URL}/bots", json={"bots": [{"bot_id": BOT_ID}], "hasNextPage": False}
    )
    stub_detail()
    stub_media(streams={"participants": []})
    archiver.sweep()
    calls_after_first = len(responses.calls)

    result = archiver.sweep()

    assert result.bots_seen == 1
    assert result.bots_archived == 0
    # Only the /bots listing call, no /detail and no media calls.
    assert len(responses.calls) == calls_after_first + 1


# -- failures ----------------------------------------------------------------


@responses.activate
def test_missing_download_url_is_an_error_not_a_crash(archiver: Archiver) -> None:
    stub_detail()
    stub_media(audio={"message": "something unexpected"})

    result = archiver.archive_bot(BOT_ID)

    assert any("no download URL" in err for err in result.errors)
    assert result.complete is False


@responses.activate
def test_one_failing_bot_does_not_stop_the_sweep(archiver: Archiver) -> None:
    responses.get(
        f"{BASE_URL}/bots",
        json={"bots": [{"bot_id": "bad"}, {"bot_id": BOT_ID}], "hasNextPage": False},
    )
    responses.get(f"{BASE_URL}/bots/bad/detail", status=500, body="nope")
    stub_detail()
    stub_media(streams={"participants": []})

    result = archiver.sweep()

    assert result.bots_seen == 2
    assert result.bots_archived == 1
    assert len(result.errors) == 1
    assert result.errors[0].startswith("bad:")


@responses.activate
def test_dry_run_writes_nothing(archiver: Archiver, settings: Settings) -> None:
    stub_detail()
    stub_media(streams={"participants": [{"name": "Alice", "url": ALICE_URL}]})

    result = archiver.archive_bot(BOT_ID, dry_run=True)

    assert sorted(result.archived) == [
        "audio.mp3",
        "participants/alice.webm",
        "video.mp4",
    ]
    assert not settings.archive_dir.exists() or list(settings.archive_dir.rglob("*")) == []
