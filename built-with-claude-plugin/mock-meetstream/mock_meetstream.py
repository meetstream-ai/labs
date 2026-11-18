#!/usr/bin/env python3
"""Offline mock of the MeetStream REST API (v1.9.0 shapes) for checking sample apps.

Standard library only. Request and response shapes follow the public OpenAPI spec
(https://docs.meetstream.ai/openapi.json) and the documented v1.9.0 behaviour.

Run:  python3 mock_meetstream.py --port 8787 [--log requests.jsonl]
Point an app at it with its base-URL setting, for example
      MEETSTREAM_BASE_URL=http://127.0.0.1:8787/api/v1

What it does
- Every /api/v1 call needs `Authorization: Token <non-empty>`; otherwise 401.
- Unknown paths answer 404 {"message": "mock: unknown route"} and are logged with
  "unknown": true, so a wrong path shows up in the log.
- POST /__mock/simulate/<bot_id> plays a short meeting for that bot:
    callback_url           <- unsigned lifecycle and post-call events (as production)
    workspace webhook      <- the same events, signed with HMAC-SHA256, when
                              MOCK_WORKSPACE_WEBHOOK_URL and MOCK_WEBHOOK_SECRET are set
    live_transcription_required.webhook_url <- unsigned live transcript chunks
    recording_config.realtime_endpoints     <- participant events the bot opted into
  Optional JSON body: {"chat": ["!help"]} adds chat messages to get_chats.
- POST /__mock/reset clears state. GET /__mock/log returns the request log.
  GET /__mock/state shows bots, hand state, chat messages the bot sent.

Switches (environment):
  MOCK_RATE_LIMIT_PER_MIN=N  429 + Retry-After after N creates per minute
  MOCK_TIMELINE_URL_FORM=1   get_speaker_timeline answers with speaker_timeline_url
  MOCK_PUBLIC_BASE=url       base for media download URLs (default: request Host)
  MOCK_TUNNEL=1              deliver https://127.0.0.1:<port> webhooks over http (acts as the tunnel)
  MOCK_MANAGED_OFF=1         MeetStream-managed voice-agent keys are switched off
  MOCK_MEDIA_TLS=cert:key       serve media/download links over https with this cert (pre-signed URLs are https)
  MOCK_NO_BYOK=1             the account has no provider keys saved (voice agents must use managed keys)
"""
import argparse
import hashlib
import hmac
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

STATE = {"bots": {}, "configs": {}, "scheduled": {}, "creates": [], "log": []}
LOCK = threading.Lock()
LOG_PATH = None
PUBLIC = os.environ.get("MOCK_PUBLIC_BASE", "")

CREATE_BOT_FIELDS = {
    "meeting_link", "bot_name", "bot_message", "bot_image_url", "video_required", "audio_required",
    "callback_url", "join_at", "deduplication_key", "custom_attributes", "recording_config",
    "automatic_leave", "live_audio_required", "live_video_required", "live_transcription_required",
    "socket_connection_url", "bot_camera_stream", "agent_config_id", "zoom", "google_meet", "teams",
    "audio_separate_streams", "video_separate_streams", "initial_audio", "storage_id", "schedule_name",
    "transcription_language", "meeting_captions", "timezone",
}
TRANSCRIPT_PROVIDERS = {
    "deepgram", "deepgram_streaming", "assemblyai", "assemblyai_streaming", "jigsawstack",
    "jigsawstack_streaming", "meeting_captions", "sarvam", "sarvam_streaming", "meetstream",
    "meetstream_streaming", "smallest", "smallest_streaming",
}
STREAMING = {p for p in TRANSCRIPT_PROVIDERS if p.endswith("_streaming")} | {"meeting_captions"}
SEND_COMMANDS = {"sendmsg", "sendchat", "sendimg", "sendimg_url", "interrupt", "screenshot",
                 "update_mia", "pause_recording", "resume_recording", "raise_hand", "lower_hand"}
REALTIME_EVENTS = {"participant_events.join", "participant_events.leave",
                   "participant_events.raise_hand", "participant_events.lower_hand"}
MIA_SECTIONS = ("transcriber", "model", "voice")
# Managed-key catalog of the mock. The real catalog is set per deployment; names here are examples.
MANAGED_CATALOG = {
    "transcriber": {"default_provider": "deepgram", "providers": {
        "deepgram": {"default_model": "nova-3", "models": {"nova-3": 0.1, "nova-2": 0.1}}}},
    "model": {"default_provider": "openai", "providers": {
        "openai": {"default_model": "gpt-4.1-mini", "models": {"gpt-4.1-mini": 0.1, "gpt-4.1": 0.2}}}},
    "voice": {"default_provider": "elevenlabs", "providers": {
        "elevenlabs": {"default_model": "eleven_turbo_v2_5", "models": {"eleven_turbo_v2_5": 0.2, "eleven_flash_v2_5": 0.2}},
        "openai": {"default_model": "tts-1", "models": {"tts-1": 0.1}}}},
}
TRANSCRIPT = [
    {"speaker": "Ana", "transcript": "Let's ship the beta on Friday.", "start_time": 0.5, "end_time": 3.2,
     "absolute_start_time": "2026-11-18T17:00:00.500Z", "absolute_end_time": "2026-11-18T17:00:03.200Z",
     "words": [{"word": "let's", "punctuated_word": "Let's", "start": 0.5, "end": 0.8}]},
    {"speaker": "Ben", "transcript": "Agreed. I will write the release notes by Thursday.", "start_time": 3.6,
     "end_time": 7.9, "absolute_start_time": "2026-11-18T17:00:03.600Z",
     "absolute_end_time": "2026-11-18T17:00:07.900Z",
     "words": [{"word": "agreed", "punctuated_word": "Agreed.", "start": 3.6, "end": 4.0}]},
    {"speaker": "Ana", "transcript": "Decision: we drop the legacy export.", "start_time": 8.1, "end_time": 10.4,
     "absolute_start_time": "2026-11-18T17:00:08.100Z", "absolute_end_time": "2026-11-18T17:00:10.400Z",
     "words": [{"word": "decision", "punctuated_word": "Decision:", "start": 8.1, "end": 8.6}]},
]
# speaker, name, start s, end s. Audio is 48 kHz mono s16le = 96000 bytes per second.
TIMELINE_CHUNKS = [("p1", "Ana", 0, 3.2), ("p2", "Ben", 3.6, 7.9), ("p1", "Ana", 8.1, 10.4), ("p2", "Ben", 10.6, 12.0)]


def _event(i, start, end, platform, url, title):
    return {"id": "evt_%d" % i, "start_time": start, "end_time": end, "calendar_id": "primary",
            "platform": "google", "platform_id": "g%d" % i, "ical_uid": "u%d@google.com" % i,
            "meeting_platform": platform, "meeting_url": url, "created_at": "2026-11-10T00:00:00Z",
            "updated_at": "2026-11-10T00:00:00Z", "is_deleted": False, "raw": {"summary": title}, "bots": []}


CALENDAR_EVENTS = [
    _event(1, "2026-11-19T17:00:00Z", "2026-11-19T17:30:00Z", "google_meet", "https://meet.google.com/abc-defg-hij", "Weekly sync"),
    _event(2, "2026-11-19T19:00:00Z", "2026-11-19T19:45:00Z", "zoom", "https://us02web.zoom.us/j/81234567890?pwd=abc", "Customer call"),
    _event(3, "2026-11-20T09:00:00Z", "2026-11-20T09:15:00Z", None, None, "Focus time"),
]


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def log(entry):
    entry = dict(entry, at=now_iso())
    with LOCK:
        STATE["log"].append(entry)
    if LOG_PATH:
        with open(LOG_PATH, "a") as f:
            f.write(json.dumps(entry) + "\n")


def post_json(url, payload, headers=None, kind="webhook"):
    h = {"Content-Type": "application/json", "User-Agent": "MeetStream-Webhook/1.0"}
    h.update(headers or {})
    if os.environ.get("MOCK_TUNNEL") and re.match(r"^https://(127\.0\.0\.1|localhost)[:/]", url or ""):
        url = "http://" + url[len("https://"):]  # stands in for an HTTPS tunnel to a local server
    try:
        req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=h)
        with urllib.request.urlopen(req, timeout=10) as r:
            status = r.status
    except urllib.error.HTTPError as e:
        status = e.code
    except Exception as e:  # receiver down: record it and keep going
        status = "error: %s" % e
    log({"outbound": kind, "url": url, "event": payload.get("event"), "status": status,
         "signed": "X-MeetStream-Signature" in h})
    return status


def detect_platform(link):
    host = urlparse(link).netloc.lower()
    if host == "meet.google.com":
        return "google_meet"
    if host == "zoom.us" or host.endswith(".zoom.us"):
        return "zoom"
    if host.endswith("teams.microsoft.com") or host.endswith("teams.live.com"):
        return "teams"
    return None


def validate_create(body):
    """A subset of create_bot validation with the production error texts."""
    link = body.get("meeting_link")
    if not isinstance(link, str) or not link.strip():
        return 400, {"message": "meeting_link is required"}
    if link.startswith("http://"):
        link = body["meeting_link"] = "https://" + link[len("http://"):]
    if not link.startswith("https://"):
        return 400, {"message": "meeting_link must use https://."}
    platform = detect_platform(link)
    if not platform:
        return 400, {"message": "invalid_meeting_link: unsupported meeting platform"}
    if platform == "zoom" and not re.search(r"/(j|w|s|wc/join)/\d{9,11}", link):
        return 400, {"message": "invalid_meeting_link: this Zoom link has no meeting number, so the bot cannot join it."}
    unknown = sorted(set(body) - CREATE_BOT_FIELDS)
    if unknown:
        log({"warning": "create_bot fields not in the public schema", "fields": unknown})
    rc = body.get("recording_config") or {}
    provider = (rc.get("transcript") or {}).get("provider") or {}
    if not isinstance(provider, dict):
        return 400, {"message": "recording_config.transcript.provider must be an object"}
    if any(p not in TRANSCRIPT_PROVIDERS for p in provider):
        return 400, {"message": "recording_config.transcript.provider must contain at least one of: "
                     + ", ".join(sorted(TRANSCRIPT_PROVIDERS))}
    live = body.get("live_transcription_required") or {}
    streaming = [p for p in provider if p in STREAMING]
    if live.get("websocket_url") and not live.get("webhook_url"):
        return 400, {"message": "live_transcription_required accepts webhook_url only"}
    if live.get("webhook_url") and not streaming:
        return 400, {"message": "live_transcription_required.webhook_url is provided but no streaming provider found."}
    if [p for p in streaming if p != "meeting_captions"] and not live.get("webhook_url"):
        return 400, {"message": "live_transcription_required.webhook_url is mandatory when using streaming providers: "
                     + ", ".join(streaming)}
    for ep in rc.get("realtime_endpoints") or []:
        bad = [e for e in ep.get("events") or [] if e not in REALTIME_EVENTS]
        if bad:
            return 400, {"message": "Invalid realtime_endpoints events: %s" % bad}
    zoom = body.get("zoom") or {}
    if "use_own_app" in zoom and zoom["use_own_app"] not in (True, False, None):
        return 400, {"message": "zoom.use_own_app must be true or false"}
    if "variant" in zoom:
        log({"warning": "zoom.variant is internal and is dropped on public requests"})
    if body.get("video_required") is False and body.get("audio_required") is False:
        return 400, {"message": "audio_required and video_required are both false, so the bot would record nothing."}
    vl = rc.get("video_layout")
    if vl and vl not in ("grid_view", "speaker_view", "grid_view_default", "speaker_view_default"):
        return 400, {"message": "recording_config.video_layout must be grid_view or speaker_view"}
    if body.get("agent_config_id") and body["agent_config_id"] not in STATE["configs"]:
        return 400, {"message": "agent_config_id not found"}
    return None


def rate_limited():
    limit = int(os.environ.get("MOCK_RATE_LIMIT_PER_MIN", "0") or 0)
    if not limit:
        return None
    t = time.time()
    with LOCK:
        STATE["creates"] = [x for x in STATE["creates"] if t - x < 60]
        if len(STATE["creates"]) >= limit:
            return max(1, int(60 - (t - STATE["creates"][0])))
        STATE["creates"].append(t)
    return None


def validate_mia(body, partial=False):
    """Agent config checks; the key_source rules copy the backend's managed-key validation."""
    mode = body.get("mode", "pipeline")
    if not partial:
        if not body.get("agent_name"):
            return "agent_name is required"
        if mode not in ("pipeline", "realtime"):
            return "mode must be pipeline or realtime"
        if not isinstance(body.get("model"), dict) or not body["model"].get("system_prompt"):
            return "model.system_prompt is required"
        if mode == "pipeline":
            for s in ("voice", "transcriber", "model"):
                sec = body.get(s)
                if not isinstance(sec, dict) or (not sec.get("provider") and sec.get("key_source") != "meetstream"):
                    return "%s.provider is required in pipeline mode" % s
            if not body["voice"].get("voice_id") and body["voice"].get("key_source") != "meetstream":
                return "voice.voice_id is required"
    for s in MIA_SECTIONS:
        sec = body.get(s)
        if isinstance(sec, dict) and "key_source" in sec and sec["key_source"] not in ("user", "meetstream"):
            return "%s.key_source must be one of: user, meetstream." % s
    managed = [s for s in MIA_SECTIONS if isinstance(body.get(s), dict) and body[s].get("key_source") == "meetstream"]
    if managed and mode != "pipeline":
        return "MeetStream-managed keys are available only in pipeline mode."
    if managed and os.environ.get("MOCK_MANAGED_OFF"):
        return "MeetStream-managed keys are not available for %s. Use your own key." % managed[0]
    for s in managed:
        sec, cat = body[s], MANAGED_CATALOG[s]
        if sec.get("api_key"):
            return '%s.api_key must be empty when %s.key_source is "meetstream".' % (s, s)
        prov = str(sec.get("provider") or cat["default_provider"]).lower()
        if prov not in cat["providers"]:
            return "%s.provider '%s' has no MeetStream key. Use one of: %s." % (s, prov, ", ".join(sorted(cat["providers"])))
        offer = cat["providers"][prov]
        model = str(sec.get("model") or offer["default_model"])
        if model not in offer["models"]:
            return "%s.model '%s' has no MeetStream price. Use one of: %s." % (s, model, ", ".join(sorted(offer["models"])))
        sec["provider"], sec["model"] = prov, model
    if os.environ.get("MOCK_NO_BYOK"):  # the account has no provider keys saved in the dashboard
        missing = ["%s.provider=%s" % (s, body[s].get("provider")) for s in MIA_SECTIONS
                   if isinstance(body.get(s), dict) and body[s].get("key_source") != "meetstream" and body[s].get("provider")]
        if missing:
            return "API key not configured for: %s. Add it via the Integrations API first." % ", ".join(missing)
    for s in MIA_SECTIONS:
        sec = body.get(s)
        if isinstance(sec, dict) and sec.get("key_source") != "meetstream" and sec.get("api_key"):
            log({"warning": "BYOK key sent inside the agent config; keys are saved in the dashboard Integrations", "section": s})
    return None


def timeline_doc():
    chunks = [{"chunkIndex": i, "timestamp": "2026-11-18T17:00:%02d.000Z" % int(s), "sampleRate": 48000,
               "speakerId": sid, "speakerName": name, "startByte": int(s * 96000), "endByte": int(e * 96000)}
              for i, (sid, name, s, e) in enumerate(TIMELINE_CHUNKS)]
    return {"chunks": chunks, "lastUpdated": now_iso(), "totalFileSize": int(12.0 * 96000)}


class Handler(BaseHTTPRequestHandler):
    server_version = "mock-meetstream/1.0"

    def log_message(self, *a):
        pass

    def _send(self, status, obj, headers=None):
        raw = isinstance(obj, bytes)
        data = obj if raw else json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/octet-stream" if raw else "application/json")
        for k, v in (headers or {}).items():
            self.send_header(k, str(v))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw) if raw else {}
        except ValueError:
            return None

    def _base(self):
        return PUBLIC or "http://%s" % self.headers.get("Host", "127.0.0.1")

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PUT(self):
        self._route("PUT")

    def do_PATCH(self):
        self._route("PATCH")

    def do_DELETE(self):
        self._route("DELETE")

    def _route(self, method):
        u = urlparse(self.path)
        path, q = u.path.rstrip("/") or "/", parse_qs(u.query)
        body = self._body() if method != "GET" else {}
        if path.startswith("/__mock") or path.startswith("/media"):
            return self._mock_admin(method, path, body)
        auth = self.headers.get("Authorization") or ""
        entry = {"method": method, "path": path, "query": u.query,
                 "auth_scheme": auth.split(" ")[0] if auth else None, "body": body}
        if body is None:
            log(dict(entry, status=400))
            return self._send(400, {"message": "Invalid JSON body"})
        if not re.match(r"^Token \S+$", auth):
            log(dict(entry, status=401))
            return self._send(401, {"detail": "Authentication credentials were not provided."})
        status, resp, headers = self._api(method, path, q, body)
        entry.update(status=status, unknown=isinstance(resp, dict) and resp.get("message") == "mock: unknown route")
        log(entry)
        self._send(status, resp, headers)

    def _api(self, method, path, q, body):
        m = re.match(r"^/api/v1/(.*)$", path)
        if not m:
            return 404, {"message": "mock: unknown route"}, None
        p, bots = m.group(1), STATE["bots"]
        if method == "POST" and p == "bots/create_bot":
            retry = rate_limited()
            if retry:
                return 429, {"error": "rate_limit_exceeded", "message": "Too many bot creates. Try again later.",
                             "limit": int(os.environ["MOCK_RATE_LIMIT_PER_MIN"]), "window": "minute",
                             "retry_after": retry}, {"Retry-After": retry}
            err = validate_create(body)
            if err:
                return err[0], err[1], None
            bot_id = str(uuid.uuid4())
            prov = ((body.get("recording_config") or {}).get("transcript") or {}).get("provider") or {}
            tid = str(uuid.uuid4()) if [x for x in prov if x not in STREAMING] else None
            bots[bot_id] = {"req": body, "transcript_id": tid, "status": "Joining", "hand": False,
                            "platform": detect_platform(body["meeting_link"]), "started": time.time(), "chat": []}
            return 201, {"bot_id": bot_id, "transcript_id": tid, "meeting_url": body["meeting_link"],
                         "status": "Scheduled" if body.get("join_at") else "Active"}, None
        if method == "GET" and p == "bots":
            return 200, {"bots": [{"bot_id": k, "status": v["status"], "meeting_link": v["req"]["meeting_link"],
                                   "platform": v["platform"], "created_at": now_iso()} for k, v in bots.items()],
                         "hasNextPage": False, "nextCursor": None}, None
        bm = re.match(r"^bots/([^/]+)(?:/(.*))?$", p)
        if bm and bm.group(1) not in ("create_bot", "trigger_old_bots", "trigger_transcript"):
            bot = bots.get(bm.group(1))
            if not bot:
                return 404, {"message": "Bot not found"}, None
            return self._bot(method, bm.group(1), bot, bm.group(2) or "", body)
        tm = re.match(r"^transcript/([^/]+)/get_transcript$", p)
        if method == "GET" and tm:
            for b in bots.values():
                if b["transcript_id"] == tm.group(1):
                    return (200, TRANSCRIPT, None) if b.get("done") else (404, {"message": "Transcript not ready"}, None)
            return 404, {"message": "Transcript not found"}, None
        if p.startswith("calendar/"):
            return self._calendar(method, p[len("calendar/"):], body)
        if p == "mia":
            return self._mia(method, q, body)
        return 404, {"message": "mock: unknown route"}, None

    def _bot(self, method, bot_id, bot, action, body):
        base, in_meeting = self._base(), bot["status"] in ("InMeeting", "Recording")
        if method == "GET" and action == "detail":
            return 200, {"bot_details": {
                "BotID": bot_id, "BotUsername": bot["req"].get("bot_name", "MeetStream Bot"),
                "MeetingLink": bot["req"]["meeting_link"], "Platform": bot["platform"], "Status": bot["status"],
                "CreatedAt": now_iso(), "transcript_id": bot["transcript_id"],
                "AudioStatus": "Success" if bot.get("done") else "Processing",
                "TranscriptStatus": ("Success" if bot.get("done") else "Processing") if bot["transcript_id"] else None,
                "custom_attributes": bot["req"].get("custom_attributes") or {}}}, None
        if method == "GET" and action in ("status", ""):
            return 200, {"bot_id": bot_id, "status": bot["status"]}, None
        if method in ("GET", "POST") and action == "remove_bot":
            bot["status"] = "Stopped"
            return 200, {"status": "stopped", "bot_id": bot_id, "message": "Bot removed"}, None
        if method == "GET" and action == "get_transcript":
            return (200, TRANSCRIPT, None) if bot.get("done") else (404, {"message": "Transcript not ready"}, None)
        if method == "GET" and action == "transcriptions":
            items = []
            if bot["transcript_id"]:
                items.append({"transcript_id": bot["transcript_id"], "provider": "meetstream",
                              "status": "Success" if bot.get("done") else "Processing", "created_at": now_iso(),
                              "config": {}, "download_urls": None})
            return 200, {"bot_id": bot_id, "transcriptions": items}, None
        if method == "GET" and action == "get_audio":
            if not bot.get("done"):
                return 202, {"audio_status": "processing", "message": "Audio is being processed"}, None
            return 200, {"audio_status": "available", "audio_url": base + "/media/%s/audio.wav" % bot_id,
                         "audio_mp3_url": base + "/media/%s/audio.mp3" % bot_id}, None
        if method == "GET" and action in ("get_video", "get_recording_streams"):
            if not bot["req"].get("video_required"):
                return 404, {"message": "Video not recorded for this bot"}, None
            return 200, {"video_url": base + "/media/%s/video.mp4" % bot_id,
                         "video_info": {"duration": 12, "size_mb": 0.01, "resolution": "1600x900", "fps": 25,
                                        "frames_processed": 300, "corrupted_frames": 0}}, None
        if method == "GET" and action == "get_audio_streams":
            if not bot.get("done"):
                return 404, {"message": "Audio streams not ready"}, None
            if not bot["req"].get("audio_separate_streams"):
                return 200, [], None
            return 200, [{"id": "s%d" % i, "created_at": now_iso(), "is_bot": False,
                          "participant": {"id": i + 1, "name": name, "is_host": i == 0, "is_bot": False,
                                          "platform": bot["platform"], "extra_data": {}},
                          "start_timestamp": {"absolute": now_iso(), "relative": 0.0}, "duration": 12.0,
                          "download_url": base + "/media/%s/%s.wav" % (bot_id, pid),
                          "download_url_mp3": base + "/media/%s/%s.mp3" % (bot_id, pid)}
                         for i, (pid, name) in enumerate([("p1", "Ana"), ("p2", "Ben")])], None
        if method == "GET" and action == "get_speaker_timeline":
            if not bot.get("done"):
                return 404, {"message": "Manifest file not found. It may still be processing."}, None
            tl = timeline_doc()
            if os.environ.get("MOCK_TIMELINE_URL_FORM"):
                return 200, {"bot_id": bot_id, "speaker_timeline_url": base + "/media/%s/speaker_timeline.json" % bot_id,
                             "size_bytes": len(json.dumps(tl)), "truncated": False}, None
            return 200, tl, None
        if method == "GET" and action == "get_chats":
            msgs = [{"messageId": "m%d" % i, "deviceId": "d1", "timestamp": now_iso(), "text": t,
                     "speakerName": "Ana", "speakerDisplayName": "Ana", "clientTimestamp": now_iso(),
                     "sessionTimestamp": i} for i, t in enumerate(bot["chat"])]
            return 200, {"metadata": {"botId": bot_id, "totalMessages": len(msgs)}, "speakers": [],
                         "chatMessages": msgs, "messagesBySpeaker": {}, "serverMetadata": {}}, None
        if method == "GET" and action == "get_participants":
            return 200, [{"id": 1, "name": "Ana", "is_host": True}, {"id": 2, "name": "Ben", "is_host": False}], None
        if method == "POST" and action == "send_message":
            msg = (body or {}).get("message")
            if not isinstance(msg, str) or not 1 <= len(msg) <= 2000:
                return 400, {"message": "message is required (1-2000 characters)"}, None
            if not in_meeting:
                return 409, {"message": "Bot is not in the meeting"}, None
            bot.setdefault("sent", []).append(msg)
            return 200, {"status": "accepted", "bot_id": bot_id, "command": "sendmsg"}, None
        if method == "POST" and action == "send_command":
            cmd = (body or {}).get("command")
            if cmd not in SEND_COMMANDS:
                return 400, {"message": "Invalid command. Allowed: %s" % sorted(SEND_COMMANDS - {"raise_hand", "lower_hand"})}, None
            if cmd in ("raise_hand", "lower_hand"):
                if not in_meeting:
                    return 409, {"message": "Bot is not in the meeting (status: %s)" % bot["status"]}, None
                bot["hand"] = cmd == "raise_hand"
                return 200, {"status": "accepted", "bot_id": bot_id, "command": cmd, "hand_raised": bot["hand"]}, None
            return 200, {"status": "accepted", "bot_id": bot_id, "command": cmd}, None
        return 404, {"message": "mock: unknown route"}, None

    def _calendar(self, method, p, body):
        if method == "GET" and p in ("events", "get_events"):
            return 200, {"next": None, "previous": None, "has_more": False, "results": CALENDAR_EVENTS}, None
        if method == "GET" and p == "calendars":
            return 200, {"calendars": [{"id": "primary", "summary": "Work", "isPrimary": True, "provider": "google",
                                        "account_id": "acc1"}], "connections": [], "total": 1, "user_id": "u1"}, None
        sm = re.match(r"^schedule/([^/]+)$", p)
        if sm and method == "POST":
            eid = sm.group(1)
            ev = next((e for e in CALENDAR_EVENTS if e["id"] == eid), None)
            if not ev:
                return 404, {"message": "Event not found"}, None
            if not ev.get("meeting_url"):
                return 400, {"message": "Event has no meeting link"}, None
            if eid in STATE["scheduled"]:
                return 409, {"message": "Bot already scheduled for this event", "bot_id": STATE["scheduled"][eid]["bot_id"]}, None
            cfg = (body or {}).get("bot_config")
            if not isinstance(cfg, dict):
                log({"warning": "schedule body without a bot_config object", "body": body})
                cfg = {}
            if "transcription" in cfg:
                log({"warning": "bot_config.transcription is ignored by create_bot (legacy key); "
                                "use bot_config.recording_config.transcript.provider", "bot_config": cfg})
            bot_id = str(uuid.uuid4())
            join = (datetime.fromisoformat(ev["start_time"].replace("Z", "+00:00")) - timedelta(minutes=1)).isoformat()
            STATE["scheduled"][eid] = {"bot_id": bot_id, "platform": ev["meeting_platform"], "status": "Scheduled",
                                       "scheduled_join_time": join, "bot_username": cfg.get("bot_name", "MeetStream Bot"),
                                       "meeting_link": ev["meeting_url"], "custom_attributes": {}}
            return 200, {"scheduled": True, "schedule_id": "sch_" + bot_id[:8], "bot_id": bot_id, "event_id": eid,
                         "scheduled_time": join, "existing_schedules": 0, "occurrence_date": None,
                         "is_recurring_occurrence": False, "bot_config": dict(cfg, meeting_url=ev["meeting_url"])}, None
        if sm and method == "DELETE":
            STATE["scheduled"].pop(sm.group(1), None)
            return 200, {"message": "Unscheduled"}, None
        if method == "GET" and p == "scheduled_bots":
            return 200, {"scheduled_bots": list(STATE["scheduled"].values())}, None
        return 404, {"message": "mock: unknown route"}, None

    def _mia(self, method, q, body):
        if method == "POST":
            err = validate_mia(body)
            if err:
                return 400, {"message": err}, None
            cid = str(uuid.uuid4())
            STATE["configs"][cid] = body
            return 200, {"message": "Agent configuration created successfully.", "agent_config_id": cid,
                         "agent_config": {"AgentConfigID": cid, "AgentName": body["agent_name"],
                                          "Mode": body.get("mode", "pipeline"), "Model": body.get("model"),
                                          "Voice": body.get("voice"), "Transcriber": body.get("transcriber")}}, None
        if method == "GET":
            cid = (q.get("agent_config_id") or [None])[0]
            if cid:
                c = STATE["configs"].get(cid)
                return (200, {"agent_config": dict(c, AgentConfigID=cid)}, None) if c else (404, {"message": "not found"}, None)
            return 200, {"agent_configs": [dict(v, AgentConfigID=k) for k, v in STATE["configs"].items()],
                         "mia_managed": {"enabled": not os.environ.get("MOCK_MANAGED_OFF"),
                                         "sections": {} if os.environ.get("MOCK_MANAGED_OFF") else MANAGED_CATALOG}}, None
        if method == "PUT":
            cid = (body or {}).get("agent_config_id")
            if cid not in STATE["configs"]:
                return 404, {"message": "not found"}, None
            err = validate_mia(dict(STATE["configs"][cid], **body), partial=True)
            if err:
                return 400, {"message": err}, None
            STATE["configs"][cid].update({k: v for k, v in body.items() if k != "agent_config_id"})
            return 200, {"message": "Agent configuration updated successfully.", "agent_config_id": cid}, None
        if method == "DELETE":
            cid = (q.get("agent_config_id") or [(body or {}).get("agent_config_id")])[0]
            STATE["configs"].pop(cid, None)
            return 200, {"message": "Agent configuration deleted successfully."}, None
        return 404, {"message": "mock: unknown route"}, None

    def _mock_admin(self, method, path, body):
        if path == "/__mock/reset":
            with LOCK:
                STATE.update(bots={}, configs={}, scheduled={}, creates=[], log=[])
            return self._send(200, {"ok": True})
        if path == "/__mock/log":
            return self._send(200, STATE["log"])
        if path == "/__mock/state":
            return self._send(200, {"bots": {k: {"status": v["status"], "hand": v["hand"], "sent": v.get("sent", []),
                                                 "transcript_id": v["transcript_id"]} for k, v in STATE["bots"].items()},
                                    "scheduled": STATE["scheduled"], "configs": STATE["configs"]})
        sm = re.match(r"^/__mock/simulate/([^/]+)$", path)
        if sm and method == "POST":
            bot = STATE["bots"].get(sm.group(1))
            if not bot:
                return self._send(404, {"message": "Bot not found"})
            bot["chat"].extend((body or {}).get("chat") or [])
            stage = (body or {}).get("stage", "all")
            simulate(sm.group(1), bot, stage)
            return self._send(200, {"ok": True})
        mm = re.match(r"^/media/([^/]+)/(.+)$", path)
        if mm and method == "GET":
            if mm.group(2) == "speaker_timeline.json":
                if self.headers.get("Authorization"):
                    log({"warning": "Authorization header sent to a pre-signed speaker_timeline_url"})
                return self._send(200, timeline_doc())
            log({"download": mm.group(2), "bot_id": mm.group(1)})
            return self._send(200, b"RIFF....WAVEmock-media-" + mm.group(2).encode())
        return self._send(404, {"message": "mock: unknown route"})


def sign(payload, secret):
    return hmac.new(secret.encode(), json.dumps(payload).encode(), hashlib.sha256).hexdigest()


def deliver(bot_id, bot, payload):
    payload = dict(payload, bot_id=bot_id, timestamp=now_iso())
    if bot["req"].get("custom_attributes"):
        payload["custom_attributes"] = bot["req"]["custom_attributes"]
    ws_url, secret = os.environ.get("MOCK_WORKSPACE_WEBHOOK_URL"), os.environ.get("MOCK_WEBHOOK_SECRET")
    if ws_url and secret:
        post_json(ws_url, payload, {"X-MeetStream-Signature": "sha256=" + sign(payload, secret),
                                    "X-MeetStream-Timestamp": payload["timestamp"]}, "workspace_webhook")
    cb = bot["req"].get("callback_url")
    if cb and cb != ws_url:
        post_json(cb, payload, None, "callback_url")


def simulate(bot_id, bot, stage="all"):
    """stage: "join" (bot ends up in the meeting), "end" (leave + post-call), or "all"."""
    req = bot["req"]
    if stage in ("all", "join"):
        for ev, st in (("bot.joining", "Joining"), ("bot.inmeeting", "InMeeting"), ("bot.recording", "Recording")):
            bot["status"] = st
            deliver(bot_id, bot, {"event": ev, "bot_event": ev, "bot_status": st, "status_code": 200, "message": st})
        live = (req.get("live_transcription_required") or {}).get("webhook_url")
        if live:
            for seg in TRANSCRIPT:
                for final in (False, True):
                    text = seg["transcript"] if final else seg["transcript"].split(" ")[0]
                    # RAW mode body (the default transcription_mode for streaming providers)
                    post_json(live, {"bot_id": bot_id, "speakerName": seg["speaker"], "speakerId": "id-" + seg["speaker"],
                                     "timestamp": now_iso(), "transcript": text, "utterance": "",
                                     "words": [{"word": w, "start": seg["start_time"], "end": seg["end_time"],
                                                "confidence": 0.99} for w in text.split(" ")],
                                     "is_final": final, "end_of_turn": final, "turn_is_formatted": final,
                                     "turn_order": TRANSCRIPT.index(seg), "transcription_mode": "raw"},
                              None, "live_transcript")
        for ep in (req.get("recording_config") or {}).get("realtime_endpoints") or []:
            for ev in ep.get("events") or []:
                post_json(ep.get("url"), {"event": ev, "timestamp": now_iso(), "data": {"data": {
                    "action": ev.split(".", 1)[1],
                    "participant": {"id": "1", "name": "Ana", "is_host": True, "platform": bot["platform"], "extra_data": {}},
                    "timestamp": {"relative": 1.0, "absolute": now_iso()}}, "bot": {"id": bot_id, "metadata": {}}}},
                          None, "realtime_endpoint")
    if stage in ("all", "end"):
        bot["status"] = "Stopped"
        deliver(bot_id, bot, {"event": "bot.stopped", "bot_event": "bot.stopped", "bot_status": "Stopped",
                              "status_code": 200, "message": "Bot left the meeting"})
        bot["done"] = True
        deliver(bot_id, bot, {"event": "audio.processed", "bot_event": "audio.processed", "status": "success",
                              "audio_status": "Success", "message": "Audio processing completed successfully",
                              "status_code": 200})
        if req.get("video_required"):
            deliver(bot_id, bot, {"event": "video.processed", "bot_event": "video.processed", "status": "success",
                                  "message": "Video processing completed", "status_code": 200})
        if bot["transcript_id"]:
            deliver(bot_id, bot, {"event": "transcription.processed", "bot_event": "transcription.processed",
                                  "status": "success", "transcript_status": "Success",
                                  "message": "Transcript processing completed successfully", "status_code": 200})
        bot["status"] = "Done"
        deliver(bot_id, bot, {"event": "bot.done", "bot_event": "bot.done", "bot_status": "Done", "status_code": 200,
                              "message": "Bot finished"})


def main():
    global LOG_PATH
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--log")
    a = ap.parse_args()
    LOG_PATH = a.log
    global PUBLIC
    tls = os.environ.get("MOCK_MEDIA_TLS")  # "cert.pem:key.pem": also serve media links over https
    if tls:
        import ssl
        cert, key = tls.split(":", 1)
        media = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        media.socket = ctx.wrap_socket(media.socket, server_side=True)
        PUBLIC = "https://127.0.0.1:%d" % media.server_address[1]
        threading.Thread(target=media.serve_forever, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    print("mock MeetStream API on http://127.0.0.1:%d/api/v1" % a.port, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
