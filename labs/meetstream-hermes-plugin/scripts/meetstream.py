#!/usr/bin/env python3
"""Small, deterministic Hermes skill client for the MIA x Hermes bridge."""

from __future__ import annotations

import json
import os
import sys
from typing import NoReturn
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen


DEFAULT_BRIDGE = "http://127.0.0.1:3000"
SECRET_NAMES = {"api_key", "key", "authorization", "token", "secret", "password"}


def fail(message: str, code: int = 2) -> NoReturn:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(code)


def bridge_url() -> str:
    value = os.getenv("MEETSTREAM_BRIDGE_URL", DEFAULT_BRIDGE).rstrip("/")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        fail("MEETSTREAM_BRIDGE_URL must be an http(s) URL")
    return value


def meeting_url(value: str) -> str:
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower().rstrip(".")
    allowed = host == "meet.google.com" or host == "zoom.us" or host.endswith(".zoom.us") or host == "teams.microsoft.com" or host.endswith(".teams.microsoft.com")
    if parsed.scheme != "https" or not allowed:
        fail("meeting URL must be an https Google Meet, Zoom, or Microsoft Teams URL")
    return value


def redact(value: object) -> object:
    if isinstance(value, dict):
        return {k: ("[redacted]" if any(part in k.lower() for part in SECRET_NAMES) else redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


def request(method: str, path: str, body: dict | None = None) -> object:
    headers = {"Accept": "application/json"}
    key = os.getenv("MEETSTREAM_BRIDGE_KEY")
    if key:
        headers["X-Integration-Key"] = key
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    req = Request(f"{bridge_url()}{path}", method=method, headers=headers, data=data)
    try:
        with urlopen(req, timeout=45) as response:
            raw = response.read().decode("utf-8")
    except HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            detail = json.loads(raw).get("error", {}).get("message", raw)
        except (ValueError, AttributeError):
            detail = raw or exc.reason
        fail(f"bridge returned HTTP {exc.code}: {detail}", 1)
    except (URLError, TimeoutError) as exc:
        fail(f"bridge is unreachable: {exc.reason if isinstance(exc, URLError) else exc}", 1)
    try:
        return json.loads(raw) if raw else {}
    except ValueError:
        fail("bridge returned a non-JSON response", 1)


def join(url: str) -> object:
    return request("POST", "/v1/meeting-sessions/from-env", {"meeting_url": meeting_url(url)})


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in {"-h", "--help"}:
        print("usage: meetstream.py {health|join URL|sessions|mia-list|inspect SESSION_ID|leave SESSION_ID}")
        return 0 if len(argv) >= 2 else 2
    command = argv[1]
    if command == "health" and len(argv) == 2:
        result = request("GET", "/health")
    elif command == "join" and len(argv) == 3:
        result = join(argv[2])
    elif command in {"list", "sessions"} and len(argv) == 2:
        result = request("GET", "/v1/meeting-sessions")
    elif command == "mia-list" and len(argv) == 2:
        result = request("GET", "/v1/mia-configurations")
    elif command == "inspect" and len(argv) == 3:
        result = request("GET", f"/v1/meeting-sessions/{quote(argv[2], safe='')}")
    elif command == "leave" and len(argv) == 3:
        result = request("POST", f"/v1/meeting-sessions/{quote(argv[2], safe='')}/stop")
    else:
        fail("invalid command or arguments; use --help")
    print(json.dumps(redact(result), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    main(sys.argv)
