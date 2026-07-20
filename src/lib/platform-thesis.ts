// Investment theses + thesis-screened sourcing matches (/platform Sourcing tab).
//
// Adapted from DealDesk's thesis/target model (reference: dd_theses/dd_targets)
// to this app's architecture: theses live in a "Theses" Sheets tab, screening
// results in "Thesis Matches", and everything runs on-demand — no autonomous
// agents, no heartbeats. Coverage is DealDesk's intermediary-coverage idea
// translated to a VC network: how many warm contacts/targets already sit in a
// thesis's space, computed on read from data we already hold.

import type { Contact, TargetLead } from "./types";

// ── Theses ────────────────────────────────────────────────────────

export type ThesisStatus = "active" | "paused" | "archived";

export const THESIS_STATUSES: ThesisStatus[] = ["active", "paused", "archived"];

/** VC entry-window stages a thesis can screen for (DealDesk used revenue/EBITDA
 *  bands; the equivalent sizing filter for this fund is the funding stage). */
export const THESIS_STAGES = ["Pre-Seed", "Seed", "Series A", "Series B"] as const;

export interface Thesis {
  id: string;
  name: string;
  /** Sectors the thesis covers (e.g. Security, AI, Supply Chain). */
  sectors: string[];
  /** Funding-stage window (subset of THESIS_STAGES; empty = any). */
  stages: string[];
  /** Geographies (free-form: "US", "Israel", "EU"...; empty = anywhere). */
  geos: string[];
  /** Extra matching hooks beyond sectors (e.g. "agentic", "SBOM", "eBPF"). */
  keywords: string[];
  /** What to exclude (free text, fed to the screen prompt verbatim). */
  exclusions: string;
  /** The thesis in the author's own words. */
  narrative: string;
  status: ThesisStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp of the last screen run ("" until first run). */
  lastScreenedAt: string;
}

export interface NewThesis {
  name: string;
  sectors: string[];
  stages: string[];
  geos: string[];
  keywords: string[];
  exclusions: string;
  narrative: string;
}

/** Days after which a thesis's screen results are considered stale (the
 *  "heartbeat" nudge — inverted from DealDesk: it prompts a human, not an agent). */
export const THESIS_STALE_DAYS = 14;

export function thesisIsStale(t: Thesis): boolean {
  if (!t.lastScreenedAt) return true;
  const then = new Date(t.lastScreenedAt).getTime();
  if (!Number.isFinite(then)) return true;
  return Date.now() - then > THESIS_STALE_DAYS * 24 * 60 * 60 * 1000;
}

export function daysSinceScreened(t: Thesis): number | null {
  if (!t.lastScreenedAt) return null;
  const then = new Date(t.lastScreenedAt).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.floor((Date.now() - then) / (24 * 60 * 60 * 1000));
}

/** One-block criteria rendering, shared by the screen prompt and the UI. */
export function thesisCriteriaText(t: Pick<Thesis, "sectors" | "stages" | "geos" | "keywords" | "exclusions" | "narrative">): string {
  const lines = [
    t.sectors.length ? `Sectors: ${t.sectors.join(", ")}` : "",
    t.stages.length ? `Funding stage window: ${t.stages.join(", ")}` : "Funding stage window: Pre-Seed through Series B",
    t.geos.length ? `Geographies: ${t.geos.join(", ")}` : "",
    t.keywords.length ? `Focus keywords: ${t.keywords.join(", ")}` : "",
    t.exclusions.trim() ? `Exclude: ${t.exclusions.trim()}` : "",
    t.narrative.trim() ? `Narrative: ${t.narrative.trim()}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

// ── Thesis matches (screened companies) ───────────────────────────

export type ThesisMatchStatus = "sourced" | "qualified" | "passed" | "promoted";

export const MATCH_STATUSES: ThesisMatchStatus[] = [
  "sourced",
  "qualified",
  "passed",
  "promoted",
];

/** DealDesk rule carried over verbatim: fits under 40 are never saved. */
export const MIN_FIT_SCORE = 40;

export interface ThesisMatch {
  id: string;
  thesisId: string;
  company: string;
  website: string;
  description: string;
  sector: string;
  stage: string;
  geo: string;
  /** 0–100 thesis-fit score from the screen run. */
  fitScore: number;
  /** Why it fits (or where it strains) — cites thesis criteria. */
  fitRationale: string;
  /** Grounded source URL ("" when the claim came from stored signals only). */
  sourceUrl: string;
  /** Where the candidate came from: stored Signal Radar rows or grounded web search. */
  origin: "signals" | "web";
  status: ThesisMatchStatus;
  screenedAt: string;
  screenedBy: string;
}

export function isMatchStatus(v: string): v is ThesisMatchStatus {
  return (MATCH_STATUSES as string[]).includes(v);
}

export function isThesisStatus(v: string): v is ThesisStatus {
  return (THESIS_STATUSES as string[]).includes(v);
}

/** Stable dedupe key for a match within a thesis. */
export function matchKeyOf(m: { thesisId: string; company: string }): string {
  return `${m.thesisId}|${m.company.trim().toLowerCase()}`;
}

/** Chip styling band for a fit score (ported from DealDesk's fitScoreClasses). */
export function fitScoreClasses(score: number | null | undefined): string {
  if (score == null || !Number.isFinite(score))
    return "border-border/70 bg-muted/70 text-muted-foreground";
  if (score >= 80)
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (score >= 60)
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (score >= MIN_FIT_SCORE)
    return "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300";
  return "border-border/70 bg-muted/70 text-muted-foreground";
}

export function matchStatusLabel(status: ThesisMatchStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

// ── Network coverage ──────────────────────────────────────────────
// "Can we act on this thesis through the network?" — counts contacts and
// pipeline targets whose sector/role/company text hits the thesis's hooks.

export interface ThesisCoverage {
  /** Network contacts in the thesis space. */
  contacts: number;
  /** Of those, Hot or Council (strongest paths). */
  warmContacts: number;
  /** Targeting-pipeline leads in the thesis space. */
  targets: number;
}

function coverageHooks(t: Thesis): string[] {
  return [...t.sectors, ...t.keywords]
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 2);
}

function hitsAny(haystack: string, hooks: string[]): boolean {
  return hooks.some((k) => haystack.includes(k));
}

export function thesisCoverage(
  thesis: Thesis,
  contacts: Contact[],
  targets: TargetLead[],
): ThesisCoverage {
  const hooks = coverageHooks(thesis);
  if (hooks.length === 0) return { contacts: 0, warmContacts: 0, targets: 0 };
  let contactCount = 0;
  let warm = 0;
  for (const c of contacts) {
    const hay = `${c.company} ${c.sector} ${c.title} ${(c.areasOfInterest || []).join(" ")}`.toLowerCase();
    if (!hitsAny(hay, hooks)) continue;
    contactCount++;
    if (c.temperature === "Hot" || c.temperature === "Council") warm++;
  }
  let targetCount = 0;
  for (const t of targets) {
    const hay = `${t.company} ${t.sector} ${t.title}`.toLowerCase();
    if (hitsAny(hay, hooks)) targetCount++;
  }
  return { contacts: contactCount, warmContacts: warm, targets: targetCount };
}

/** Contact count per company (lowercased name) — warm-path chips on match rows. */
export function contactCountsByCompany(contacts: Contact[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of contacts) {
    const key = (c.company || "").trim().toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

// ── CSV-ish (de)serialization for Sheets cells ────────────────────

export const LIST_SEP = ",";

export function joinList(items: string[]): string {
  return items.map((s) => s.trim()).filter(Boolean).join(`${LIST_SEP} `);
}

export function splitList(raw: string): string[] {
  return (raw || "")
    .split(LIST_SEP)
    .map((s) => s.trim())
    .filter(Boolean);
}
