import type { SumbleTech } from "@/utils/sumble.server";

/** Persisted company tech-stack payload (Contacts "tech stack" column). */
export interface StoredTechStack {
  v: 1;
  domain?: string;
  fetchedAt: string;
  /** True when Sumble usage enrichment was run and saved. */
  usageChecked?: boolean;
  technologies: SumbleTech[];
}

const LEGACY_SEP = /,/;

/** True when the sheet cell holds rich JSON (vs. a legacy comma list). */
export function isRichTechStack(raw?: string): boolean {
  const s = (raw || "").trim();
  return s.startsWith("{") && s.includes('"technologies"');
}

/**
 * Parse the Contacts "tech stack" cell.
 * Supports rich JSON (v1) and legacy comma-separated technology names.
 */
export function parseTechStackField(raw?: string): StoredTechStack | null {
  const s = (raw || "").trim();
  if (!s) return null;

  if (s.startsWith("{")) {
    try {
      const parsed = JSON.parse(s) as StoredTechStack;
      if (!parsed || !Array.isArray(parsed.technologies)) return null;
      return {
        v: 1,
        domain: parsed.domain,
        fetchedAt: parsed.fetchedAt || "",
        usageChecked: !!parsed.usageChecked,
        technologies: parsed.technologies.filter((t) => t && (t.name || "").trim()),
      };
    } catch {
      // fall through to legacy
    }
  }

  const names = s
    .split(LEGACY_SEP)
    .map((t) => t.trim())
    .filter(Boolean);
  if (names.length === 0) return null;
  return {
    v: 1,
    fetchedAt: "",
    usageChecked: false,
    technologies: names.map((name) => ({ name })),
  };
}

/** Serialize for the Contacts "tech stack" column. */
export function serializeTechStackField(data: {
  domain?: string;
  fetchedAt?: string;
  usageChecked?: boolean;
  technologies: SumbleTech[];
}): string {
  const payload: StoredTechStack = {
    v: 1,
    domain: data.domain,
    fetchedAt: data.fetchedAt || new Date().toISOString(),
    usageChecked: !!data.usageChecked,
    technologies: data.technologies.map((t) => ({
      name: t.name,
      jobsCount: t.jobsCount,
      lastJobPost: t.lastJobPost,
      mentionCount: t.mentionCount,
      usedCount: t.usedCount,
      confidence: t.confidence,
      portcoSimilarity: t.portcoSimilarity,
    })),
  };
  return JSON.stringify(payload);
}

/** Human-readable name list (for toasts / summaries). */
export function techStackNames(raw?: string): string[] {
  const stored = parseTechStackField(raw);
  return stored?.technologies.map((t) => t.name) || [];
}
