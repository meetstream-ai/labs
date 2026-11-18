"""Local server that receives the live transcript stream and prints it."""

import hashlib
import hmac
import json
import logging
from collections import deque
from typing import Any, Deque, Dict, Optional, Set, Tuple

from fastapi import FastAPI, Request, Response

from .captions import CaptionPrinter
from .config import LIVE_TRANSCRIPT_PATH, WEBHOOK_PATH, Settings

logger = logging.getLogger(__name__)

SIGNATURE_HEADER = "x-meetstream-signature"

# Lifecycle events worth a line in the terminal. Anything else is logged only.
_LIFECYCLE_MESSAGES = {
    "bot.joining": "bot is joining the meeting",
    "bot.in_waiting_room": "bot is in the waiting room — admit it to start captions",
    "bot.inmeeting": "bot joined the meeting",
    "bot.recording": "recording started — captions will appear as people talk",
    "bot.leaving": "bot is leaving",
    "bot.done": "session finished",
    "bot.error": "transcription provider reported an error (recording continues)",
}

# bot.stopped carries the real reason in bot_event.
_TERMINAL_MESSAGES = {
    "bot.stopped": "bot left the meeting",
    "bot.kicked": "bot was removed from the meeting",
    "bot.notallowed": "bot was never admitted (waiting room timed out)",
    "bot.denied": "host denied the bot entry or recording permission",
    "bot.failed": "bot failed",
}

_DEDUPE_LIMIT = 500


def verify_signature(secret: str, body: bytes, header: Optional[str]) -> bool:
    """Check the HMAC-SHA256 signature MeetStream sends when a secret is set."""
    if not header:
        return False
    provided = header.split("=", 1)[1] if header.startswith("sha256=") else header
    expected = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, provided.strip())


class _Deduper:
    """Remembers recent event keys; MeetStream can redeliver the same event."""

    def __init__(self, limit: int = _DEDUPE_LIMIT) -> None:
        self._seen: Set[Tuple] = set()
        self._order: Deque[Tuple] = deque()
        self._limit = limit

    def seen(self, key: Tuple) -> bool:
        if key in self._seen:
            return True
        self._seen.add(key)
        self._order.append(key)
        if len(self._order) > self._limit:
            self._seen.discard(self._order.popleft())
        return False


async def _read_json(request: Request) -> Optional[Dict[str, Any]]:
    body = await request.body()
    try:
        payload = json.loads(body or b"")
    except ValueError:
        logger.warning("ignoring non-JSON body on %s", request.url.path)
        return None
    return payload if isinstance(payload, dict) else None


def create_app(printer: CaptionPrinter, settings: Settings) -> FastAPI:
    app = FastAPI(title="live-captions", docs_url=None, redoc_url=None)
    deduper = _Deduper()

    def _authorised(body: bytes, request: Request) -> bool:
        """Verify signed deliveries. Unsigned ones pass: signing is optional
        on the MeetStream side and only happens once a secret is configured."""
        secret = settings.webhook_secret
        if not secret:
            return True
        header = request.headers.get(SIGNATURE_HEADER)
        if header is None:
            logger.warning("delivery on %s was not signed", request.url.path)
            return True
        return verify_signature(secret, body, header)

    @app.get("/healthz")
    async def healthz() -> Dict[str, str]:
        return {"status": "ok"}

    @app.post(LIVE_TRANSCRIPT_PATH)
    async def live_transcript(request: Request) -> Response:
        body = await request.body()
        if not _authorised(body, request):
            logger.warning("rejected live transcript chunk: bad signature")
            return Response(status_code=401)
        try:
            payload = json.loads(body or b"")
        except ValueError:
            logger.warning("ignoring non-JSON live transcript chunk")
            return Response(status_code=400)
        if not isinstance(payload, dict):
            return Response(status_code=400)
        logger.debug("live chunk: %s", payload)
        printer.handle_chunk(payload)
        return Response(status_code=200)

    @app.post(WEBHOOK_PATH)
    async def lifecycle(request: Request) -> Response:
        body = await request.body()
        if not _authorised(body, request):
            logger.warning("rejected lifecycle event: bad signature")
            return Response(status_code=401)
        payload = await _read_json(request)
        if payload is None:
            return Response(status_code=400)
        logger.debug("lifecycle event: %s", payload)

        event = payload.get("event")
        bot_event = payload.get("bot_event") or event
        key = (payload.get("bot_id"), bot_event, payload.get("timestamp"))
        if deduper.seen(key):
            return Response(status_code=200)

        if event == "bot.stopped":
            message = _TERMINAL_MESSAGES.get(bot_event, "bot stopped (%s)" % bot_event)
        else:
            message = _LIFECYCLE_MESSAGES.get(event)
        if message:
            printer.status(message)
        return Response(status_code=200)

    return app
