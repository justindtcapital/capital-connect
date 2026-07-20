// Heuristic matching of Asana BD/GTM activities to CRM records. Activities carry
// free-text company/person strings (parsed from Asana custom fields or the task
// name), so matching is name/email-substring based rather than keyed.

import type { AsanaActivity, Contact } from "@/lib/types";

const norm = (s?: string) => (s || "").trim().toLowerCase();

// The Portfolio Company field can tag several companies ("Maven, Comcast"); split
// it into normalized whole names so matching is exact per-name — never a substring
// (which would wrongly match "Mave" against "Maven").
export function taggedCompanies(a: AsanaActivity): string[] {
  return (a.company || "")
    .split(/[;,/|]/)
    .map((s) => norm(s))
    .filter(Boolean);
}

// An activity belongs to a contact when it names the person (a person field equals
// the contact name, or the task text mentions their full name or email), OR when
// the contact works at the company the activity is tagged to (e.g. GTM tasks carry
// only a Portfolio Company field — those surface on that company's people).
export function matchActivitiesToContact(
  activities: AsanaActivity[],
  contact: Contact,
): AsanaActivity[] {
  const name = norm(contact.name);
  const emails = (contact.email || "")
    .split(";")
    .map((e) => norm(e))
    .filter(Boolean);
  const company = norm(contact.company);
  if (!name && emails.length === 0 && !company) return [];
  return activities.filter((a) => {
    if (name && norm(a.person) === name) return true;
    // Person named in the task title/notes (full name or email — specific enough).
    // Gmail-synced activities embed counterparty emails in notes, so email join works here.
    const hay = `${a.name} ${a.notes || ""} ${a.person || ""} ${a.url || ""}`.toLowerCase();
    if (name && name.length > 3 && hay.includes(name)) return true;
    if (emails.some((e) => e && hay.includes(e))) return true;
    // Contact works at a company the activity is tagged to (exact, per-name).
    // Gmail emails name their exact participants (emails are in notes above), so we
    // never company-fan-out — that would put a 1:1 email onto uninvolved colleagues.
    // The email still surfaces company-wide via matchActivitiesToCompany (PortCo view).
    const gmailSourced = a.gid.startsWith("gmail-");
    if (!gmailSourced && company && taggedCompanies(a).includes(company)) return true;
    return false;
  });
}

// An activity belongs to a company/PortCo when its company field matches, or the
// task text mentions the company name.
export function matchActivitiesToCompany(
  activities: AsanaActivity[],
  companyName: string,
): AsanaActivity[] {
  const co = norm(companyName);
  if (!co || co.length < 2) return [];
  return activities.filter((a) => {
    if (taggedCompanies(a).includes(co)) return true;
    if (co.length < 3) return false;
    const hay = `${a.name} ${a.notes || ""} ${a.company || ""}`.toLowerCase();
    return hay.includes(co);
  });
}

/**
 * Resolve which portfolio companies an activity mentions — from the Asana/Gmail
 * company field and from name/notes text. Returns canonical PortCo display names
 * (preferring the longest match first so "Maven AGI" beats "Maven").
 */
export function resolvePortcosMentioned(a: AsanaActivity, portfolioNames: string[]): string[] {
  if (!portfolioNames.length) return [];
  // Longest first so nested names resolve to the more specific PortCo.
  const sorted = [...portfolioNames]
    .map((n) => ({ raw: n, key: norm(n) }))
    .filter((p) => p.key.length >= 3)
    .sort((x, y) => y.key.length - x.key.length);

  const tagged = new Set(taggedCompanies(a));
  const hay = `${a.name} ${a.notes || ""} ${a.company || ""}`.toLowerCase();
  const found: string[] = [];
  const claimed = new Set<string>();

  for (const p of sorted) {
    if (claimed.has(p.key)) continue;
    const hit = tagged.has(p.key) || hay.includes(p.key);
    if (!hit) continue;
    found.push(p.raw);
    claimed.add(p.key);
  }
  return found;
}
