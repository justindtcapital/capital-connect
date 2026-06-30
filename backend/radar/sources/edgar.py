"""SEC EDGAR source (§3.1) — funding (Form D) + material events (8-K).

Uses EDGAR's full-text search JSON API (efts.sec.gov), matching by company name.
Form D is especially useful: private companies file it when raising capital, so
it surfaces funding signals for portcos that never appear in the news.

v1 uses name-matching; a future enrichment populates `sec_cik` for precise,
low-noise matching (see §15 Q1). EDGAR requires a descriptive User-Agent, which
the guarded HTTP client always sends.
"""

from __future__ import annotations

from .. import http_client
from ..models import Company, SignalCandidate
from .base import SignalSource

_EFTS = "https://efts.sec.gov/LATEST/search-index"
_FORMS = "8-K,D"


def _filing_url(cik: str, accession: str, doc: str) -> str:
    try:
        cik_int = int(cik)
    except (ValueError, TypeError):
        return ""
    acc_nodash = accession.replace("-", "")
    tail = doc or f"{accession}-index.htm"
    return f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{acc_nodash}/{tail}"


class EdgarSource(SignalSource):
    source_type = "edgar"

    async def fetch_candidates(self, companies: list[Company]) -> list[SignalCandidate]:
        out: list[SignalCandidate] = []
        for company in companies:
            name = company.name.strip()
            if not name:
                continue
            # Prefer CIK when known (precise); else name full-text search.
            params = {"forms": _FORMS}
            if company.sec_cik.strip():
                params["q"] = f'"{name}"'
                params["ciks"] = company.sec_cik.strip().zfill(10)
            else:
                params["q"] = f'"{name}"'
            try:
                data = await http_client.get_json(_EFTS, params=params)
                out.extend(self._parse(data, name))
            except Exception:  # noqa: BLE001
                continue
        return out

    def _parse(self, data, company_name: str) -> list[SignalCandidate]:
        cands: list[SignalCandidate] = []
        if not isinstance(data, dict):
            return cands
        hits = (((data.get("hits") or {}).get("hits")) or [])
        for hit in hits[:10]:
            src = hit.get("_source") or {}
            _id = str(hit.get("_id") or "")
            accession = _id.split(":")[0]
            doc = _id.split(":")[1] if ":" in _id else ""
            ciks = src.get("ciks") or []
            cik = str(ciks[0]) if ciks else ""
            url = _filing_url(cik, accession, doc)
            if not url:
                continue
            form = str(src.get("root_form") or src.get("file_type") or src.get("form") or "Filing")
            file_date = str(src.get("file_date") or "")
            display = (src.get("display_names") or [company_name])[0]
            cands.append(SignalCandidate(
                company_name=company_name,
                source_type=self.source_type,
                source_url=url,
                raw_title=f"SEC {form} filing — {display}",
                raw_snippet=f"{form} filed with the SEC on {file_date}.",
                published_at=f"{file_date}T00:00:00+00:00" if file_date else "",
            ))
        return cands
