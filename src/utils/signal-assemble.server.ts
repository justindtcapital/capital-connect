/**
 * Phase 3 Stage C (head) — turn validated extracts into StoredSignal candidates.
 * Clustering / resolve / novelty / gates stay in processCandidatesIntoEvents.
 * Outreach drafting is intentionally NOT done here.
 */

import type { StoredSignal } from "./signal-store.server";
import { keyForStored } from "./signal-store.server";
import { newsSourceType } from "@/lib/signal-feed";
import { categoryFromEventType } from "@/lib/signal-extract";
import type { DocumentExtractResult } from "./signal-extract.server";

export function storedFromExtract(
  row: DocumentExtractResult,
  dateFound: string,
  portcoNames: Set<string>,
): StoredSignal | null {
  const { doc, extract } = row;
  if (!extract || !doc.url) return null;
  const company = extract.subjectCompany;
  const isPortco = portcoNames.has(company.trim().toLowerCase());
  const category = categoryFromEventType(extract.eventType);
  const signal =
    extract.summary ||
    `${company}: ${extract.eventType.replace(/_/g, " ")}${
      extract.magnitude ? ` (${extract.magnitude.verbatim})` : ""
    }`;
  const mentioned =
    extract.mentionedCompanies.length > 0
      ? `Also mentioned: ${extract.mentionedCompanies.slice(0, 5).join(", ")}.`
      : "";
  const magNote = extract.magnitude
    ? `Magnitude ${extract.magnitude.verbatim} (validated).`
    : "";
  const s: StoredSignal = {
    id: "",
    dateFound,
    type: "awareness",
    status: "New",
    person: "",
    company,
    email: "",
    category,
    signal,
    sourceUrl: doc.url,
    subject: doc.title || signal.slice(0, 120),
    body: "",
    relevance: 0,
    justification: [
      `Stage B extract · ${extract.eventType}`,
      extract.subjectQuote ? `Subject quote: “${extract.subjectQuote}”` : "",
      magNote,
      mentioned,
      extract.discarded.length ? `Discarded claims: ${extract.discarded.slice(0, 3).join("; ")}` : "",
    ]
      .filter(Boolean)
      .join(" — "),
    urgency: "Medium",
    timing: extract.publishedClaimDate || doc.publishedAt || "",
    sourceType: newsSourceType(category, isPortco, doc.url),
    docUrl: doc.kind === "drive_pdf" || doc.kind === "gmail_pdf" ? doc.url : "",
    hasBody: false,
    scoreBreakdown: JSON.stringify({
      pipeline: "v3_stage_b",
      eventType: extract.eventType,
      subjectQuote: extract.subjectQuote,
      mentioned: extract.mentionedCompanies,
      magnitude: extract.magnitude,
      discarded: extract.discarded,
      parts: [
        {
          name: "extract_subject",
          value: 1,
          why: `Validated subject “${company}” via quote in document`,
        },
      ],
    }).slice(0, 4000),
  };
  s.id = keyForStored(s);
  return s;
}

/** Map successful extracts to awareness candidates (exhaustive — no display caps). */
export function candidatesFromExtracts(
  results: DocumentExtractResult[],
  dateFound: string,
  portcoNames: Set<string>,
): StoredSignal[] {
  const out: StoredSignal[] = [];
  for (const r of results) {
    const s = storedFromExtract(r, dateFound, portcoNames);
    if (s) out.push(s);
  }
  return out;
}
