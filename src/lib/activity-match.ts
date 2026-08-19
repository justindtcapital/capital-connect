// Heuristic matching of Asana BD/GTM activities to CRM records. Activities carry
// free-text company/person strings (parsed from Asana custom fields or the task
// name), so matching is name/email-substring based rather than keyed.

import type { AsanaActivity, Contact } from "@/lib/types";

const norm = (s?: string) => (s || "").trim().toLowerCase();

// Whole-address tokens only — substring matching let jo@x.com match inside
// jjo@x.com. Regex tokens are maximal, so a longer address can never be
// "contained" by a shorter contact email.
const EMAIL_TOKEN_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Exact counterparty emails a Gmail activity carries (People line + personEmail). */
export function gmailActivityEmails(a: AsanaActivity): Set<string> {
  const out = new Set<string>();
  const peopleLine =
    (a.notes || "").split("\n").find((l) => l.trimStart().startsWith("People:")) || "";
  for (const tok of peopleLine.match(EMAIL_TOKEN_RE) || []) out.add(tok.toLowerCase());
  if (a.personEmail) out.add(a.personEmail.trim().toLowerCase());
  return out;
}

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
    const gmailSourced = a.gid.startsWith("gmail-");
    const hay = `${a.name} ${a.notes || ""} ${a.person || ""} ${a.url || ""}`.toLowerCase();

    // Gmail BD/GTM rows always carry exact counterparty emails in notes. Match by
    // email only — fuzzy name substring was attaching noise to wrong Contacts
    // (e.g. short names / shared first names in subject lines). Token-exact
    // against the People line, never substring over the whole notes blob.
    if (gmailSourced) {
      const people = gmailActivityEmails(a);
      return emails.some((e) => e && people.has(e));
    }

    if (name && norm(a.person) === name) return true;
    // Person named in the task title/notes (full name or email — specific enough).
    if (name && name.length > 3 && hay.includes(name)) return true;
    if (emails.some((e) => e && hay.includes(e))) return true;
    // Contact works at a company the activity is tagged to (exact, per-name).
    // Never company-fan-out for Gmail (handled above); Asana GTM often only tags company.
    if (company && taggedCompanies(a).includes(company)) return true;
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `key` appears in `hay` as its own token — not as a prefix/substring
 * of a longer word. Prevents portfolio "Mave" matching subject "Maven".
 */
export function portcoNameMentioned(hay: string, key: string): boolean {
  const k = norm(key);
  if (!k || k.length < 3) return false;
  // Allow soft boundaries: start/end, whitespace, or punctuation (/, -, :, etc.).
  const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(k)}(?=[^a-z0-9]|$)`, "i");
  return re.test(hay || "");
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
    // Exact tag on the company field, or token-boundary mention in text.
    const hit = tagged.has(p.key) || portcoNameMentioned(hay, p.key);
    if (!hit) continue;
    found.push(p.raw);
    claimed.add(p.key);
    // Also claim shorter PortCo keys that are prefixes of this match so a
    // tagged "Maven" row never also picks up a stray "Mave" portfolio entry.
    for (const other of sorted) {
      if (other.key !== p.key && p.key.startsWith(other.key)) claimed.add(other.key);
    }
  }
  return found;
}

/** Subject collapsed to a comparison key: reply/forward prefixes stripped
 *  (repeatedly — "RE: FW: x"), punctuation and case folded away. */
export function normalizeSubjectKey(subject: string): string {
  let t = (subject || "").trim().toLowerCase();
  for (;;) {
    const next = t.replace(/^(re|fw|fwd|aw|wg)\s*:\s*/i, "");
    if (next === t) break;
    t = next;
  }
  return t
    .replace(/[^a-z0-9@&\s.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CROSS_SOURCE_WINDOW_DAYS = 3;

/**
 * Drop Gmail activities that are cross-source twins of an Asana task — most
 * tracked threads also go to an x+…@mail.asana.com intake address, so the same
 * touch arrives from both sources with different gids.
 *
 * Rule: the ASANA record wins (it carries richer custom fields); the Gmail
 * activity is dropped when an Asana task has the same normalized subject
 * within ±3 days (or an undated match on either side).
 */
export function dropCrossSourceDupes(
  asana: AsanaActivity[],
  gmail: AsanaActivity[],
): AsanaActivity[] {
  if (asana.length === 0 || gmail.length === 0) return gmail;
  const asanaDatesByKey = new Map<string, string[]>();
  for (const a of asana) {
    const key = normalizeSubjectKey(a.name);
    if (!key) continue;
    const dates = asanaDatesByKey.get(key);
    if (dates) dates.push(a.date || "");
    else asanaDatesByKey.set(key, [a.date || ""]);
  }
  const windowMs = CROSS_SOURCE_WINDOW_DAYS * 86_400_000;
  return gmail.filter((g) => {
    const key = normalizeSubjectKey(g.name);
    if (!key) return true;
    const dates = asanaDatesByKey.get(key);
    if (!dates) return true;
    const gd = g.date ? Date.parse(g.date) : Number.NaN;
    const isTwin = dates.some((d) => {
      const ad = d ? Date.parse(d) : Number.NaN;
      if (!Number.isFinite(ad) || !Number.isFinite(gd)) return true; // undated same-subject → twin
      return Math.abs(ad - gd) <= windowMs;
    });
    return !isTwin;
  });
}

/** Contacts indexed by every email they carry (semicolon-separated), lowercased. */
export function contactsByEmail(contacts: Contact[]): Map<string, Contact> {
  const map = new Map<string, Contact>();
  for (const c of contacts) {
    for (const raw of (c.email || "").split(";")) {
      const key = raw.trim().toLowerCase();
      if (key && !map.has(key)) map.set(key, c);
    }
  }
  return map;
}

/**
 * Canonicalize Gmail activities against the CRM before any sheet write, so the
 * BD/GTM tabs and contact pages always show the same spelling of a person.
 *
 * Person: the CRM contact's exact name when personEmail matches a contact;
 * else the header display name already on the activity.
 * Company precedence: (1) portfolio company mentioned in subject/notes,
 * (2) the matched contact's CRM company, (3) the email-domain guess the
 * activity arrived with. Never the forwarder's domain — the builder already
 * derives the guess from the external counterparty.
 */
export function canonicalizeGmailActivities(
  gmail: AsanaActivity[],
  contacts: Contact[],
  portfolioNames: string[],
): AsanaActivity[] {
  const byEmail = contactsByEmail(contacts);
  return gmail.map((a) => {
    if (!a.gid.startsWith("gmail-")) return a;
    const contact = a.personEmail ? byEmail.get(a.personEmail.trim().toLowerCase()) : undefined;
    const portco = resolvePortcosMentioned(a, portfolioNames)[0] || "";
    const person = contact?.name?.trim() || a.person;
    const company = portco || contact?.company?.trim() || a.company;
    if (person === a.person && company === a.company) return a;
    return { ...a, person, company };
  });
}
