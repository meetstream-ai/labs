#!/usr/bin/env python3
"""Read-only configuration preflight for the MeetStream Hermes skill."""

import os
import sys
from urllib.parse import urlparse

from meetstream import DEFAULT_HERMES, bridge_url, request


def main() -> int:
    try:
        bridge_url()
        hermes = os.getenv("HERMES_GATEWAY_URL", DEFAULT_HERMES)
        parsed = urlparse(hermes)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("HERMES_GATEWAY_URL must be an http(s) URL")
        request("GET", "/health")
    except (SystemExit, ValueError) as exc:
        if isinstance(exc, SystemExit):
            raise
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print("ok: bridge URL is valid and /health is reachable")
    print("info: Hermes gateway URL is configured")
    if not os.getenv("MEETSTREAM_API_KEY") or not os.getenv("HERMES_API_KEY"):
        print("warning: join credentials are not both configured")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
