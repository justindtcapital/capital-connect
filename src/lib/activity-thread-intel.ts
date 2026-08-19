// Shared BD/GTM thread intelligence for Gmail messages and Asana tasks with
// pasted email/calendar text. Pure — safe to unit-test.
//
// Hybrid policy (Asana): Type/Status/People from the thread when chrome is
// detected; Person/Company keep curated values when already set.

import {
  isNameOnlyAttendeeEmail,
  parseAddressOrDisplayList,
  type EmailAddress,
} from "./email-address";
import { isCalendarAppointmentMessage } from "./email-activity";
import { extractForwardedHeaders, nameMatchesInternal } from "./email-forward";
import { parseDtcMeetingSubject } from "./meeting-subject";
import {
  isInternalEmail,
  isNoiseEmail,
  pickPrimaryCounterparty,
  type Counterparty,
  type InternalConfig,
} from "./email-noise";

export const ACTIVITY_NOTES_BUDGET = 1000;

export interface ThreadIntelInput {
  subject: string;
  body: string;
  snippet?: string;
  /** Seed counterparties from MIME headers (Gmail) or prior People line. */
  seedPeople?: Array<{ name: string; email: string; role?: Counterparty["role"] }>;
  /** Curated Asana (or prior) Person — kept when non-empty. */
  existingPerson?: string;
  /** Curated company — kept when non-empty. */
  existingCompany?: string;
  existingType?: string;
  existingStatus?: string;
  /**
   * When set, used as the initial outbound guess (Gmail: From is internal/alias).
   * When omitted, inferred from body From / seed people.
   */
  outboundHint?: boolean;
}

export interface ThreadIntelResult {
  /** True when subject/body look like email or calendar chrome worth enriching. */
  detected: boolean;
  isMeeting: boolean;
  outbound: boolean;
  type?: string;
  status?: string;
  person?: string;
  company?: string;
  people: Counterparty[];
  primary?: Counterparty;
  headLine: string;
  peopleLine: string;
  channelLine: string;
  subjectHints: { company?: string; externalName?: string; ownerHint?: string };
}

/** True when text looks like a pasted email thread or calendar invite. */
export function looksLikeThreadChrome(subject: string, body: string, snippet?: string): boolean {
  if (
    isCalendarAppointmentMessage({ subject, body, snippet })
  ) {
    return true;
  }
  const blob = `${subject}\n${snippet || ""}\n${(body || "").slice(0, 4000)}`;
  if (extractForwardedHeaders(body)) return true;
  if (/^\s*people\s*:/im.test(body || "")) return true;
  if (/\b(from|to|cc)\s*:\s*\S+/i.test(blob) && /@/.test(blob)) return true;
  if (
    /-----Original (Message|Appointment)-----/i.test(blob) ||
    /Forwarded message/i.test(blob) ||
    /Begin forwarded message/i.test(blob)
  ) {
    return true;
  }
  // Named mailbox pairs are enough to treat Asana pastes as threads.
  if (/[A-Za-z][\w.,'\- ]{1,60}\s*<\s*[^<>]+@[^<>]+>/i.test(blob)) return true;
  return false;
}

function normPersonName(name: string): string {
  let s = (name || "").toLowerCase().trim();
  const comma = s.match(/^([^,]+),\s*(.+)$/);
  if (comma) s = `${comma[2]} ${comma[1]}`;
  return s.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function titleCaseLocal(local: string): string {
  return local
    .replace(/^name:/, "")
    .replace(/[._+]+/g, " ")
    .replace(/\d+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ")
    .slice(0, 80);
}

function companyFromEmail(email: string): string {
  if (isNameOnlyAttendeeEmail(email)) return "";
  const domain = (email.split("@")[1] || "").toLowerCase();
  if (!domain || domain === "attendee.local") return "";
  const sld = domain.split(".")[0] || "";
  if (!sld) return "";
  return sld.charAt(0).toUpperCase() + sld.slice(1);
}

/**
 * Collect counterparties from seed headers + forwarded/appointment body blocks
 * + loose Display Name <email> scans. Applies DTC subject name hints for meetings.
 */
export function collectThreadCounterparties(
  input: ThreadIntelInput,
  aliases: Set<string>,
  internal: InternalConfig,
  isMeeting: boolean,
): Counterparty[] {
  const out = new Map<string, Counterparty>();
  const byName = new Map<string, string>();

  const consider = (name: string, email: string, role: Counterparty["role"]) => {
    const e = (email || "").trim().toLowerCase();
    if (!e || aliases.has(e) || out.has(e) || isNoiseEmail(e)) return;
    const display = name.trim() || titleCaseLocal(e.split("@")[0] || "");
    const nn = normPersonName(display);
    if (nn && byName.has(nn)) {
      const prev = byName.get(nn)!;
      if (isNameOnlyAttendeeEmail(e) && !isNameOnlyAttendeeEmail(prev)) return;
    }
    const flaggedInternal =
      isInternalEmail(e, internal) ||
      (isNameOnlyAttendeeEmail(e) && nameMatchesInternal(display, internal));
    out.set(e, {
      name: display,
      email: e,
      role,
      internal: flaggedInternal,
    });
    if (nn) byName.set(nn, e);
  };

  for (const p of input.seedPeople || []) {
    consider(p.name, p.email, p.role || "to");
  }

  const hasExternal = [...out.values()].some((p) => !p.internal);
  if (!hasExternal || isMeeting) {
    const fwd = extractForwardedHeaders(input.body, internal);
    if (fwd) {
      // Role "forwarded" so MIME outboundHint still self-corrects via original From.
      const add = (a?: EmailAddress) => {
        if (a) consider(a.name, a.email, "forwarded");
      };
      add(fwd.from);
      for (const a of fwd.to) add(a);
      for (const a of fwd.cc) add(a);
    }
  }

  // Loose scan for "Name <email>" not already captured (Asana pastes without banners).
  const hay = `${input.subject}\n${input.body || ""}`;
  const named = /([A-Za-z][\w.,'\- ]{1,70}?)\s*<\s*([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = named.exec(hay))) {
    consider(m[1], m[2], "forwarded");
  }

  // DTC subject: Flexor (Or) - DTC (Chris F)
  const subjectHints = isMeeting ? parseDtcMeetingSubject(input.subject) : {};
  if (isMeeting && subjectHints.externalName) {
    const hasExternalPerson = [...out.values()].some((p) => !p.internal);
    if (!hasExternalPerson) {
      const slug = subjectHints.externalName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ".")
        .replace(/^\.+|\.+$/g, "")
        .slice(0, 80);
      if (slug.length >= 2) {
        consider(subjectHints.externalName, `name:${slug}@attendee.local`, "to");
      }
    }
  }

  return [...out.values()];
}

function inferOutbound(
  input: ThreadIntelInput,
  people: Counterparty[],
  aliases: Set<string>,
  internal: InternalConfig,
): boolean {
  if (typeof input.outboundHint === "boolean") {
    // MIME-seeded externals keep the hint; body-only recovery uses quoted From
    // (self-forward of inbound → Received even when the forwarder is internal).
    const mimeExternal = (input.seedPeople || []).some((p) => {
      const e = (p.email || "").toLowerCase();
      return (
        !!e &&
        !aliases.has(e) &&
        !isNoiseEmail(e) &&
        !isInternalEmail(e, internal) &&
        !isNameOnlyAttendeeEmail(e)
      );
    });
    if (mimeExternal) return input.outboundHint;
    const fwd = extractForwardedHeaders(input.body, internal);
    if (fwd?.from) return Boolean(fwd.fromIsInternal);
    return input.outboundHint;
  }

  const fwd = extractForwardedHeaders(input.body, internal);
  if (fwd?.from) return Boolean(fwd.fromIsInternal);

  // Seed "from" role if present.
  const fromSeed = (input.seedPeople || []).find((p) => p.role === "from");
  if (fromSeed?.email) {
    const e = fromSeed.email.toLowerCase();
    return aliases.has(e) || isInternalEmail(e, internal);
  }

  // Body From: line via parseAddressOrDisplayList on first From.
  const fromLine = (input.body || "").match(/^\s*>?\s*from\s*:\s*(.+)$/im);
  if (fromLine) {
    const addrs = parseAddressOrDisplayList(fromLine[1]);
    if (addrs[0]) {
      const e = addrs[0].email.toLowerCase();
      return (
        aliases.has(e) ||
        isInternalEmail(e, internal) ||
        (isNameOnlyAttendeeEmail(e) && nameMatchesInternal(addrs[0].name, internal))
      );
    }
  }

  // Default outbound when any internal is on the thread (BD paste of our send).
  if (people.some((p) => p.internal)) return true;
  return false;
}

/**
 * Enrich a subject+body (Gmail or Asana paste) into BD/GTM activity fields.
 */
export function enrichActivityFromThreadText(
  input: ThreadIntelInput,
  aliases: Set<string>,
  internal: InternalConfig,
): ThreadIntelResult {
  const chrome = looksLikeThreadChrome(input.subject, input.body, input.snippet);
  // Gmail MIME seeds count even when the body has no forward/calendar chrome.
  const hasSeed = (input.seedPeople || []).some((p) => {
    const e = (p.email || "").toLowerCase();
    return !!e && !aliases.has(e) && !isNoiseEmail(e);
  });
  const detected = chrome || hasSeed;
  const isMeeting = isCalendarAppointmentMessage({
    subject: input.subject,
    body: input.body,
    snippet: input.snippet,
  });
  const subjectHints = isMeeting ? parseDtcMeetingSubject(input.subject) : {};

  const people = detected
    ? collectThreadCounterparties(input, aliases, internal, isMeeting)
    : [];
  const outbound = detected
    ? inferOutbound(input, people, aliases, internal)
    : false;
  const primary = pickPrimaryCounterparty(people, outbound);

  const peopleOrdered = primary
    ? [primary, ...people.filter((p) => p.email !== primary.email)]
    : people;
  const peopleLine =
    peopleOrdered.length > 0
      ? `People: ${peopleOrdered.map((p) => `${p.name} <${p.email}>`).join("; ")}`
      : "";

  const headLine = !detected
    ? ""
    : isMeeting
      ? outbound
        ? "Outbound meeting"
        : "Meeting"
      : outbound
        ? "Outbound email"
        : "Inbound email";

  const channelLine = detected && isMeeting ? "Channel: calendar" : "";

  // Hybrid: curated Person/Company win when set.
  const existingPerson = (input.existingPerson || "").trim();
  const existingCompany = (input.existingCompany || "").trim();
  const person =
    existingPerson ||
    primary?.name ||
    subjectHints.externalName ||
    undefined;
  let company = existingCompany || subjectHints.company || undefined;
  if (!company && primary) {
    const fromDomain = companyFromEmail(primary.email);
    if (fromDomain) company = fromDomain;
  }

  const existingType = (input.existingType || "").trim();
  const existingStatus = (input.existingStatus || "").trim();

  let type = existingType || undefined;
  let status = existingStatus || undefined;
  if (detected) {
    // Thread wins for Type when chrome detected (Meeting vs Email).
    type = isMeeting ? "Meeting" : existingType || "Email";
    // Direction status when we can infer; keep curated otherwise if not Sent/Received-shaped.
    if (!existingStatus || /^(sent|received|completed)$/i.test(existingStatus)) {
      status = outbound ? "Sent" : "Received";
    }
  }

  return {
    detected,
    isMeeting,
    outbound,
    type,
    status,
    person,
    company,
    people: peopleOrdered,
    primary,
    headLine,
    peopleLine,
    channelLine,
    subjectHints,
  };
}

/**
 * Build notes with People line protected inside a fixed budget (Gmail/Asana).
 */
export function formatActivityNotes(opts: {
  headLine?: string;
  peopleLine?: string;
  channelLine?: string;
  auditLine?: string;
  bodyExcerpt?: string;
  budget?: number;
}): string {
  const budget = opts.budget ?? ACTIVITY_NOTES_BUDGET;
  const fixed = [opts.headLine, opts.peopleLine, opts.channelLine, opts.auditLine]
    .filter(Boolean)
    .join("\n");
  const remaining = budget - fixed.length - 1;
  const excerpt = (opts.bodyExcerpt || "").trim();
  if (remaining > 40 && excerpt) return `${fixed}\n${excerpt.slice(0, remaining)}`;
  return fixed;
}
