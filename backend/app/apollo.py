"""Apollo.io API integration.

Port of `src/utils/apollo.server.ts`.
Primary: POST /people/match (searches full Apollo database)
Fallback: POST /contacts/search (your account contacts only)
"""

from __future__ import annotations

import json
import logging
import re

import httpx

from . import config
from .models import ApolloEnrichmentResult, EmploymentHistoryItem

logger = logging.getLogger(__name__)

APOLLO_API_URL = "https://api.apollo.io/api/v1"


async def _apollo_fetch(
    client: httpx.AsyncClient, path: str, method: str, body: dict, api_key: str
) -> httpx.Response:
    return await client.request(
        method,
        f"{APOLLO_API_URL}{path}",
        headers={"Content-Type": "application/json", "X-Api-Key": api_key},
        json=body,
    )


def _extract_person(person: dict) -> ApolloEnrichmentResult:
    employment_history: list[EmploymentHistoryItem] = []
    raw_history = person.get("employment_history")
    if isinstance(raw_history, list):
        for e in raw_history[:5]:
            employment_history.append(EmploymentHistoryItem(
                title=str(e.get("title") or ""),
                company=str(e.get("organization_name") or ""),
                current=bool(e.get("current")),
            ))

    # Phone — Apollo's free/lower tiers don't return personal/mobile numbers
    # unless you opt into reveal_phone_number (which requires a webhook URL).
    # We still try every documented field; if nothing personal is available we
    # fall back to the organization's main switchboard so there's at least
    # *some* number on the contact record.
    phone = ""
    phone_source = ""
    phone_numbers = person.get("phone_numbers")
    if isinstance(phone_numbers, list) and len(phone_numbers) > 0:
        def by_type(t: str):
            return next(
                (n for n in phone_numbers if t in str(n.get("type") or "").lower()),
                None,
            )

        pick = by_type("mobile") or by_type("personal") or by_type("work") or phone_numbers[0]
        phone = str(pick.get("sanitized_number") or pick.get("raw_number") or pick.get("number") or "")
        t = str(pick.get("type") or "").lower()
        phone_source = (
            "mobile" if "mobile" in t
            else "personal" if "personal" in t
            else "work" if "work" in t
            else "personal"
        )

    if not phone and person.get("mobile_phone"):
        phone, phone_source = str(person["mobile_phone"]), "mobile"
    if not phone and person.get("personal_phone"):
        phone, phone_source = str(person["personal_phone"]), "personal"
    if not phone and person.get("sanitized_phone"):
        phone, phone_source = str(person["sanitized_phone"]), "personal"
    if not phone and person.get("phone"):
        phone, phone_source = str(person["phone"]), "personal"
    if not phone and person.get("direct_phone"):
        phone, phone_source = str(person["direct_phone"]), "work"
    if not phone and person.get("work_direct_phone"):
        phone, phone_source = str(person["work_direct_phone"]), "work"
    if not phone and person.get("corporate_phone"):
        phone, phone_source = str(person["corporate_phone"]), "work"

    # Last-resort fallback: company switchboard from the org record.
    org = person.get("organization")
    if not phone and isinstance(org, dict):
        primary = org.get("primary_phone")
        primary_num = (
            (primary.get("sanitized_number") or primary.get("number"))
            if isinstance(primary, dict) else None
        )
        org_phone = org.get("sanitized_phone") or org.get("phone") or primary_num
        if org_phone:
            phone, phone_source = str(org_phone), "company"

    # City: check person directly, then organization
    city = str(person.get("city") or "")
    state = str(person.get("state") or "")
    country = str(person.get("country") or "")

    # Fall back to organization location if person-level is empty
    if not city and isinstance(org, dict):
        if not city and org.get("city"):
            city = str(org["city"])
        if not state and org.get("state"):
            state = str(org["state"])
        if not country and org.get("country"):
            country = str(org["country"])

    # Also try present_raw_address as fallback
    if not city and person.get("present_raw_address"):
        city = str(person["present_raw_address"])
        state = ""
        country = ""

    company = str(
        person.get("organization_name")
        or (org.get("name") if isinstance(org, dict) else "")
        or ""
    )

    return ApolloEnrichmentResult(
        found=True,
        title=str(person.get("title") or ""),
        company=company,
        linkedinUrl=str(person.get("linkedin_url") or ""),
        city=city,
        state=state,
        country=country,
        headline=str(person.get("headline") or ""),
        photoUrl=str(person.get("photo_url") or ""),
        phone=phone,
        phoneSource=phone_source,
        email=str(person.get("email") or ""),
        employmentHistory=employment_history,
        # Round-trip through JSON to drop any non-serializable values, matching
        # the TS `JSON.parse(JSON.stringify(person))`.
        rawResponse=json.loads(json.dumps(person, default=str)),
    )


def _is_valid_str(v) -> bool:
    return isinstance(v, str) and len(v.strip()) > 0


def _is_valid_url(v) -> bool:
    return isinstance(v, str) and re.match(r"^https?://", v.strip(), re.I) is not None


async def enrich_person(
    *,
    email: str | None = None,
    first_name: str | None = None,
    last_name: str | None = None,
    organization_name: str | None = None,
    linkedin_url: str | None = None,
) -> ApolloEnrichmentResult:
    """Try /people/match first (full Apollo DB). If the key doesn't have access,
    fall back to /contacts/search (your account contacts only)."""
    api_key = config.APOLLO_API_KEY
    if not api_key:
        raise RuntimeError("APOLLO_API_KEY is not configured")

    # --- Attempt 1: /people/match (full database) ---
    match_body: dict = {
        "reveal_personal_emails": True,
        # NOTE: do NOT enable reveal_phone_number here — Apollo requires a
        # webhook_url alongside it and otherwise returns HTTP 400.
    }
    if _is_valid_str(email):
        match_body["email"] = email.strip()
    if _is_valid_str(first_name):
        match_body["first_name"] = first_name.strip()
    if _is_valid_str(last_name):
        match_body["last_name"] = last_name.strip()
    if _is_valid_str(organization_name):
        match_body["organization_name"] = organization_name.strip()
    if _is_valid_url(linkedin_url):
        match_body["linkedin_url"] = linkedin_url.strip()

    logger.info("[Apollo] /people/match request keys: %s", ",".join(match_body.keys()))

    async with httpx.AsyncClient(timeout=30) as client:
        match_res = await _apollo_fetch(client, "/people/match", "POST", match_body, api_key)

        if match_res.status_code < 400:
            data = match_res.json()
            if data.get("person"):
                logger.info("[Apollo] /people/match succeeded")
                return _extract_person(data["person"])
            logger.info("[Apollo] /people/match: 200 OK but no person matched. Falling back to /contacts/search.")
        else:
            error_body = match_res.text
            logger.info(
                "[Apollo] /people/match returned %s, falling back to /contacts/search. Body: %s",
                match_res.status_code, error_body[:300],
            )
            if match_res.status_code != 403:
                logger.error("[Apollo] /people/match unexpected error: %s", error_body)

        # --- Attempt 2: /contacts/search (account contacts) ---
        search_keywords = " ".join(p for p in (first_name, last_name, email) if p)

        search_res = await _apollo_fetch(
            client, "/contacts/search", "POST",
            {"q_keywords": search_keywords, "per_page": 5}, api_key,
        )

    if search_res.status_code >= 400:
        error_body = search_res.text
        try:
            parsed = json.loads(error_body)
            if search_res.status_code == 403 and parsed.get("error_code") == "API_INACCESSIBLE":
                return ApolloEnrichmentResult(
                    found=False,
                    accessDenied=True,
                    errorCode=parsed["error_code"],
                    error=(
                        "Neither /people/match nor /contacts/search are accessible with this "
                        "API key. Please check your Apollo plan or key permissions."
                    ),
                )
        except (json.JSONDecodeError, ValueError):
            pass  # non-JSON
        raise RuntimeError(f"Apollo API error [{search_res.status_code}]: {error_body}")

    contacts = search_res.json().get("contacts")

    if not contacts:
        tried = ", ".join(filter(None, [
            f'email "{email}"' if email else None,
            f'name "{first_name} {last_name}"' if first_name and last_name else None,
            f'at "{organization_name}"' if organization_name else None,
        ]))
        return ApolloEnrichmentResult(
            found=False,
            error=(
                f"No Apollo match found for {tried}. This person may not be in Apollo's database, "
                "or the email/company may be too generic to match. Try adding a LinkedIn URL."
                if tried else
                "No match found. Add an email, name + company, or LinkedIn URL to improve matching."
            ),
        )

    # Try to match by email
    match = contacts[0]
    if email:
        email_lower = email.lower()
        email_match = next(
            (c for c in contacts if str(c.get("email") or "").lower() == email_lower),
            None,
        )
        if email_match:
            match = email_match

    logger.info("[Apollo] /contacts/search matched, returning data")
    return _extract_person(match)
