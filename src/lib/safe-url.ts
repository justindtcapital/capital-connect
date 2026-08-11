/**
 * Normalize hrefs used in Signals / markdown so relative junk like "drive/"
 * never opens as a DNS host. Returns "" when the value isn't a safe absolute link.
 */
export function absoluteHttpUrl(raw?: string | null): string {
  const href = (raw || "").trim();
  if (!href || href === "#") return "";

  if (/^(https?:|mailto:|tel:)/i.test(href)) return href;
  // Protocol-relative: //drive.google.com/...
  if (href.startsWith("//") && href.length > 2) return `https:${href}`;
  // Bare Google Drive/Docs host without scheme.
  if (/^(drive|docs)\.google\.com([/?#]|$)/i.test(href)) return `https://${href}`;

  return "";
}

/** True when the URL is a Google Drive / Docs permalink. */
export function isGoogleDriveUrl(raw?: string | null): boolean {
  return /^https?:\/\/(drive|docs)\.google\.com\//i.test(absoluteHttpUrl(raw));
}

/** Build a stable file permalink from a Drive file id. */
export function driveFileViewUrl(id?: string | null): string {
  const fileId = (id || "").trim();
  if (!fileId) return "";
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}
