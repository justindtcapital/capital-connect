// RFC 5322 address-list parsing.
//
// Naive `split(",")` destroys quoted display names — `"Jain, Vrashank"
// <vrashank.j@dell.com>` becomes two junk tokens, and the real name is lost so
// downstream code invents one from the local part. This parser respects quoted
// strings, angle brackets and comments, and keeps the display name for EVERY
// recipient (To/Cc), not just From.

export interface EmailAddress {
  name: string;
  email: string;
}

const ADDR_SHAPE = /^[^\s@,"'<>()[\]:;]+@[^\s@,"'<>()[\]:;]+\.[a-z]{2,}$/i;

/** True when the token looks like a real local@domain.tld address. */
export function isPlausibleAddress(email: string): boolean {
  return ADDR_SHAPE.test((email || "").trim());
}

/**
 * Strip wrapping junk from a scraped token (`(prabhat@openobserve.ai` →
 * `prabhat@openobserve.ai`). Returns "" when the result is not a plausible address.
 */
export function sanitizeEmailToken(raw: string): string {
  let e = (raw || "").trim().toLowerCase();
  // Peel wrapping quotes / brackets / parens commonly left by markdown or "Name (email)".
  e = e.replace(/^[\s"'([{<]+/, "").replace(/[\s"')\]}>]+$/, "");
  e = e.replace(/^[.,;:]+|[.,;:]+$/g, "");
  if (!isPlausibleAddress(e)) return "";
  return e;
}

// Split an address list on top-level commas/semicolons only: commas inside
// quotes, angle brackets or parentheses belong to the address, not the list.
function splitTopLevel(raw: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quoted = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quoted) {
      if (ch === "\\" && i + 1 < raw.length) {
        buf += ch + raw[i + 1];
        i++;
        continue;
      }
      if (ch === '"') quoted = false;
      buf += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      buf += ch;
      continue;
    }
    if (ch === "<") angle++;
    else if (ch === ">") angle = Math.max(0, angle - 1);
    else if (ch === "(") paren++;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    if ((ch === "," || ch === ";") && angle === 0 && paren === 0) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

function cleanName(name: string): string {
  return name
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/\\(.)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * Parse one address ("Display Name" <a@b.com>, a@b.com, a@b.com (Comment)).
 * Returns null when no plausible address is present.
 */
export function parseEmailAddress(raw: string): EmailAddress | null {
  const s = (raw || "").trim();
  if (!s) return null;

  const angled = s.match(/<([^<>]+)>\s*$/) || s.match(/<([^<>]+)>/);
  if (angled) {
    const email = angled[1].trim().toLowerCase().replace(/^mailto:/, "");
    if (!isPlausibleAddress(email)) return null;
    const before = s.slice(0, s.indexOf(angled[0]));
    return { name: cleanName(before), email };
  }

  // Bare address, optionally followed by an RFC comment used as a name.
  const comment = s.match(/\(([^()]*)\)/);
  const bare = s.replace(/\([^()]*\)/g, " ").trim().replace(/^mailto:/, "");
  const email = bare.toLowerCase();
  if (!isPlausibleAddress(email)) return null;
  return { name: comment ? cleanName(comment[1]) : "", email };
}

/**
 * Split a recipient list. When the value contains semicolons (Outlook calendar /
 * appointment style), only ";" separates people — commas belong to "Last, First"
 * display names. A single unquoted `Last, First <email@x>` must stay one token.
 */
function splitRecipientList(raw: string): string[] {
  const s = (raw || "").trim();
  if (!s) return [];
  if (s.includes(";")) {
    return s
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean);
  }
  // One angled address (commas only in the display name) — don't comma-split.
  const angled = s.match(/<[^<>]+@[^<>]+>/g);
  if (angled && angled.length === 1 && s.includes("<")) {
    return [s];
  }
  // Display-name only, e.g. Outlook "Beech, Julia" with no mailbox.
  if (!/@/.test(s)) {
    return [s];
  }
  return splitTopLevel(s);
}

/** Parse a full To/Cc/From header value into unique addresses (order kept). */
export function parseAddressList(raw: string): EmailAddress[] {
  const seen = new Set<string>();
  const out: EmailAddress[] = [];
  for (const part of splitRecipientList(raw || "")) {
    const addr = parseEmailAddress(part);
    if (!addr || seen.has(addr.email)) continue;
    seen.add(addr.email);
    out.push(addr);
  }
  return out;
}

/** Synthetic domain for calendar attendees who appear as display names only. */
export const ATTENDEE_LOCAL_DOMAIN = "attendee.local";

/** True when the address is a name-only calendar placeholder (not a real mailbox). */
export function isNameOnlyAttendeeEmail(email: string): boolean {
  const e = (email || "").trim().toLowerCase();
  // Match both legacy `beech.julia@attendee.local` and `name:beech.julia@attendee.local`.
  return e.endsWith(`@${ATTENDEE_LOCAL_DOMAIN}`);
}

function slugDisplayName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 80);
}

/**
 * Like parseAddressList, but when a token has no email (Outlook calendar
 * "To: Falloon, Chris; Or Zabludowski"), keep it as a name-only attendee with a
 * synthetic address so People/Person can still surface the human.
 */
export function parseAddressOrDisplayList(raw: string): EmailAddress[] {
  // Prefer per-token merge so "Chris <a@b.com>; Or Zabludowski" keeps the
  // name-only attendee instead of dropping them when any email is present.
  const seen = new Set<string>();
  const out: EmailAddress[] = [];
  for (const part of splitRecipientList(raw || "")) {
    const addr = parseEmailAddress(part);
    if (addr) {
      if (seen.has(addr.email)) continue;
      seen.add(addr.email);
      out.push(addr);
      continue;
    }
    const name = cleanName(part);
    if (!name || name.length < 2) continue;
    if (/^(microsoft teams|zoom|webex|meet\.google|teams meeting)/i.test(name)) continue;
    if (/@/.test(name)) continue; // failed address shape — don't invent
    const slug = slugDisplayName(name);
    if (slug.length < 2) continue;
    const email = `name:${slug}@${ATTENDEE_LOCAL_DOMAIN}`;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ name, email });
  }
  return out;
}
