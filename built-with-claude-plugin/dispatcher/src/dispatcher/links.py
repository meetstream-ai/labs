"""Parsing and validation of the meeting-link input file.

Every link is classified before a single API call goes out: a typo'd link that we
can reject locally costs nothing, a rejected create_bot costs a round trip.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, List, Optional, Tuple

# platform -> pattern that a valid meeting link for that platform must match.
PLATFORM_PATTERNS = {
    "google_meet": re.compile(
        r"^https://meet\.google\.com/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:\?.*)?$",
        re.IGNORECASE,
    ),
    "zoom": re.compile(
        r"^https://(?:[\w.-]+\.)?(?:zoom\.us|zoomgov\.com)/(?:j|w|s)/\d{9,12}(?:\?.*)?$",
        re.IGNORECASE,
    ),
    # Work/school meeting links (both forms) and teams.live.com links; the API
    # accepts all three.
    "teams": re.compile(
        r"^https://teams\.(?:microsoft|live)\.com/(?:l/meetup-join|meet)/[^\s]+$",
        re.IGNORECASE,
    ),
}

# Shapes that look like a meeting link for a platform we do support, but are not
# something a bot can join. Reported with a specific reason instead of "unknown".
UNSUPPORTED_PATTERNS = {
    re.compile(r"^https://meet\.google\.com/lookup/", re.IGNORECASE): (
        "Google Meet lookup links are not joinable; use the meet.google.com/xxx-yyyy-zzz form"
    ),
    re.compile(r"^https://(?:[\w.-]+\.)?zoom\.us/my/", re.IGNORECASE): (
        "Zoom personal-room links need the /j/<meeting id> form"
    ),
}

COMMENT_PREFIX = "#"


@dataclass(frozen=True)
class MeetingLink:
    """One accepted line of the input file."""

    url: str
    platform: str
    bot_name: Optional[str]
    line_number: int


@dataclass(frozen=True)
class RejectedLink:
    """One line we refuse to dispatch, and why."""

    url: str
    reason: str
    line_number: int


def classify(url: str) -> Tuple[Optional[str], Optional[str]]:
    """Return ``(platform, None)`` for a joinable link, else ``(None, reason)``."""
    if not url.lower().startswith(("http://", "https://")):
        return None, "not an http(s) URL"
    if url.lower().startswith("http://"):
        return None, "http:// link; meeting links must be https"
    for platform, pattern in PLATFORM_PATTERNS.items():
        if pattern.match(url):
            return platform, None
    for pattern, reason in UNSUPPORTED_PATTERNS.items():
        if pattern.match(url):
            return None, reason
    return None, "not a recognised Zoom, Google Meet or Teams meeting link"


def _split_line(line: str) -> Tuple[str, Optional[str]]:
    """Split ``url[,bot name]`` into its parts."""
    url, sep, name = line.partition(",")
    bot_name = name.strip() if sep else None
    return url.strip(), (bot_name or None)


def parse_links(
    lines: Iterable[str], allow_duplicates: bool = False
) -> Tuple[List[MeetingLink], List[RejectedLink]]:
    """Parse input lines into accepted links and rejections.

    Each line is ``<meeting url>`` with an optional ``,<bot name>`` override.
    Blank lines and ``#`` comments are ignored.
    """
    accepted: List[MeetingLink] = []
    rejected: List[RejectedLink] = []
    seen = {}

    for line_number, raw in enumerate(lines, start=1):
        line = raw.strip()
        if not line or line.startswith(COMMENT_PREFIX):
            continue

        url, bot_name = _split_line(line)
        platform, reason = classify(url)
        if platform is None:
            rejected.append(RejectedLink(url=url, reason=reason, line_number=line_number))
            continue

        if not allow_duplicates and url in seen:
            rejected.append(
                RejectedLink(
                    url=url,
                    reason="duplicate of line {0}; skipped so two bots do not join one meeting".format(
                        seen[url]
                    ),
                    line_number=line_number,
                )
            )
            continue

        seen[url] = line_number
        accepted.append(
            MeetingLink(
                url=url,
                platform=platform,
                bot_name=bot_name,
                line_number=line_number,
            )
        )

    return accepted, rejected
