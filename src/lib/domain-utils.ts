/**
 * Extract a normalized root domain from a website URL or email address.
 * Strips protocol, "www.", path, and lowercases.
 * Returns null if unparseable.
 */
export function extractDomain(input: string | undefined | null): string | null {
  if (!input) return null;
  let value = input.trim().toLowerCase();
  if (!value) return null;

  // Email → take the part after @
  if (value.includes("@")) {
    const parts = value.split("@");
    value = parts[parts.length - 1];
  }

  // URL → strip protocol and path
  value = value.replace(/^https?:\/\//, "").replace(/^www\./, "");
  value = value.split("/")[0].split("?")[0].split("#")[0];

  if (!value) return null;
  return value;
}

/**
 * Generic email providers — these are not company domains, so don't try to fetch a logo.
 */
const GENERIC_EMAIL_DOMAINS = new Set([
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
]);

/**
 * Returns a Google favicon URL for the contact's company, derived from their
 * email domain. Returns null for generic providers (gmail, yahoo, etc.) or
 * when no usable domain can be extracted.
 */
export function getCompanyLogoUrl(input: {
  email?: string;
  website?: string;
}): string | null {
  const domain =
    extractDomain(input.website) || extractDomain(input.email);
  if (!domain) return null;
  if (GENERIC_EMAIL_DOMAINS.has(domain)) return null;
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
}

/**
 * Returns true when contact's email domain matches the company's website domain.
 */
export function contactMatchesCompany(
  contactEmail: string | undefined,
  companyWebsite: string | undefined
): boolean {
  const a = extractDomain(contactEmail);
  const b = extractDomain(companyWebsite);
  if (!a || !b) return false;
  return a === b;
}
