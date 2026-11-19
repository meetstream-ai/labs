"""Minimal MeetStream API access: fetch one bot's speaker timeline.

Only used when the CLI is given ``--bot-id``. The response is returned as an
open stream so the timeline parser can consume it without buffering the whole
body - the same path a four-hour meeting takes from disk.

A long meeting answers 200 with links to the timeline rather than the chunks
themselves, so there is a second opener for those links.
"""

from __future__ import annotations

import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, Optional

from .config import Config

BOT_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
# Timeline links are pre-signed download URLs. Plain http would put the
# signature, and the recording behind it, on the wire in clear.
LINK_SCHEMES = ("https",)


class ApiError(RuntimeError):
    """The API could not give us a timeline."""


class MissingApiKey(ApiError):
    pass


def speaker_timeline_url(base_url: str, bot_id: str) -> str:
    if not BOT_ID_PATTERN.match(bot_id or ""):
        raise ApiError(
            "bot id {!r} is not valid - expected up to 128 letters, digits, '-' or '_'".format(bot_id)
        )
    return "{}/bots/{}/get_speaker_timeline".format(base_url.rstrip("/"), bot_id)


def redact_url(url: str) -> str:
    """The link without its query string - a pre-signed URL signs itself there."""
    parsed = urllib.parse.urlsplit(url)
    if not parsed.scheme:
        return url
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))


def _fetch(request, opener: Optional[Callable], timeout: float, what: str, host: str):
    """Send ``request`` and return the open response, or raise :class:`ApiError`."""
    opener = opener or urllib.request.urlopen
    try:
        response = opener(request, timeout=timeout)
    except urllib.error.HTTPError as exc:
        raise ApiError(
            "MeetStream returned HTTP {} for {}: {}".format(exc.code, what, exc.reason)
        )
    except urllib.error.URLError as exc:
        raise ApiError("could not reach {}: {}".format(host, exc.reason))

    status = getattr(response, "status", None) or getattr(response, "code", 200)
    if status == 202:
        response.close()
        raise ApiError(
            "the speaker timeline for {} is not ready yet (HTTP 202) - "
            "wait for the bot.done webhook and try again".format(what)
        )
    if status != 200:
        response.close()
        raise ApiError("MeetStream returned HTTP {} for {}".format(status, what))
    return response


def open_speaker_timeline(
    bot_id: str,
    config: Config,
    opener: Optional[Callable] = None,
    timeout: float = 60.0,
):
    """Open ``GET /bots/{bot_id}/get_speaker_timeline`` and return the stream."""
    if not config.api_key:
        raise MissingApiKey(
            "MEETSTREAM_API_KEY is not set - put it in .env (see .env.example), "
            "or pass a saved timeline JSON file instead of --bot-id"
        )
    request = urllib.request.Request(
        speaker_timeline_url(config.base_url, bot_id),
        headers={
            "Authorization": "Token {}".format(config.api_key),
            "Accept": "application/json",
        },
        method="GET",
    )
    return _fetch(request, opener, timeout, "bot {}".format(bot_id), config.base_url)


def open_timeline_link(
    url: str,
    opener: Optional[Callable] = None,
    timeout: float = 60.0,
):
    """Open a timeline link the API returned instead of the chunks themselves.

    The API key is deliberately not sent: these links are pre-signed and point
    at storage, not at the API.
    """
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in LINK_SCHEMES or not parsed.netloc:
        raise ApiError(
            "refusing to follow the timeline link {} - only {} links are followed".format(
                redact_url(url), "/".join(LINK_SCHEMES)
            )
        )
    request = urllib.request.Request(
        url, headers={"Accept": "application/json"}, method="GET"
    )
    return _fetch(request, opener, timeout, "timeline link {}".format(redact_url(url)), parsed.netloc)
