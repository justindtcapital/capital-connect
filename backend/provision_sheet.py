"""One-off: provision the required tabs + header rows in the Google Sheet.

Idempotent — only creates tabs that don't already exist, then (re)writes the
header row on each. Leaves any existing tabs (e.g. 'Sheet1') untouched.

Run: python provision_sheet.py
"""

import asyncio

import httpx

from app import config, sheets

# Tab name -> header row. Column order matches what the write-back server
# functions append (see src/utils/sheets.functions.ts), so reads and writes line up.
SCHEMA = {
    "Contacts": [
        "Name", "Role", "Company", "Email", "Phone Number", "Location",
        "Relationship Prime", "Industry Category", "Relationship Status",
        "Follow Up Flag", "Date Added", "URID",
    ],
    "Events": ["Contact Email", "Event Name", "Date", "Type"],
    "PortCos Introduced": ["Contact Email", "PortCo Name", "Date"],
    "Notes": [
        "Contact Email", "Timestamp", "Note Content",
        "Requires Follow Up", "Follow Up Resolved",
    ],
    "Targets": [
        "First Name", "Last Name", "Company", "Role", "LinkedIn", "Email",
        "Location", "Sector", "Stage", "Source", "Research Purpose",
        "Date Added", "Last Contacted",
    ],
    "Portfolio Companies": ["Company Name", "Website", "Focus Area(s)", "HQ", "Summary"],
}

BASE = "https://sheets.googleapis.com/v4/spreadsheets"


async def main():
    sid = config.GOOGLE_SPREADSHEET_ID
    token = await sheets._get_access_token()
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    async with httpx.AsyncClient(timeout=30) as client:
        # 1. Which tabs already exist?
        meta = await client.get(
            f"{BASE}/{sid}?fields=sheets.properties.title", headers=headers
        )
        meta.raise_for_status()
        existing = {s["properties"]["title"] for s in meta.json().get("sheets", [])}
        print("Existing tabs:", sorted(existing))

        # 2. Create any missing tabs.
        to_add = [name for name in SCHEMA if name not in existing]
        if to_add:
            requests = [{"addSheet": {"properties": {"title": name}}} for name in to_add]
            r = await client.post(
                f"{BASE}/{sid}:batchUpdate", headers=headers, json={"requests": requests}
            )
            r.raise_for_status()
            print("Created tabs:", to_add)
        else:
            print("No new tabs needed.")

        # 3. Write the header row on every tab.
        data = [{"range": f"{name}!A1", "values": [cols]} for name, cols in SCHEMA.items()]
        r = await client.post(
            f"{BASE}/{sid}/values:batchUpdate",
            headers=headers,
            json={"valueInputOption": "USER_ENTERED", "data": data},
        )
        r.raise_for_status()
        print(f"Wrote headers to {len(data)} tabs.")

    print("\nDone. Sheet is provisioned.")


if __name__ == "__main__":
    asyncio.run(main())
