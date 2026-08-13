// Build BD/GTM activities from alias-tracked Gmail threads.
// Pure — safe to unit-test without Gmail; gmail.server.ts wires in env config.
//
// One activity per THREAD (not per message): reply chains used to produce one
// row each, so a four-message thread inflated activity counts fourfold. The
// thread's counterparties are unioned across its messages; date/subject/
// direction come from the newest human message.

import { isNoiseEmail, pickPrimaryCounterparty, type Counterparty } from "./email-noise";
import {
  extractForwardedBlock,
  isInternalEmail,
  EMPTY_INTERNAL_CONFIG,
  type EmailAddr,
  type InternalMailConfig,
} from "./email-participants";
import type { AsanaActivity } from "./types";

/** The slice of a Gmail message the activity builder needs. */
export interface ActivityMessage {
  id: string;
  threadId: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  /** Parsed To/Cc recipients WITH display names (RFC 5322 parse, not comma split). */
  toAddrs: EmailAddr[];
  ccAddrs: EmailAddr[];
  /** Received time, epoch ms. */
  date: number;
  /** YYYY-MM-DD. */
  dateLabel: string;
  snippet: string;
  body: string;
  permalink: string;
  isBulk?: boolean;
}

const FREE_EMAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "msn.com",
]);

export function isFreeEmailDomain(domain: string): boolean {
  return FREE_EMAIL.has((domain || "").toLowerCase());
}

/** Last-resort company guess from the counterparty's email domain — the
 *  canonicalization pass (portco mention > CRM company) overrides this. */
export function companyFromEmail(email: string): string {
  const domain = (email.split("@")[1] || "").toLowerCase();
  if (!domain || FREE_EMAIL.has(domain)) return "";
  const sld = domain.split(".")[0] || "";
  if (!sld) return "";
  return sld.charAt(0).toUpperCase() + sld.slice(1);
}

function titleCaseLocal(local: string): string {
  return local
    .replace(/[._+]+/g, " ")
    .replace(/\d+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ")
    .slice(0, 80);
}

// Counterparties = people on the message who are NOT the tracking aliases and
// not newsletter/system mailboxes. Internal teammates stay in the list (they
// matter for Owner and the People line) but are flagged so the picker only
// falls back to them when no external human exists.
function messageCounterparties(
  m: ActivityMessage,
  aliases: Set<string>,
  internal: InternalMailConfig,
): Counterparty[] {
  const out = new Map<string, Counterparty>();
  const consider = (name: string, email: string, role: Counterparty["role"]) => {
    const e = (email || "").trim().toLowerCase();
    if (!e || aliases.has(e) || isNoiseEmail(e)) return;
    const existing = out.get(e);
    if (existing) {
      if (!existing.name && name) existing.name = name;
      return;
    }
    out.set(e, {
      name: name || titleCaseLocal(e.split("@")[0] || ""),
      email: e,
      role,
      internal: isInternalEmail(e, internal),
    });
  };
  consider(m.fromName, m.fromEmail, "from");
  for (const a of m.toAddrs) consider(a.name, a.email, "to");
  for (const a of m.ccAddrs) consider(a.name, a.email, "cc");
  return [...out.values()];
}

// Participants recovered from a forwarded message's quoted header block,
// noise/alias-filtered and internal-flagged.
function forwardedCounterparties(
  body: string,
  aliases: Set<string>,
  internal: InternalMailConfig,
): { people: Counterparty[]; fromIsInternal: boolean } | null {
  const block = extractForwardedBlock(body);
  if (!block) return null;
  const people: Counterparty[] = [];
  const seen = new Set<string>();
  const add = (a: EmailAddr, role: Counterparty["role"]) => {
    const e = a.email;
    if (!e || aliases.has(e) || isNoiseEmail(e) || seen.has(e)) return;
    seen.add(e);
    people.push({
      name: a.name || titleCaseLocal(e.split("@")[0] || ""),
      email: e,
      role,
      internal: isInternalEmail(e, internal),
    });
  };
  for (const a of block.from) add(a, "from");
  for (const a of block.to) add(a, "to");
  for (const a of block.cc) add(a, "cc");
  if (people.length === 0) return null;
  const fromAddrs = block.from.filter((a) => !aliases.has(a.email));
  const fromIsInternal =
    fromAddrs.length > 0 && fromAddrs.every((a) => isInternalEmail(a.email, internal));
  return { people, fromIsInternal };
}

const NOTES_CAP = 1000;

// People line + audit link are written IN FULL first; only the snippet absorbs
// the length cap. Contact matching joins on emails inside the People line, so
// a giant CC list must never push them past the cap.
function assembleNotes(
  outbound: boolean,
  people: Counterparty[],
  permalink: string,
  snippet: string,
): string {
  const parts = [
    outbound ? "Outbound email" : "Inbound email",
    `People: ${people.map((p) => `${p.name} <${p.email}>`).join("; ")}`,
  ];
  if (permalink) parts.push(`Link: ${permalink}`);
  let base = parts.join("\n");
  if (base.length > NOTES_CAP) base = base.slice(0, NOTES_CAP);
  const snip = (snippet || "").trim();
  const remaining = NOTES_CAP - base.length - 1;
  return snip && remaining > 20 ? `${base}\n${snip.slice(0, remaining)}` : base;
}

/**
 * Convert ONE thread's messages into a single BD/GTM activity, or null when
 * nothing human remains after the noise filters.
 *
 * Direction: outbound = the newest message's From is an internal person or the
 * alias itself (a teammate mailing/CCing the alias while writing to a portco is
 * an outbound touch on the external recipient — the old alias-only definition
 * called that inbound and logged it against the teammate).
 *
 * Owner = the internal human who did the work; Person = who the relationship
 * is with. These are different fields on purpose.
 */
export function threadToActivity(
  msgs: ActivityMessage[],
  track: "BD" | "GTM",
  aliases: Set<string>,
  internal: InternalMailConfig = EMPTY_INTERNAL_CONFIG,
): AsanaActivity | null {
  // Bulk blasts and noise-mailbox sends never form activities (old per-message rule).
  const live = msgs.filter((m) => {
    if (m.isBulk) return false;
    const from = (m.fromEmail || "").toLowerCase();
    return !(from && isNoiseEmail(from) && !aliases.has(from));
  });
  if (live.length === 0) return null;
  live.sort((a, b) => b.date - a.date);
  const newest = live[0];

  const merged = new Map<string, Counterparty>();
  for (const m of live) {
    for (const c of messageCounterparties(m, aliases, internal)) {
      const existing = merged.get(c.email);
      if (existing) {
        if (!existing.name && c.name) existing.name = c.name;
        continue;
      }
      merged.set(c.email, c);
    }
  }
  let others = [...merged.values()];

  const newestFrom = (newest.fromEmail || "").toLowerCase();
  let outbound = aliases.has(newestFrom) || isInternalEmail(newestFrom, internal);

  // Self-forward recovery: headers show only our side ("FW: …" to the alias) —
  // the real counterparty lives in the quoted header block of the body.
  // Conservative: only the first forwarded hop, only when it names an external.
  if (!others.some((p) => !p.internal)) {
    for (const m of live) {
      const fwd = forwardedCounterparties(m.body, aliases, internal);
      if (!fwd || !fwd.people.some((p) => !p.internal)) continue;
      const headerInternals = others.filter(
        (p) => p.internal && !fwd.people.some((f) => f.email === p.email),
      );
      others = [...fwd.people, ...headerInternals];
      // The forwarded hop determines direction: internal original sender = our touch.
      outbound = fwd.fromIsInternal;
      break;
    }
  }

  const primary = pickPrimaryCounterparty(others, outbound);
  if (!primary) return null;

  // Owner: newest internal human on a From line, else any internal participant.
  // Falls back to the old rule (From when non-noise) for setups with no
  // internal config, so behavior degrades gracefully rather than silently.
  const ownerEmail =
    live
      .map((m) => (m.fromEmail || "").trim().toLowerCase())
      .find((e) => e && !aliases.has(e) && isInternalEmail(e, internal)) ||
    others.find((p) => p.internal)?.email ||
    (newestFrom && !aliases.has(newestFrom) && !isNoiseEmail(newestFrom) ? newestFrom : undefined);

  const peopleOrdered = [primary, ...others.filter((p) => p.email !== primary.email)];

  return {
    // threadId equals the first message's id, so single-message threads keep
    // the same gid the per-message sync wrote — sheet dedupe is preserved.
    gid: `gmail-${newest.threadId || newest.id}`,
    track,
    name: newest.subject,
    date: newest.dateLabel || undefined,
    completed: true,
    status: outbound ? "Sent" : "Received",
    owner: ownerEmail,
    type: "Email",
    company: companyFromEmail(primary.email) || undefined,
    person: primary.name || undefined,
    personEmail: primary.email,
    notes: assembleNotes(
      outbound,
      peopleOrdered,
      newest.permalink,
      newest.snippet || newest.body.slice(0, 400),
    ),
    url: newest.permalink,
  };
}

/** Group messages by thread and build one activity per thread. */
export function threadsToActivities(
  msgs: ActivityMessage[],
  track: "BD" | "GTM",
  aliases: Set<string>,
  internal: InternalMailConfig = EMPTY_INTERNAL_CONFIG,
): AsanaActivity[] {
  const byThread = new Map<string, ActivityMessage[]>();
  for (const m of msgs) {
    const key = m.threadId || m.id;
    const group = byThread.get(key);
    if (group) group.push(m);
    else byThread.set(key, [m]);
  }
  const out: AsanaActivity[] = [];
  for (const group of byThread.values()) {
    const act = threadToActivity(group, track, aliases, internal);
    if (act) out.push(act);
  }
  return out;
}
