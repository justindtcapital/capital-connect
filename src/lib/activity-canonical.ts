// Canonicalize BD/GTM activities against the CRM before they are displayed or
// written to sheets.
//
// Two problems this fixes:
//   * Person was whatever the mail headers happened to say ("Falloon, Chris"),
//     even when the address exactly matches a Contact whose canonical name is
//     "Chris Falloon" — the sheet and the contact page then disagreed.
//   * Company was title-cased from the sender's email domain, so a thread about
//     MaxIQ's Dell pursuit was filed under "Dell" because a Dell teammate sent it.
//
// Company precedence: portfolio/target name found in subject+notes → CRM company
// of the matched counterparty → counterparty email domain (last resort).

import type { AsanaActivity, Contact } from "./types";
import { isNameOnlyAttendeeEmail, sanitizeEmailToken } from "./email-address";
import { resolvePortcosMentioned } from "./activity-match";

const norm = (s?: string) => (s || "").trim().toLowerCase();

/** One human parsed from a BD/GTM activity (People line or body scan). */
export interface ActivityPersonRef {
  name: string;
  email: string;
}

/** Emails listed on the machine-readable "People:" line of a synced note. */
export function peopleEmailsFromNotes(notes?: string): string[] {
  return peopleEntriesFromNotes(notes).map((p) => p.email);
}

/**
 * Name + email pairs from the "People:" line.
 * Skips name-only calendar placeholders (`name:…@attendee.local`).
 */
export function peopleEntriesFromNotes(notes?: string): ActivityPersonRef[] {
  const line = (notes || "")
    .split("\n")
    .find((l) => /^people\s*:/i.test(l.trim()));
  if (!line) return [];
  const rest = line.replace(/^\s*people\s*:/i, "");
  const out: ActivityPersonRef[] = [];
  const seen = new Set<string>();
  const named = /([^;<]+?)\s*<\s*([^<>]+@[^<>]+)\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = named.exec(rest))) {
    const email = sanitizeEmailToken(m[2]);
    if (!email || seen.has(email) || isNameOnlyAttendeeEmail(email)) continue;
    seen.add(email);
    const name = cleanPersonName(m[1]);
    out.push({
      name: isUsablePersonName(name, email) ? name : nameFromEmailLocal(email),
      email,
    });
  }
  // Bare addresses with no display name.
  for (const bare of rest.match(/[^\s<>;,]+@[^\s<>;,]+/g) || []) {
    const email = sanitizeEmailToken(bare);
    if (!email || seen.has(email) || isNameOnlyAttendeeEmail(email)) continue;
    seen.add(email);
    out.push({ name: nameFromEmailLocal(email), email });
  }
  return out;
}

/**
 * People to consider for contact create / join: prefer the People line, else
 * scan subject+notes for mailbox addresses (Asana threads).
 */
export function peopleEntriesFromActivity(a: {
  name?: string;
  notes?: string;
  person?: string;
}): ActivityPersonRef[] {
  const fromLine = peopleEntriesFromNotes(a.notes);
  if (fromLine.length > 0) return fromLine;

  const hay = `${a.name || ""}\n${a.notes || ""}`;
  const out: ActivityPersonRef[] = [];
  const seen = new Set<string>();
  const named = /([A-Za-z][\w.,'\- ]{1,70}?)\s*[<(]\s*([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\s*[>)]/gi;
  let m: RegExpExecArray | null;
  while ((m = named.exec(hay))) {
    const email = sanitizeEmailToken(m[2]);
    if (!email || seen.has(email) || isNameOnlyAttendeeEmail(email)) continue;
    seen.add(email);
    const name = cleanPersonName(m[1]);
    out.push({ name: isUsablePersonName(name, email) ? name : nameFromEmailLocal(email), email });
  }
  for (const bare of hay.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []) {
    const email = sanitizeEmailToken(bare);
    if (!email || seen.has(email) || isNameOnlyAttendeeEmail(email)) continue;
    seen.add(email);
    out.push({ name: nameFromEmailLocal(email), email });
  }
  // Last resort: Person field + no email on the row (can't create a contact).
  void a.person;
  return out;
}

function cleanPersonName(raw: string): string {
  let s = (raw || "")
    .trim()
    .replace(/["']/g, "")
    .replace(/^[\s(]+|[)\s]+$/g, "")
    .replace(/\s+/g, " ");
  const parts = s.split(",");
  if (parts.length === 2 && parts[0].trim() && parts[1].trim() && !/\d/.test(s)) {
    s = `${parts[1].trim()} ${parts[0].trim()}`;
  }
  return s
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .slice(0, 80);
}

/** Reject parse debris like `(prabhat` or a name that is just the email local-part junk. */
function isUsablePersonName(name: string, email: string): boolean {
  const n = (name || "").trim();
  if (!n || n.length < 2) return false;
  if (/[<>@]/.test(n)) return false;
  if (/^[(\[{]/.test(n)) return false;
  const local = (email.split("@")[0] || "").toLowerCase();
  if (n.toLowerCase() === `(${local}` || n.toLowerCase() === local) return false;
  return true;
}

function nameFromEmailLocal(email: string): string {
  const local = (email.split("@")[0] || "").replace(/\d+/g, "").replace(/[._+-]+/g, " ").trim();
  if (!local) return email;
  return local
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ")
    .slice(0, 80);
}

/**
 * Expand a short person token (e.g. subject "Flexor (Or)") to a CRM contact name
 * when exactly one contact at a mentioned company matches that first/given name.
 */
export function expandPersonViaCompany(
  person: string | undefined,
  company: string | undefined,
  contacts: Contact[],
): string | undefined {
  const hint = (person || "").trim();
  if (!hint || !company?.trim()) return person;
  // Already a multi-word name — leave unless it exactly matches nothing useful.
  const companies = company
    .split(/\s*\/\s*/)
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  if (companies.length === 0) return person;
  const needle = hint.toLowerCase();
  const hits = contacts.filter((c) => {
    const cc = (c.company || "").trim().toLowerCase();
    if (!cc || !companies.some((co) => cc === co || cc.includes(co) || co.includes(cc))) {
      return false;
    }
    const cn = (c.name || "").trim().toLowerCase();
    if (!cn) return false;
    if (cn === needle) return true;
    const parts = cn.split(/\s+/);
    return parts[0] === needle || parts.some((p) => p === needle);
  });
  if (hits.length === 1) return hits[0].name?.trim() || person;
  return person;
}

/** Index contacts by every address they carry, for exact-email lookups. */
export function contactsByEmail(contacts: Contact[]): Map<string, Contact> {
  const map = new Map<string, Contact>();
  for (const c of contacts) {
    for (const raw of (c.email || "").split(";")) {
      const e = norm(raw);
      if (e && !map.has(e)) map.set(e, c);
    }
  }
  return map;
}

/**
 * Replace Person/Company on Gmail-sourced activities with CRM-canonical values.
 * Asana rows keep their custom-field values (they are already curated).
 */
export function canonicalizeActivities(
  activities: AsanaActivity[],
  contacts: Contact[],
  portfolioNames: string[] = [],
): AsanaActivity[] {
  const byEmail = contactsByEmail(contacts);
  return activities.map((a) => {
    if (!a.gid.startsWith("gmail-")) return a;
    const emails = peopleEmailsFromNotes(a.notes);
    const match = emails.map((e) => byEmail.get(e)).find(Boolean);

    const mentioned = resolvePortcosMentioned(a, portfolioNames);
    // Keep EVERY matched PortCo on the company field (slash-separated) so BD/GTM
    // rows and PortCo Introduced tags carry multi-company meetings, not just the first.
    const company =
      (mentioned.length > 0 ? mentioned.join(" / ") : "") ||
      match?.company?.trim() ||
      a.company ||
      undefined;

    let person = match?.name?.trim() || a.person;
    // Calendar subjects often only carry a short external name ("Or"); expand
    // against CRM when company/PortCo is already known.
    if (!match) {
      person = expandPersonViaCompany(person, company, contacts) || person;
    }

    if (person === a.person && company === a.company) return a;
    return { ...a, person, company };
  });
}

// ── K: user corrections ──────────────────────────────────────────
// A human said "this touch is on the wrong person/company". Corrections live in
// the Attribution Feedback tab and are replayed over every canonicalization, so
// one fix sticks across syncs instead of being overwritten on the next run.

export interface AttributionCorrection {
  /** Activity gid (gmail-<id>) — exact target. */
  gid?: string;
  /** Gmail thread id — covers later replies in the same conversation. */
  threadId?: string;
  person?: string;
  company?: string;
}

/** Thread id recorded on the audit line of a synced Gmail note. */
export function threadIdFromNotes(notes?: string): string {
  const m = (notes || "").match(/thread\s+([A-Za-z0-9_-]+)/);
  return m ? m[1] : "";
}

export function applyAttributionCorrections(
  activities: AsanaActivity[],
  corrections: AttributionCorrection[],
): AsanaActivity[] {
  if (corrections.length === 0) return activities;
  const byGid = new Map<string, AttributionCorrection>();
  const byThread = new Map<string, AttributionCorrection>();
  for (const c of corrections) {
    if (c.gid) byGid.set(c.gid, c);
    if (c.threadId) byThread.set(c.threadId, c);
  }
  return activities.map((a) => {
    const fix = byGid.get(a.gid) || byThread.get(threadIdFromNotes(a.notes));
    if (!fix) return a;
    return {
      ...a,
      person: fix.person?.trim() || a.person,
      company: fix.company?.trim() || a.company,
    };
  });
}

// ── I: ambiguity detection (input for the Gemini fallback) ───────

export interface AttributionCandidate {
  name: string;
  email: string;
}

export interface AmbiguousActivity {
  gid: string;
  subject: string;
  notes: string;
  candidates: AttributionCandidate[];
  /**
   * What Gemini has to decide. "person" = the counterparty is already resolved
   * from the CRM but no portfolio company is tagged; "both" = neither is known.
   */
  needs: "company" | "both";
  /** Person already resolved deterministically (when needs === "company"). */
  knownPerson?: string;
}


/** Names + emails from the machine-readable "People:" line of a synced note. */
export function peopleFromNotes(notes?: string): AttributionCandidate[] {
  const line = (notes || "").split("\n").find((l) => /^people\s*:/i.test(l.trim()));
  if (!line) return [];
  return line
    .replace(/^\s*people\s*:/i, "")
    .split(";")
    .map((chunk) => {
      const m = chunk.match(/^\s*(.*?)\s*<([^<>]+)>\s*$/);
      if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
      const bare = chunk.match(/([^\s<>]+@[^\s<>]+)/);
      return bare ? { name: "", email: bare[1].toLowerCase() } : { name: "", email: "" };
    })
    .filter((p) => p.email);
}

/**
 * Gmail activities Gemini should look at:
 *   - "both": no exact CRM email match AND (several plausible counterparties OR
 *     no company resolved from content).
 *   - "company": the counterparty IS known from the CRM, but no portfolio
 *     company is tagged — Gemini gets a shot at inferring the portco.
 * Everything fully resolved deterministically is never sent to the LLM.
 */
export function findAmbiguousActivities(
  activities: AsanaActivity[],
  contacts: Contact[],
  portfolioNames: string[] = [],
): AmbiguousActivity[] {
  const byEmail = contactsByEmail(contacts);
  const out: AmbiguousActivity[] = [];
  for (const a of activities) {
    if (!a.gid.startsWith("gmail-")) continue;
    const candidates = peopleFromNotes(a.notes);
    const crmHit = candidates.find((p) => byEmail.has(p.email));
    const mentioned = resolvePortcosMentioned(a, portfolioNames);
    const base = {
      gid: a.gid,
      subject: a.name || "",
      notes: (a.notes || "").slice(0, 700),
      candidates,
    };
    if (crmHit) {
      // CRM decided the person. Only the untagged portco is still open.
      if (mentioned.length === 0 && !norm(a.company)) {
        const known = byEmail.get(crmHit.email);
        out.push({
          ...base,
          needs: "company",
          knownPerson: crmHit.name || known?.name || a.person || "",
        });
      }
      continue;
    }
    const uncertain = candidates.length > 1 || mentioned.length === 0;
    if (!uncertain || candidates.length === 0) continue;
    out.push({ ...base, needs: "both" });
  }
  return out;
}



/** Subject key for cross-source duplicate detection (RE:/FW: and noise stripped). */
export function normalizeSubjectKey(subject: string): string {
  return (subject || "")
    .replace(/^\s*(?:(?:re|fw|fwd|tr|aw)\s*:\s*)+/gi, "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

/**
 * Per-contact subject twin key: email|normalizedSubject.
 * Used so a Gmail Note is not logged when Asana already has the same touch.
 */
export function subjectTwinKey(email: string, subject: string): string {
  const e = (email || "").trim().toLowerCase();
  const k = normalizeSubjectKey(subject);
  if (!e || k.length < 6) return "";
  return `${e}|${k}`;
}

function dayNumber(date?: string): number | null {
  if (!date) return null;
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(t) ? Math.round(t / 86_400_000) : null;
}

/**
 * Drop Gmail activities that duplicate an Asana task: nearly every tracked
 * thread is also sent to an x+…@mail.asana.com intake address, so the same touch
 * arrives twice. Rule (documented, one-way): the ASANA record wins — it carries
 * richer custom fields — and the Gmail twin is discarded when the normalized
 * subject matches within `windowDays` on the same track.
 */
export function dedupeAcrossSources(
  activities: AsanaActivity[],
  windowDays = 3,
): { activities: AsanaActivity[]; dropped: number } {
  const asanaKeys: { key: string; day: number | null; track: string }[] = [];
  for (const a of activities) {
    if (a.gid.startsWith("gmail-")) continue;
    const key = normalizeSubjectKey(a.name);
    if (key.length < 6) continue;
    asanaKeys.push({ key, day: dayNumber(a.date), track: a.track });
  }
  if (asanaKeys.length === 0) return { activities, dropped: 0 };

  let dropped = 0;
  const kept = activities.filter((a) => {
    if (!a.gid.startsWith("gmail-")) return true;
    const key = normalizeSubjectKey(a.name);
    if (key.length < 6) return true;
    const day = dayNumber(a.date);
    const twin = asanaKeys.some(
      (k) =>
        k.key === key &&
        k.track === a.track &&
        (k.day === null || day === null || Math.abs(k.day - day) <= windowDays),
    );
    if (twin) dropped++;
    return !twin;
  });
  return { activities: kept, dropped };
}
