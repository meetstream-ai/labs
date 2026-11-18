from __future__ import annotations

from pathlib import Path

import pytest
import responses

from conftest import BASE_URL, BOT_ID, detail_payload
from recording_archiver.client import MeetStreamClient, MeetStreamError
from recording_archiver.config import Settings


@pytest.fixture
def client(settings: Settings) -> MeetStreamClient:
    with MeetStreamClient(settings) as c:
        yield c


@responses.activate
def test_api_calls_send_the_token_header(client: MeetStreamClient) -> None:
    responses.get(f"{BASE_URL}/bots/{BOT_ID}/detail", json=detail_payload())

    client.get_bot_detail(BOT_ID)

    assert responses.calls[0].request.headers["Authorization"] == "Token test-key"


@responses.activate
def test_get_bot_detail_unwraps_bot_details(client: MeetStreamClient) -> None:
    responses.get(f"{BASE_URL}/bots/{BOT_ID}/detail", json=detail_payload())

    detail = client.get_bot_detail(BOT_ID)

    assert detail["Status"] == "Done"
    assert detail["AudioStatus"] == "Success"


@responses.activate
def test_media_202_is_not_ready_not_an_error(client: MeetStreamClient) -> None:
    responses.get(f"{BASE_URL}/bots/{BOT_ID}/get_audio_streams", status=202, json={})

    result = client.get_audio_streams(BOT_ID)

    assert result.ready is False
    assert "202" in result.reason


@responses.activate
def test_media_404_is_reported_as_unavailable(client: MeetStreamClient) -> None:
    responses.get(f"{BASE_URL}/bots/{BOT_ID}/get_video", status=404, json={})

    result = client.get_video(BOT_ID)

    assert result.ready is False
    assert "404" in result.reason


@responses.activate
def test_media_500_raises(client: MeetStreamClient) -> None:
    responses.get(f"{BASE_URL}/bots/{BOT_ID}/get_audio", status=500, body="boom")

    with pytest.raises(MeetStreamError, match="500"):
        client.get_audio(BOT_ID)


@responses.activate
def test_media_endpoint_may_return_a_bare_url(client: MeetStreamClient) -> None:
    responses.get(
        f"{BASE_URL}/bots/{BOT_ID}/get_audio",
        status=200,
        body="https://s3.example.com/a.mp3",
        content_type="text/plain",
    )

    result = client.get_audio(BOT_ID)

    assert result.ready is True
    assert result.payload == "https://s3.example.com/a.mp3"


@responses.activate
def test_download_writes_file_without_the_api_token(
    client: MeetStreamClient, tmp_path: Path
) -> None:
    url = "https://s3.example.com/a.mp3?sig=1"
    responses.get(url, body=b"audio-bytes")
    destination = tmp_path / "nested" / "audio.mp3"

    written = client.download(url, destination)

    assert written == len(b"audio-bytes")
    assert destination.read_bytes() == b"audio-bytes"
    # S3 rejects pre-signed requests that also carry an Authorization header.
    assert "Authorization" not in responses.calls[0].request.headers


@responses.activate
def test_failed_download_leaves_no_partial_file(
    client: MeetStreamClient, tmp_path: Path
) -> None:
    url = "https://s3.example.com/a.mp3"
    responses.get(url, status=403, body="expired")
    destination = tmp_path / "audio.mp3"

    with pytest.raises(MeetStreamError, match="403"):
        client.download(url, destination)

    assert not destination.exists()
    assert list(tmp_path.glob("*.part")) == []


@responses.activate
def test_empty_download_is_rejected(client: MeetStreamClient, tmp_path: Path) -> None:
    url = "https://s3.example.com/a.mp3"
    responses.get(url, body=b"")
    destination = tmp_path / "audio.mp3"

    with pytest.raises(MeetStreamError, match="empty"):
        client.download(url, destination)

    assert not destination.exists()


@responses.activate
def test_iter_bots_follows_the_cursor(client: MeetStreamClient) -> None:
    responses.get(
        f"{BASE_URL}/bots",
        json={"bots": [{"bot_id": "a"}], "hasNextPage": True, "nextCursor": "c1"},
    )
    responses.get(
        f"{BASE_URL}/bots",
        json={"bots": [{"bot_id": "b"}], "hasNextPage": False, "nextCursor": None},
    )

    assert [b["bot_id"] for b in client.iter_bots()] == ["a", "b"]
    assert responses.calls[1].request.params["cursor"] == "c1"


@responses.activate
def test_iter_bots_stops_if_the_cursor_repeats(client: MeetStreamClient) -> None:
    """A pagination contract that never advances must not loop forever."""
    responses.get(
        f"{BASE_URL}/bots",
        json={"bots": [{"bot_id": "a"}], "hasNextPage": True, "nextCursor": "same"},
    )

    bots = list(client.iter_bots())

    assert [b["bot_id"] for b in bots] == ["a", "a"]
    assert len(responses.calls) == 2


@responses.activate
def test_iter_bots_honours_the_page_cap(settings: Settings) -> None:
    responses.get(
        f"{BASE_URL}/bots",
        json={"bots": [{"bot_id": "a"}], "hasNextPage": True, "nextCursor": "c"},
    )
    for index in range(10):
        responses.get(
            f"{BASE_URL}/bots",
            json={
                "bots": [{"bot_id": f"b{index}"}],
                "hasNextPage": True,
                "nextCursor": f"c{index}",
            },
        )

    with MeetStreamClient(settings) as client:
        bots = list(client.iter_bots())

    assert len(bots) == settings.max_list_pages == 5
