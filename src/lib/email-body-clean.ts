// Clean forwarded / digested email bodies for Signals cards.
// Pure — safe to unit-test without Gmail.
//
// NEWS@ / research forwards often arrive as nested Outlook threads:
// confidentiality banners, From/To/Cc blocks, and broken
// "emailmailto:email" artifacts. Cards should show the research blurb,
// not the forwarder's reply chain.

const ENTITY_MAP: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  "#34": '"',
};

/** Decode common HTML entities (named + numeric) that survive plain-text parts. */
export function decodeBasicEntities(text: string): string {
  return (text || "").replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (full, name: string) => {
    const key = name.toLowerCase();
    if (ENTITY_MAP[key] != null) return ENTITY_MAP[key];
    if (key.startsWith("#x")) {
      const n = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : full;
    }
    if (key.startsWith("#")) {
      const n = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : full;
    }
    return full;
  });
}

/** Fix Outlook/HTML-strip artifacts like `a@b.commailto:a@b.com`. */
export function fixMailtoArtifacts(text: string): string {
  return (text || "")
    .replace(/([\w.+-]+@[\w.-]+\.\w{2,})mailto:\1/gi, "$1")
    .replace(/<mailto:([\w.+-]+@[\w.-]+\.\w{2,})>/gi, "<$1>")
    .replace(/\s*mailto:([\w.+-]+@[\w.-]+\.\w{2,})/gi, " <$1>");
}

/** Light sanitize safe for any email body (entities + mailto glue). */
export function sanitizeEmailText(text: string): string {
  return fixMailtoArtifacts(decodeBasicEntities(text || ""));
}

/** True when a snippet/summary is thread chrome, not useful copy. */
export function isEmailChromeText(text: string): boolean {
  const s = (text || "").trim().replace(/\s+/g, " ");
  if (!s) return true;
  if (/^(internal use|confidential|from:|to:|cc:|bcc:|subject:|sent:|date:)/i.test(s))
    return true;
  if (/mailto:/i.test(s)) return true;
  if (/&(?:lt|gt|nbsp|#\d+);/i.test(s)) return true;
  // Dense address-book dump from a forwarded To:/Cc: line.
  const atCount = (s.match(/@/g) || []).length;
  if (atCount >= 3 && s.length < 400) return true;
  return false;
}

const HEADER_LINE =
  /^(from|to|cc|bcc|subject|sent|date|delivered-to|reply-to|importance|sensitivity)\s*:/i;
const BANNER_LINE =
  /^(internal use\b.*confidential|confidential(\s*[—–-]\s*internal use)?|confidential(\s*[—–-]\s*internal)?)\s*$/i;
const SEPARATOR_LINE = /^[-_=*]{3,}\s*(original message|forwarded message)?\s*[-_=*]*$/i;

function peelAfterPublisherFrom(text: string, publisher: string): string | null {
  const pub = publisher.trim();
  if (!pub || /^industry report$/i.test(pub)) return null;
  const fromRe = new RegExp(
    `(?:^|\\n)\\s*From:\\s*[^\\n]*${escapeRegExp(pub)}[^\\n]*\\n`,
    "gi",
  );
  let lastIdx = -1;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(text)) !== null) lastIdx = m.index + m[0].length;
  return lastIdx >= 0 ? text.slice(lastIdx) : null;
}

function peelAfterForwardSeparators(text: string): string | null {
  const sep = [...text.matchAll(/(?:^|\n)\s*[-_]{3,}.*(?:original|forwarded).*$/gim)];
  const last = sep[sep.length - 1];
  if (last && last.index != null) {
    return text.slice(last.index + last[0].length);
  }
  // Outlook often uses a bare rule line before the innermost From:.
  const rules = [...text.matchAll(/(?:^|\n)_{10,}\s*(?:\n|$)/g)];
  const rule = rules[rules.length - 1];
  if (rule && rule.index != null) {
    return text.slice(rule.index + rule[0].length);
  }
  return null;
}

/**
 * Drop leading reply/forward chrome and keep the innermost substantive body.
 * When `publisherHint` is set, prefer content after that From: block so the
 * human forwarder's headers don't dominate the card. Falls back to peeling
 * any Original/Forwarded Message stack — publisher-agnostic.
 */
export function cleanForwardedResearchBody(
  raw: string,
  opts: { publisherHint?: string; maxLen?: number } = {},
): string {
  let text = sanitizeEmailText(raw);
  // Normalize newlines; keep paragraph breaks.
  text = text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n");

  const peeled =
    peelAfterPublisherFrom(text, opts.publisherHint || "") ||
    peelAfterForwardSeparators(text);
  if (peeled != null) text = peeled;

  const lines = text.split("\n");
  const kept: string[] = [];
  let pastHeaders = false;
  for (const line of lines) {
    const t = line.trim();
    if (!pastHeaders) {
      if (!t || BANNER_LINE.test(t) || SEPARATOR_LINE.test(t) || HEADER_LINE.test(t)) continue;
      // "Name <email>" alone on a line right after From: residue
      if (/^[^<>\n]{0,80}<[\w.+-]+@[\w.-]+>\s*$/.test(t) && kept.length === 0) continue;
      pastHeaders = true;
    }
    if (BANNER_LINE.test(t) || SEPARATOR_LINE.test(t)) continue;
    // Skip mid-body header echoes that Outlook re-inserts.
    if (HEADER_LINE.test(t) && t.length < 200) continue;
    kept.push(line);
  }

  let out = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Collapse runaway single-line dumps (HTML→text with no newlines).
  if (!/\n/.test(out) && out.length > 500) {
    out = out.replace(/\s{2,}/g, " ").trim();
  }
  const max = opts.maxLen ?? 1800;
  if (out.length > max) out = `${out.slice(0, max).trim()}…`;
  return out;
}

/** Prefer a paragraph that mentions the entity; else the cleaned body start. */
export function excerptForEntity(
  cleanedBody: string,
  entity: string,
  maxLen = 600,
): string {
  const body = (cleanedBody || "").trim();
  if (!body) return "";
  const name = (entity || "").trim();
  if (!name) return body.slice(0, maxLen).trim();

  // Match entity (allow dropping legal suffixes like AG / Inc).
  const core = name.replace(/\b(ag|inc|corp|ltd|llc|plc|co)\.?$/i, "").trim() || name;
  const re = new RegExp(
    `(?:^|[.\\n])[^.\\n]{0,40}${escapeRegExp(core)}[^.\\n]{0,200}[.!?]?`,
    "i",
  );
  const hit = body.match(re);
  if (hit?.[0]) {
    const snippet = hit[0].replace(/^[\s.]+/, "").trim();
    if (snippet.length >= 40) {
      return snippet.length > maxLen ? `${snippet.slice(0, maxLen).trim()}…` : snippet;
    }
  }

  // Section starting at a line that begins with the entity name.
  const lineRe = new RegExp(
    `(?:^|\\n)\\s*${escapeRegExp(core)}[^\\n]{0,120}\\n?([\\s\\S]{0,${maxLen}})`,
    "i",
  );
  const section = body.match(lineRe);
  if (section) {
    const block = `${section[0]}`.trim();
    if (block.length >= 40)
      return block.length > maxLen ? `${block.slice(0, maxLen).trim()}…` : block;
  }

  return body.length > maxLen ? `${body.slice(0, maxLen).trim()}…` : body;
}

/** True when a research-card snippet is a placeholder, not a real finding. */
export function isWeakResearchSnippet(snippet: string): boolean {
  const s = (snippet || "").trim().replace(/\s+/g, " ");
  if (!s || isEmailChromeText(s)) return true;
  // "Siemens covered in 451 Research (2026-08-10)."
  if (/\bcovered in\b.+\(\d{4}-\d{2}-\d{2}\)\.?$/i.test(s)) return true;
  if (/^from [^=\n]{2,60}:\s*.{0,80}$/i.test(s) && s.length < 120) return true;
  // Subject echo with no substance.
  if (/^[A-Z0-9][\w&.''' +-]{1,40}\s*[—–-]\s*[A-Z0-9][\w&.''' +-]{1,40}$/i.test(s)) return true;
  return false;
}

export interface ResearchCardCopy {
  body: string;
  snippet: string;
}

/**
 * Build body + snippet for a NEWS@ research entity/PDF card.
 * Rejects Gmail snippets that are just forward chrome.
 */
export function researchCardCopy(input: {
  rawBody: string;
  gmailSnippet?: string;
  entity?: string;
  publisherName?: string;
  dateLabel?: string;
}): ResearchCardCopy {
  const publisher = (input.publisherName || "").trim();
  const cleaned = cleanForwardedResearchBody(input.rawBody, {
    publisherHint: publisher || undefined,
  });
  const entity = (input.entity || "").trim();
  const body = entity ? excerptForEntity(cleaned, entity) || cleaned : cleaned;

  const gmailSnip = sanitizeEmailText(input.gmailSnippet || "").trim();
  let snippet = "";
  if (gmailSnip && !isEmailChromeText(gmailSnip) && !/^fw:|^re:/i.test(gmailSnip)) {
    snippet = gmailSnip;
  } else if (body && !isEmailChromeText(body)) {
    snippet = body.replace(/\s+/g, " ").slice(0, 220).trim();
  } else {
    const pubLabel = publisher || "Industry Report";
    snippet = entity
      ? `${entity} covered in ${pubLabel}${input.dateLabel ? ` (${input.dateLabel})` : ""}.`
      : `Covered in ${pubLabel}${input.dateLabel ? ` (${input.dateLabel})` : ""}.`;
  }

  return {
    body: body || snippet,
    snippet,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
