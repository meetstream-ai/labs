"""Tiny Recall.ai integration: send a bot, handle bot.done webhook, pull the transcript."""
import os

import requests
from flask import Flask, jsonify, request

RECALL_REGION = os.environ.get("RECALL_REGION", "us-east-1")
BASE = f"https://{RECALL_REGION}.recall.ai/api/v1"


def headers():
    return {"Authorization": f"Token {os.environ['RECALL_API_KEY']}", "Content-Type": "application/json"}


def send_bot(meeting_url, bot_name="Notetaker", webhook_url=None, session=requests):
    body = {
        "meeting_url": meeting_url,
        "bot_name": bot_name,
        "recording_config": {"transcript": {"provider": {"recallai_streaming": {}}}},
    }
    r = session.post(f"{BASE}/bot/", json=body, headers=headers(), timeout=30)
    r.raise_for_status()
    return r.json()["id"]


def get_transcript(bot_id, session=requests):
    bot = session.get(f"{BASE}/bot/{bot_id}/", headers=headers(), timeout=30).json()
    url = bot["recordings"][0]["media_shortcuts"]["transcript"]["data"]["download_url"]
    segments = session.get(url, timeout=60).json()
    lines = []
    for seg in segments:
        name = seg["participant"]["name"]
        text = " ".join(w["text"] for w in seg["words"])
        lines.append(f"{name}: {text}")
    return "\n".join(lines)


app = Flask(__name__)
SAVED = {}


@app.post("/webhooks/recall")
def recall_webhook():
    evt = request.get_json(force=True)
    if evt.get("event") == "bot.done":
        bot_id = evt["data"]["bot"]["id"]
        SAVED[bot_id] = get_transcript(bot_id)
    return jsonify(ok=True)


if __name__ == "__main__":
    import sys
    print(send_bot(sys.argv[1]))
