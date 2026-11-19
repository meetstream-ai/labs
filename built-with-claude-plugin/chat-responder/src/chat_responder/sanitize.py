"""Cleaning for text that crosses a trust boundary.

Inbound chat comes from anyone in the meeting, so it is scrubbed before we look
for commands. Outbound text is scrubbed too: agenda.md is local but editable,
and the chat panel should never receive control characters.
"""

import re
import unicodedata
from typing import Optional

# Zero-width and bidi-override characters. Harmless to drop, and they are the
# usual way to hide or reorder text in a chat line.
_INVISIBLE = re.compile("[​-‏  ‪-‮⁦-⁩﻿]")
_WHITESPACE_RUN = re.compile(r"[ \t]+")
_BLANK_LINE_RUN = re.compile(r"\n{3,}")

TRUNCATION_MARKER = "... (truncated)"


def _strip_control(text: str, keep_newlines: bool) -> str:
    kept = []
    for char in text:
        if char == "\n" and keep_newlines:
            kept.append(char)
            continue
        if char in ("\t", "\r", "\n", "\v", "\f"):
            kept.append(" ")
            continue
        # Cc = control, Cs = surrogate, Cf = format (already mostly handled above)
        if unicodedata.category(char) in ("Cc", "Cs", "Cf"):
            continue
        kept.append(char)
    return "".join(kept)


def clean_inbound(text: Optional[str], max_chars: int) -> str:
    """Normalise one chat line into something safe to tokenise."""
    if not isinstance(text, str):
        return ""
    text = _INVISIBLE.sub("", text)[: max_chars + 1]
    text = _strip_control(text, keep_newlines=False)
    text = _WHITESPACE_RUN.sub(" ", text).strip()
    return text[:max_chars]


def clean_outbound(text: str, max_chars: int) -> str:
    """Normalise a reply, truncating on a line boundary where possible."""
    text = _INVISIBLE.sub("", text)
    text = _strip_control(text, keep_newlines=True)
    text = _BLANK_LINE_RUN.sub("\n\n", text).strip()
    if len(text) <= max_chars:
        return text

    budget = max(0, max_chars - len(TRUNCATION_MARKER) - 1)
    head = text[:budget]
    newline = head.rfind("\n")
    if newline > budget // 2:
        head = head[:newline]
    return head.rstrip() + "\n" + TRUNCATION_MARKER
