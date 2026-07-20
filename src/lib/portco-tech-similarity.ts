import type { PortfolioCompany, PortfolioDomain } from "@/lib/types";

/** One PortCo that offers something related to a detected technology. */
export interface PortcoTechMatch {
  portco: string;
  /** Short note for the UI (e.g. "Comparable competitive set" / "Same focus area"). */
  reason: string;
  /** How we matched: discovery cache, description, or domain affinity. */
  source: "comparable" | "description" | "domain" | "name";
}

export interface PortcoOfferingIndexEntry {
  name: string;
  domain: PortfolioDomain | string;
  sector: string;
  description: string;
  /** Named products/tools from Customer Discovery profile (when cached). */
  comparableTechnologies: string[];
}

/** Normalize for fuzzy equality (GCP ≈ Google Cloud, k8s ≈ Kubernetes). */
const TECH_ALIASES: Record<string, string> = {
  gcp: "google cloud",
  "google cloud platform": "google cloud",
  gcloud: "google cloud",
  azure: "microsoft azure",
  "ms azure": "microsoft azure",
  k8s: "kubernetes",
  "amazon web services": "aws",
  amazon: "aws",
  golang: "go",
  node: "node.js",
  nodejs: "node.js",
  "react.js": "react",
  reactjs: "react",
  vue: "vue.js",
  postgres: "postgresql",
  "ms sql": "microsoft sql server",
  mssql: "microsoft sql server",
  tf: "terraform",
  powerbi: "power bi",
  newrelic: "new relic",
  "palo alto": "palo alto networks",
};

export function normalizeTechKey(name: string): string {
  let s = (name || "").trim().toLowerCase();
  if (!s) return "";
  if (TECH_ALIASES[s]) s = TECH_ALIASES[s];
  return s.replace(/[^a-z0-9+#.]/g, " ").replace(/\s+/g, " ").trim();
}

function tokens(s: string): string[] {
  return normalizeTechKey(s)
    .split(" ")
    .filter((t) => t.length > 2);
}

/** Technologies commonly adjacent to each portfolio focus area. */
const DOMAIN_TECH_AFFINITY: Record<PortfolioDomain, string[]> = {
  Security: [
    "CrowdStrike",
    "Okta",
    "Auth0",
    "Palo Alto Networks",
    "SailPoint",
    "Splunk",
    "Sentry",
  ],
  AI: ["TensorFlow", "PyTorch", "Databricks", "Snowflake", "BigQuery", "Python"],
  Data: [
    "Snowflake",
    "Databricks",
    "BigQuery",
    "dbt",
    "Apache Kafka",
    "Apache Spark",
    "Tableau",
    "Looker",
    "Power BI",
    "Elasticsearch",
    "PostgreSQL",
    "MongoDB",
  ],
  Cloud: [
    "AWS",
    "Google Cloud",
    "Microsoft Azure",
    "Kubernetes",
    "Docker",
    "Terraform",
    "Cloudflare",
    "Datadog",
  ],
  Logistics: ["SAP", "Oracle", "NetSuite", "Salesforce"],
  "Supply Chain": ["SAP", "Oracle", "NetSuite", "Salesforce", "ServiceNow"],
  Silicon: ["Python", "C#", "Go", "Kubernetes"],
};

function techMatchesComparable(techKey: string, comparable: string): boolean {
  const cKey = normalizeTechKey(comparable);
  if (!techKey || !cKey) return false;
  if (techKey === cKey) return true;
  // Containment for multi-word (e.g. "microsoft azure" vs "azure")
  if (techKey.includes(cKey) || cKey.includes(techKey)) {
    const shorter = techKey.length <= cKey.length ? techKey : cKey;
    return shorter.length >= 3;
  }
  return false;
}

function descriptionMentionsTech(description: string, techName: string): boolean {
  const desc = (description || "").toLowerCase();
  if (!desc) return false;
  const key = normalizeTechKey(techName);
  if (key.length >= 3 && desc.includes(key)) return true;
  // Also check raw name and significant tokens
  const raw = techName.toLowerCase();
  if (raw.length >= 3 && new RegExp(`\\b${raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(desc))
    return true;
  return tokens(techName).some((tok) => tok.length >= 4 && desc.includes(tok));
}

/**
 * Build a lightweight offering index from portfolio rows + optional discovery
 * comparable-technology lists (from Customer Discovery cache).
 */
export function buildPortcoOfferingIndex(
  companies: Pick<PortfolioCompany, "name" | "domain" | "sector" | "description">[],
  discoveryComparables?: Map<string, string[]>,
): PortcoOfferingIndexEntry[] {
  return companies
    .filter((c) => (c.name || "").trim())
    .map((c) => {
      const key = c.name.trim().toLowerCase();
      return {
        name: c.name.trim(),
        domain: c.domain,
        sector: c.sector || "",
        description: c.description || "",
        comparableTechnologies: discoveryComparables?.get(key) || [],
      };
    });
}

/**
 * For one technology detected at a prospect/contact company, find PortCos whose
 * offerings (or competitive set) are similar.
 */
export function matchTechToPortcoOfferings(
  techName: string,
  index: PortcoOfferingIndexEntry[],
  max = 4,
): PortcoTechMatch[] {
  const techKey = normalizeTechKey(techName);
  if (!techKey || index.length === 0) return [];

  const matches: PortcoTechMatch[] = [];
  const seen = new Set<string>();

  const push = (m: PortcoTechMatch) => {
    const k = m.portco.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    matches.push(m);
  };

  for (const p of index) {
    // 1. Exact / fuzzy match against Customer Discovery comparable technologies
    for (const comp of p.comparableTechnologies) {
      if (techMatchesComparable(techKey, comp)) {
        push({
          portco: p.name,
          reason: `Similar to tools in ${p.name}'s competitive set (${comp})`,
          source: "comparable",
        });
        break;
      }
    }

    // 2. PortCo name itself is the product/tech (rare but useful)
    if (techMatchesComparable(techKey, p.name)) {
      push({
        portco: p.name,
        reason: `Directly related to portfolio company ${p.name}`,
        source: "name",
      });
    }

    // 3. Offering description mentions this technology / category
    if (descriptionMentionsTech(p.description, techName)) {
      push({
        portco: p.name,
        reason: `Appears related to ${p.name}'s offering`,
        source: "description",
      });
    }

    // 4. Domain affinity — PortCo focus area overlaps this tech's category
    const domain = p.domain as PortfolioDomain;
    const affinity = DOMAIN_TECH_AFFINITY[domain] || [];
    for (const a of affinity) {
      if (techMatchesComparable(techKey, a)) {
        push({
          portco: p.name,
          reason: `Overlaps ${p.name}'s focus area (${p.sector || domain})`,
          source: "domain",
        });
        break;
      }
    }

    if (matches.length >= max * 3) break; // gather then rank
  }

  // Prefer comparable > name > description > domain
  const rank = { comparable: 0, name: 1, description: 2, domain: 3 };
  matches.sort((a, b) => rank[a.source] - rank[b.source]);
  return matches.slice(0, max);
}

/** Annotate a list of technology names with PortCo similarity notes. */
export function annotateTechnologies<T extends { name: string }>(
  techs: T[],
  index: PortcoOfferingIndexEntry[],
): (T & { portcoSimilarity: PortcoTechMatch[] })[] {
  return techs.map((t) => ({
    ...t,
    portcoSimilarity: matchTechToPortcoOfferings(t.name, index),
  }));
}
