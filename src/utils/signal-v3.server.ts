/**
 * Phase 3 V3 hardening helpers — extract-first path, shadow diffs, survivor drafts.
 */

import type { Contact } from "@/lib/types";
import { scoreAttribution } from "@/lib/attribution-score";
import { outreachVerdict } from "@/lib/outreach-gate";
import { proposeRadarEntities } from "@/lib/ecosystem-discovery";
import { detectExtractMovements, type KnownPerson } from "@/lib/exec-movement";
import { BADGE, mergeBadges } from "@/lib/fusion";
import type { DocumentExtractResult } from "./signal-extract.server";
import type { StoredSignal } from "./signal-store.server";
import { keyForStored } from "./signal-store.server";
import { draftEmail } from "./gemini.server";
import { newsSourceType } from "@/lib/signal-feed";

export function subjectAgreementRate(
  extracts: DocumentExtractResult[],
  megaCompanies: string[],
): { agreed: number; compared: number; rate: number | null } {
  const mega = new Set(megaCompanies.map((c) => c.trim().toLowerCase()).filter(Boolean));
  let compared = 0;
  let agreed = 0;
  for (const e of extracts) {
    if (!e.extract) continue;
    compared++;
    if (mega.has(e.extract.subjectCompany.trim().toLowerCase())) agreed++;
  }
  return {
    agreed,
    compared,
    rate: compared > 0 ? agreed / compared : null,
  };
}

/** Best CRM contacts at a company (for survivor attribution). */
export function contactsAtCompany(contacts: Contact[], company: string): Contact[] {
  const key = company.trim().toLowerCase();
  if (!key) return [];
  return contacts.filter((c) => (c.company || "").trim().toLowerCase() === key);
}

/**
 * Stamp NEW_TO_RADAR on awareness rows whose company is outside the roster.
 */
export function stampNewToRadar(
  rows: StoredSignal[],
  rosterNames: Set<string>,
  thesisKeywords: string[],
): StoredSignal[] {
  const proposals = proposeRadarEntities(
    rows.map((r) => ({
      name: r.company,
      evidenceText: `${r.signal} ${r.justification}`,
      source: "extract" as const,
      sourceUrl: r.sourceUrl,
    })),
    rosterNames,
    thesisKeywords,
  );
  const proposeSet = new Set(proposals.map((p) => p.name.trim().toLowerCase()));
  return rows.map((r) => {
    if (!proposeSet.has((r.company || "").trim().toLowerCase())) return r;
    return {
      ...r,
      badges: mergeBadges(r.badges || "", BADGE.newToRadar),
    };
  });
}

/** Movement cards from Stage B people[].role_change. */
export function movementCandidatesFromExtracts(
  results: DocumentExtractResult[],
  known: KnownPerson[],
  dateFound: string,
  portcoNames: Set<string>,
): StoredSignal[] {
  const claims = results.flatMap((r) =>
    (r.extract?.people || [])
      .filter((p) => p.roleChange)
      .map((p) => ({
        name: p.name,
        roleChange: p.roleChange,
        quote: p.quote,
        storyCompany: r.extract!.subjectCompany,
        sourceUrl: r.doc.url,
      })),
  );
  const hits = detectExtractMovements(claims, known);
  const out: StoredSignal[] = [];
  for (const h of hits) {
    const isPortco = portcoNames.has(h.company.trim().toLowerCase());
    const category = "Executive Movement";
    const s: StoredSignal = {
      id: "",
      dateFound,
      type: "awareness",
      status: "New",
      person: h.personName,
      company: h.company,
      email: "",
      category,
      signal: h.why,
      sourceUrl: claims.find((c) => c.name === h.personName)?.sourceUrl || "",
      subject: `${h.personName} — ${h.titleHint}`.slice(0, 120),
      body: "",
      relevance: h.prior,
      justification: `${h.origin} lane · quote: “${h.quote}”`,
      urgency: h.kind === "founder_movement" ? "High" : "Medium",
      timing: dateFound,
      sourceType: newsSourceType(category, isPortco, ""),
      docUrl: "",
      hasBody: false,
      badges: h.kind === "founder_movement" ? BADGE.founderMovement : BADGE.execMovement,
      scoreBreakdown: JSON.stringify({
        pipeline: "v3_movement",
        kind: h.kind,
        origin: h.origin,
        prior: h.prior,
        parts: [{ name: "movement", value: h.prior, why: h.why }],
      }).slice(0, 3000),
    };
    s.id = keyForStored(s);
    out.push(s);
  }
  return out;
}

/**
 * Promote high-rank awareness into outreach recommendations for CRM contacts
 * at the subject company — drafting only for survivors.
 */
export async function draftSurvivorOutreach(
  survivors: StoredSignal[],
  contacts: Contact[],
  opts: {
    portcoNames: Set<string>;
    portfolioSectors: string[];
    minRank: number;
    maxDrafts: number;
  },
): Promise<StoredSignal[]> {
  const eligible = survivors
    .filter((s) => (s.rankScore ?? 0) >= opts.minRank && s.company)
    .sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0))
    .slice(0, opts.maxDrafts * 3);

  const drafted: StoredSignal[] = [];
  for (const s of eligible) {
    if (drafted.length >= opts.maxDrafts) break;
    const atCo = contactsAtCompany(contacts, s.company);
    if (atCo.length === 0) continue;

    let best: { contact: Contact; relevance: number; summary: string } | null = null;
    for (const contact of atCo.slice(0, 5)) {
      const att = scoreAttribution(
        {
          person: contact.name,
          email: contact.email || "",
          company: s.company,
          category: s.category,
          signal: s.signal,
          llmRelevance: 6,
        },
        {
          contact,
          isPortcoCompany: opts.portcoNames.has(s.company.trim().toLowerCase()),
          isWatchlistCompany: false,
          isContactAtPortco: opts.portcoNames.has((contact.company || "").trim().toLowerCase()),
          portfolioSectors: opts.portfolioSectors,
        },
      );
      const verdict = outreachVerdict({
        contact,
        storyCompany: s.company,
        relevance: att.relevance,
        portcoNames: opts.portcoNames,
      });
      if (!verdict.ok) continue;
      if (!best || att.relevance > best.relevance) {
        best = { contact, relevance: att.relevance, summary: att.summary };
      }
    }
    if (!best) continue;

    const draft = await draftEmail({
      contactName: best.contact.name,
      contactCompany: s.company,
      contactTitle: best.contact.title,
      purpose: "Congrats / relationship touch on recent news",
      notes: s.signal,
      tone: "Warm",
      senderName: "[Your name]",
    });
    if (!draft.found || !draft.body) continue;

    const rec: StoredSignal = {
      ...s,
      type: "recommendation",
      person: best.contact.name,
      email: best.contact.email || "",
      subject: draft.subject || `Re: ${s.company}`,
      body: draft.body,
      hasBody: true,
      relevance: best.relevance,
      justification: [best.summary, s.justification].filter(Boolean).join(" — "),
      urgency: "High",
    };
    rec.id = keyForStored(rec);
    drafted.push(rec);
  }
  return drafted;
}
