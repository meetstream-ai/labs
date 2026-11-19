"""Thin REST client for the MeetStream endpoints the archiver needs."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

import requests

from .config import Settings

log = logging.getLogger(__name__)

# Pre-signed URLs expire quickly (10 minutes for video and per-participant audio),
# so a sweep fetches them immediately before downloading rather than caching them.
CHUNK_BYTES = 1024 * 1024


class MeetStreamError(RuntimeError):
    """An API call failed in a way the sweep should not silently ignore."""


@dataclass(frozen=True)
class MediaResponse:
    """Outcome of a media endpoint call.

    `ready` is False for the two documented "nothing to download yet" cases:
    HTTP 202 (the bot is still in the meeting / still processing) and HTTP 404
    (the bot never produced this kind of media).
    """

    ready: bool
    payload: Any = None
    reason: str = ""


class MeetStreamClient:
    def __init__(self, settings: Settings, session: requests.Session | None = None) -> None:
        self._settings = settings
        self._session = session or requests.Session()
        self._session.headers.update(
            {
                "Authorization": f"Token {settings.api_key}",
                "Accept": "application/json",
            }
        )
        # Pre-signed S3 URLs must be fetched WITHOUT the API token: S3 rejects
        # requests carrying an unexpected Authorization header.
        self._media_session = requests.Session()

    def close(self) -> None:
        self._session.close()
        self._media_session.close()

    def __enter__(self) -> "MeetStreamClient":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def _url(self, path: str) -> str:
        return f"{self._settings.base_url}/{path.lstrip('/')}"

    def _get(self, path: str, params: dict[str, Any] | None = None) -> requests.Response:
        url = self._url(path)
        try:
            return self._session.get(
                url, params=params, timeout=self._settings.request_timeout_seconds
            )
        except requests.RequestException as exc:
            raise MeetStreamError(f"GET {url} failed: {exc}") from exc

    def _get_json(self, path: str, params: dict[str, Any] | None = None) -> Any:
        resp = self._get(path, params=params)
        if resp.status_code != 200:
            raise MeetStreamError(
                f"GET {self._url(path)} returned HTTP {resp.status_code}: {resp.text[:200]}"
            )
        try:
            return resp.json()
        except ValueError as exc:
            raise MeetStreamError(f"GET {self._url(path)} returned non-JSON body") from exc

    def _get_media(self, path: str) -> MediaResponse:
        resp = self._get(path)
        if resp.status_code == 202:
            return MediaResponse(False, reason="not ready yet (HTTP 202)")
        if resp.status_code == 404:
            return MediaResponse(False, reason="not available for this bot (HTTP 404)")
        if resp.status_code != 200:
            raise MeetStreamError(
                f"GET {self._url(path)} returned HTTP {resp.status_code}: {resp.text[:200]}"
            )
        try:
            return MediaResponse(True, payload=resp.json())
        except ValueError:
            # Some media endpoints can hand back a bare URL rather than JSON.
            body = resp.text.strip()
            if body.startswith(("http://", "https://")):
                return MediaResponse(True, payload=body)
            raise MeetStreamError(f"GET {self._url(path)} returned an unusable body")

    def iter_bots(self) -> Iterator[dict[str, Any]]:
        """Yield bots from GET /bots, following the documented cursor pagination.

        Stops at ARCHIVE_MAX_LIST_PAGES, and also stops if a page repeats its
        cursor, so an unexpected pagination contract cannot spin forever.
        """
        cursor: str | None = None
        seen_cursors: set[str] = set()
        for _ in range(self._settings.max_list_pages):
            page = self._get_json("bots", params=None if cursor is None else {"cursor": cursor})
            bots = page.get("bots") if isinstance(page, dict) else page
            if not isinstance(bots, list):
                return
            for bot in bots:
                if isinstance(bot, dict):
                    yield bot
            if not isinstance(page, dict) or not page.get("hasNextPage"):
                return
            next_cursor = page.get("nextCursor")
            if not isinstance(next_cursor, str) or next_cursor in seen_cursors:
                log.warning("Stopping bot listing: pagination cursor did not advance")
                return
            seen_cursors.add(next_cursor)
            cursor = next_cursor
        log.warning(
            "Stopping bot listing at the %s page cap (ARCHIVE_MAX_LIST_PAGES)",
            self._settings.max_list_pages,
        )

    def get_bot_detail(self, bot_id: str) -> dict[str, Any]:
        payload = self._get_json(f"bots/{bot_id}/detail")
        if not isinstance(payload, dict):
            raise MeetStreamError(f"Unexpected /detail payload for bot {bot_id}")
        details = payload.get("bot_details")
        return details if isinstance(details, dict) else payload

    def get_audio(self, bot_id: str) -> MediaResponse:
        return self._get_media(f"bots/{bot_id}/get_audio")

    def get_video(self, bot_id: str) -> MediaResponse:
        return self._get_media(f"bots/{bot_id}/get_video")

    def get_audio_streams(self, bot_id: str) -> MediaResponse:
        return self._get_media(f"bots/{bot_id}/get_audio_streams")

    def download(self, url: str, destination: Path) -> int:
        """Stream a pre-signed URL to disk atomically. Returns bytes written."""
        destination.parent.mkdir(parents=True, exist_ok=True)
        partial = destination.with_name(destination.name + ".part")
        written = 0
        try:
            with self._media_session.get(
                url, stream=True, timeout=self._settings.request_timeout_seconds
            ) as resp:
                if resp.status_code != 200:
                    raise MeetStreamError(
                        f"Download failed with HTTP {resp.status_code} for {destination.name}"
                    )
                with partial.open("wb") as handle:
                    for chunk in resp.iter_content(chunk_size=CHUNK_BYTES):
                        if chunk:
                            handle.write(chunk)
                            written += len(chunk)
        except requests.RequestException as exc:
            partial.unlink(missing_ok=True)
            raise MeetStreamError(f"Download failed for {destination.name}: {exc}") from exc
        except BaseException:
            partial.unlink(missing_ok=True)
            raise

        if written == 0:
            partial.unlink(missing_ok=True)
            raise MeetStreamError(f"Download for {destination.name} was empty")
        partial.replace(destination)
        return written
