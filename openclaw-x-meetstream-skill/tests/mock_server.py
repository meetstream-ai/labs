#!/usr/bin/env python3
"""Minimal mock of the MeetStream API surface this skill talks to.
Used only for local test runs against MEETSTREAM_API_BASE=http://127.0.0.1:PORT/api/v1
Not part of the shipped skill.
"""
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8935
PORT_FILE = sys.argv[2] if len(sys.argv) > 2 else None

BOTS = {
    "bot-active-1": {"bot_id": "bot-active-1", "status": "InCallRecording", "meeting_url": "https://meet.google.com/aaa-bbbb-ccc", "transcript_id": "transcript-1"},
    "bot-done-1": {"bot_id": "bot-done-1", "status": "Done", "meeting_url": "https://meet.google.com/xxx-yyyy-zzz"},
}

AGENTS = [
    {"AgentConfigID": "agent-1", "UserID": "u1", "AgentName": "Sales Notetaker", "Mode": "pipeline",
     "Model": {"provider": "openai", "model": "gpt-4o-mini"}},
    {"AgentConfigID": "agent-2", "UserID": "u1", "AgentName": "Standup Bot", "Mode": "realtime",
     "Model": {"provider": "openai", "model": "gpt-realtime-mini"}},
]
FORCE_NEXT_PAGE = False


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _check_auth(self):
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Token "):
            self._send(401, {"detail": "Missing or malformed Authorization header"})
            return False
        if auth == "Token bad-key":
            self._send(401, {"detail": "Invalid API key"})
            return False
        return True

    def do_GET(self):
        global FORCE_NEXT_PAGE
        if not self._check_auth():
            return
        path = self.path

        if path == "/api/v1/test/force-next-page":
            FORCE_NEXT_PAGE = True
            self._send(200, {"ok": True})
            return

        if path == "/api/v1/mia":
            self._send(200, {"agent_configs": AGENTS, "count": len(AGENTS)})
            return

        if path.startswith("/api/v1/bots") and not re.search(r"/bots/[^/]+", path):
            # List bots (ignore query filters for the mock, or apply status filter loosely)
            has_next = FORCE_NEXT_PAGE
            FORCE_NEXT_PAGE = False
            self._send(200, {"bots": list(BOTS.values()), "hasNextPage": has_next,
                             "nextCursor": "next-page" if has_next else None})
            return

        m = re.match(r"^/api/v1/bots/([^/]+)/status$", path)
        if m:
            bot = BOTS.get(m.group(1))
            if not bot:
                self._send(404, {"detail": "Bot not found"})
                return
            self._send(200, {"bot_id": bot["bot_id"], "status": bot["status"], "custom_attributes": {}})
            return

        m = re.match(r"^/api/v1/bots/([^/]+)/remove_bot$", path)
        if m:
            bot_id = m.group(1)
            if bot_id not in BOTS:
                self._send(404, {"detail": "Bot not found"})
                return
            BOTS[bot_id]["status"] = "Stopped"
            self._send(200, {"message": f"Stop signal sent for bot {bot_id}."})
            return

        m = re.match(r"^/api/v1/bots/([^/]+)/(detail|summary|get_participants|get_chats|get_speaker_timeline|get_audio|get_video|get_audio_streams|get_recording_streams|get_screenshots|transcriptions)$", path)
        if m:
            bot_id, kind = m.groups()
            if bot_id not in BOTS:
                self._send(404, {"detail": "Bot not found"})
                return
            payloads = {
                "detail": {"bot_details": {"bot_id": bot_id, "status": BOTS[bot_id]["status"], "transcript_id": BOTS[bot_id].get("transcript_id")}},
                "summary": {"summary": "The team agreed on the launch plan."},
                "get_participants": {"participants": [{"displayName": "Alice", "status": "joined"}]},
                "get_chats": {"chats": [{"sender": "Alice", "message": "Hello"}]},
                "get_speaker_timeline": {"speakers": [{"speaker_name": "Alice", "start": 0, "end": 4}]},
                "get_audio": {"url": "https://media.example/audio.mp3"},
                "get_video": {"url": "https://media.example/video.mp4"},
                "get_audio_streams": {"recordings": []},
                "get_recording_streams": {"recordings": []},
                "get_screenshots": {"screenshots": []},
                "transcriptions": {"transcriptions": [{"transcript_id": BOTS[bot_id].get("transcript_id"), "status": "completed"}]},
            }
            self._send(200, payloads[kind])
            return

        if re.match(r"^/api/v1/transcript/transcript-1/get_transcript(?:\?.*)?$", path):
            self._send(200, {"message": [{"speaker": "Alice", "transcript": "We approved the launch plan."}]})
            return

        if path == "/api/v1/calendar/events":
            self._send(200, {"events": [{"event_id": "event-1", "title": "Weekly standup", "meeting_link": "https://meet.google.com/aaa-bbbb-ccc"}]})
            return

        self._send(404, {"detail": f"no mock route for {path}"})

    def do_POST(self):
        if not self._check_auth():
            return
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw)
        except Exception:
            self._send(400, {"detail": "invalid json"})
            return

        if self.path == "/api/v1/bots/create_bot":
            if not data.get("meeting_link") or not data.get("bot_name"):
                self._send(400, {"detail": "meeting_link and bot_name are required"})
                return
            if data.get("agent_config_id") and (data.get("socket_connection_url") or data.get("live_audio_required")):
                self._send(400, {"detail": "Hosted MIA must not include custom bridge URLs"})
                return
            new_id = "bot-new-1"
            transcript_id = "transcript-1" if data.get("recording_config", {}).get("transcript") else None
            BOTS[new_id] = {"bot_id": new_id, "status": "Joining", "meeting_url": data["meeting_link"], "transcript_id": transcript_id}
            self._send(201, {"bot_id": new_id, "transcript_id": transcript_id,
                              "meeting_url": data["meeting_link"], "status": "Active"})
            return

        m = re.match(r"^/api/v1/bots/([^/]+)/send_message$", self.path)
        if m:
            bot_id = m.group(1)
            if bot_id not in BOTS:
                self._send(404, {"detail": "Bot not found"})
                return
            if not data.get("message"):
                self._send(400, {"detail": "message is required"})
                return
            self._send(200, {"message": "Message sent"})
            return

        m = re.match(r"^/api/v1/calendar/schedule/([^/]+)$", self.path)
        if m:
            self._send(200, {"message": f"Bot scheduled for event {m.group(1)}"})
            return

        self._send(404, {"detail": f"no mock route for {self.path}"})

    def do_DELETE(self):
        if not self._check_auth():
            return
        m = re.match(r"^/api/v1/calendar/schedule/([^/]+)$", self.path)
        if m:
            self._send(200, {"message": f"Bot unscheduled for event {m.group(1)}"})
            return
        self._send(404, {"detail": f"no mock route for {self.path}"})

    def log_message(self, fmt, *args):
        pass  # keep test output quiet


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    if PORT_FILE:
        with open(PORT_FILE, "w", encoding="utf-8") as f:
            f.write(str(server.server_port))
    server.serve_forever()
