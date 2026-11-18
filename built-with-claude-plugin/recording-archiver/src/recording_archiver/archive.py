"""Decide what is ready, download it, and record what landed on disk."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from .client import MediaResponse, MeetStreamClient, MeetStreamError
from .config import Settings
from .extract import ParticipantStream, extract_media_url, extract_participant_streams

log = logging.getLogger(__name__)

MANIFEST_NAME = "manifest.json"
MANIFEST_VERSION = 1

# `Done` is the only status that means post-call processing finished. `Stopped`
# means the bot left but audio/video are still being produced, so we wait.
DONE_STATUS = "done"

# Endings where the bot never recorded anything. Nothing will ever arrive, so
# these are settled once rather than re-checked on every sweep.
DEAD_STATUSES = {"notallowed", "denied", "failed", "error"}

AUDIO_READY_STATUSES = {"success"}

KNOWN_EXTENSIONS = {
    ".mp3",
    ".wav",
    ".m4a",
    ".aac",
    ".flac",
    ".ogg",
    ".opus",
    ".webm",
    ".mp4",
    ".mkv",
    ".mov",
}

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def slugify(value: str, fallback: str = "participant") -> str:
    """Make a filesystem-safe name fragment out of a participant label.

    Participant names come from the meeting, so they are untrusted input: this
    strips path separators, dots and anything else that could escape the bot's
    archive directory.
    """
    slug = _SLUG_RE.sub("-", value.strip().lower()).strip("-")
    return slug[:64] or fallback


def extension_for(url: str, default: str) -> str:
    """Pick a file extension from the pre-signed URL's object key."""
    path = unquote(urlparse(url).path)
    suffix = Path(path).suffix.lower()
    return suffix if suffix in KNOWN_EXTENSIONS else default


def _lower(value: Any) -> str:
    return value.strip().lower() if isinstance(value, str) else ""


@dataclass
class BotArchiveResult:
    bot_id: str
    archived: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    complete: bool = False

    @property
    def changed(self) -> bool:
        return bool(self.archived)


@dataclass
class SweepResult:
    bots_seen: int = 0
    bots_archived: int = 0
    files_archived: int = 0
    errors: list[str] = field(default_factory=list)


class Archiver:
    def __init__(self, settings: Settings, client: MeetStreamClient) -> None:
        self._settings = settings
        self._client = client

    # -- manifest -----------------------------------------------------------

    def bot_dir(self, bot_id: str) -> Path:
        return self._settings.archive_dir / slugify(bot_id, fallback="bot")

    def read_manifest(self, bot_id: str) -> dict[str, Any]:
        path = self.bot_dir(bot_id) / MANIFEST_NAME
        if not path.exists():
            return {}
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            log.warning("Ignoring unreadable manifest for bot %s", bot_id)
            return {}
        return data if isinstance(data, dict) else {}

    def write_manifest(self, bot_id: str, manifest: dict[str, Any]) -> None:
        directory = self.bot_dir(bot_id)
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / MANIFEST_NAME
        partial = path.with_name(path.name + ".part")
        partial.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        partial.replace(path)

    # -- sweep --------------------------------------------------------------

    def sweep(self, bot_ids: list[str] | None = None, dry_run: bool = False) -> SweepResult:
        result = SweepResult()
        if bot_ids is None:
            ids = self._discover_bot_ids()
        else:
            ids = bot_ids

        for bot_id in ids:
            result.bots_seen += 1
            manifest = self.read_manifest(bot_id)
            if manifest.get("complete"):
                log.debug("Bot %s is already fully archived; skipping", bot_id)
                continue
            try:
                outcome = self.archive_bot(bot_id, manifest=manifest, dry_run=dry_run)
            except MeetStreamError as exc:
                log.error("Bot %s: %s", bot_id, exc)
                result.errors.append(f"{bot_id}: {exc}")
                continue
            if outcome.changed:
                result.bots_archived += 1
                result.files_archived += len(outcome.archived)
            result.errors.extend(f"{bot_id}: {err}" for err in outcome.errors)
        return result

    def _discover_bot_ids(self) -> list[str]:
        ids: list[str] = []
        seen: set[str] = set()
        for bot in self._client.iter_bots():
            bot_id = _bot_id_of(bot)
            if bot_id and bot_id not in seen:
                seen.add(bot_id)
                ids.append(bot_id)
        return ids

    # -- one bot ------------------------------------------------------------

    def archive_bot(
        self,
        bot_id: str,
        manifest: dict[str, Any] | None = None,
        dry_run: bool = False,
    ) -> BotArchiveResult:
        result = BotArchiveResult(bot_id=bot_id)
        manifest = dict(manifest if manifest is not None else self.read_manifest(bot_id))

        detail = self._client.get_bot_detail(bot_id)
        status = _lower(detail.get("Status") or detail.get("status"))
        audio_status = _lower(detail.get("AudioStatus") or detail.get("audio_status"))

        if status in DEAD_STATUSES:
            result.skipped.append(f"bot never recorded (status {status})")
            result.complete = True
            if not dry_run:
                self.write_manifest(
                    bot_id,
                    {
                        "schema_version": MANIFEST_VERSION,
                        "bot_id": bot_id,
                        "first_archived_at": manifest.get("first_archived_at") or utcnow(),
                        "last_updated_at": utcnow(),
                        "bot": _bot_summary(detail),
                        "artifacts": manifest.get("artifacts") or {},
                        "complete": True,
                        "note": f"Bot ended as {status}; there is no recording to archive.",
                    },
                )
            return result

        if status != DONE_STATUS:
            result.skipped.append(
                f"bot has not finished processing (status {status or 'unknown'})"
            )
            return result

        artifacts: dict[str, Any] = dict(manifest.get("artifacts") or {})
        audio_done = _artifact_present(self.bot_dir(bot_id), artifacts.get("audio"))

        if audio_done:
            result.skipped.append("audio already archived")
        elif artifacts.get("audio") == "unavailable":
            result.skipped.append("audio already resolved as unavailable")
            audio_done = True
        elif audio_status not in AUDIO_READY_STATUSES:
            result.skipped.append(f"audio not ready (AudioStatus {audio_status or 'unknown'})")
        else:
            response = self._client.get_audio(bot_id)
            if not response.ready and _is_permanent(response):
                # Retention expired or the data was deleted - it is never coming back.
                result.skipped.append(f"audio {response.reason}")
                artifacts["audio"] = "unavailable"
                audio_done = True
            else:
                entry = self._archive_single(bot_id, response, "audio", ".mp3", dry_run, result)
                if entry:
                    artifacts["audio"] = entry
                    audio_done = True

        video_done = _artifact_present(self.bot_dir(bot_id), artifacts.get("video"))
        video_unavailable = artifacts.get("video") == "unavailable"
        if not self._settings.include_video:
            result.skipped.append("video disabled by config")
            video_done = True
        elif video_done or video_unavailable:
            result.skipped.append("video already resolved")
            video_done = True
        else:
            response = self._client.get_video(bot_id)
            if not response.ready:
                result.skipped.append(f"video {response.reason}")
                if _is_permanent(response):
                    artifacts["video"] = "unavailable"
                    video_done = True
            else:
                entry = self._archive_single(bot_id, response, "video", ".mp4", dry_run, result)
                if entry:
                    artifacts["video"] = entry
                    video_done = True

        participants_done = self._archive_participant_audio(
            bot_id, artifacts, dry_run, result
        )

        manifest.update(
            {
                "schema_version": MANIFEST_VERSION,
                "bot_id": bot_id,
                "first_archived_at": manifest.get("first_archived_at") or utcnow(),
                "last_updated_at": utcnow(),
                "bot": _bot_summary(detail),
                "artifacts": artifacts,
            }
        )
        result.complete = bool(audio_done and video_done and participants_done and not result.errors)
        manifest["complete"] = result.complete

        if dry_run:
            log.info("[dry-run] bot %s: would archive %s", bot_id, result.archived or "nothing")
            return result
        if result.archived or manifest.get("complete") or not self.read_manifest(bot_id):
            self.write_manifest(bot_id, manifest)
        return result

    def _archive_single(
        self,
        bot_id: str,
        response: MediaResponse,
        kind: str,
        default_ext: str,
        dry_run: bool,
        result: BotArchiveResult,
    ) -> dict[str, Any] | None:
        if not response.ready:
            result.skipped.append(f"{kind} {response.reason}")
            return None
        url = extract_media_url(response.payload)
        if not url:
            result.errors.append(f"{kind}: no download URL in the API response")
            return None

        relative = f"{kind}{extension_for(url, default_ext)}"
        destination = self.bot_dir(bot_id) / relative
        if dry_run:
            result.archived.append(relative)
            return None
        try:
            written = self._client.download(url, destination)
        except MeetStreamError as exc:
            result.errors.append(str(exc))
            return None
        result.archived.append(relative)
        log.info("Bot %s: saved %s (%s bytes)", bot_id, relative, written)
        return {"path": relative, "bytes": written, "archived_at": utcnow()}

    def _archive_participant_audio(
        self,
        bot_id: str,
        artifacts: dict[str, Any],
        dry_run: bool,
        result: BotArchiveResult,
    ) -> bool:
        if not self._settings.include_participant_audio:
            result.skipped.append("per-participant audio disabled by config")
            return True
        existing = artifacts.get("participant_audio")
        if existing == "unavailable":
            result.skipped.append("per-participant audio already resolved as unavailable")
            return True
        if isinstance(existing, list) and existing and all(
            _artifact_present(self.bot_dir(bot_id), entry) for entry in existing
        ):
            result.skipped.append("per-participant audio already archived")
            return True

        response = self._client.get_audio_streams(bot_id)
        if not response.ready:
            result.skipped.append(f"per-participant audio {response.reason}")
            if _is_permanent(response):
                artifacts["participant_audio"] = "unavailable"
                return True
            return False

        streams = extract_participant_streams(response.payload)
        if not streams:
            # The endpoint answered but the bot was not created with
            # `audio_separate_streams: true`, so there is nothing per-speaker.
            result.skipped.append("no per-participant audio for this bot")
            artifacts["participant_audio"] = "unavailable"
            return True

        entries = list(existing) if isinstance(existing, list) else []
        done_paths = {entry.get("path") for entry in entries if isinstance(entry, dict)}
        ok = True
        for stream in streams:
            for index, url in enumerate(stream.segments, start=1):
                relative = _participant_relpath(stream, index, url, len(stream.segments))
                destination = self.bot_dir(bot_id) / relative
                if relative in done_paths and destination.exists():
                    continue
                if dry_run:
                    result.archived.append(relative)
                    continue
                try:
                    written = self._client.download(url, destination)
                except MeetStreamError as exc:
                    result.errors.append(str(exc))
                    ok = False
                    continue
                entries.append(
                    {
                        "path": relative,
                        "participant": stream.participant,
                        "bytes": written,
                        "archived_at": utcnow(),
                    }
                )
                done_paths.add(relative)
                result.archived.append(relative)
                log.info("Bot %s: saved %s (%s bytes)", bot_id, relative, written)

        if entries:
            artifacts["participant_audio"] = entries
        return ok


def _participant_relpath(
    stream: ParticipantStream, index: int, url: str, total: int
) -> str:
    slug = slugify(stream.participant)
    suffix = extension_for(url, ".webm")
    name = slug if total == 1 else f"{slug}-{index:03d}"
    return f"participants/{name}{suffix}"


def _artifact_present(bot_dir: Path, entry: Any) -> bool:
    if not isinstance(entry, dict):
        return False
    path = entry.get("path")
    if not isinstance(path, str):
        return False
    return (bot_dir / path).exists()


def _is_permanent(response: MediaResponse) -> bool:
    """A 404 means this bot has no such media; a 202 means come back later."""
    return "404" in response.reason


def _bot_id_of(bot: dict[str, Any]) -> str | None:
    for key in ("bot_id", "botId", "BotID", "id"):
        value = bot.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _bot_summary(detail: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "BotID",
        "BotUsername",
        "MeetingLink",
        "Platform",
        "Status",
        "AudioStatus",
        "TranscriptStatus",
        "StartTime",
        "EndTime",
        "Duration",
        "CreatedAt",
    )
    return {key: detail[key] for key in keys if key in detail}
