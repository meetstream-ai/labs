"""Dispatch bots to a list of meetings with bounded concurrency."""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

from .client import MeetStreamClient, MeetStreamError
from .config import Config
from .links import MeetingLink, RejectedLink

logger = logging.getLogger(__name__)

DISPATCHED = "dispatched"
FAILED = "failed"
SKIPPED = "skipped"


@dataclass(frozen=True)
class Result:
    """What happened to one line of the input file."""

    url: str
    platform: Optional[str]
    status: str
    line_number: int
    bot_id: Optional[str] = None
    bot_name: Optional[str] = None
    reason: Optional[str] = None
    kind: Optional[str] = None
    attempts: int = 0

    def as_dict(self) -> Dict[str, Any]:
        return {
            "url": self.url,
            "platform": self.platform,
            "status": self.status,
            "line_number": self.line_number,
            "bot_id": self.bot_id,
            "bot_name": self.bot_name,
            "reason": self.reason,
            "kind": self.kind,
            "attempts": self.attempts,
        }


@dataclass
class Report:
    """Every result, in input order."""

    results: List[Result] = field(default_factory=list)
    dry_run: bool = False

    def of_status(self, status: str) -> List[Result]:
        return [r for r in self.results if r.status == status]

    @property
    def counts(self) -> Dict[str, int]:
        return {
            DISPATCHED: len(self.of_status(DISPATCHED)),
            FAILED: len(self.of_status(FAILED)),
            SKIPPED: len(self.of_status(SKIPPED)),
        }

    @property
    def exit_code(self) -> int:
        """0 only when every line produced a bot."""
        counts = self.counts
        return 1 if counts[FAILED] or counts[SKIPPED] else 0

    def as_dict(self) -> Dict[str, Any]:
        return {
            "dry_run": self.dry_run,
            "counts": self.counts,
            "results": [r.as_dict() for r in self.results],
        }


def _skipped(rejected: RejectedLink) -> Result:
    return Result(
        url=rejected.url,
        platform=None,
        status=SKIPPED,
        line_number=rejected.line_number,
        reason=rejected.reason,
        kind="invalid_link",
    )


def dispatch(
    links: Sequence[MeetingLink],
    rejected: Sequence[RejectedLink],
    config: Config,
    client: Optional[MeetStreamClient] = None,
    dry_run: bool = False,
) -> Report:
    """Send one bot per link, and fold the pre-flight rejections into the report."""
    results: List[Result] = [_skipped(r) for r in rejected]

    if dry_run:
        results.extend(
            Result(
                url=link.url,
                platform=link.platform,
                status=DISPATCHED,
                line_number=link.line_number,
                bot_id=None,
                bot_name=link.bot_name or config.bot_name,
                reason="dry run - no API call made",
            )
            for link in links
        )
    elif links:
        if client is None:
            raise ValueError("a client is required unless dry_run is set")
        workers = min(config.concurrency, len(links))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            results.extend(pool.map(lambda link: _dispatch_one(link, config, client), links))

    results.sort(key=lambda r: r.line_number)
    return Report(results=results, dry_run=dry_run)


def _dispatch_one(link: MeetingLink, config: Config, client: MeetStreamClient) -> Result:
    bot_name = link.bot_name or config.bot_name
    payload = config.bot_payload(link.url, bot_name)
    try:
        created = client.create_bot(payload)
    except MeetStreamError as exc:
        logger.error(
            "bot dispatch failed for %s (line %d, %s): %s",
            link.url,
            link.line_number,
            exc.kind,
            exc.reason,
        )
        return Result(
            url=link.url,
            platform=link.platform,
            status=FAILED,
            line_number=link.line_number,
            bot_name=bot_name,
            reason=exc.reason,
            kind=exc.kind,
            attempts=exc.attempts,
        )
    logger.info("bot %s dispatched to %s", created.bot_id, link.url)
    return Result(
        url=link.url,
        platform=link.platform,
        status=DISPATCHED,
        line_number=link.line_number,
        bot_id=created.bot_id,
        bot_name=bot_name,
        attempts=created.attempts,
    )
