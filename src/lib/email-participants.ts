// Address-list parsing + internal/external participant classification for the
// BD/GTM alias activity sync. Pure — safe to unit-test without Gmail.
//
// Why this exists: To/Cc headers used to be split on every comma, which broke
// quoted display names ("Jain, Vrashank" <v@dell.com> became two junk tokens)
// and threw away recipient display names entirely. This module parses address
// lists RFC 5322-style (quotes, angle brackets, comments respected), keeps the
// display name for every recipient, and can recover the original participants
// from the quoted header block of a forwarded message body.

export interface EmailAddr {
  name: string;
  email: string;
}

// Conservative local@domain shape — anything that fails this never enters a
// recipient list (drops the garbage tokens a naive comma split used to emit).
const EMAIL_RE =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

export function isPlausibleEmail(email: string): boolean {
  const e = (email || "").trim();
  return e.length > 0 && e.length <= 254 && EMAIL_RE.test(e);
}

/**
 * Split an address-list header on commas/semicolons that sit OUTSIDE quoted
 * strings, angle brackets, and () comments.
 */
export function splitAddressList(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  let inAngle = false;
  let paren = 0;
  for (const ch of raw || "") {
    if (inQuote) {
      cur += ch;
      if (ch === '"') inQuote = false;
      continue;
    }
    switch (ch) {
      case '"':
        inQuote = true;
        cur += ch;
        break;
      case "(":
        paren++;
        cur += ch;
        break;
      case ")":
        paren = Math.max(0, paren - 1);
        cur += ch;
        break;
      case "<":
        inAngle = true;
        cur += ch;
        break;
      case ">":
        inAngle = false;
        cur += ch;
        break;
      case ",":
      case ";":
        if (!inAngle && paren === 0) {
          if (cur.trim()) out.push(cur.trim());
          cur = "";
        } else {
          cur += ch;
        }
        break;
      default:
        cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function cleanDisplayName(name: string): string {
  return (name || "")
    .replace(/^\s*"(.*)"\s*$/s, "$1")
    .replace(/\\(["\\])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse one address token: `Name <email>`, `Name [mailto:email]`, or a bare email. */
export function parseOneAddress(token: string): EmailAddr | null {
  let t = (token || "").trim();
  if (!t) return null;

  const angle = t.match(/^(.*?)<\s*(?:mailto:)?([^<>\s]+)\s*>/s);
  if (angle) {
    const email = angle[2].trim().toLowerCase();
    if (!isPlausibleEmail(email)) return null;
    // Outlook nesting (`Name <a@b.com<mailto:a@b.com>>`) makes the regex
    // backtrack the first bracket into the name — cut the name at any `<`.
    let name = cleanDisplayName(angle[1].split("<")[0]);
    if (name.toLowerCase() === email) name = "";
    return { name, email };
  }

  // Outlook plain-text forwards: `From: Chris Falloon [mailto:chris@dell.com]`
  const mailto = t.match(/^(.*?)\[\s*mailto:([^\][\s]+)\s*\]/is);
  if (mailto) {
    const email = mailto[2].trim().toLowerCase();
    if (!isPlausibleEmail(email)) return null;
    return { name: cleanDisplayName(mailto[1]), email };
  }

  t = cleanDisplayName(t.replace(/^mailto:/i, ""));
  const email = t.toLowerCase();
  if (!isPlausibleEmail(email)) return null;
  return { name: "", email };
}

/**
 * Parse a full To/Cc/From header value into named addresses, deduped by email.
 * Unquoted "Last, First <email>" survives: an address-less fragment is glued
 * onto the next token's display name instead of becoming a junk entry.
 */
export function parseAddressList(raw: string): EmailAddr[] {
  const out: EmailAddr[] = [];
  const byEmail = new Map<string, EmailAddr>();
  let pendingName = "";
  for (const tok of splitAddressList(raw)) {
    if (!tok.includes("@")) {
      // Hold ONLY the most recent fragment — the "Last, First <email>" repair
      // needs just the surname directly before the address. Accumulating would
      // glue a whole name-only list ("Kohl, Neal; Gibbard, James" from an
      // Outlook forward) into one giant display name.
      pendingName = cleanDisplayName(tok);
      continue;
    }
    const addr = parseOneAddress(tok);
    if (!addr) {
      pendingName = "";
      continue;
    }
    if (pendingName) {
      addr.name = addr.name ? `${pendingName}, ${addr.name}` : pendingName;
      pendingName = "";
    }
    const existing = byEmail.get(addr.email);
    if (existing) {
      if (!existing.name && addr.name) existing.name = addr.name;
      continue;
    }
    byEmail.set(addr.email, addr);
    out.push(addr);
  }
  return out;
}

/** Which mailbox addresses/domains count as "our side" (never the relationship contact). */
export interface InternalMailConfig {
  domains: Set<string>;
  addresses: Set<string>;
}

export const EMPTY_INTERNAL_CONFIG: InternalMailConfig = {
  domains: new Set(),
  addresses: new Set(),
};

export function isInternalEmail(email: string, cfg: InternalMailConfig): boolean {
  const e = (email || "").trim().toLowerCase();
  if (!e) return false;
  if (cfg.addresses.has(e)) return true;
  const domain = e.split("@")[1] || "";
  return domain.length > 0 && cfg.domains.has(domain);
}

export interface ForwardedBlock {
  from: EmailAddr[];
  to: EmailAddr[];
  cc: EmailAddr[];
}

// Value of a forwarded header line: first line + indented continuation lines.
// In HTML-stripped bodies there are no newlines at all — the slice between two
// header keys is already the value.
function joinHeaderValue(val: string): string {
  const paragraph = val.indexOf("\n\n");
  const bounded = paragraph === -1 ? val : val.slice(0, paragraph);
  const lines = bounded.split("\n");
  let joined = lines[0] || "";
  for (let i = 1; i < lines.length; i++) {
    if (!/^[ \t]/.test(lines[i])) break;
    joined += ` ${lines[i].trim()}`;
  }
  return joined;
}

/**
 * Recover the original participants from the quoted header block that every
 * mail client embeds in a forward ("From: … / Sent: … / To: …" — Outlook, or
 * the Gmail "---------- Forwarded message ---------" variant). Only the FIRST
 * forwarded hop is trusted; deeper quoted chains are ignored.
 *
 * Used when the live headers show no external human (the "teammate forwards a
 * thread to the tracking alias" pattern) — the true counterparty only exists
 * in the body text.
 */
export function extractForwardedBlock(body: string): ForwardedBlock | null {
  const text = (body || "").replace(/\r/g, "").slice(0, 6000);
  const start = text.search(/(?:^|\n|\s)From\s*:/i);
  if (start === -1) return null;
  const region = text.slice(start, start + 2500);

  const keyRe = /\b(From|To|Cc|Bcc|Sent|Date|Subject)\s*:\s*/gi;
  const hits = [...region.matchAll(keyRe)];
  if (hits.length === 0) return null;

  const block: ForwardedBlock = { from: [], to: [], cc: [] };
  let sawFrom = false;
  for (let i = 0; i < hits.length; i++) {
    const key = hits[i][1].toLowerCase();
    if (key === "from") {
      if (sawFrom) break; // second From: = the next (older) hop in the chain
      sawFrom = true;
    }
    if (key !== "from" && key !== "to" && key !== "cc") continue;
    const valStart = (hits[i].index ?? 0) + hits[i][0].length;
    const valEnd =
      i + 1 < hits.length
        ? (hits[i + 1].index ?? region.length)
        : Math.min(region.length, valStart + 600);
    const addrs = parseAddressList(joinHeaderValue(region.slice(valStart, valEnd)));
    if (key === "from") block.from.push(...addrs);
    else if (key === "to") block.to.push(...addrs);
    else block.cc.push(...addrs);
  }

  if (block.from.length === 0 && block.to.length === 0 && block.cc.length === 0) return null;
  return block;
}
