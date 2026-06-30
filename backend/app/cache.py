"""A tiny in-memory TTL cache.

Ports the `Map<string, CacheEntry>` pattern used in both `asana.server.ts` and
`sheets.server.ts` to avoid hammering upstream rate limits (Asana caps at
150 req/min). Process-local and not thread-safe in the strict sense, but fine
under FastAPI's async single-threaded event loop.
"""

from __future__ import annotations

import time
from typing import Generic, TypeVar

T = TypeVar("T")


class TTLCache(Generic[T]):
    def __init__(self, ttl_seconds: float) -> None:
        self._ttl = ttl_seconds
        self._store: dict[str, tuple[T, float]] = {}

    def get(self, key: str) -> T | None:
        entry = self._store.get(key)
        if entry is None:
            return None
        value, expires = entry
        if time.monotonic() > expires:
            self._store.pop(key, None)
            return None
        return value

    def set(self, key: str, value: T) -> None:
        self._store[key] = (value, time.monotonic() + self._ttl)

    def delete(self, key: str) -> None:
        self._store.pop(key, None)


CACHE_TTL_SECONDS = 5 * 60  # 5 minutes, matching the TS `CACHE_TTL_MS`.
