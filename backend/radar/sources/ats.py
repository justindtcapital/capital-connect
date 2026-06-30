"""ATS job-board source (§3.1) — senior/exec hiring as an executive-movement and
growth proxy.

Only runs for companies whose `ats_board_url` enrichment column is set. Supports
Greenhouse and Lever public boards. To keep signal quality high we emit only
SENIOR postings (C-level / VP / Head / Director) — a flood of IC reqs is noise.

`ats_board_url` formats accepted:
  - "greenhouse:<board_token>"  or a greenhouse boards URL
  - "lever:<company>"           or a lever.co URL
"""

from __future__ import annotations

import re

from dateutil import parser as dateparser

from .. import http_client
from ..models import Company, SignalCandidate
from .base import SignalSource

_SENIOR = re.compile(r"\b(chief|c[teofdor]o|vp|vice president|head of|director|svp|evp)\b", re.I)


def _is_senior(title: str) -> bool:
    return bool(_SENIOR.search(title or ""))


class AtsSource(SignalSource):
    source_type = "ats"

    async def fetch_candidates(self, companies: list[Company]) -> list[SignalCandidate]:
        out: list[SignalCandidate] = []
        for company in companies:
            spec = company.ats_board_url.strip()
            if not spec:
                continue
            try:
                if "lever" in spec.lower():
                    out.extend(await self._lever(company, spec))
                else:
                    out.extend(await self._greenhouse(company, spec))
            except Exception:  # noqa: BLE001
                continue
        return out

    @staticmethod
    def _token(spec: str, host_marker: str) -> str:
        if ":" in spec and not spec.lower().startswith("http"):
            return spec.split(":", 1)[1]
        # Pull the slug after the host from a full URL.
        m = re.search(rf"{host_marker}[./]([\w-]+)", spec, re.I)
        return m.group(1) if m else spec

    async def _greenhouse(self, company: Company, spec: str) -> list[SignalCandidate]:
        token = self._token(spec, "greenhouse|boards")
        data = await http_client.get_json(
            f"https://boards-api.greenhouse.io/v1/boards/{token}/jobs"
        )
        jobs = data.get("jobs", []) if isinstance(data, dict) else []
        cands: list[SignalCandidate] = []
        for j in jobs:
            title = j.get("title") or ""
            url = j.get("absolute_url")
            if not url or not _is_senior(title):
                continue
            loc = (j.get("location") or {}).get("name", "")
            cands.append(SignalCandidate(
                company_name=company.name,
                source_type=self.source_type,
                source_url=url,
                raw_title=f"{company.name} hiring: {title}",
                raw_snippet=f"Senior opening — {title}{f' · {loc}' if loc else ''}.",
                published_at=self._iso(j.get("updated_at")),
            ))
        return cands

    async def _lever(self, company: Company, spec: str) -> list[SignalCandidate]:
        token = self._token(spec, "lever")
        data = await http_client.get_json(f"https://api.lever.co/v0/postings/{token}?mode=json")
        postings = data if isinstance(data, list) else []
        cands: list[SignalCandidate] = []
        for p in postings:
            title = p.get("text") or ""
            url = p.get("hostedUrl")
            if not url or not _is_senior(title):
                continue
            cat = p.get("categories") or {}
            loc = cat.get("location", "")
            cands.append(SignalCandidate(
                company_name=company.name,
                source_type=self.source_type,
                source_url=url,
                raw_title=f"{company.name} hiring: {title}",
                raw_snippet=f"Senior opening — {title}{f' · {loc}' if loc else ''}.",
                published_at=self._iso_ms(p.get("createdAt")),
            ))
        return cands

    @staticmethod
    def _iso(s) -> str:
        if not s:
            return ""
        try:
            return dateparser.parse(str(s)).isoformat()
        except (ValueError, OverflowError, TypeError):
            return ""

    @staticmethod
    def _iso_ms(ms) -> str:
        try:
            from datetime import datetime, timezone
            return datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc).isoformat()
        except (ValueError, OverflowError, TypeError):
            return ""
