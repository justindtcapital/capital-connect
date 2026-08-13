/**
 * Phase 1 — entity resolution ladder (pure, fixture-testable).
 *
 * First hit wins:
 *   1. domain → primary_domain / subdomain
 *   2. cik / atsRef / githubOrg exact (xref)
 *   3. normalized name exact vs canonical or alias (unique)
 *   4. fuzzy containment size-1 + context corroboration
 *   5. ambiguous (candidates listed — never silent attribution)
 *   6. unknown
 */

import { normCompanyKey } from "@/lib/event-cluster";

export type ResolveRung =
  | "domain"
  | "registry_key"
  | "alias_exact"
  | "fuzzy_corroborated"
  | "ambiguous"
  | "unknown";

export interface RegistryEntity {
  entityId: string;
  canonicalName: string;
  primaryDomain?: string;
  aliases?: string[];
  /** Collector / filing keys: ats, github, edgar/cik, … */
  xref?: Record<string, string>;
  sector?: string;
}

export interface EntityRegistry {
  entities: RegistryEntity[];
}

export interface ResolveInput {
  name?: string;
  domain?: string;
  cik?: string;
  atsRef?: string;
  githubOrg?: string;
  context?: {
    sector?: string;
    personNames?: string[];
    /** Known contact company names at candidate entities (corroboration). */
    contactCompanies?: string[];
    geo?: string;
  };
}

export interface ResolveResult {
  entityId?: string;
  canonicalName?: string;
  confidence: number;
  rung: ResolveRung;
  why: string;
  candidates?: Array<{ entityId: string; name: string }>;
}

function hostKey(raw?: string): string {
  const s = (raw || "").trim().toLowerCase().replace(/^www\./, "");
  if (!s) return "";
  try {
    if (/^https?:\/\//i.test(s)) return new URL(s).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    /* fall through */
  }
  return s.split("/")[0] || "";
}

function aliasKeys(e: RegistryEntity): string[] {
  const keys = new Set<string>();
  const canon = normCompanyKey(e.canonicalName);
  if (canon) keys.add(canon);
  for (const a of e.aliases || []) {
    const k = normCompanyKey(a);
    if (k) keys.add(k);
  }
  return [...keys];
}

/** Build a lookup index once per resolve batch. */
export function indexRegistry(registry: EntityRegistry): {
  byDomain: Map<string, RegistryEntity[]>;
  byAlias: Map<string, RegistryEntity[]>;
  byXref: Map<string, RegistryEntity>;
  all: RegistryEntity[];
} {
  const byDomain = new Map<string, RegistryEntity[]>();
  const byAlias = new Map<string, RegistryEntity[]>();
  const byXref = new Map<string, RegistryEntity>();
  for (const e of registry.entities) {
    const d = hostKey(e.primaryDomain);
    if (d) {
      const list = byDomain.get(d) || [];
      list.push(e);
      byDomain.set(d, list);
    }
    for (const k of aliasKeys(e)) {
      const list = byAlias.get(k) || [];
      list.push(e);
      byAlias.set(k, list);
    }
    for (const [xk, xv] of Object.entries(e.xref || {})) {
      const v = (xv || "").trim().toLowerCase();
      if (!v) continue;
      byXref.set(`${xk.toLowerCase()}:${v}`, e);
      if (xk.toLowerCase() === "edgar" || xk.toLowerCase() === "cik") {
        byXref.set(`cik:${v.replace(/^0+/, "")}`, e);
      }
    }
  }
  return { byDomain, byAlias, byXref, all: registry.entities };
}

/**
 * Containment candidate generator (tightened companiesMatch):
 * - exact norm match OR
 * - containment only when both sides ≥ 5 chars AND the longer string's
 *   leftover tokens don't themselves equal another registry entry's key
 */
export function fuzzyCandidates(
  name: string,
  registry: EntityRegistry,
): RegistryEntity[] {
  const needle = normCompanyKey(name);
  if (!needle || needle.length < 2) return [];
  const indexed = indexRegistry(registry);
  const exact = indexed.byAlias.get(needle) || [];
  if (exact.length) return [...new Map(exact.map((e) => [e.entityId, e])).values()];

  const hits: RegistryEntity[] = [];
  for (const e of indexed.all) {
    for (const k of aliasKeys(e)) {
      if (k.length < 5 || needle.length < 5) continue;
      if (k === needle) {
        hits.push(e);
        break;
      }
      if (k.includes(needle) || needle.includes(k)) {
        const longer = k.length >= needle.length ? k : needle;
        const shorter = k.length >= needle.length ? needle : k;
        const leftover = longer.replace(shorter, "").trim();
        // Reject "Scale" ⊂ "Scaled Agile" when leftover tokens hit another entity.
        if (leftover) {
          const leftoverKey = normCompanyKey(leftover);
          const conflict =
            leftoverKey &&
            leftoverKey !== shorter &&
            (indexed.byAlias.get(leftoverKey) || []).some((o) => o.entityId !== e.entityId);
          if (conflict) continue;
        }
        hits.push(e);
        break;
      }
    }
  }
  return [...new Map(hits.map((e) => [e.entityId, e])).values()];
}

function contextAgrees(e: RegistryEntity, input: ResolveInput): boolean {
  const ctx = input.context;
  if (!ctx) return false;
  if (ctx.sector && e.sector && ctx.sector.toLowerCase() === e.sector.toLowerCase()) return true;
  const contacts = ctx.contactCompanies || [];
  for (const c of contacts) {
    if (aliasKeys(e).includes(normCompanyKey(c))) return true;
  }
  return false;
}

export function resolveEntity(input: ResolveInput, registry: EntityRegistry): ResolveResult {
  const idx = indexRegistry(registry);

  // 1. Domain
  const domain = hostKey(input.domain);
  if (domain) {
    const direct = idx.byDomain.get(domain) || [];
    // subdomain of a registered primary domain
    const parentHits: RegistryEntity[] = [];
    if (direct.length === 0) {
      for (const [d, ents] of idx.byDomain) {
        if (domain.endsWith(`.${d}`)) parentHits.push(...ents);
      }
    }
    const hits = [...new Map([...(direct.length ? direct : parentHits)].map((e) => [e.entityId, e])).values()];
    if (hits.length === 1) {
      return {
        entityId: hits[0].entityId,
        canonicalName: hits[0].canonicalName,
        confidence: 0.98,
        rung: "domain",
        why: `domain ${domain} → ${hits[0].canonicalName}`,
      };
    }
    if (hits.length > 1) {
      return {
        confidence: 0.4,
        rung: "ambiguous",
        why: `domain ${domain} matches ${hits.length} entities`,
        candidates: hits.map((e) => ({ entityId: e.entityId, name: e.canonicalName })),
      };
    }
  }

  // 2. Registry keys (cik / ats / github)
  const keyTries: Array<[string, string | undefined]> = [
    ["cik", input.cik],
    ["ats", input.atsRef],
    ["github", input.githubOrg],
  ];
  for (const [kind, raw] of keyTries) {
    const v = (raw || "").trim().toLowerCase();
    if (!v) continue;
    const hit =
      idx.byXref.get(`${kind}:${v}`) ||
      (kind === "cik" ? idx.byXref.get(`cik:${v.replace(/^0+/, "")}`) : undefined);
    if (hit) {
      return {
        entityId: hit.entityId,
        canonicalName: hit.canonicalName,
        confidence: 0.95,
        rung: "registry_key",
        why: `${kind}=${v} → ${hit.canonicalName}`,
      };
    }
  }

  // 3. Alias / canonical exact
  const nameKey = normCompanyKey(input.name || "");
  if (nameKey) {
    const exact = idx.byAlias.get(nameKey) || [];
    const uniq = [...new Map(exact.map((e) => [e.entityId, e])).values()];
    if (uniq.length === 1) {
      return {
        entityId: uniq[0].entityId,
        canonicalName: uniq[0].canonicalName,
        confidence: 0.9,
        rung: "alias_exact",
        why: `name "${input.name}" exact → ${uniq[0].canonicalName}`,
      };
    }
    if (uniq.length > 1) {
      // Context can break a multi-alias tie (two Mercurys + fintech sector).
      const corroborated = uniq.filter((e) => contextAgrees(e, input));
      if (corroborated.length === 1) {
        return {
          entityId: corroborated[0].entityId,
          canonicalName: corroborated[0].canonicalName,
          confidence: 0.85,
          rung: "fuzzy_corroborated",
          why: `name "${input.name}" matched ${uniq.length}; context → ${corroborated[0].canonicalName}`,
          candidates: uniq.map((e) => ({ entityId: e.entityId, name: e.canonicalName })),
        };
      }
      return {
        confidence: 0.4,
        rung: "ambiguous",
        why: `name "${input.name}" exact-matches ${uniq.length} entities`,
        candidates: uniq.map((e) => ({ entityId: e.entityId, name: e.canonicalName })),
      };
    }
  }

  // 4. Fuzzy + corroboration
  if (nameKey) {
    const fuzzy = fuzzyCandidates(input.name || "", registry);
    if (fuzzy.length === 1 && contextAgrees(fuzzy[0], input)) {
      return {
        entityId: fuzzy[0].entityId,
        canonicalName: fuzzy[0].canonicalName,
        confidence: 0.7,
        rung: "fuzzy_corroborated",
        why: `fuzzy "${input.name}" → ${fuzzy[0].canonicalName} (context corroborated)`,
      };
    }
    if (fuzzy.length === 1 && !contextAgrees(fuzzy[0], input)) {
      return {
        confidence: 0.4,
        rung: "ambiguous",
        why: `fuzzy "${input.name}" → single candidate ${fuzzy[0].canonicalName} without corroboration`,
        candidates: [{ entityId: fuzzy[0].entityId, name: fuzzy[0].canonicalName }],
      };
    }
    if (fuzzy.length > 1) {
      return {
        confidence: 0.4,
        rung: "ambiguous",
        why: `fuzzy "${input.name}" → ${fuzzy.length} candidates`,
        candidates: fuzzy.map((e) => ({ entityId: e.entityId, name: e.canonicalName })),
      };
    }
  }

  // 6. Unknown
  return {
    confidence: 0,
    rung: "unknown",
    why: input.name ? `no registry match for "${input.name}"` : "no name or domain to resolve",
  };
}

/** Auto-generate suffix-stripped alias from a display name (seed helper). */
export function autoAliases(name: string): string[] {
  const raw = (name || "").trim();
  if (!raw) return [];
  const out = new Set<string>([raw]);
  const stripped = raw
    .replace(
      /,?\s*\b(Inc\.?|Incorporated|Corp\.?|Corporation|LLC|LLP|Ltd\.?|Limited|Co\.?|Company|Labs|Technologies|Technology|AI)\b\.?$/gi,
      "",
    )
    .trim();
  if (stripped && stripped.toLowerCase() !== raw.toLowerCase()) out.add(stripped);
  return [...out];
}

/** Parse semicolon-separated aliases cell. */
export function parseAliasesCell(raw?: string): string[] {
  return (raw || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function serializeAliases(aliases: string[]): string {
  return [...new Set(aliases.map((a) => a.trim()).filter(Boolean))].join("; ");
}
