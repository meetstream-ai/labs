"""Reading the local agenda file.

The path comes from config only - never from chat - so a participant cannot
steer this at another file. The byte cap stops a large file from turning into a
large chat message.
"""

from pathlib import Path

from .sanitize import clean_outbound

OVERSIZE_NOTE = "... (agenda truncated)"


class AgendaError(Exception):
    """The agenda file is missing or unreadable."""


def load_agenda(path: Path, max_bytes: int, max_chars: int) -> str:
    """Return the agenda text, truncated and scrubbed for the chat panel."""
    resolved = path.expanduser()
    try:
        if not resolved.is_file():
            raise AgendaError("No agenda file at {}".format(resolved))
        with resolved.open("rb") as handle:
            raw = handle.read(max_bytes + 1)
    except OSError as exc:
        raise AgendaError("Could not read {}: {}".format(resolved, exc))

    oversized = len(raw) > max_bytes
    text = raw[:max_bytes].decode("utf-8", errors="replace")
    if oversized:
        # Drop the trailing partial line before flagging the cut.
        text = text[: text.rfind("\n") + 1] if "\n" in text else text
        text = text.rstrip() + "\n" + OVERSIZE_NOTE

    text = clean_outbound(text, max_chars)
    if not text.strip():
        raise AgendaError("Agenda file {} is empty".format(resolved))
    return text
