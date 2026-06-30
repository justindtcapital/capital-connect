"""Verify Apollo people-search (/mixed_people/search) works with the configured key.

Run: python verify_apollo_search.py
"""

import asyncio
import json

import httpx

from app import config


async def main():
    key = config.APOLLO_API_KEY
    print("API key present:", bool(key))
    body = {
        "person_titles": ["Chief Information Security Officer", "CISO"],
        "person_locations": ["Boston, Massachusetts"],
        "page": 1,
        "per_page": 5,
    }
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(
            "https://api.apollo.io/api/v1/mixed_people/api_search",
            headers={"Content-Type": "application/json", "X-Api-Key": key or ""},
            json=body,
        )
    print("HTTP", r.status_code)
    if r.status_code >= 400:
        print("ERROR body:", r.text[:500])
        return
    data = r.json()
    print("top-level keys:", list(data.keys()))
    print("pagination:", json.dumps(data.get("pagination", {})))
    people = data.get("people") or data.get("contacts") or []
    print("people count:", len(people))
    if people:
        p = people[0]
        print("first person keys:", list(p.keys()))
        print("first person sample:", json.dumps({
            k: p.get(k) for k in ["id", "name", "first_name", "last_name", "title",
                                   "organization_name", "linkedin_url", "city", "state", "country", "email"]
        }, indent=2))
        org = p.get("organization")
        print("has organization object:", isinstance(org, dict), "->", (org or {}).get("name") if isinstance(org, dict) else None)


if __name__ == "__main__":
    asyncio.run(main())
