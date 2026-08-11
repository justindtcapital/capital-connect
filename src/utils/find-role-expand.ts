// Soften Find people-search role criteria across org title ladders.
// Apollo's person_seniorities facet is binary (vp ≠ head ≠ director); orgs
// name the same seat differently. We expand selected chips to a ±1 seniority
// band plus common title synonyms before calling searchPeople.

/** Apollo person_seniorities keys, most-senior → least (matches Find chips). */
export const SENIORITY_ORDER = [
  "owner",
  "founder",
  "c_suite",
  "partner",
  "vp",
  "head",
  "director",
  "manager",
  "senior",
  "entry",
  "intern",
] as const;

export type ApolloSeniority = (typeof SENIORITY_ORDER)[number];

/** Common title strings per Apollo seniority — catch org naming variance. */
export const SENIORITY_TITLE_SYNONYMS: Record<string, string[]> = {
  owner: ["Owner", "Co-Owner", "Business Owner", "Proprietor"],
  founder: ["Founder", "Co-Founder", "Co Founder", "Founding Partner"],
  c_suite: [
    "CEO",
    "CIO",
    "CTO",
    "CISO",
    "CFO",
    "COO",
    "CPO",
    "CMO",
    "CRO",
    "Chief Digital Officer",
    "Chief Data Officer",
    "Chief Information Security Officer",
    "Chief Technology Officer",
    "Chief Information Officer",
    "President",
  ],
  partner: ["Partner", "Managing Partner", "General Partner", "Equity Partner"],
  vp: [
    "VP",
    "Vice President",
    "SVP",
    "Senior Vice President",
    "EVP",
    "Executive Vice President",
    "AVP",
    "Assistant Vice President",
  ],
  head: ["Head of", "Head,", "Global Head", "Head"],
  director: [
    "Director",
    "Senior Director",
    "Managing Director",
    "Executive Director",
    "Associate Director",
  ],
  manager: ["Manager", "Senior Manager", "Group Manager", "Program Manager"],
  senior: ["Senior", "Staff", "Principal", "Lead", "Architect"],
  entry: ["Associate", "Analyst", "Coordinator", "Specialist"],
  intern: ["Intern", "Internship", "Trainee"],
};

/** Expand selected seniorities to each chip ± one adjacent Apollo level. */
export function expandSeniorities(selected: string[]): string[] {
  const out = new Set<string>();
  for (const key of selected) {
    const i = SENIORITY_ORDER.indexOf(key as ApolloSeniority);
    if (i < 0) {
      out.add(key);
      continue;
    }
    out.add(SENIORITY_ORDER[i]);
    if (i > 0) out.add(SENIORITY_ORDER[i - 1]);
    if (i < SENIORITY_ORDER.length - 1) out.add(SENIORITY_ORDER[i + 1]);
  }
  return [...out];
}

/** Title synonyms for the user's selected chips (not the expanded band). */
export function titlesForSeniorities(selected: string[]): string[] {
  const out = new Set<string>();
  for (const key of selected) {
    for (const t of SENIORITY_TITLE_SYNONYMS[key] || []) out.add(t);
  }
  return [...out];
}

/**
 * Merge typed titles with seniority synonym fan-out, and soften seniority to a
 * ±1 band. Synonym titles come from the expanded band (not only the clicked
 * chips) so Apollo's titles∩seniorities AND still catches Head/Director naming
 * when the user picked VP. Deduped for Apollo. Empty inputs stay empty.
 */
export function expandFindRoleQuery(input: {
  titles?: string[];
  seniorities?: string[];
}): { titles: string[]; seniorities: string[] } {
  const typed = (input.titles || []).map((t) => t.trim()).filter(Boolean);
  const selected = (input.seniorities || []).map((s) => s.trim()).filter(Boolean);
  const seniorities = expandSeniorities(selected);
  const titles = [...new Set([...typed, ...titlesForSeniorities(seniorities)])];
  return { titles, seniorities };
}
