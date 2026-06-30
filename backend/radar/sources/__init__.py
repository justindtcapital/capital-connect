"""Structured signal sources (Stage 1 INGEST).

Every source implements the common `SignalSource` interface so new sources are
purely additive (§3.4). `ALL_SOURCES` is the registry the orchestrator iterates.
"""

from __future__ import annotations

from .ats import AtsSource
from .base import SignalSource
from .edgar import EdgarSource
from .github import GithubSource
from .gnews import GoogleNewsSource

# Order = cheapest/broadest first. Google News covers every company with no
# enrichment; the others activate as enrichment columns get populated.
ALL_SOURCES: list[SignalSource] = [
    GoogleNewsSource(),
    EdgarSource(),
    GithubSource(),
    AtsSource(),
]

__all__ = ["SignalSource", "ALL_SOURCES", "GoogleNewsSource", "EdgarSource", "GithubSource", "AtsSource"]
