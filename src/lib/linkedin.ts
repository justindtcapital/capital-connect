// Canonical LinkedIn URL handling — one source of truth so a profile URL is stored
// consistently no matter how it entered the app (manual add, edit, Apollo
// enrichment, smart-paste, or CSV upload). Every write path in sheets.server.ts
// runs values through normalizeLinkedinUrl, and the paste/upload dialogs use it for
// preview parity. Kept isomorphic (only the global URL) so it runs on server + client.

// Matches the first LinkedIn URL inside a free-text blob (paste parsers use this to
// pull a profile link out of a mixed line like "Jane Doe, CISO, linkedin.com/in/jd").
export const LINKEDIN_URL_RE = /https?:\/\/(?:[a-z0-9-]{2,}\.)?linkedin\.com\/[^\s,|<>]+/i;

// Produce a stable, deduplicable LinkedIn URL:
//   • adds https:// when the scheme is missing
//   • lowercases the host, forces https
//   • drops query string + hash (LinkedIn tracking params carry no identity)
//   • strips the trailing slash
// A value that isn't a LinkedIn URL (bare handle, empty, junk) is returned trimmed
// rather than mangled, and any parse failure falls back to a light cleanup — this
// never throws, so it's safe to call unconditionally on every write.
export function normalizeLinkedinUrl(input: string | undefined | null): string {
  const raw = (input || "").trim();
  if (!raw) return "";
  // Only treat it as a URL to canonicalize when it actually looks like one.
  const looksLikeUrl = /linkedin\.com/i.test(raw) || /^https?:\/\//i.test(raw);
  if (!looksLikeUrl) return raw;

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    u.protocol = "https:";
    u.host = u.host.toLowerCase();
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return withScheme.replace(/\/+$/, "");
  }
}
