"""Turn live transcript chunks into speaker-labelled terminal captions."""

import sys
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Mapping, Optional, TextIO

UNKNOWN_SPEAKER = "Unknown"

# MeetStream reports audio it cannot attribute to a participant under this name.
_UNATTRIBUTED = {"", "nospeaker", "no speaker", "unknown"}

# One colour per speaker, assigned in the order speakers first talk.
_SPEAKER_COLORS = (36, 32, 35, 33, 34, 31, 96, 92)
_DIM = "\x1b[2m"
_BOLD = "\x1b[1m"
_RESET = "\x1b[0m"
_CLEAR_LINE = "\r\x1b[2K"


@dataclass(frozen=True)
class Caption:
    """One renderable caption, normalised from a live transcript chunk."""

    speaker: str
    text: str
    is_final: bool
    clock: str


def _speaker_of(payload: Mapping[str, Any]) -> str:
    speaker = payload.get("speakerName")
    if not isinstance(speaker, str) or speaker.strip().lower() in _UNATTRIBUTED:
        return UNKNOWN_SPEAKER
    return speaker.strip()


def _clock_of(payload: Mapping[str, Any], now: Optional[datetime] = None) -> str:
    """Local wall-clock HH:MM:SS for the chunk, falling back to arrival time."""
    raw = payload.get("timestamp")
    if isinstance(raw, str) and raw:
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            parsed = None
        if parsed is not None:
            if parsed.tzinfo is not None:
                parsed = parsed.astimezone()
            return parsed.strftime("%H:%M:%S")
    return (now or datetime.now()).strftime("%H:%M:%S")


def parse_chunk(payload: Mapping[str, Any], now: Optional[datetime] = None) -> Optional[Caption]:
    """Normalise a live transcript chunk. Returns None when there is nothing to show."""
    if not isinstance(payload, Mapping):
        return None
    text = payload.get("transcript")
    if not isinstance(text, str):
        return None
    text = text.strip()
    if not text:
        return None
    return Caption(
        speaker=_speaker_of(payload),
        text=text,
        is_final=bool(payload.get("is_final")),
        clock=_clock_of(payload, now),
    )


class CaptionPrinter:
    """Writes captions to a terminal.

    Final captions are printed one per line and stay. Interim captions are
    written in place on the line below and overwritten as the speaker talks,
    so the scrollback only ever holds settled text.
    """

    def __init__(
        self,
        stream: Optional[TextIO] = None,
        color: Optional[bool] = None,
        show_interim: Optional[bool] = None,
    ) -> None:
        self._stream = stream if stream is not None else sys.stdout
        is_tty = bool(getattr(self._stream, "isatty", lambda: False)())
        self._color = is_tty if color is None else bool(color)
        # Overwriting in place only works on a terminal; elsewhere it would
        # flood the log with half-finished sentences.
        self._show_interim = is_tty if show_interim is None else bool(show_interim)
        self._interim_shown = False
        self._speaker_colors: dict = {}
        self._last_final: Optional[tuple] = None

    def handle_chunk(self, payload: Mapping[str, Any]) -> Optional[str]:
        """Render one live transcript chunk. Returns the final line, if one was printed."""
        caption = parse_chunk(payload)
        if caption is None:
            return None
        if not caption.is_final:
            self._write_interim(caption)
            return None
        # The same final chunk occasionally arrives twice; show it once.
        key = (caption.speaker, caption.text)
        if key == self._last_final:
            self._clear_interim()
            return None
        self._last_final = key
        line = "[%s] %s: %s" % (caption.clock, caption.speaker, caption.text)
        self._print(
            "%s %s %s"
            % (
                self._paint("[%s]" % caption.clock, _DIM),
                self._paint(caption.speaker + ":", self._color_for(caption.speaker), bold=True),
                caption.text,
            )
        )
        return line

    def status(self, text: str) -> None:
        """Print a lifecycle line (bot joined, recording, left...)."""
        self._print(self._paint("• " + text, _DIM))

    def close(self) -> None:
        self._clear_interim()
        self._stream.flush()

    # -- internals -------------------------------------------------------

    def _color_for(self, speaker: str) -> str:
        if speaker not in self._speaker_colors:
            code = _SPEAKER_COLORS[len(self._speaker_colors) % len(_SPEAKER_COLORS)]
            self._speaker_colors[speaker] = "\x1b[%dm" % code
        return self._speaker_colors[speaker]

    def _paint(self, text: str, color: str, bold: bool = False) -> str:
        if not self._color:
            return text
        return "%s%s%s%s" % (_BOLD if bold else "", color, text, _RESET)

    def _write_interim(self, caption: Caption) -> None:
        if not self._show_interim:
            return
        self._stream.write(
            "%s%s"
            % (
                _CLEAR_LINE,
                self._paint("  %s: %s" % (caption.speaker, caption.text), _DIM),
            )
        )
        self._stream.flush()
        self._interim_shown = True

    def _clear_interim(self) -> None:
        if self._interim_shown:
            self._stream.write(_CLEAR_LINE)
            self._interim_shown = False

    def _print(self, line: str) -> None:
        self._clear_interim()
        self._stream.write(line + "\n")
        self._stream.flush()
