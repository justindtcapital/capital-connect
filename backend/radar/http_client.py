"""Guarded HTTP client.

Every outbound fetch in the radar goes through here, so the compliance blocklist
(§13) is enforced in exactly one place. Also sets the descriptive User-Agent SEC
EDGAR requires. Network/HTTP errors are surfaced to the caller, which decides
whether to degrade gracefully (sources return [] on error).
"""

from __future__ import annotations

import httpx

from . import compliance
from .config import HTTP_TIMEOUT, USER_AGENT

# A blocked attempt is recorded here so the run can emit a compliance_block audit
# event (§13). Reset per run by the orchestrator.
COMPLIANCE_BLOCKS: list[str] = []


async def _request(method: str, url: str, *, client: httpx.AsyncClient, **kw) -> httpx.Response:
    try:
        compliance.assert_allowed(url)
    except compliance.ComplianceBlock:
        COMPLIANCE_BLOCKS.append(url)
        raise
    return await client.request(method, url, **kw)


async def get_text(url: str, *, headers: dict | None = None, params: dict | None = None) -> str:
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT, follow_redirects=True) as client:
        res = await _request(
            "GET", url, client=client,
            headers={"User-Agent": USER_AGENT, **(headers or {})}, params=params,
        )
        res.raise_for_status()
        return res.text


async def get_json(url: str, *, headers: dict | None = None, params: dict | None = None) -> dict | list:
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT, follow_redirects=True) as client:
        res = await _request(
            "GET", url, client=client,
            headers={"User-Agent": USER_AGENT, "Accept": "application/json", **(headers or {})},
            params=params,
        )
        res.raise_for_status()
        return res.json()


async def head_ok(url: str) -> bool:
    """Return True if the URL resolves to a 2xx — used to verify source_url at
    promotion time (§12 acceptance criterion)."""
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT, follow_redirects=True) as client:
            res = await _request("GET", url, client=client, headers={"User-Agent": USER_AGENT})
            return 200 <= res.status_code < 300
    except Exception:  # noqa: BLE001
        return False
