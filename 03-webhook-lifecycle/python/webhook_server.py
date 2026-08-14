"""
MeetStream Webhook Server

This Flask server receives HTTP POST requests from MeetStream at every
stage of a bot's lifecycle and logs each event with a formatted summary.

Endpoint:
    POST /webhooks/meetstream
        Receives a JSON event payload, prints a formatted summary to the
        terminal, saves the raw payload to a JSON file in the events/
        directory, and returns HTTP 200 with a JSON acknowledgement.

Health check:
    GET /api/health
        Returns a simple JSON status response. Use this to confirm the
        server is running before creating a bot with create_bot.py.

Dashboard:
    GET /
        Renders a local web dashboard (templates/dashboard.html) as an
        alternative to the CLI. It lets you paste a MeetStream API key
        and a meeting link, deploy a bot, and watch lifecycle events
        arrive in a live log panel. It is backed by these JSON routes:
            POST /api/deploy          create a bot from the dashboard form
            GET  /api/session         current session status
            GET  /api/logs            log lines for the Live Logs panel
            GET  /api/output-files    list of saved event JSON files
        The dashboard polls these routes on an interval; it does not use
        WebSockets.

Events are saved as JSON files in the events/ directory for later
inspection and debugging.

MeetStream requires your webhook endpoint to return a 2xx response
within a reasonable time. If it does not, MeetStream will retry the
webhook delivery.
"""

import json
import os
import time
from datetime import datetime
import requests
from flask import Flask, request, jsonify, render_template
from dotenv import load_dotenv

load_dotenv()

PORT = int(os.getenv("WEBHOOK_PORT", "3000"))

EVENTS_DIR = os.path.join(os.getcwd(), "events")
os.makedirs(EVENTS_DIR, exist_ok=True)

app = Flask(__name__)

EVENT_DESCRIPTIONS = {
    "bot.joining": "Bot has been dispatched and is attempting to join the meeting waiting room",
    "bot.inmeeting": "Bot has been admitted and is now actively recording",
    "bot.recording": "Recording has started successfully",
    "bot.leaving": "Bot is in the process of leaving the meeting",
    "bot.stopped": "Bot has left the meeting and post-processing has started",
    "bot.done": "All post-processing complete - transcript and media files are ready",
    "bot.notallowed": "Bot was not admitted before the waiting_room_timeout expired",
    "bot.failed": "Bot encountered a fatal error and could not complete the session",
    "bot.recording_permission_denied": "Zoom host denied the recording permission request",
}

CURRENT_SESSION = {
    "bot_id": None,
    "meeting_link": None,
    "platform": None,
    "start_time": None,
    "status": "Idle",
}
EVENT_LOG = []  # list of formatted log line strings, most recent last
MAX_LOG_LINES = 500


def detect_platform(meeting_link: str) -> str:
    if "meet.google.com" in meeting_link:
        return "Google Meet"
    if "zoom.us" in meeting_link:
        return "Zoom"
    if "teams.microsoft.com" in meeting_link:
        return "Microsoft Teams"
    return "Unknown"


@app.route("/webhooks/meetstream", methods=["POST"])
def meetstream_webhook():
    data = request.get_json(silent=True)
    if data is None:
        return jsonify({"error": "Invalid JSON body"}), 400

    event_type = data.get("event", "unknown")
    bot_id = data.get("bot_id", "unknown")
    status = data.get("status", "unknown")
    message = data.get("message", "")
    timestamp = data.get("timestamp", datetime.utcnow().isoformat())
    meeting_url = data.get("meeting_url", "")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    description = EVENT_DESCRIPTIONS.get(event_type, "Unknown event type")

    print(f"\n[{now}] EVENT RECEIVED")
    print(f"Event:       {event_type}")
    print(f"Bot ID:      {bot_id}")
    print(f"Status:      {status}")
    if meeting_url:
        print(f"Meeting URL: {meeting_url}")
    if message:
        print(f"Message:     {message}")
    print(f"Description: {description}")
    print(f"Raw payload: {json.dumps(data)}")
    print("-" * 40)

    CURRENT_SESSION["bot_id"] = bot_id
    CURRENT_SESSION["status"] = status
    EVENT_LOG.append(f"[{now}] {event_type} - {status} - {message}".strip())
    if len(EVENT_LOG) > MAX_LOG_LINES:
        del EVENT_LOG[: len(EVENT_LOG) - MAX_LOG_LINES]

    filename = f"{event_type.replace('.', '_')}_{bot_id[:8]}_{int(time.time())}.json"
    filepath = os.path.join(EVENTS_DIR, filename)
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

    return jsonify({"status": "received", "event": event_type}), 200


@app.route("/api/health", methods=["GET"])
def health_check():
    return jsonify({
        "status": "running",
        "service": "MeetStream Webhook Server",
        "endpoint": "/webhooks/meetstream"
    }), 200


@app.route("/", methods=["GET"])
def dashboard():
    return render_template("dashboard.html")


@app.route("/api/deploy", methods=["POST"])
def deploy_agent():
    body = request.get_json(silent=True) or {}
    api_key = (body.get("api_key") or "").strip()
    meeting_link = (body.get("meeting_link") or "").strip()

    if not api_key:
        return jsonify({"error": "MeetStream API key is required"}), 400
    if not meeting_link:
        return jsonify({"error": "Meeting link is required"}), 400

    callback_url = os.getenv("CALLBACK_URL")
    if not callback_url:
        return jsonify({"error": "CALLBACK_URL is not set in .env"}), 400
    if callback_url == "https://your-ngrok-url-here.ngrok-free.app/webhooks/meetstream":
        return jsonify({
            "error": "CALLBACK_URL in .env still has the placeholder value. "
                     "Run ngrok and update CALLBACK_URL with your actual ngrok URL."
        }), 400

    payload = {
        "meeting_link": meeting_link,
        "bot_name": "MeetStream Webhook Bot",
        "video_required": False,
        "callback_url": callback_url,
    }
    headers = {
        "Authorization": f"Token {api_key}",
        "Content-Type": "application/json",
    }

    try:
        response = requests.post(
            "https://api.meetstream.ai/api/v1/bots/create_bot",
            json=payload,
            headers=headers,
        )
    except requests.exceptions.RequestException as e:
        return jsonify({"error": str(e)}), 502

    if response.status_code == 201:
        data = response.json()
        CURRENT_SESSION["bot_id"] = data["bot_id"]
        CURRENT_SESSION["meeting_link"] = meeting_link
        CURRENT_SESSION["platform"] = detect_platform(meeting_link)
        CURRENT_SESSION["start_time"] = datetime.now().isoformat()
        CURRENT_SESSION["status"] = data["status"]
        EVENT_LOG.append(f"Bot deployed: {data['bot_id']} ({data['status']})")
        return jsonify({"bot_id": data["bot_id"], "status": data["status"]}), 200
    elif response.status_code == 401:
        return jsonify({"error": "Authentication failed. Check your MeetStream API key."}), 401
    elif response.status_code == 400:
        return jsonify({"error": f"Bad request: {response.json()}"}), 400
    else:
        return jsonify({"error": f"{response.status_code}: {response.text}"}), 502


@app.route("/api/session", methods=["GET"])
def get_session():
    return jsonify(CURRENT_SESSION), 200


@app.route("/api/logs", methods=["GET"])
def get_logs():
    return jsonify({"lines": EVENT_LOG}), 200


@app.route("/api/output-files", methods=["GET"])
def get_output_files():
    files = sorted(os.listdir(EVENTS_DIR))
    return jsonify({"files": files, "count": len(files)}), 200


if __name__ == "__main__":
    print(f"MeetStream Webhook Server running on http://0.0.0.0:{PORT}")
    print(f"Webhook endpoint: http://0.0.0.0:{PORT}/webhooks/meetstream")
    print(f"Dashboard: http://0.0.0.0:{PORT}/")
    print(f"Events will be saved to: {EVENTS_DIR}")
    print(f"Waiting for events...\n")
    app.run(host="0.0.0.0", port=PORT, debug=False)
