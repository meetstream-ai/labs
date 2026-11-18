"""Tiny MeetStream integration: send a bot, handle bot.done webhook, pull the transcript."""
import os

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request

load_dotenv()

BASE = os.environ.get("MEETSTREAM_BASE_URL", "https://api.meetstream.ai/api/v1").rstrip("/")


class TranscriptNotReady(Exception):
    """MeetStream is still processing the transcript; a later fetch can succeed."""


class TranscriptFailed(Exception):
    """MeetStream finished transcribing and it failed; retrying will never succeed."""


def headers():
    return {"Authorization": f"Token {os.environ['MEETSTREAM_API_KEY']}", "Content-Type": "application/json"}


def send_bot(meeting_url, bot_name="Notetaker", webhook_url=None, session=requests):
    body = {
        "meeting_link": meeting_url,
        "bot_name": bot_name,
        "video_required": False,
        "recording_config": {
            "transcript": {"provider": {"meetstream": {"language": "en", "translate": False}}}
        },
    }
    if webhook_url:
        body["callback_url"] = webhook_url
    r = session.post(f"{BASE}/bots/create_bot", json=body, headers=headers(), timeout=30)
    r.raise_for_status()
    return r.json()["bot_id"]


def get_transcript(bot_id, session=requests):
    # MeetStream serves transcripts by transcript_id, so resolve it from the bot first.
    # Bot detail is the canonical source: /transcriptions returns a list of runs instead.
    r = session.get(f"{BASE}/bots/{bot_id}/detail", headers=headers(), timeout=30)
    r.raise_for_status()
    details = r.json()["bot_details"]

    # TranscriptStatus is the authoritative signal. On failure the fetch below keeps
    # answering 202 rather than erroring, so a caller that ignores this retries forever.
    if details.get("TranscriptStatus") == "Failed":
        raise TranscriptFailed(f"transcription failed for bot {bot_id}")
    transcript_id = details.get("transcript_id")
    if not transcript_id:
        raise TranscriptNotReady(f"no transcript_id on bot {bot_id} yet")

    r = session.get(f"{BASE}/transcript/{transcript_id}/get_transcript", headers=headers(), timeout=60)
    r.raise_for_status()
    if r.status_code == 202:
        raise TranscriptNotReady(f"transcript {transcript_id} is still processing")
    segments = r.json()  # top-level array of segments, not {"transcript": [...]}

    lines = []
    for seg in segments:
        name = seg.get("speaker") or "Unknown"
        text = seg.get("transcript", "")
        lines.append(f"{name}: {text}")
    return "\n".join(lines)


app = Flask(__name__)
SAVED = {}


@app.post("/webhooks/meetstream")
@app.post("/webhooks/recall")  # kept so an already-configured callback URL keeps working
def meetstream_webhook():
    evt = request.get_json(force=True, silent=True) or {}
    # MeetStream's envelope is flat: bot_id sits at the top level. Recall nested it
    # under data.bot.id, which is what made this handler 500 on the first bot.done.
    if evt.get("event") == "bot.done":
        bot_id = evt.get("bot_id")
        if bot_id:
            try:
                SAVED[bot_id] = get_transcript(bot_id)
            except Exception:
                # MeetStream never retries a webhook, so a failure here must not become
                # a 500 that drops the event; log it and acknowledge.
                app.logger.exception("could not save transcript for bot %s", bot_id)
    return jsonify(ok=True)


if __name__ == "__main__":
    import sys
    print(send_bot(sys.argv[1]))
