"""Configuration, read from a .env file and the process environment."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping, Optional

from dotenv import dotenv_values

DEFAULTS = {
    "MEETSTREAM_BASE_URL": "https://api.meetstream.ai/api/v1",
    "TALK_TIME_SAMPLE_RATE": "48000",
    "TALK_TIME_SAMPLE_WIDTH": "2",
    "TALK_TIME_CHANNELS": "1",
    "TALK_TIME_TURN_GAP_SECONDS": "1.0",
    "TALK_TIME_UNATTRIBUTED_LABELS": "NoSpeaker,Unknown",
    "TALK_TIME_OUTPUT": "talk-time.json",
}


class ConfigError(ValueError):
    """Raised when a setting is present but unusable."""


@dataclass(frozen=True)
class Config:
    api_key: Optional[str] = None
    base_url: str = DEFAULTS["MEETSTREAM_BASE_URL"]
    sample_rate: int = 48000
    sample_width: int = 2
    channels: int = 1
    turn_gap_seconds: float = 1.0
    unattributed_labels: frozenset = field(default_factory=lambda: frozenset({"NoSpeaker", "Unknown"}))
    output_path: str = DEFAULTS["TALK_TIME_OUTPUT"]

    @property
    def bytes_per_second(self) -> int:
        """How many audio bytes one second of recording occupies."""
        return self.sample_rate * self.sample_width * self.channels


def _positive_int(values: Mapping[str, str], key: str) -> int:
    raw = values.get(key) or DEFAULTS[key]
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        raise ConfigError("{} must be a whole number, got {!r}".format(key, raw))
    if parsed <= 0:
        raise ConfigError("{} must be greater than 0, got {!r}".format(key, raw))
    return parsed


def _non_negative_float(values: Mapping[str, str], key: str) -> float:
    raw = values.get(key) or DEFAULTS[key]
    try:
        parsed = float(raw)
    except (TypeError, ValueError):
        raise ConfigError("{} must be a number, got {!r}".format(key, raw))
    if parsed < 0:
        raise ConfigError("{} must not be negative, got {!r}".format(key, raw))
    return parsed


def load_config(env_file: Optional[Path] = None, environ: Optional[Mapping[str, str]] = None) -> Config:
    """Build a Config from ``env_file`` overlaid with the process environment.

    The real environment wins over the file, so a shell export can override .env
    without editing it.
    """
    environ = os.environ if environ is None else environ
    values = {}
    path = Path(env_file) if env_file is not None else Path(".env")
    if path.is_file():
        values.update({k: v for k, v in dotenv_values(path).items() if v is not None})
    values.update({k: v for k, v in environ.items() if k in DEFAULTS or k.startswith(("MEETSTREAM_", "TALK_TIME_"))})

    labels = values.get("TALK_TIME_UNATTRIBUTED_LABELS", DEFAULTS["TALK_TIME_UNATTRIBUTED_LABELS"])
    api_key = (values.get("MEETSTREAM_API_KEY") or "").strip()

    return Config(
        api_key=api_key or None,
        base_url=(values.get("MEETSTREAM_BASE_URL") or DEFAULTS["MEETSTREAM_BASE_URL"]).rstrip("/"),
        sample_rate=_positive_int(values, "TALK_TIME_SAMPLE_RATE"),
        sample_width=_positive_int(values, "TALK_TIME_SAMPLE_WIDTH"),
        channels=_positive_int(values, "TALK_TIME_CHANNELS"),
        turn_gap_seconds=_non_negative_float(values, "TALK_TIME_TURN_GAP_SECONDS"),
        unattributed_labels=frozenset(lbl.strip() for lbl in labels.split(",") if lbl.strip()),
        output_path=values.get("TALK_TIME_OUTPUT") or DEFAULTS["TALK_TIME_OUTPUT"],
    )
