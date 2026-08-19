// Turn a raw email body into the human-readable message the sender actually wrote.
// Drops confidentiality banners, quoted reply chains, "On ... wrote:" separators,
// signature blocks and forwarded header stacks — pure, so it's unit-testable.

import { cleanForwardedResearchBody, isEmailChromeText, sanitizeEmailText } from "./email-body-clean";

const BANNER = /^(internal use|confidential|this (e-?mail|message)|disclaimer|caution:|external email)/i;
const QUOTE_START =
  /^(on .{5,120}\bwrote:\s*$|-{2,}\s*original message|-{2,}\s*forwarded message|from:\s.+)/i;
const SIGN_OFF = /^(--\s*$|__+\s*$|sent from my )/i;
const UNSUB = /(unsubscribe|manage (your )?preferences|view (this|in) browser)/i;

/**
 * Best-effort plain-text excerpt of the newest message in a thread.
 * Returns "" when nothing substantive survives (caller falls back to the snippet).
 */
export function emailBodyExcerpt(raw: string, maxLen = 800): string {
  const text = sanitizeEmailText(raw || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n");

  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (QUOTE_START.test(t) || SIGN_OFF.test(t)) break; // rest is quoted chain / signature
    if (!t) {
      if (kept.length) kept.push("");
      continue;
    }
    if (t.startsWith(">")) continue;
    if (BANNER.test(t) || UNSUB.test(t)) continue;
    if (/^\[?(image|cid):/i.test(t)) continue;
    kept.push(t);
  }

  let out = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // Nothing useful up front (e.g. pure forward) — peel the forward stack instead.
  if (!out || isEmailChromeText(out)) {
    out = cleanForwardedResearchBody(raw || "", { maxLen });
  }
  if (!out || isEmailChromeText(out)) return "";
  out = out.replace(/[ \t]{2,}/g, " ").trim();
  return out.length > maxLen ? `${out.slice(0, maxLen).trim()}…` : out;
}
