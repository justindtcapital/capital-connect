// Heuristic matching of Asana BD/GTM activities to CRM records. Activities carry
// free-text company/person strings (parsed from Asana custom fields or the task
// name), so matching is name/email-substring based rather than keyed.

import type { AsanaActivity, Contact } from "@/lib/types";

const norm = (s?: string) => (s || "").trim().toLowerCase();

// The Portfolio Company field can tag several companies ("Maven, Comcast"); split
// it into normalized whole names so matching is exact per-name — never a substring
// (which would wrongly match "Mave" against "Maven").
function taggedCompanies(a: AsanaActivity): string[] {
  return (a.company || "")
    .split(/[;,/|]/)
    .map((s) => norm(s))
    .filter(Boolean);
}

// An activity belongs to a contact when it names the person (a person field equals
// the contact name, or the task text mentions their full name or email), OR when
// the contact works at the company the activity is tagged to (e.g. GTM tasks carry
// only a Portfolio Company field — those surface on that company's people).
export function matchActivitiesToContact(activities: AsanaActivity[], contact: Contact): AsanaActivity[] {
  const name = norm(contact.name);
  const email = norm(contact.email?.split(";")[0]);
  const company = norm(contact.company);
  if (!name && !email && !company) return [];
  return activities.filter((a) => {
    if (name && norm(a.person) === name) return true;
    // Person named in the task title/notes (full name or email — specific enough).
    const hay = `${a.name} ${a.notes || ""} ${a.person || ""}`.toLowerCase();
    if (name && name.length > 3 && hay.includes(name)) return true;
    if (email && hay.includes(email)) return true;
    // Contact works at a company the activity is tagged to (exact, per-name).
    if (company && taggedCompanies(a).includes(company)) return true;
    return false;
  });
}

// An activity belongs to a company/PortCo when its company field matches, or the
// task text mentions the company name.
export function matchActivitiesToCompany(activities: AsanaActivity[], companyName: string): AsanaActivity[] {
  const co = norm(companyName);
  if (!co || co.length < 2) return [];
  return activities.filter((a) => taggedCompanies(a).includes(co));
}
