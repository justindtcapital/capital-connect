// Shared contact-import hygiene. Used by addContactRow (all create paths),
// activity sync auto-source, and the audit script. Pure — safe to unit-test.

import { isNoiseEmail } from "@/lib/email-noise";
import { isPlausibleAddress, sanitizeEmailToken } from "@/lib/email-address";

/**
 * Explicit never-add list (DTC teammates / internal names that must not land
 * on the Network Contacts tab). Matching is order-independent and also checks
 * email local-parts (julia.beech / beech.julia / name:beech.julia@…).
 */
export const BLOCKED_CONTACT_NAMES = [
  "julia beech",
  "chris hillock",
  "chris falloon",
] as const;

/** Lowercased alphabetic tokens from a display name, sorted for order-independence. */
export function blockedNameTokens(name: string): string[] {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .sort();
}

/**
 * True for any iteration of a blocked person: "Julia Beech", "Beech Julia",
 * "Beech, Julia", "JULIA BEECH", etc.
 */
export function isBlockedContactName(name: string): boolean {
  const tokens = blockedNameTokens(name);
  if (tokens.length < 2) return false;
  const key = tokens.join(" ");
  for (const blocked of BLOCKED_CONTACT_NAMES) {
    const bt = blockedNameTokens(blocked);
    if (bt.length < 2) continue;
    if (bt.join(" ") === key) return true;
    // Name contains all blocked tokens (extra middle initial / suffix ok).
    if (bt.every((t) => tokens.includes(t))) return true;
  }
  return false;
}

/**
 * True when the email local-part is clearly one of the blocked people
 * (beech.julia@…, julia_beech@…, name:chris.hillock@attendee.local).
 */
export function isBlockedContactEmail(email: string): boolean {
  const raw = (email || "").trim().toLowerCase();
  if (!raw.includes("@")) return false;
  let local = raw.split("@")[0] || "";
  if (local.startsWith("name:")) local = local.slice("name:".length);
  const parts = local
    .split(/[._+\-]+/)
    .map((p) => p.replace(/[^a-z]/g, ""))
    .filter((p) => p.length >= 2)
    .sort();
  if (parts.length < 2) return false;
  for (const blocked of BLOCKED_CONTACT_NAMES) {
    const bt = blockedNameTokens(blocked);
    if (bt.length >= 2 && bt.every((t) => parts.includes(t))) return true;
  }
  return false;
}

/**
 * Display names that must never become CRM contacts (RSVP bots, portfolio
 * aliases, keyboard mash / hex person-ids, URL-encoded debris, blocked people).
 */
export function isGarbageContactName(name: string): boolean {
  const n = (name || "").trim();
  if (!n) return true;
  if (isBlockedContactName(n)) return true;
  if (/^(response|dell\.com)$/i.test(n)) return true;
  if (/^portfolio\b/i.test(n) || /%/i.test(n)) return true;
  // Shared-mailbox display names from tracking aliases / booking links.
  if (/^(bd|gtm)(\s+|[-_])?tracking$/i.test(n)) return true;
  if (/^(booking|bookings|scheduler|calendar|tracking|alias)$/i.test(n)) return true;
  // Consonant salad / repeated-char mash (Bafeacacdddcec).
  if (/^[a-z]{8,}$/i.test(n) && /(.)\1{2,}/i.test(n)) return true;
  if (!/\s/.test(n) && n.length >= 12 && !/[aeiou]/i.test(n.replace(/[^a-z]/gi, ""))) {
    return true;
  }
  // Long single-token alphanumerics (uuid-ish locals mistaken for names).
  if (!/\s/.test(n) && n.length >= 14 && /^[a-z0-9]+$/i.test(n)) return true;
  return false;
}

/** Primary email from a multi-value Contacts cell. */
function primaryEmail(raw: string): string {
  return sanitizeEmailToken((raw || "").split(/[;,|]/)[0] || "") || "";
}

/**
 * Why this row must not be written to Contacts, or null if importable.
 * Checks name + email (+ portfolio alias company).
 */
export function contactImportRejectReason(input: {
  name?: string;
  email?: string;
  company?: string;
}): string | null {
  const name = (input.name || "").trim();
  if (isBlockedContactName(name)) return "blocked name";
  if (isGarbageContactName(name)) return "garbage name";

  const company = (input.company || "").trim();
  if (/^portfolio\b/i.test(company)) return "portfolio alias company";

  const email = primaryEmail(input.email || "");
  if (email) {
    if (isBlockedContactEmail(email)) return "blocked name";
    if (!isPlausibleAddress(email) || isNoiseEmail(email)) return "noise/implausible email";
    if (/\bon\.behalf(\.of)?\./i.test(email)) return "on-behalf debris email";
  }
  return null;
}
