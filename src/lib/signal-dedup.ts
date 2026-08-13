/**
 * Shared story identity for Signals — collapses the same news item when it
 * arrives via Drive, NewsAPI, Perplexity, or a paraphrased re-scan.
 */

import { driveFileIdFromUrl } from "@/lib/safe-url";

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeStoryText(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Stable content fingerprint: company + leading significant text.
 * Same story with slight rewording still collapses when the opening facts match.
 */
export function storyContentKey(company: string, ...parts: Array<string | undefined>): string {
  const c = (company || "").trim().toLowerCase();
  const text = normalizeStoryText(parts.filter(Boolean).join(" ")).slice(0, 160);
  if (!c && !text) return "";
  return `c:${c}|${text}`;
}

/** True when `needle` is already covered by `haystack` (UI / body dedup). */
export function textAlreadyCovered(haystack: string, needle: string): boolean {
  const h = normalizeStoryText(haystack);
  const n = normalizeStoryText(needle);
  if (!n || n.length < 24) return false;
  if (h.includes(n.slice(0, Math.min(100, n.length)))) return true;
  // Near-equal openings (paraphrase / Signal: prefix).
  const a = h.slice(0, 80);
  const b = n.slice(0, 80);
  return Boolean(a && b && (a.includes(b.slice(0, 48)) || b.includes(a.slice(0, 48))));
}

/** Collect Drive file ids already cited on stored signals (source or archive). */
export function citedDriveIdsFromUrls(...urls: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const u of urls) {
    const id = driveFileIdFromUrl(u);
    if (id) out.push(id);
  }
  return out;
}
