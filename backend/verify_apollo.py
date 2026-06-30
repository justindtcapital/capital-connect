"""Quick check that the Apollo API key works. Run: python verify_apollo.py"""

import asyncio

from app import apollo, config


async def main():
    print("API key present:", bool(config.APOLLO_API_KEY),
          "| length:", len(config.APOLLO_API_KEY or ""))
    r = await apollo.enrich_person(
        first_name="Stacy", last_name="Brown-Philpot",
        organization_name="Cherryrock Capital",
    )
    print("found:", r.found)
    if r.found:
        print("  title   :", r.title)
        print("  company :", r.company)
        print("  linkedin:", r.linkedin_url)
        print("  location:", r.city, r.state, r.country)
        print("  phone   :", r.phone, f"({r.phone_source})")
        jobs = [f"{e.title} @ {e.company}" for e in (r.employment_history or [])][:3]
        print("  jobs    :", jobs)
    else:
        print("  error      :", r.error)
        print("  accessDenied:", r.access_denied, "| code:", r.error_code)


if __name__ == "__main__":
    asyncio.run(main())
