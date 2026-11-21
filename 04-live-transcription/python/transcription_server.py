"""
MeetStream Live Transcription Server.

This Flask server receives live transcription webhook payloads from
MeetStream and displays each speaker-labeled sentence as it arrives during
a meeting.

The /live-transcript endpoint accepts one HTTP POST per transcribed
sentence. Each payload includes a speaker label, the sentence text,
start/end timestamps, a confidence score, and the is_final flag.

The is_final field distinguishes complete sentences from interim results.
Deepgram Streaming sends interim results as a sentence is still being
spoken, and these are replaced by a final result once the sentence is
complete. This server skips interim results (is_final is false) and only
displays and accumulates final sentences.

Sentences are accumulated in memory per bot_id. Every 50 sentences, a
checkpoint file is automatically saved to the transcripts/ folder. A
developer can also trigger a manual save at any time by sending a POST
request to /save/{bot_id}, which is useful when the meeting ends and the
final partial batch of sentences has not yet hit the auto-save threshold.
"""

import json
import os
import time
from datetime import datetime
from flask import Flask, request, jsonify
from dotenv import load_dotenv

load_dotenv()

PORT = int(os.getenv("SERVER_PORT", "4000"))
TRANSCRIPTS_DIR = os.path.join(os.getcwd(), "transcripts")

os.makedirs(TRANSCRIPTS_DIR, exist_ok=True)

# Accumulates final sentences per bot_id across the session
# Key: bot_id, Value: list of sentence dicts
session_transcripts: dict = {}


def format_timestamp(seconds: float) -> str:
    minutes = int(seconds) // 60
    secs = int(seconds) % 60
    return f"{minutes:02d}:{secs:02d}"


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
    return filepath


app = Flask(__name__)


@app.route("/live-transcript", methods=["POST"])
def live_transcript():
    data = request.get_json(silent=True)
    if data is None:
        return jsonify({"error": "Invalid JSON body"}), 400

    print(f"\n[DEBUG raw payload] {json.dumps(data)}")

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
    print(f"\n[{timestamp}] {speaker} (confidence: {confidence:.2f})")
    print(text)

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

    sentence_count = len(session_transcripts[bot_id])
    if sentence_count % 50 == 0:
        filepath = save_session_transcript(bot_id)
        if filepath:
            print(f"\n[checkpoint] Transcript saved: {filepath} ({sentence_count} sentences)")

    return jsonify({"status": "received"}), 200


@app.route("/", methods=["GET"])
def health_check():
    active_sessions = len(session_transcripts)
    total_sentences = sum(len(v) for v in session_transcripts.values())
    return jsonify({
        "status": "running",
        "service": "MeetStream Live Transcription Server",
        "endpoint": "/live-transcript",
        "active_sessions": active_sessions,
        "total_sentences_received": total_sentences
    }), 200


@app.route("/save/<bot_id>", methods=["POST"])
def save_transcript(bot_id: str):
    filepath = save_session_transcript(bot_id)
    if filepath:
        sentence_count = len(session_transcripts.get(bot_id, []))
        return jsonify({
            "status": "saved",
            "filepath": filepath,
            "sentence_count": sentence_count
        }), 200
    return jsonify({"status": "no_data", "bot_id": bot_id}), 404


if __name__ == "__main__":
    print(f"MeetStream Live Transcription Server running on http://0.0.0.0:{PORT}")
    print(f"Webhook endpoint: http://0.0.0.0:{PORT}/live-transcript")
    print(f"Transcripts will be saved to: {TRANSCRIPTS_DIR}")
    print(f"Waiting for sentences...\n")
    app.run(host="0.0.0.0", port=PORT, debug=False)
