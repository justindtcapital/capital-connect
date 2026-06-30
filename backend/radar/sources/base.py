"""SignalSource interface (§3.4).

New sources (e.g. future Sumble technographic deltas) only need to implement
`fetch_candidates`; nothing else in the pipeline changes.
"""

from __future__ import annotations

import abc

from ..models import Company, SignalCandidate


class SignalSource(abc.ABC):
    #: stable identifier written to signal_candidates.source_type
    source_type: str = "base"

    @abc.abstractmethod
    async def fetch_candidates(self, companies: list[Company]) -> list[SignalCandidate]:
        """Return raw candidates for the given companies. Must NEVER raise for a
        single-company failure — degrade to fewer results and keep going. Every
        candidate must carry a resolvable source_url (no URL → don't emit it)."""
        raise NotImplementedError
