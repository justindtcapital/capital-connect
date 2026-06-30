// Normalize a possibly-multi-email cell into a single, consistently-separated
// string. The whole app treats the FIRST email as primary (split on ";") and
// dedupes on ";", so any source that uses "|", ",", or whitespace between
// addresses gets unified to "; " here — on import and on every write.
//
// Emails never legitimately contain | , ; so splitting on them is safe. We also
// split on whitespace and keep only @-containing tokens (dropping stray labels
// like "(work)"), falling back to the raw parts if nothing looks like an email.
export function normalizeEmails(raw: string): string {
  const parts = (raw || "").split(/[\s|,;]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  const emails = parts.filter((p) => p.includes("@"));
  return (emails.length > 0 ? emails : parts).join("; ");
}
