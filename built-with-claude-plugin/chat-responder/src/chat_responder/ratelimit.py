"""Reply throttling.

Anyone in the meeting can type, so one person cannot be allowed to turn the
chat into a flood of bot replies (or into a stream of API calls we pay for).
"""

from collections import deque
from typing import Deque, Dict

WINDOW_SECONDS = 60.0
_MAX_TRACKED_SENDERS = 512


class RateLimiter:
    def __init__(self, sender_cooldown_seconds: float, max_per_minute: int) -> None:
        self._cooldown = sender_cooldown_seconds
        self._max_per_minute = max_per_minute
        self._last_by_sender: Dict[str, float] = {}
        self._recent: Deque[float] = deque()

    def allow(self, sender: str, now: float) -> bool:
        """True if a reply to `sender` is allowed now; records it if so."""
        while self._recent and now - self._recent[0] >= WINDOW_SECONDS:
            self._recent.popleft()
        if len(self._recent) >= self._max_per_minute:
            return False

        last = self._last_by_sender.get(sender)
        if last is not None and now - last < self._cooldown:
            return False

        self._prune(now)
        self._last_by_sender[sender] = now
        self._recent.append(now)
        return True

    def _prune(self, now: float) -> None:
        if len(self._last_by_sender) < _MAX_TRACKED_SENDERS:
            return
        self._last_by_sender = {
            sender: seen
            for sender, seen in self._last_by_sender.items()
            if now - seen < self._cooldown
        }
