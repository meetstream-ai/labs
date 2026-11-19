"""Offline replay of a live transcript stream, for trying the display out.

Same chunk shape MeetStream POSTs to the live transcription webhook, so this
exercises the real rendering path without an API key or a meeting.
"""

import time
from typing import Any, Dict, List

from .captions import CaptionPrinter

SAMPLE_CHUNKS: List[Dict[str, Any]] = [
    {"speakerName": "Priya", "transcript": "Okay, so where", "is_final": False},
    {"speakerName": "Priya", "transcript": "Okay, so where are we on", "is_final": False},
    {
        "speakerName": "Priya",
        "transcript": "Okay, so where are we on the live captions app?",
        "is_final": True,
        "end_of_turn": True,
    },
    {"speakerName": "Sam", "transcript": "The bot joins and", "is_final": False},
    {
        "speakerName": "Sam",
        "transcript": "The bot joins and streams chunks straight to a local server.",
        "is_final": True,
        "end_of_turn": True,
    },
    {"speakerName": "NoSpeaker", "transcript": "(background noise)", "is_final": True},
    {
        "speakerName": "Priya",
        "transcript": "Nice — and that is MeetStream's own transcription, no third party.",
        "is_final": True,
        "end_of_turn": True,
    },
]


def run_demo(printer: CaptionPrinter, delay: float = 0.6) -> None:
    printer.status("demo: replaying a sample meeting (no API calls)")
    for chunk in SAMPLE_CHUNKS:
        printer.handle_chunk(chunk)
        if delay:
            time.sleep(delay)
    printer.status("demo: end of sample")
    printer.close()
