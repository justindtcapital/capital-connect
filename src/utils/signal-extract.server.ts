/**
 * Phase 3 Stage B — batched per-document extraction (LLM, schema-constrained).
 * One call per batch of 10–20 docs; validators dispose of unsupported claims.
 */

import { callGeminiJSON } from "./gemini.server";
import type { RetrievalDocument } from "@/lib/signal-document";
import {
  EXTRACT_JSON_SHAPE,
  validateExtract,
  type ExtractProposal,
  type ValidatedExtract,
} from "@/lib/signal-extract";

export interface DocumentExtractResult {
  doc: RetrievalDocument;
  extract: ValidatedExtract | null;
  raw?: ExtractProposal;
  error?: string;
}

const SYSTEM = `You extract structured venture/news facts from documents for a VC signal reader.
Rules:
- subject_companies: only companies the story is ABOUT (not publishers, not casually mentioned peers). Each MUST include a verbatim quote from the document text.
- mentioned_companies: other company names that appear but are not the subject.
- event_type: closed set only.
- magnitude: only if a number appears; quote must be verbatim from the text.
- people: only when a named person has a role change or is central; quote required.
- Never invent URLs, companies, or numbers not present in the provided text.
- Return JSON matching the schema. One output object per input document, same url.`;

function batchPrompt(docs: RetrievalDocument[]): string {
  const payload = docs.map((d) => ({
    url: d.url,
    title: d.title,
    publishedAt: d.publishedAt,
    source: d.sourceName,
    text: (d.text || d.title || "").slice(0, 6000),
  }));
  return `Extract facts from each document. Schema:
${EXTRACT_JSON_SHAPE}

Documents:
${JSON.stringify(payload, null, 2)}`;
}

/**
 * Run Stage B over documents that have grounding text.
 * PDFs / empty email stubs are skipped (returned with extract=null).
 */
export async function extractDocumentBatch(
  docs: RetrievalDocument[],
  opts?: { batchSize?: number },
): Promise<DocumentExtractResult[]> {
  const batchSize = Math.max(1, Math.min(opts?.batchSize ?? 12, 20));
  const out: DocumentExtractResult[] = [];

  const withText = docs.filter((d) => (d.text || d.title).trim().length >= 40);
  const skipped = docs.filter((d) => (d.text || d.title).trim().length < 40);
  for (const d of skipped) {
    out.push({ doc: d, extract: null, error: "insufficient_grounding_text" });
  }

  for (let i = 0; i < withText.length; i += batchSize) {
    const chunk = withText.slice(i, i + batchSize);
    const r = await callGeminiJSON<{
      documents?: Array<ExtractProposal & { url?: string }>;
    }>(SYSTEM, batchPrompt(chunk), 8192);

    if (!r.ok || !r.data) {
      for (const d of chunk) {
        out.push({ doc: d, extract: null, error: r.error || "extract_failed" });
      }
      continue;
    }

    const byUrl = new Map<string, ExtractProposal & { url?: string }>();
    for (const row of r.data.documents || []) {
      const u = (row.url || "").trim().toLowerCase();
      if (u) byUrl.set(u, row);
    }

    for (const d of chunk) {
      const raw =
        byUrl.get(d.url.trim().toLowerCase()) ||
        [...byUrl.values()].find(
          (x) => (x.url || "").includes(d.urlKey) || d.url.includes(x.url || "___"),
        );
      if (!raw) {
        out.push({ doc: d, extract: null, error: "missing_from_batch_response" });
        continue;
      }
      const grounded = d.text || d.title;
      const extract = validateExtract(raw, grounded);
      out.push({ doc: d, extract, raw, error: extract ? undefined : "validation_failed" });
    }
  }

  return out;
}
