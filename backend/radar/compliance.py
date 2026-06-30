"""Compliance guard (§3.3, §13).

LinkedIn / Crunchbase / PitchBook must never be fetched — corporate licensing
risk. This is enforced at the HTTP-client layer: every outbound request passes
through `assert_allowed`, and a blocked attempt raises `ComplianceBlock` (fails
loudly) rather than silently skipping. The CI test in tests/ asserts this holds.
"""

from __future__ import annotations

from urllib.parse import urlparse

from .config import BLOCKED_DOMAINS


class ComplianceBlock(Exception):
    """Raised when code attempts to fetch a blocklisted domain."""


def host_of(url: str) -> str:
    return (urlparse(url).hostname or "").lower()


def is_blocked(url: str) -> bool:
    host = host_of(url)
    if not host:
        return False
    return any(host == d or host.endswith("." + d) for d in BLOCKED_DOMAINS)


def assert_allowed(url: str) -> None:
    """Raise ComplianceBlock if the URL targets a blocklisted domain."""
    if is_blocked(url):
        raise ComplianceBlock(
            f"Blocked by compliance policy: {host_of(url)} "
            f"(blocklist: {', '.join(BLOCKED_DOMAINS)})"
        )
