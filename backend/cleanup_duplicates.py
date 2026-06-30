"""One-off: remove duplicate contact rows from the Contacts tab.

Keeps the FIRST occurrence of each email (case-insensitive) and deletes later
duplicates. This restores the intended state after a CSV upload re-added
already-seeded contacts.

Run: python cleanup_duplicates.py
"""

import asyncio

import httpx

from app import config, sheets

BASE = "https://sheets.googleapis.com/v4/spreadsheets"
EMAIL_COL = 3  # 0-based column index of Email in the Contacts tab


async def main():
    sid = config.GOOGLE_SPREADSHEET_ID
    token = await sheets._get_access_token()
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    async with httpx.AsyncClient(timeout=30) as client:
        # Resolve the Contacts tab's numeric sheetId.
        meta = await client.get(
            f"{BASE}/{sid}?fields=sheets.properties(sheetId,title)", headers=headers
        )
        meta.raise_for_status()
        contacts_id = next(
            s["properties"]["sheetId"]
            for s in meta.json()["sheets"]
            if s["properties"]["title"] == "Contacts"
        )

        # Read rows and find duplicate emails (keep first occurrence).
        sheets._cache.delete("Contacts")
        rows = await sheets.fetch_sheet_tab("Contacts")
        seen: set[str] = set()
        dupe_indexes: list[int] = []  # 0-based row indexes to delete
        for idx, row in enumerate(rows):
            if idx == 0:
                continue  # header
            email = (row[EMAIL_COL] if len(row) > EMAIL_COL else "").strip().lower()
            if not email:
                continue
            if email in seen:
                dupe_indexes.append(idx)
                print(f"  duplicate -> row {idx + 1}: {row[0]} ({email})")
            else:
                seen.add(email)

        if not dupe_indexes:
            print("No duplicates found. Nothing to do.")
            return

        # Delete from the bottom up so earlier indexes stay valid.
        requests = [
            {"deleteDimension": {"range": {
                "sheetId": contacts_id, "dimension": "ROWS",
                "startIndex": idx, "endIndex": idx + 1,
            }}}
            for idx in sorted(dupe_indexes, reverse=True)
        ]
        r = await client.post(
            f"{BASE}/{sid}:batchUpdate", headers=headers, json={"requests": requests}
        )
        r.raise_for_status()
        print(f"\nDeleted {len(dupe_indexes)} duplicate row(s).")

    sheets._cache.delete("Contacts")
    contacts = await sheets.build_contacts()
    print(f"\nContacts now: {len(contacts)}")
    for c in contacts:
        print(f"  - {c.name:22} | {c.temperature:5} | portcos: {c.port_co_intros}")


if __name__ == "__main__":
    asyncio.run(main())
