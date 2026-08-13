/**
 * Phase 4.3 — Founder / executive movement detection (pure).
 */

export interface KnownPerson {
  name: string;
  email?: string;
  company?: string;
  title?: string;
}

export interface RoleChangeClaim {
  name: string;
  roleChange: string;
  quote: string;
  /** Story company from the extract. */
  storyCompany: string;
  sourceUrl?: string;
}

export type MovementKind = "founder_movement" | "exec_change";

export interface MovementHit {
  kind: MovementKind;
  personName: string;
  company: string;
  priorCompany?: string;
  titleHint: string;
  quote: string;
  origin: "extraction" | "crm";
  why: string;
  /** Materiality prior hint (founder 9 / exec 6). */
  prior: number;
}

const FOUNDER_RE =
  /\b(founder|co-?founder|founding\s+(ceo|cto|engineer)|owner)\b/i;
const EXEC_RE =
  /\b(ceo|cto|cfo|coo|ciso|cpo|chief\s+\w+|vp\b|vice\s+president|head\s+of|president)\b/i;

function normName(s: string): string {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function looksFounder(title: string, roleChange: string): boolean {
  return FOUNDER_RE.test(title) || FOUNDER_RE.test(roleChange);
}

/**
 * Stage B extraction lane: validated people[].role_change against tracked persons.
 */
export function detectExtractMovements(
  claims: RoleChangeClaim[],
  known: KnownPerson[],
): MovementHit[] {
  const byName = new Map(known.map((k) => [normName(k.name), k]));
  const hits: MovementHit[] = [];

  for (const c of claims) {
    const name = (c.name || "").trim();
    if (!name || !(c.roleChange || "").trim()) continue;
    const knownP = byName.get(normName(name));
    const titleBlob = `${c.roleChange} ${knownP?.title || ""}`;
    const isFounder = looksFounder(titleBlob, c.roleChange);
    const isExec = isFounder || EXEC_RE.test(titleBlob);
    if (!isExec) continue;

    const left =
      /\b(left|resign|depart|stepped\s+down|exits?|departed)\b/i.test(c.roleChange) ||
      (knownP?.company &&
        c.storyCompany &&
        normName(knownP.company) !== normName(c.storyCompany));

    hits.push({
      kind: isFounder ? "founder_movement" : "exec_change",
      personName: name,
      company: c.storyCompany || knownP?.company || "",
      priorCompany: knownP?.company,
      titleHint: c.roleChange,
      quote: c.quote,
      origin: "extraction",
      why: left
        ? `${name} role change vs network record — ${c.roleChange}`
        : `${name}: ${c.roleChange}`,
      prior: isFounder ? 9 : 6,
    });
  }
  return hits;
}

/**
 * CRM lane: title or company drift vs a prior snapshot.
 * Caller supplies previous employment from sheet/cache when available.
 */
export function detectCrmMovements(
  current: KnownPerson[],
  previous: KnownPerson[],
): MovementHit[] {
  const prevByEmail = new Map(
    previous.filter((p) => p.email).map((p) => [p.email!.trim().toLowerCase(), p]),
  );
  const prevByName = new Map(previous.map((p) => [normName(p.name), p]));
  const hits: MovementHit[] = [];

  for (const cur of current) {
    const prev =
      (cur.email && prevByEmail.get(cur.email.trim().toLowerCase())) ||
      prevByName.get(normName(cur.name));
    if (!prev) continue;
    const companyChanged =
      Boolean(prev.company && cur.company) &&
      normName(prev.company!) !== normName(cur.company!);
    const titleChanged =
      Boolean(prev.title && cur.title) &&
      normName(prev.title!) !== normName(cur.title!);
    if (!companyChanged && !titleChanged) continue;

    const blob = `${cur.title || ""} ${prev.title || ""}`;
    const isFounder = looksFounder(blob, "") || looksFounder(prev.title || "", "");
    if (!isFounder && !EXEC_RE.test(blob)) continue;

    hits.push({
      kind: isFounder ? "founder_movement" : "exec_change",
      personName: cur.name,
      company: cur.company || "",
      priorCompany: prev.company,
      titleHint: cur.title || prev.title || "",
      quote: companyChanged
        ? `${prev.company} → ${cur.company}`
        : `${prev.title} → ${cur.title}`,
      origin: "crm",
      why: companyChanged
        ? `${cur.name} moved ${prev.company} → ${cur.company}`
        : `${cur.name} title drift: ${prev.title} → ${cur.title}`,
      prior: isFounder ? 9 : 6,
    });
  }
  return hits;
}
