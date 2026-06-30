"""Google News RSS source (§3.1) — the workhorse: covers every company, no key.

One RSS query per company: news.google.com/rss/search?q="<company>". Parsed with
the stdlib XML parser (no feedparser dependency). pubDate gives a real published
date, so most candidates pass the triage date gate deterministically.
"""

from __future__ import annotations

import re
from xml.etree import ElementTree as ET

from dateutil import parser as dateparser

from .. import http_client
from ..models import Company, SignalCandidate
from .base import SignalSource

_RSS = "https://news.google.com/rss/search"
_TAG_RE = re.compile(r"<[^>]+>")


def _to_iso(pub: str | None) -> str:
    if not pub:
        return ""
    try:
        return dateparser.parse(pub).isoformat()
    except (ValueError, OverflowError, TypeError):
        return ""


def _strip_html(s: str) -> str:
    return _TAG_RE.sub("", s or "").strip()


class GoogleNewsSource(SignalSource):
    source_type = "gnews_rss"

    async def fetch_candidates(self, companies: list[Company]) -> list[SignalCandidate]:
        out: list[SignalCandidate] = []
        for company in companies:
            name = company.name.strip()
            if not name:
                continue
            try:
                xml = await http_client.get_text(
                    _RSS,
                    params={"q": f'"{name}"', "hl": "en-US", "gl": "US", "ceid": "US:en"},
                )
                out.extend(self._parse(xml, name))
            except Exception:  # noqa: BLE001 — one company failing must not kill the run
                continue
        return out

    def _parse(self, xml: str, company_name: str) -> list[SignalCandidate]:
        cands: list[SignalCandidate] = []
        try:
            root = ET.fromstring(xml)
        except ET.ParseError:
            return cands
        for item in root.iter("item"):
            link = (item.findtext("link") or "").strip()
            if not link:  # no URL → discard (§3.2)
                continue
            title = _strip_html(item.findtext("title") or "")
            desc = _strip_html(item.findtext("description") or "")
            cands.append(SignalCandidate(
                company_name=company_name,
                source_type=self.source_type,
                source_url=link,
                raw_title=title,
                raw_snippet=desc[:500],
                published_at=_to_iso(item.findtext("pubDate")),
            ))
        return cands
