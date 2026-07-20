// Helpers for exploding "link digest" emails (e.g. the weekly "Portco blogs"
// forward) into one signal per linked article. Pure functions — no network
// calls; the server-side page-preview fetcher lives in
// utils/link-preview.server.ts.

/** Hostname without a leading www., lowercased. "" when unparseable. */
export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

// Hosts that are never a blog article: mail/calendar plumbing, social networks
// that block automated reads (LinkedIn), share widgets, auth-gated docs.
const JUNK_HOST_SUFFIXES = [
  "mail.google.com",
  "accounts.google.com",
  "drive.google.com",
  "docs.google.com",
  "calendar.google.com",
  "meet.google.com",
  "google.com", // bare search / redirect leftovers (real /url redirects are unwrapped first)
  "gstatic.com",
  "googleusercontent.com",
  "linkedin.com",
  "lnkd.in",
  "twitter.com",
  "x.com",
  "facebook.com",
  "instagram.com",
  "zoom.us",
  "teams.microsoft.com",
  "aka.ms",
  "calendly.com",
  "list-manage.com",
  "mailchi.mp",
];

function isJunkHost(host: string): boolean {
  return JUNK_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

// Unsubscribe/preference plumbing and static assets are not articles.
const JUNK_PATH_RE =
  /(unsubscribe|list-manage|email-settings|\/preferences\b|opt-?out|privacy-policy|terms-of-)/i;
const ASSET_RE = /\.(png|jpe?g|gif|svg|ico|webp|css|js|woff2?)([?#]|$)/i;

// Tracking query params stripped for both display and dedup.
const TRACKING_PARAM_RE =
  /^(utm_|mc_|mkt_|hsa_|vero_|oly_|_hs|gclid$|fbclid$|igshid$|mkt_tok$|cmpid$|s_cid$|source$|ref$)/i;

/**
 * Normalize a raw URL match: trim trailing punctuation, unwrap Outlook
 * SafeLinks / Google redirects, strip tracking params + fragment.
 * Returns "" when the result isn't a usable http(s) URL.
 */
export function cleanArticleUrl(raw: string, depth = 0): string {
  if (depth > 3) return "";
  const s = (raw || "").replace(/&amp;/gi, "&").replace(/[)\]>.,;:!?'"”’…]+$/g, "");
  if (!/^https?:\/\//i.test(s) || s.length > 400) return "";
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return "";
  }
  const host = url.hostname.toLowerCase();
  // Outlook SafeLinks wrapper → the real destination rides in ?url=
  if (host.endsWith("safelinks.protection.outlook.com")) {
    const inner = url.searchParams.get("url");
    return inner ? cleanArticleUrl(inner, depth + 1) : "";
  }
  // Google redirect wrapper (google.com/url?q=… or ?url=…)
  if (/(^|\.)google\.com$/.test(host) && url.pathname === "/url") {
    const inner = url.searchParams.get("q") || url.searchParams.get("url");
    return inner ? cleanArticleUrl(inner, depth + 1) : "";
  }
  const drop: string[] = [];
  url.searchParams.forEach((_, k) => {
    if (TRACKING_PARAM_RE.test(k)) drop.push(k);
  });
  for (const k of drop) url.searchParams.delete(k);
  url.hash = "";
  return url.toString().replace(/\?$/, "");
}

/**
 * Pull candidate ARTICLE links out of an email: plain-text URLs plus HTML
 * hrefs, cleaned, junk-filtered, and de-duplicated (host+path). Bare-domain
 * links (signatures) and short index pages (/blog) are dropped.
 */
export function extractArticleLinks(input: { text?: string; html?: string }, cap = 60): string[] {
  const raw: string[] = [];
  const urlRe = /https?:\/\/[^\s<>"')\]]+/gi;
  for (const m of (input.text || "").matchAll(urlRe)) raw.push(m[0]);
  const hrefRe = /href=["']([^"'\s]+)["']/gi;
  for (const m of (input.html || "").matchAll(hrefRe)) {
    if (/^https?:\/\//i.test(m[1])) raw.push(m[1]);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const u = cleanArticleUrl(r);
    if (!u || JUNK_PATH_RE.test(u) || ASSET_RE.test(u)) continue;
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      continue;
    }
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (!host || isJunkHost(host)) continue;
    const segs = url.pathname.split("/").filter(Boolean);
    if (segs.length === 0) continue; // bare domain = signature link
    if (segs.length === 1 && segs[0].length < 12) continue; // index pages like /blog
    const key = `${host}${url.pathname.replace(/\/$/, "")}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Is this email a link roundup that should be exploded into per-article
 * signals? Subject-matched digests ("Portco blogs …") need only 2 links; any
 * email carrying 6+ distinct article links counts regardless of subject.
 */
export function isLinkDigest(subject: string, links: string[]): boolean {
  if (links.length >= 6) return true;
  return (
    links.length >= 2 &&
    /\b(port\s?cos?\b.{0,16}\bblogs?|blogs?\s+(digest|roundup|for the week)|weekly\s+(blogs?|links|reads|reading))\b/i.test(
      subject || "",
    )
  );
}

const ACRONYMS = new Set([
  "ai",
  "api",
  "llm",
  "rag",
  "eu",
  "cfo",
  "ceo",
  "cto",
  "gpt",
  "aws",
  "ml",
  "okr",
  "kpi",
]);

/** Human title from the URL slug — the fallback when the page fetch fails. */
export function titleFromSlug(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    const slug = decodeURIComponent(segs[segs.length - 1] || "").replace(
      /\.(html?|php|aspx?)$/i,
      "",
    );
    const words = slug
      .replace(/[-_+]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!words) return hostOfUrl(url);
    return words
      .split(" ")
      .map((w) => {
        const lw = w.toLowerCase();
        if (ACRONYMS.has(lw)) return lw.toUpperCase();
        return /^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w;
      })
      .join(" ")
      .slice(0, 120);
  } catch {
    return url;
  }
}

// Common second-level public suffixes so "example.co.uk" → "example".
const SECOND_LEVEL_TLDS = new Set(["co", "com", "net", "org", "ac", "gov", "edu"]);

/** Display company name guessed from a host: "blog.auditoria.ai" → "Auditoria". */
export function companyFromHost(host: string): string {
  const parts = (host || "").split(".").filter(Boolean);
  if (parts.length === 0) return "";
  let sld = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  if (parts.length >= 3 && SECOND_LEVEL_TLDS.has(sld)) sld = parts[parts.length - 3];
  if (!sld) return "";
  return sld.charAt(0).toUpperCase() + sld.slice(1);
}

/** Match a host (or its registrable parent) against a domain→company map. */
export function matchCompanyByHost(host: string, domainToCompany: Map<string, string>): string {
  if (!host) return "";
  const hit = domainToCompany.get(host);
  if (hit) return hit;
  for (const [d, company] of domainToCompany) {
    if (host === d || host.endsWith(`.${d}`) || d.endsWith(`.${host}`)) return company;
  }
  return "";
}
