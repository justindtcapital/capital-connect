"""Compliance guard tests (§13 hard requirement).

Asserts the LinkedIn/Crunchbase/PitchBook blocklist is enforced at the HTTP
layer — any attempt to fetch a blocked domain raises ComplianceBlock and is
recorded. Run: `python -m radar.tests.test_compliance` or via pytest.
"""

from __future__ import annotations

import asyncio

from radar import compliance, http_client
from radar.config import BLOCKED_DOMAINS

BLOCKED_URLS = [
    "https://www.linkedin.com/in/someone",
    "https://linkedin.com/company/acme",
    "https://api.crunchbase.com/v4/entities/organizations/acme",
    "https://www.pitchbook.com/profiles/company/123",
    "https://sub.pitchbook.com/x",
]
ALLOWED_URLS = [
    "https://news.google.com/rss/search?q=acme",
    "https://efts.sec.gov/LATEST/search-index?q=acme",
    "https://api.github.com/orgs/acme/repos",
    "https://notlinkedin.com/x",  # must NOT be blocked by a naive substring check
]


def test_is_blocked():
    for u in BLOCKED_URLS:
        assert compliance.is_blocked(u), f"should be blocked: {u}"
    for u in ALLOWED_URLS:
        assert not compliance.is_blocked(u), f"should be allowed: {u}"


def test_assert_allowed_raises():
    for u in BLOCKED_URLS:
        try:
            compliance.assert_allowed(u)
        except compliance.ComplianceBlock:
            continue
        raise AssertionError(f"assert_allowed did not raise for {u}")


def test_http_client_blocks_and_records():
    http_client.COMPLIANCE_BLOCKS.clear()
    blocked = "https://www.linkedin.com/in/someone"

    async def _go():
        try:
            await http_client.get_text(blocked)
        except compliance.ComplianceBlock:
            return True
        return False

    assert asyncio.run(_go()) is True, "http_client.get_text should raise ComplianceBlock"
    assert blocked in http_client.COMPLIANCE_BLOCKS, "blocked attempt must be recorded"


if __name__ == "__main__":
    test_is_blocked()
    test_assert_allowed_raises()
    test_http_client_blocks_and_records()
    print(f"OK — compliance blocklist enforced for {', '.join(BLOCKED_DOMAINS)}")
