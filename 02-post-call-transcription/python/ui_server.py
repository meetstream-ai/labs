"""
meetstream-post-call-transcription - UI mode

A local web dashboard that provides an alternative way to exercise the same
MeetStream post-call transcription flow implemented in transcription.py.
Instead of running the script from the command line, a developer pastes a
MeetStream API key and a meeting link into the browser, clicks "Deploy
Agent", and watches the bot status, live logs, and output files update in
real time.

This reuses the exact same helper functions from transcription.py
(create_bot, get_bot_status, fetch_transcript, fetch_audio_url,
save_outputs) so the underlying API behavior is identical to the CLI. The
CLI (normal and --headless modes) is unchanged and still works as before;
this is a second, independent way to drive the same API.

Usage:
    python ui_server.py
    (then open http://localhost:8000 in a browser)
"""

import os
import threading
import time
from datetime import datetime

from flask import Flask, jsonify, render_template, request, send_from_directory

from transcription import (
    add_log_listener,
    create_bot,
    fetch_audio_url,
    fetch_transcript,
    get_bot_status,
    save_outputs,
)

OUTPUT_DIR = "output"
POLL_INTERVAL_SECONDS = 5
POST_PROCESS_WAIT_SECONDS = 30
DEPLOY_TIMEOUT_SECONDS = 3600
TERMINAL_STATUSES = ("Fatal", "PermissionDenied")

app = Flask(__name__)

state_lock = threading.Lock()
state = {
    "status": "Idle",
    "busy": False,
    "bot_id": None,
    "transcript_id": None,
    "meeting_link": None,
    "platform": None,
    "start_time": None,
    "completed_at": None,
    "speakers_detected": 0,
    "logs": [],
}


def detect_platform(meeting_link: str) -> str:
    if "meet.google.com" in meeting_link:
        return "Google Meet"
    if "zoom.us" in meeting_link:
        return "Zoom"
    if "teams.microsoft.com" in meeting_link:
        return "Microsoft Teams"
    return "Unknown"


def _on_log_line(line: str) -> None:
    with state_lock:
        state["logs"].append(f"{datetime.now().strftime('%H:%M:%S')} {line}")
        state["logs"] = state["logs"][-300:]


add_log_listener(_on_log_line)


def set_status(new_status: str) -> None:
    with state_lock:
        state["status"] = new_status


def run_agent(api_key: str, meeting_link: str) -> None:
    with state_lock:
        state["busy"] = True
        state["status"] = "Deploying"
        state["meeting_link"] = meeting_link
        state["platform"] = detect_platform(meeting_link)
        state["start_time"] = time.time()
        state["completed_at"] = None
        state["speakers_detected"] = 0
        state["bot_id"] = None
        state["transcript_id"] = None

    try:
        try:
            bot_data = create_bot(meeting_link, api_key, headless=False)
        except SystemExit:
            set_status("Error")
            return

        bot_id = bot_data.get("bot_id")
        transcript_id = bot_data.get("transcript_id")
        with state_lock:
            state["bot_id"] = bot_id
            state["transcript_id"] = transcript_id
            state["status"] = "Joining"

        elapsed = 0
        while True:
            time.sleep(POLL_INTERVAL_SECONDS)
            elapsed += POLL_INTERVAL_SECONDS
            status = get_bot_status(bot_id, api_key)

            if status:
                set_status(status)

            if status == "Done":
                break
            if status in TERMINAL_STATUSES:
                return
            if elapsed >= DEPLOY_TIMEOUT_SECONDS:
                set_status("Timeout")
                return

        set_status("Processing")
        time.sleep(POST_PROCESS_WAIT_SECONDS)

        transcript_data = fetch_transcript(transcript_id, api_key, headless=False)
        audio_url = fetch_audio_url(bot_id, api_key, headless=False)

        if transcript_data is not None:
            speakers = {
                entry.get("speaker", "Unknown Speaker")
                for entry in transcript_data.get("message", [])
            }
            with state_lock:
                state["speakers_detected"] = len(speakers)

        save_outputs(transcript_data, audio_url, bot_id, OUTPUT_DIR, headless=False)

        with state_lock:
            state["completed_at"] = time.time()
            state["status"] = "Complete"
    finally:
        with state_lock:
            state["busy"] = False


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/deploy", methods=["POST"])
def deploy():
    payload = request.get_json(silent=True) or {}
    api_key = (payload.get("api_key") or "").strip()
    meeting_link = (payload.get("meeting_link") or "").strip()

    if not api_key:
        return jsonify({"error": "MeetStream API key is required."}), 400
    if not meeting_link:
        return jsonify({"error": "Meeting link is required."}), 400

    with state_lock:
        if state["busy"]:
            return jsonify({"error": "An agent is already deployed. Wait for it to finish."}), 409

    thread = threading.Thread(target=run_agent, args=(api_key, meeting_link), daemon=True)
    thread.start()
    return jsonify({"ok": True})


@app.route("/api/state")
def get_state():
    with state_lock:
        start_time = state["start_time"]
        completed_at = state["completed_at"]
        if start_time is None:
            elapsed = 0
        elif completed_at is not None:
            elapsed = int(completed_at - start_time)
        else:
            elapsed = int(time.time() - start_time)

        try:
            files_saved = len(os.listdir(OUTPUT_DIR)) if os.path.isdir(OUTPUT_DIR) else 0
        except OSError:
            files_saved = 0

        return jsonify({
            "status": state["status"],
            "busy": state["busy"],
            "elapsed": elapsed,
            "speakers_detected": state["speakers_detected"],
            "files_saved": files_saved,
            "session": {
                "bot_id": state["bot_id"],
                "platform": state["platform"],
                "meeting_link": state["meeting_link"],
                "start_time": (
                    datetime.fromtimestamp(start_time).strftime("%H:%M:%S")
                    if start_time else None
                ),
            },
            "logs": state["logs"],
        })


@app.route("/api/output-files")
def output_files():
    if not os.path.isdir(OUTPUT_DIR):
        return jsonify({"files": []})

    files = []
    for name in sorted(os.listdir(OUTPUT_DIR)):
        path = os.path.join(OUTPUT_DIR, name)
        if os.path.isfile(path):
            files.append({
                "name": name,
                "size_bytes": os.path.getsize(path),
                "modified": datetime.fromtimestamp(os.path.getmtime(path)).strftime("%Y-%m-%d %H:%M:%S"),
            })
    return jsonify({"files": files})


@app.route("/output/<path:filename>")
def download_output(filename):
    return send_from_directory(OUTPUT_DIR, filename, as_attachment=False)


if __name__ == "__main__":
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    app.run(host="127.0.0.1", port=8000, debug=False)
