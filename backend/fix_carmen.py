"""One-off: rewrite the single misaligned Carmen row (1011) in the new column order."""

import asyncio

import httpx

from app import config, sheets

BASE = "https://sheets.googleapis.com/v4/spreadsheets"

# New column order: Name, Company, Role, Industry Category, Date Added,
# Phone Number, Email, Location, Relationship Status, Relationship Prime, Follow Up Flag
ROW = [
    "Carmen Rijo",
    "illumyn Impact",
    "Strategic Partnerships & Events",
    "",                                  # Industry Category (sector) — unknown
    "2026-06-08",
    "13105007749",
    "carmen@illumynimpact.org",
    "Oakland, California, United States",
    "Warm",
    "Julia",
    "FALSE",
]


async def main():
    sid = config.GOOGLE_SPREADSHEET_ID
    token = await sheets._get_access_token()
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.put(
            f"{BASE}/{sid}/values/Contacts!A1011?valueInputOption=USER_ENTERED",
            headers=headers,
            json={"values": [ROW]},
        )
        r.raise_for_status()
    sheets._cache.delete("Contacts")
    print("Fixed Carmen's row:", ROW)


if __name__ == "__main__":
    asyncio.run(main())
