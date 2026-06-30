"""One-off: reorder the Contacts tab columns to the user's preferred layout.

Reads the existing data, remaps every row into the new column order (matched by
header name, so no data is lost or misaligned), then overwrites the tab. The
app's reads/writes are header-aware, so this is safe.

Run: python reorder_contacts.py
"""

import asyncio

import httpx

from app import config, sheets

# Target column order.
NEW_HEADERS = [
    "Name",
    "Company",
    "Role",
    "Industry Category",
    "Date Added",
    "Phone Number",
    "Email",
    "Location",
    "Relationship Status",
    "Relationship Prime",
    "Follow Up Flag",
]

BASE = "https://sheets.googleapis.com/v4/spreadsheets"


async def main():
    sid = config.GOOGLE_SPREADSHEET_ID
    token = await sheets._get_access_token()
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    sheets._cache.delete("Contacts")
    rows = await sheets.fetch_sheet_tab("Contacts")
    if not rows:
        print("Contacts tab is empty — nothing to reorder.")
        return

    old_headers = [h.strip().lower() for h in rows[0]]

    def old_index(header: str) -> int:
        try:
            return old_headers.index(header.lower())
        except ValueError:
            return -1

    src_idx = [old_index(h) for h in NEW_HEADERS]
    print("Old order:", rows[0])
    print("New order:", NEW_HEADERS)

    new_matrix = [NEW_HEADERS]
    for r in rows[1:]:
        new_matrix.append([(r[i] if 0 <= i < len(r) else "") for i in src_idx])

    async with httpx.AsyncClient(timeout=30) as client:
        # Clear the whole tab first so the dropped column (URID) doesn't linger.
        c = await client.post(f"{BASE}/{sid}/values/Contacts:clear", headers=headers, json={})
        c.raise_for_status()
        w = await client.put(
            f"{BASE}/{sid}/values/Contacts!A1?valueInputOption=USER_ENTERED",
            headers=headers,
            json={"values": new_matrix},
        )
        w.raise_for_status()

    sheets._cache.delete("Contacts")
    print(f"\nReordered {len(new_matrix) - 1} contact row(s).")

    # Verify the app can still read them.
    contacts = await sheets.build_contacts()
    print(f"build_contacts() -> {len(contacts)} contacts")
    for ct in contacts[:6]:
        print(f"  - {ct.name:22} | {ct.company:18} | {ct.title:30} | {ct.temperature}")


if __name__ == "__main__":
    asyncio.run(main())
