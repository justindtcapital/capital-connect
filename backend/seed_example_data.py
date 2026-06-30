"""One-off: seed example Warm contacts + portfolio companies + portco links.

Appends to the existing tabs (does not clear anything). Safe to delete the rows
afterward in Google Sheets if you don't want the demo data.

Run: python seed_example_data.py
"""

import asyncio

import httpx

from app import config, sheets

TODAY = "2026-06-05"
BASE = "https://sheets.googleapis.com/v4/spreadsheets"

# Contacts tab columns:
# Name, Role, Company, Email, Phone Number, Location, Relationship Prime,
# Industry Category, Relationship Status, Follow Up Flag, Date Added, URID
CONTACTS = [
    ["Ada Lovelace", "Chief Technology Officer", "Analytical Engines",
     "ada@analyticalengines.io", "+1-555-0142", "Boston, MA", "Jane Partner",
     "AI", "Warm", "FALSE", TODAY, ""],
    ["Grace Hopper", "VP Engineering", "NavyTech Systems",
     "grace.hopper@navytech.mil", "+1-555-0188", "Arlington, VA", "Sam Lead",
     "Security", "Warm", "FALSE", TODAY, ""],
    ["Alan Turing", "Founder & CEO", "Bombe AI",
     "alan@bombe.ai", "+1-555-0199", "Manchester, UK", "Jane Partner",
     "AI", "Warm", "FALSE", TODAY, ""],
]

# Portfolio Companies tab columns: Company Name, Website, Focus Area(s), HQ, Summary
PORTFOLIO = [
    ["Coactive AI", "coactive.ai", "AI / Computer Vision", "San Jose, CA",
     "Multimodal AI platform that makes visual data searchable and analyzable."],
    ["StockX", "stockx.com", "E-commerce / Logistics", "Detroit, MI",
     "Online marketplace and clearinghouse for sneakers and collectibles."],
    ["Sentinel Cyber", "sentinelcyber.io", "Cybersecurity", "Austin, TX",
     "Threat detection and automated incident response platform."],
]

# PortCos Introduced tab columns: Contact Email, PortCo Name, Date
INTROS = [
    ["ada@analyticalengines.io", "Coactive AI", TODAY],
    ["ada@analyticalengines.io", "StockX", TODAY],
    ["grace.hopper@navytech.mil", "Sentinel Cyber", TODAY],
    ["alan@bombe.ai", "Coactive AI", TODAY],
]


async def append(client, headers, sid, tab, rows):
    url = (
        f"{BASE}/{sid}/values/{tab}:append"
        "?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS"
    )
    r = await client.post(url, headers=headers, json={"values": rows})
    r.raise_for_status()
    updated = r.json().get("updates", {}).get("updatedRange", "?")
    print(f"  {tab}: appended {len(rows)} rows -> {updated}")


async def main():
    sid = config.GOOGLE_SPREADSHEET_ID
    token = await sheets._get_access_token()
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    async with httpx.AsyncClient(timeout=30) as client:
        await append(client, headers, sid, "Contacts", CONTACTS)
        await append(client, headers, sid, "Portfolio Companies", PORTFOLIO)
        await append(client, headers, sid, "PortCos Introduced", INTROS)

    # Bust the read cache so the verification below sees fresh data.
    for tab in ("Contacts", "Portfolio Companies", "PortCos Introduced"):
        sheets._cache.delete(tab)

    print("\nVerifying via build_contacts()...")
    contacts = await sheets.build_contacts()
    for c in contacts:
        if c.email in {r[3] for r in CONTACTS}:
            print(f"  {c.name}: {c.temperature} | portcos -> {c.port_co_intros}")

    print("\nDone.")


if __name__ == "__main__":
    asyncio.run(main())
