"""Offline smoke test — verifies the ported logic without hitting any network.

Run: python test_smoke.py
"""

import asyncio

from app import asana, sheets
from app.apollo import _extract_person
from app.main import app


def test_routes():
    paths = sorted({r.path for r in app.routes if r.path.startswith("/api")})
    expected = {
        "/api/contacts", "/api/targets", "/api/portfolio-companies",
        "/api/notes", "/api/events", "/api/portco-intros",
        "/api/resolve-follow-up", "/api/asana/portco-data", "/api/asana/events",
        "/api/apollo/enrich", "/api/health",
    }
    missing = expected - set(paths)
    assert not missing, f"missing routes: {missing}"
    print(f"  routes OK ({len(paths)} /api paths)")


def test_map_rows_and_field_value():
    rows = [
        ["Name", "Role", "Company", "Email", "Relationship Status"],
        ["Ada Lovelace", "CTO", "Analytical Engines", "ada@ae.io", "Hot"],
    ]
    mapped = sheets._map_rows(rows, sheets.CONTACT_COLS)
    assert mapped == [{
        "name": "Ada Lovelace", "title": "CTO", "company": "Analytical Engines",
        "email": "ada@ae.io", "temperature": "Hot",
    }], mapped

    assert asana._field_string_value({"display_value": "X"}) == "X"
    assert asana._field_string_value({"enum_value": {"name": "Hosted"}}) == "Hosted"
    assert asana._field_string_value(
        {"multi_enum_values": [{"name": "AI"}, {"name": "Security"}]}
    ) == "AI, Security"
    assert asana._field_string_value({"number_value": 42}) == "42"
    assert asana._field_string_value({}) == ""
    print("  map_rows + field_string_value OK")


async def test_build_contacts(monkeypatch_tab):
    monkeypatch_tab({
        "Contacts": [
            ["Name", "Email", "Relationship Status", "Follow Up Flag"],
            ["Ada Lovelace", "ada@ae.io", "Warm", "FALSE"],
            ["Grace Hopper", "grace@navy.mil", "bogus", "TRUE"],
        ],
        "Events": [
            ["Contact Email", "Event Name", "Date", "Type"],
            ["ada@ae.io", "AI Summit", "2026-01-01", "attended"],
            ["ada@ae.io", "Future Forum", "2026-02-01", "invited"],
        ],
        "Notes": [
            ["Contact Email", "Timestamp", "Note Content", "Requires Follow Up", "Follow Up Resolved"],
            ["ada@ae.io", "2026-03-01", "Discussed roadmap", "TRUE", "FALSE"],
        ],
        "PortCos Introduced": [["Contact Email", "PortCo Name", "Date"]],
    })
    contacts = await sheets.build_contacts()
    by_email = {c.email: c for c in contacts}

    ada = by_email["ada@ae.io"]
    assert ada.temperature == "Warm"
    assert ada.events_attended == ["AI Summit"]
    # eventsInvited is the union of invited + attended, de-duplicated.
    assert set(ada.events_invited) == {"AI Summit", "Future Forum"}
    assert ada.follow_up_pending is True  # from unresolved note
    assert ada.interactions[0].summary == "Discussed roadmap"

    grace = by_email["grace@navy.mil"]
    assert grace.temperature == "Cold"  # invalid status falls back to Cold
    assert grace.follow_up_pending is True  # from the contact-level flag
    print("  build_contacts OK")


async def test_build_portfolio(monkeypatch_tab):
    monkeypatch_tab({
        "Portfolio Companies": [
            ["Company Name", "Website", "Focus Area(s)", "HQ", "Summary"],
            ["SecureCo", "secure.co", "Cybersecurity platform", "Boston", "We secure things"],
            ["VagueCo", "vague.co", "Misc widgets", "Reno", "Unknown focus"],
        ],
    })
    cos = await sheets.build_portfolio_companies()
    assert cos[0].domain == "Security"  # 'security' keyword matched
    assert cos[1].domain == "Cloud"     # default when nothing matches
    print("  build_portfolio OK")


async def test_asana_events(monkeypatch):
    async def fake_tasks(project_gid, due_after=None, due_before=None):
        return [{
            "gid": "111",
            "name": "DevSecOps Dinner",
            "due_on": "2020-05-01",  # in the past → completed
            "custom_fields": [
                {"name": "Portfolio Companies", "type": "multi_enum",
                 "multi_enum_values": [{"name": "SecureCo"}]},
                {"name": "Role", "type": "enum", "enum_value": {"name": "Hosted"}},
                {"name": "Type", "type": "enum", "enum_value": {"name": "Dinner"}},
                {"name": "Industry", "type": "multi_enum",
                 "multi_enum_values": [{"name": "Security"}, {"name": "AI"}]},
                {"name": "Format", "type": "enum", "enum_value": {"name": "In-person"}},
            ],
        }]

    monkeypatch.setattr(asana, "fetch_project_tasks", fake_tasks)
    monkeypatch.setattr(asana.config, "ASANA_EVENTS_PROJECT_GID", "evt-gid")

    events = await asana.fetch_all_asana_events()
    assert len(events) == 1
    ev = events[0]
    assert ev.type == "dinner"
    assert ev.role == "hosted"
    assert ev.status == "completed"
    assert ev.format == "in-person"
    assert ev.sectors == ["Security", "AI"]
    assert ev.portcos == ["SecureCo"]

    exploded = await asana.fetch_portfolio_events()
    assert "secureco" in exploded
    assert exploded["secureco"][0].event_role == "hosted"
    print("  asana events parsing OK")


def test_apollo_extract():
    person = {
        "title": "VP Eng",
        "organization_name": "Globex",
        "linkedin_url": "https://linkedin.com/in/x",
        "phone_numbers": [{"type": "work", "sanitized_number": "+1-555"}],
        "employment_history": [
            {"title": "VP Eng", "organization_name": "Globex", "current": True},
            {"title": "Eng", "organization_name": "Initech", "current": False},
        ],
        "organization": {"city": "Springfield", "state": "IL", "country": "USA"},
    }
    r = _extract_person(person)
    assert r.found is True
    assert r.company == "Globex"
    assert r.phone == "+1-555"
    assert r.phone_source == "work"
    assert r.city == "Springfield"  # fell back to org location
    assert len(r.employment_history) == 2
    print("  apollo extract OK")


# ── Minimal pytest-style fixtures, hand-rolled so no pytest dependency ───────

class _MonkeyPatch:
    def __init__(self):
        self._undo = []

    def setattr(self, target, name, value):
        old = getattr(target, name)
        self._undo.append((target, name, old))
        setattr(target, name, value)

    def undo(self):
        for target, name, old in reversed(self._undo):
            setattr(target, name, old)


def main():
    print("Running offline smoke tests...")
    test_routes()
    test_map_rows_and_field_value()
    test_apollo_extract()

    mp = _MonkeyPatch()
    try:
        def monkeypatch_tab(tab_map):
            async def fake_fetch(tab_name):
                return tab_map.get(tab_name, [])
            mp.setattr(sheets, "fetch_sheet_tab", fake_fetch)

        asyncio.run(test_build_contacts(monkeypatch_tab))
        asyncio.run(test_build_portfolio(monkeypatch_tab))
        asyncio.run(test_asana_events(mp))
    finally:
        mp.undo()

    print("\nAll smoke tests passed.")


if __name__ == "__main__":
    main()
