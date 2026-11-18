"""Minimal MeetStream API client — just what live captions need."""

import logging
from typing import Any, Dict, Optional

import httpx

from .config import Settings

logger = logging.getLogger(__name__)

# Generous enough that a bot does not drop out of a real meeting, per the
# MeetStream recommended defaults.
AUTOMATIC_LEAVE = {
    "waiting_room_timeout": 600,
    "everyone_left_timeout": 600,
    "voice_inactivity_timeout": 600,
    "in_call_recording_timeout": 14400,
    "recording_permission_denied_timeout": 300,
}


class MeetStreamError(RuntimeError):
    """The API returned something other than success."""

    def __init__(self, message: str, status_code: Optional[int] = None, body: str = "") -> None:
        super().__init__(message)
        self.status_code = status_code
        self.body = body


class MeetStreamClient:
    def __init__(
        self,
        settings: Settings,
        transport: Optional[httpx.BaseTransport] = None,
        timeout: float = 30.0,
    ) -> None:
        self._settings = settings
        self._transport = transport
        self._timeout = timeout

    def build_create_bot_payload(self, meeting_link: str) -> Dict[str, Any]:
        """The create_bot body for a live-caption bot.

        Audio only (no video recording, no per-participant streams) and
        MeetStream's own streaming transcription, which needs no third-party
        provider key. Streaming providers produce no post-call transcript —
        the live webhook stream is the record.
        """
        settings = self._settings
        return {
            "meeting_link": meeting_link,
            "bot_name": settings.bot_name,
            "video_required": False,
            "callback_url": settings.callback_url,
            "live_transcription_required": {"webhook_url": settings.live_transcript_url},
            "recording_config": {
                "transcript": {"provider": {"meetstream_streaming": {}}},
                "retention": {"type": "timed", "hours": settings.retention_hours},
            },
            "automatic_leave": AUTOMATIC_LEAVE,
        }

    def create_bot(self, meeting_link: str) -> Dict[str, Any]:
        """Send a bot into a meeting. Returns the BotResponse body."""
        payload = self.build_create_bot_payload(meeting_link)
        logger.debug("create_bot payload: %s", payload)
        response = self._request("POST", "/bots/create_bot", json=payload)
        if response.status_code not in (200, 201):
            raise MeetStreamError(
                "create_bot failed with HTTP %d" % response.status_code,
                response.status_code,
                response.text,
            )
        return response.json()

    def remove_bot(self, bot_id: str) -> Dict[str, Any]:
        """Pull the bot out of the meeting it is in."""
        response = self._request("GET", "/bots/%s/remove_bot" % bot_id)
        if response.status_code != 200:
            raise MeetStreamError(
                "remove_bot failed with HTTP %d" % response.status_code,
                response.status_code,
                response.text,
            )
        try:
            return response.json()
        except ValueError:
            return {"message": response.text}

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        headers = {
            "Authorization": "Token %s" % self._settings.require_api_key(),
            "Content-Type": "application/json",
        }
        with httpx.Client(
            base_url=self._settings.base_url,
            headers=headers,
            timeout=self._timeout,
            transport=self._transport,
        ) as client:
            try:
                return client.request(method, path, **kwargs)
            except httpx.HTTPError as exc:
                logger.error("%s %s failed: %s", method, path, exc)
                raise MeetStreamError("could not reach MeetStream: %s" % exc) from exc
