"""Check whether /people/match can reveal a searched person by Apollo id.

Run: python verify_apollo_reveal.py
"""

import asyncio
import json

import httpx

from app import config


async def main():
    key = config.APOLLO_API_KEY or ""
    headers = {"Content-Type": "application/json", "X-Api-Key": key}
    async with httpx.AsyncClient(timeout=30) as c:
        # 1) Search to get an id
        s = await c.post(
            "https://api.apollo.io/api/v1/mixed_people/api_search",
            headers=headers,
            json={"person_titles": ["CISO"], "person_locations": ["Boston, Massachusetts"], "per_page": 1},
        )
        people = s.json().get("people", [])
        if not people:
            print("no search results")
            return
        pid = people[0]["id"]
        print("searched id:", pid, "| first_name:", people[0].get("first_name"), "| has_email:", people[0].get("has_email"))

        # 2) Try to reveal via /people/match by id
        m = await c.post(
            "https://api.apollo.io/api/v1/people/match",
            headers=headers,
            json={"id": pid, "reveal_personal_emails": True},
        )
        print("match HTTP", m.status_code)
        if m.status_code < 400:
            person = m.json().get("person") or {}
            print("revealed:", json.dumps({
                "name": person.get("name"),
                "title": person.get("title"),
                "company": person.get("organization_name") or (person.get("organization") or {}).get("name"),
                "email": person.get("email"),
                "linkedin_url": person.get("linkedin_url"),
                "city": person.get("city"),
                "state": person.get("state"),
            }, indent=2))
        else:
            print("match error:", m.text[:300])


if __name__ == "__main__":
    asyncio.run(main())
