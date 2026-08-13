/**
 * Phase 3 Stage A — retrieval document model (pure).
 * Every NewsAPI / Perplexity / email-link / Drive item becomes one row before
 * any LLM sees it. Caps apply here; ranking decides what surfaces later.
 */

import { articleUrlKey } from "@/utils/news.server";
import type { SourceTier } from "@/lib/signal-config";

export type RetrievalSourceKind = "article" | "email_link" | "drive_pdf" | "gmail_pdf" | "topic_search";

export interface RetrievalDocument {
  /** Stable URL identity (articleUrlKey). */
  urlKey: string;
  /** Durable openable URL when known. */
  url: string;
  title: string;
  /** Grounding text available without fetching the page (title + description). */
  text: string;
  publishedAt: string;
  sourceHost: string;
  sourceName: string;
  kind: RetrievalSourceKind;
  /** Query/company tag from retrieval (may be topic phrase — not final subject). */
  queryTag?: string;
  tierHint?: SourceTier;
}

export interface RetrievalCapConfig {
  articleCap: number;
  topicArtCap: number;
  emailLinkCap: number;
  docCap: number;
}

export const DEFAULT_RETRIEVAL_CAPS: RetrievalCapConfig = {
  articleCap: 36,
  topicArtCap: 16,
  emailLinkCap: 20,
  docCap: 8,
};

export interface RetrievalOverflow {
  kind: string;
  url: string;
  name: string;
  company: string;
  reason: "capped";
  cap: number;
  keptCount: number;
}

export interface CappedRetrieval {
  kept: RetrievalDocument[];
  overflow: RetrievalOverflow[];
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Build a Stage A document from a NewsAPI/Perplexity article. */
export function retrievalFromArticle(a: {
  company: string;
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt: string;
}, opts?: { kind?: RetrievalSourceKind }): RetrievalDocument | null {
  const url = (a.url || "").trim();
  const urlKey = articleUrlKey(url);
  if (!urlKey) return null;
  const title = (a.title || "").trim();
  const description = (a.description || "").trim();
  return {
    urlKey,
    url,
    title,
    text: [title, description].filter(Boolean).join("\n\n"),
    publishedAt: a.publishedAt || "",
    sourceHost: hostOf(url),
    sourceName: a.source || hostOf(url),
    kind: opts?.kind || "article",
    queryTag: a.company || undefined,
  };
}

/** Email-link stub — text filled later via URL-context or left thin. */
export function retrievalFromEmailLink(l: {
  url: string;
  company?: string;
}): RetrievalDocument | null {
  const url = (l.url || "").trim();
  const urlKey = articleUrlKey(url);
  if (!urlKey) return null;
  return {
    urlKey,
    url,
    title: "",
    text: "",
    publishedAt: "",
    sourceHost: hostOf(url),
    sourceName: hostOf(url),
    kind: "email_link",
    queryTag: l.company,
  };
}

/** Drive / Gmail PDF — text often empty until multimodal extract. */
export function retrievalFromPdf(d: {
  name: string;
  link?: string;
}): RetrievalDocument | null {
  const url = (d.link || "").trim();
  const urlKey = articleUrlKey(url) || `pdf:${(d.name || "").toLowerCase().slice(0, 80)}`;
  if (!urlKey && !d.name) return null;
  return {
    urlKey,
    url,
    title: d.name || "",
    text: "",
    publishedAt: "",
    sourceHost: hostOf(url) || "drive.google.com",
    sourceName: "Drive",
    kind: "drive_pdf",
  };
}

/**
 * Cap Stage A inventory. Topic-tagged articles first, then company news,
 * then email links, then PDFs. Overflow rows measure recall cost of caps.
 */
export function applyRetrievalCaps(
  docs: RetrievalDocument[],
  topicTags: string[],
  cfg: RetrievalCapConfig = DEFAULT_RETRIEVAL_CAPS,
): CappedRetrieval {
  const topicLower = new Set(topicTags.map((t) => t.toLowerCase()).filter(Boolean));
  const articles = docs.filter((d) => d.kind === "article" || d.kind === "topic_search");
  const emailLinks = docs.filter((d) => d.kind === "email_link");
  const pdfs = docs.filter((d) => d.kind === "drive_pdf" || d.kind === "gmail_pdf");

  const topicArts = articles.filter(
    (d) => d.queryTag && topicLower.has(d.queryTag.toLowerCase()),
  );
  const companyArts = articles.filter(
    (d) => !(d.queryTag && topicLower.has(d.queryTag.toLowerCase())),
  );

  const topicKept = topicArts.slice(0, cfg.topicArtCap);
  const companyKept = companyArts.slice(
    0,
    Math.max(0, cfg.articleCap - Math.min(topicArts.length, cfg.topicArtCap)),
  );
  const emailKept = emailLinks.slice(0, cfg.emailLinkCap);
  const pdfKept = pdfs.slice(0, cfg.docCap);

  const kept = [...topicKept, ...companyKept, ...emailKept, ...pdfKept];
  const overflow: RetrievalOverflow[] = [];

  const push = (
    kind: string,
    dropped: RetrievalDocument[],
    keptCount: number,
    cap: number,
  ) => {
    for (const d of dropped) {
      overflow.push({
        kind,
        url: d.url,
        name: d.title,
        company: d.queryTag || "",
        reason: "capped",
        cap,
        keptCount,
      });
    }
  };

  push("article", topicArts.slice(cfg.topicArtCap), topicKept.length + companyKept.length, cfg.articleCap);
  push(
    "article",
    companyArts.slice(Math.max(0, cfg.articleCap - Math.min(topicArts.length, cfg.topicArtCap))),
    topicKept.length + companyKept.length,
    cfg.articleCap,
  );
  push("email_link", emailLinks.slice(cfg.emailLinkCap), emailKept.length, cfg.emailLinkCap);
  push("document", pdfs.slice(cfg.docCap), pdfKept.length, cfg.docCap);

  return { kept, overflow };
}

/** Deduplicate by urlKey, preserving first occurrence. */
export function dedupeRetrievalDocs(docs: RetrievalDocument[]): RetrievalDocument[] {
  const seen = new Set<string>();
  const out: RetrievalDocument[] = [];
  for (const d of docs) {
    if (!d.urlKey || seen.has(d.urlKey)) continue;
    seen.add(d.urlKey);
    out.push(d);
  }
  return out;
}
