"""GitHub releases source (§3.1) — product/milestone signals for OSS portcos.

Only runs for companies whose `github_org` enrichment column is populated. Reads
the org's recently-pushed repos and emits their latest published release as a
candidate. Unauthenticated (60 req/hr) — kept small and best-effort.
"""

from __future__ import annotations

from .. import http_client
from ..models import Company, SignalCandidate
from .base import SignalSource

_API = "https://api.github.com"


class GithubSource(SignalSource):
    source_type = "github"

    async def fetch_candidates(self, companies: list[Company]) -> list[SignalCandidate]:
        out: list[SignalCandidate] = []
        for company in companies:
            org = company.github_org.strip()
            if not org:
                continue
            try:
                repos = await http_client.get_json(
                    f"{_API}/orgs/{org}/repos",
                    params={"sort": "pushed", "per_page": "5"},
                    headers={"Accept": "application/vnd.github+json"},
                )
            except Exception:  # noqa: BLE001
                continue
            if not isinstance(repos, list):
                continue
            for repo in repos[:5]:
                name = repo.get("name")
                if not name:
                    continue
                try:
                    rel = await http_client.get_json(
                        f"{_API}/repos/{org}/{name}/releases/latest",
                        headers={"Accept": "application/vnd.github+json"},
                    )
                except Exception:  # noqa: BLE001 — no release / 404 is normal
                    continue
                url = rel.get("html_url")
                if not url:
                    continue
                tag = rel.get("tag_name") or rel.get("name") or "release"
                body = (rel.get("body") or "").strip()
                out.append(SignalCandidate(
                    company_name=company.name,
                    source_type=self.source_type,
                    source_url=url,
                    raw_title=f"{org}/{name} {tag} released",
                    raw_snippet=body[:400],
                    published_at=str(rel.get("published_at") or ""),
                ))
        return out
