"""
MeetStream Live Transcription Dashboard.

A single-process Flask app that combines bot deployment and live
transcription receiving behind a browser dashboard, as an alternative to
running create_bot.py and transcription_server.py separately from the
command line. The CLI/headless path (create_bot.py + transcription_server.py)
still works unchanged; this app is a second, UI-based way to do the same
thing, backed by the same MeetStream live transcription API and the same
webhook payload handling.

Routes:
  GET  /                 Dashboard UI
  POST /api/deploy       Deploy a bot (api_key + meeting_link in JSON body)
  GET  /api/status       Poll current session/status/stat tiles/live logs
  GET  /api/transcripts  List saved transcript checkpoint files
  GET  /transcripts/<f>  Download a saved transcript file
  POST /live-transcript  Webhook endpoint MeetStream posts sentences to
  POST /save/<bot_id>    Manual transcript save, same as transcription_server.py

Like transcription_server.py, this app only processes final sentences
(is_final is true) and auto-saves a transcript checkpoint every 50
sentences. WEBHOOK_URL still needs to point at this process's
/live-transcript endpoint via your ngrok tunnel, configured the same way as
in the CLI setup (see README.md).
"""

import json
import os
import time
from collections import deque
from datetime import datetime
from urllib.parse import urlparse

import requests
from flask import Flask, request, jsonify, render_template, send_from_directory
from dotenv import load_dotenv

load_dotenv()

PORT = int(os.getenv("SERVER_PORT", "4000"))
TRANSCRIPTS_DIR = os.path.join(os.getcwd(), "transcripts")
os.makedirs(TRANSCRIPTS_DIR, exist_ok=True)

DEFAULT_API_KEY = os.getenv("MEETSTREAM_API_KEY", "")
WEBHOOK_URL = os.getenv("WEBHOOK_URL", "")

# Same live transcription configuration as create_bot.py's
# DEEPGRAM_STREAMING_CONFIG - sentence mode, streaming model, 300ms endpointing
DEEPGRAM_STREAMING_CONFIG = {
    "model": "nova-2",
    "transcription_mode": "sentence",
    "language": "en",
    "punctuate": True,
    "smart_format": True,
    "endpointing": 300,
    "vad_events": True,
    "utterance_end_ms": 1000,
    "encoding": "linear16",
    "channels": 1
}

PLATFORM_HOSTS = {
    "meet.google.com": "Google Meet",
    "zoom.us": "Zoom",
    "teams.microsoft.com": "Microsoft Teams",
}

# Accumulates final sentences per bot_id, same shape as transcription_server.py
session_transcripts: dict = {}
# Number of checkpoint files saved per bot_id
checkpoint_counts: dict = {}
# The dashboard tracks one deployed session at a time
current_session = {
    "bot_id": None,
    "platform": None,
    "meeting_link": None,
    "start_time": None,
    "status": "idle",  # idle | deploying | active | error
}
live_logs = deque(maxlen=200)


def add_log(message: str) -> None:
    live_logs.append({
        "time": datetime.utcnow().isoformat(),
        "message": message
    })
    print(message)


def format_timestamp(seconds: float) -> str:
    minutes = int(seconds) // 60
    secs = int(seconds) % 60
    return f"{minutes:02d}:{secs:02d}"


def detect_platform(meeting_link: str) -> str:
    host = urlparse(meeting_link).netloc.lower()
    for known_host, name in PLATFORM_HOSTS.items():
        if known_host in host:
            return name
    return "Unknown"


def save_session_transcript(bot_id: str) -> str | None:
    sentences = session_transcripts.get(bot_id, [])
    if not sentences:
        return None
    filename = f"transcript_{bot_id[:8]}_{int(time.time())}.json"
    filepath = os.path.join(TRANSCRIPTS_DIR, filename)
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump({
            "bot_id": bot_id,
            "sentence_count": len(sentences),
            "saved_at": datetime.utcnow().isoformat(),
            "sentences": sentences
        }, f, indent=2, ensure_ascii=False)
    checkpoint_counts[bot_id] = checkpoint_counts.get(bot_id, 0) + 1
    return filepath


app = Flask(__name__)


@app.route("/", methods=["GET"])
def dashboard():
    return render_template("dashboard.html")


@app.route("/api/deploy", methods=["POST"])
def api_deploy():
    body = request.get_json(silent=True) or {}
    api_key = (body.get("api_key") or DEFAULT_API_KEY or "").strip()
    meeting_link = (body.get("meeting_link") or "").strip()

    if not api_key:
        return jsonify({"error": "MeetStream API key is required"}), 400
    if not meeting_link:
        return jsonify({"error": "Meeting link is required"}), 400
    if not WEBHOOK_URL or WEBHOOK_URL == "https://your-ngrok-url-here.ngrok-free.app/live-transcript":
        return jsonify({
            "error": "WEBHOOK_URL is not configured. Set it in .env to your ngrok "
                     "forwarding URL followed by /live-transcript."
        }), 400

    current_session.update({
        "bot_id": None,
        "platform": detect_platform(meeting_link),
        "meeting_link": meeting_link,
        "start_time": time.time(),
        "status": "deploying",
    })
    add_log("Creating bot with live transcription...")

    payload = {
        "meeting_link": meeting_link,
        "bot_name": "MeetStream Live Transcription Bot",
        "video_required": False,
        "live_transcription_required": {
            "webhook_url": WEBHOOK_URL
        },
        "recording_config": {
            "transcript": {
                "provider": {
                    "deepgram_streaming": DEEPGRAM_STREAMING_CONFIG
                }
            }
        }
    }
    headers = {
        "Authorization": f"Token {api_key}",
        "Content-Type": "application/json"
    }

    try:
        response = requests.post(
            "https://api.meetstream.ai/api/v1/bots/create_bot",
            json=payload,
            headers=headers,
            timeout=30
        )
    except requests.exceptions.RequestException as e:
        current_session["status"] = "error"
        add_log(f"Error: Failed to reach MeetStream API: {e}")
        return jsonify({"error": f"Failed to reach MeetStream API: {e}"}), 502

    if response.status_code == 201:
        data = response.json()
        current_session.update({
            "bot_id": data["bot_id"],
            "status": "active",
        })
        session_transcripts.setdefault(data["bot_id"], [])
        checkpoint_counts.setdefault(data["bot_id"], 0)
        add_log(f"Bot created: {data['bot_id']}")
        add_log(f"Webhook URL: {WEBHOOK_URL}")
        add_log(f"Status: {data['status']}")
        add_log("Bot dispatched. Admit it in your meeting to start receiving live transcription.")
        return jsonify({"bot_id": data["bot_id"], "status": data["status"]}), 201

    current_session["status"] = "error"
    if response.status_code == 401:
        message = "Unauthorized. Check that the MeetStream API key is correct."
    elif response.status_code == 400:
        message = f"Bad request. {response.text}"
    else:
        message = f"Unexpected status code {response.status_code}. {response.text}"
    add_log(f"Error: {message}")
    return jsonify({"error": message}), response.status_code


@app.route("/live-transcript", methods=["POST"])
def live_transcript():
    data = request.get_json(silent=True)
    if data is None:
        return jsonify({"error": "Invalid JSON body"}), 400

    speaker = data.get("speaker", "Unknown Speaker")
    speaker_id = data.get("speaker_id", "")
    text = data.get("text", "")
    start = data.get("start", 0.0)
    end = data.get("end", 0.0)
    is_final = data.get("is_final", True)
    confidence = data.get("confidence", 0.0)
    bot_id = data.get("bot_id", "unknown")

    if not is_final:
        return jsonify({"status": "skipped", "reason": "interim result"}), 200
    if not text.strip():
        return jsonify({"status": "skipped", "reason": "empty text"}), 200

    timestamp = format_timestamp(start)
    add_log(f"[{timestamp}] {speaker} (confidence: {confidence:.2f}): {text}")

    if bot_id not in session_transcripts:
        session_transcripts[bot_id] = []
    session_transcripts[bot_id].append({
        "speaker": speaker,
        "speaker_id": speaker_id,
        "text": text,
        "start": start,
        "end": end,
        "confidence": confidence,
        "received_at": datetime.utcnow().isoformat()
    })

    if current_session.get("bot_id") == bot_id:
        current_session["status"] = "active"

    sentence_count = len(session_transcripts[bot_id])
    if sentence_count % 50 == 0:
        filepath = save_session_transcript(bot_id)
        if filepath:
            add_log(f"[checkpoint] Transcript saved: {filepath} ({sentence_count} sentences)")

    return jsonify({"status": "received"}), 200


@app.route("/save/<bot_id>", methods=["POST"])
def save_transcript(bot_id: str):
    filepath = save_session_transcript(bot_id)
    if filepath:
        sentence_count = len(session_transcripts.get(bot_id, []))
        add_log(f"Transcript saved manually: {filepath} ({sentence_count} sentences)")
        return jsonify({
            "status": "saved",
            "filepath": filepath,
            "sentence_count": sentence_count
        }), 200
    return jsonify({"status": "no_data", "bot_id": bot_id}), 404


@app.route("/api/status", methods=["GET"])
def api_status():
    bot_id = current_session.get("bot_id")
    sentences = session_transcripts.get(bot_id, []) if bot_id else []
    start_time = current_session.get("start_time")
    elapsed = time.time() - start_time if start_time else 0

    return jsonify({
        "status": current_session["status"],
        "elapsed_seconds": int(elapsed),
        "sentence_count": len(sentences),
        "transcripts_saved": checkpoint_counts.get(bot_id, 0) if bot_id else 0,
        "session": {
            "bot_id": bot_id,
            "platform": current_session.get("platform"),
            "meeting_link": current_session.get("meeting_link"),
            "start_time": datetime.utcfromtimestamp(start_time).isoformat() if start_time else None,
        },
        "logs": list(live_logs)
    }), 200


@app.route("/api/transcripts", methods=["GET"])
def api_transcripts():
    files = []
    for name in sorted(os.listdir(TRANSCRIPTS_DIR)):
        if not name.endswith(".json"):
            continue
        filepath = os.path.join(TRANSCRIPTS_DIR, name)
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        files.append({
            "filename": name,
            "bot_id": data.get("bot_id"),
            "sentence_count": data.get("sentence_count"),
            "saved_at": data.get("saved_at")
        })
    return jsonify({"files": files}), 200


@app.route("/transcripts/<path:filename>", methods=["GET"])
def download_transcript(filename: str):
    return send_from_directory(TRANSCRIPTS_DIR, filename, as_attachment=True)


if __name__ == "__main__":
    print(f"MeetStream Live Transcription Dashboard running on http://0.0.0.0:{PORT}")
    print(f"Open http://localhost:{PORT} in your browser to deploy a bot and watch sentences arrive.")
    print(f"Webhook endpoint: http://0.0.0.0:{PORT}/live-transcript")
    print(f"Transcripts will be saved to: {TRANSCRIPTS_DIR}\n")
    app.run(host="0.0.0.0", port=PORT, debug=False)
