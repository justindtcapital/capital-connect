/**
 * Company domain + logo URL helpers for Network, Targets, Companies, Signals.
 *
 * Clearbit's free logo API (logo.clearbit.com) shut down Dec 2025 — do not use it.
 * Ladder: optional Logo.dev (if VITE_LOGO_DEV_TOKEN) → DuckDuckGo → Google favicons.
 */

/**
 * Extract a normalized root domain from a website URL or email address.
 * Strips protocol, "www.", path, and lowercases. Returns null if unparseable.
 */
export function extractDomain(input: string | undefined | null): string | null {
  if (!input) return null;
  let value = input.trim().toLowerCase();
  if (!value) return null;

  if (value.includes("@")) {
    const parts = value.split("@");
    value = parts[parts.length - 1] || "";
  }

  value = value.replace(/^https?:\/\//, "").replace(/^www\./, "");
  value = value.split("/")[0].split("?")[0].split("#")[0];

  if (!value || !value.includes(".")) return null;
  return value;
}

/** Personal / free mail providers — not company logo domains. */
export const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "live.com",
  "msn.com",
  "googlemail.com",
  "gmx.com",
  "mail.com",
  "ymail.com",
  "hey.com",
]);

/**
 * Last-resort domain from a company display name ("Salesforce Inc" → salesforce.com).
 * Low confidence — prefer Clearbit/Logo.dev style APIs that 404 cleanly over blind favicons.
 */
export function guessDomainFromCompanyName(name?: string | null): string | null {
  if (!name) return null;
  // Keep "Labs" / "Lab" in the slug — many startups use brandlabs.com, and
  // stripping them yields the wrong domain (Architect Labs → architect.com).
  const slug = name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(
      /\b(inc|llc|ltd|corp|co|company|technologies|technology|holdings|group|the)\b\.?/g,
      "",
    )
    .replace(/[^a-z0-9]/g, "");
  if (slug.length < 2) return null;
  return `${slug}.com`;
}

/**
 * When a news/article URL's host looks like the company's own site (not a
 * publisher), return that host as a high-confidence logo domain.
 * e.g. nvidia.com/blog/... for company "NVIDIA", but not techcrunch.com.
 */
export function domainFromCompanySourceUrl(
  company?: string | null,
  sourceUrl?: string | null,
): string | null {
  const host = extractDomain(sourceUrl || undefined);
  if (!host) return null;
  // Common publishers / aggregators — never treat as the company logo domain.
  const PUBLISHERS = new Set([
    "techcrunch.com",
    "bloomberg.com",
    "reuters.com",
    "wsj.com",
    "ft.com",
    "forbes.com",
    "businessinsider.com",
    "theverge.com",
    "wired.com",
    "cnn.com",
    "bbc.com",
    "bbc.co.uk",
    "nytimes.com",
    "washingtonpost.com",
    "cnbc.com",
    "yahoo.com",
    "google.com",
    "linkedin.com",
    "twitter.com",
    "x.com",
    "facebook.com",
    "medium.com",
    "substack.com",
    "youtube.com",
    "wikipedia.org",
    "crunchbase.com",
    "prnewswire.com",
    "businesswire.com",
    "globenewswire.com",
    "seekingalpha.com",
    "morningstar.com",
    "pitchbook.com",
    "axios.com",
    "protocol.com",
    "venturebeat.com",
    "zdnet.com",
    "arxiv.org",
    "github.com",
  ]);
  if (PUBLISHERS.has(host)) return null;
  const labels = host.split(".").filter(Boolean);
  // Prefer the registrable-ish label (skip www/news/blog prefixes).
  const skip = new Set(["www", "news", "blog", "blogs", "press", "ir", "investors", "com", "io", "ai", "co"]);
  const brandLabel = labels.find((l) => !skip.has(l)) || labels[0] || "";
  const companySlug = (company || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(
      /\b(inc|llc|ltd|corp|co|company|technologies|technology|holdings|group|the)\b\.?/g,
      "",
    )
    .replace(/[^a-z0-9]/g, "");
  if (companySlug.length < 3 || !brandLabel) return null;
  // Host must contain a meaningful chunk of the company slug (or vice versa).
  const chunk = companySlug.slice(0, Math.min(8, companySlug.length));
  const hostCompact = host.replace(/\./g, "");
  if (
    host.includes(chunk) ||
    hostCompact.includes(companySlug) ||
    companySlug.includes(brandLabel) ||
    brandLabel.includes(chunk)
  ) {
    return host;
  }
  return null;
}

export type LogoConfidence = "high" | "low";

export interface ResolvedLogoDomain {
  domain: string;
  /** high = website / corporate email / explicit domain; low = guessed from company name */
  confidence: LogoConfidence;
  source: "website" | "domain" | "email" | "company";
}

/**
 * Resolve the best company domain for a logo.
 * Priority: website → explicit domain → corporate email → company-name guess.
 */
export function resolveCompanyLogoDomain(input: {
  website?: string | null;
  domain?: string | null;
  email?: string | null;
  company?: string | null;
}): ResolvedLogoDomain | null {
  const website = extractDomain(input.website || undefined);
  if (website) return { domain: website, confidence: "high", source: "website" };

  const explicit = extractDomain(input.domain || undefined);
  if (explicit && !GENERIC_EMAIL_DOMAINS.has(explicit)) {
    return { domain: explicit, confidence: "high", source: "domain" };
  }

  // First address only (contacts may store "a@co.com; b@co.com")
  const primaryEmail = (input.email || "").split(/[;,]/)[0]?.trim() || "";
  const emailDom = extractDomain(primaryEmail);
  if (emailDom && !GENERIC_EMAIL_DOMAINS.has(emailDom)) {
    return { domain: emailDom, confidence: "high", source: "email" };
  }

  const guessed = guessDomainFromCompanyName(input.company || undefined);
  if (guessed) return { domain: guessed, confidence: "low", source: "company" };

  return null;
}

/** Optional publishable Logo.dev token (client-side, VITE_*). */
function logoDevToken(): string {
  const raw = import.meta.env.VITE_LOGO_DEV_TOKEN;
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Ordered logo image URLs to try for a domain.
 * Callers should advance on onError.
 */
export function companyLogoSources(
  domain: string,
  confidence: LogoConfidence = "high",
): string[] {
  const d = domain.trim().toLowerCase().replace(/^www\./, "");
  if (!d) return [];

  const sources: string[] = [];
  const token = logoDevToken();
  if (token) {
    // Official Clearbit replacement — publishable key is safe in the browser.
    sources.push(
      `https://img.logo.dev/${encodeURIComponent(d)}?token=${encodeURIComponent(token)}&size=128&format=png`,
    );
  }

  // DuckDuckGo usually 404s when missing — better than Google's silent default globe.
  sources.push(`https://icons.duckduckgo.com/ip3/${d}.ico`);

  // High-confidence domains: also try Google at a usable size.
  // Low-confidence guesses: skip Google when Logo.dev is configured.
  if (confidence === "high" || !token) {
    sources.push(
      `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=128`,
    );
  }

  return sources;
}

/**
 * @deprecated Prefer resolveCompanyLogoDomain + companyLogoSources with a staged <img>.
 * Kept for call sites that need a single URL (first candidate only).
 */
export function getCompanyLogoUrl(input: {
  email?: string;
  website?: string;
  domain?: string;
  company?: string;
}): string | null {
  const resolved = resolveCompanyLogoDomain(input);
  if (!resolved) return null;
  const sources = companyLogoSources(resolved.domain, resolved.confidence);
  return sources[0] || null;
}

/**
 * Returns true when contact's email domain matches the company's website domain.
 */
export function contactMatchesCompany(
  contactEmail: string | undefined,
  companyWebsite: string | undefined,
): boolean {
  const a = extractDomain(contactEmail);
  const b = extractDomain(companyWebsite);
  if (!a || !b) return false;
  return a === b;
}
