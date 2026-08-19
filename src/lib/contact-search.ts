// Contact list search: name-first matching with nicknames, Last/First order,
// accents, and relevance ranking. Company + email still match, but rank lower.
// Pure — safe client-side / fixture-testable.

import type { Contact } from "@/lib/types";

/** Fold for comparison: lowercase, strip diacritics, keep punctuation for tokenizing. */
export function foldSearchText(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

/**
 * Common given-name aliases. Bidirectional: "Mike" finds Michael, "Christopher"
 * finds Chris. Prefix matching already covers Chris → Christopher.
 */
const NICK_GROUPS: string[][] = [
  ["alex", "alexander", "alexandra", "alexis"],
  ["andy", "andrew"],
  ["ben", "benjamin"],
  ["bill", "billy", "will", "william", "willy"],
  ["bob", "bobby", "rob", "robert", "robbie"],
  ["cate", "cathy", "kate", "katie", "katherine", "catherine", "kathy"],
  ["chris", "christopher", "christine", "christina"],
  ["dan", "danny", "daniel"],
  ["dave", "david"],
  ["dick", "richard", "rich", "rick"],
  ["ed", "eddie", "edward", "ted", "teddy"],
  ["beth", "liz", "lizzie", "elizabeth", "eliza"],
  ["frank", "francis", "frankie"],
  ["hank", "henry"],
  ["jack", "john", "johnny"],
  ["jon", "jonathan", "jonny"],
  ["jake", "jacob"],
  ["jen", "jenny", "jenn", "jennifer"],
  ["jerry", "jeremy", "jerome", "gerald"],
  ["jim", "jimmy", "james", "jamie"],
  ["joe", "joseph", "joey"],
  ["larry", "lawrence"],
  ["matt", "matthew", "matty"],
  ["meg", "megan", "meghan", "margaret", "maggie", "peggy"],
  ["mike", "michael", "mick", "mickey"],
  ["ann", "anne", "anna"],
  ["nate", "nathan", "nathaniel"],
  ["nick", "nicholas", "nicolas"],
  ["pat", "patrick", "patricia", "paddy", "trish"],
  ["pete", "peter"],
  ["ray", "raymond"],
  ["ron", "ronald", "ronnie"],
  ["sam", "samuel", "samantha", "sammy"],
  ["steve", "steven", "stephen", "stevie"],
  ["sue", "susan", "suzanne", "susie"],
  ["tim", "timothy", "timmy"],
  ["tom", "thomas", "tommy"],
  ["tony", "anthony"],
  ["vicky", "victoria", "vicki"],
  ["zach", "zack", "zachary"],
];

const NICKNAMES: Record<string, string[]> = (() => {
  const map: Record<string, string[]> = {};
  for (const group of NICK_GROUPS) {
    for (const name of group) {
      const others = group.filter((n) => n !== name);
      const prev = map[name] || [];
      map[name] = [...new Set([...prev, ...others])];
    }
  }
  return map;
})();

function aliases(token: string): string[] {
  return NICKNAMES[token] || [];
}

/**
 * Tokens from a person/company string.
 * "Falloon, Chris" → chris, falloon
 * "O'Brien" → o, brien, obrien
 * "Jean-Luc" → jean, luc, jeanluc
 */
export function searchTokens(s: string): string[] {
  const folded = foldSearchText(s);
  if (!folded) return [];
  const chunks = folded.split(",").map((c) => c.trim()).filter(Boolean);
  const ordered = chunks.length >= 2 ? [...chunks.slice(1), chunks[0]] : chunks;
  const out = new Set<string>();
  for (const word of ordered.join(" ").split(/\s+/)) {
    if (!word) continue;
    const parts = word.split(/[^a-z0-9]+/).filter(Boolean);
    for (const p of parts) out.add(p);
    const collapsed = word.replace(/[^a-z0-9]/g, "");
    if (collapsed.length >= 2) out.add(collapsed);
  }
  return [...out];
}

function emailLocalTokens(email: string): string[] {
  const out = new Set<string>();
  for (const raw of (email || "").split(/[;,]/)) {
    const addr = foldSearchText(raw);
    const local = addr.split("@")[0] || "";
    if (!local) continue;
    for (const t of searchTokens(local.replace(/[._+]/g, " "))) out.add(t);
    const collapsed = local.replace(/[^a-z0-9]/g, "");
    if (collapsed.length >= 2) out.add(collapsed);
  }
  return [...out];
}

/** How well a query token matches one candidate token. 0 = no match. */
function tokenScore(queryToken: string, candidate: string): number {
  if (!queryToken || !candidate) return 0;
  if (queryToken === candidate) return 100;
  const qAl = aliases(queryToken);
  const cAl = aliases(candidate);
  if (qAl.includes(candidate) || cAl.includes(queryToken)) return 85;
  // Prefix typeahead: "chris" → christopher (need 2+ chars so "a" isn't everything).
  if (queryToken.length >= 2 && candidate.startsWith(queryToken)) return 80;
  for (const a of qAl) {
    if (candidate.startsWith(a) && a.length >= 3) return 75;
  }
  for (const a of cAl) {
    if (a.startsWith(queryToken) && queryToken.length >= 3) return 75;
  }
  return 0;
}

function bestTokenScore(queryToken: string, candidates: string[]): number {
  let best = 0;
  for (const c of candidates) {
    const s = tokenScore(queryToken, c);
    if (s > best) best = s;
  }
  return best;
}

export type ContactSearchFields = Pick<Contact, "name" | "company" | "email">;

/**
 * Relevance of a contact to a search string. 0 = no match.
 * Bands: 100 exact name, ~90 exact name tokens, ~70–85 nickname/prefix on
 * name, ~50 name+company mix, ~25 company/email only.
 */
export function scoreContactSearch(contact: ContactSearchFields, query: string): number {
  const raw = (query || "").trim();
  if (!raw) return 1;

  const qTokens = searchTokens(raw);
  if (qTokens.length === 0) return 1;

  const nameTokens = searchTokens(contact.name || "");
  const companyTokens = searchTokens(contact.company || "");
  const mailTokens = emailLocalTokens(contact.email || "");

  const nameFold = searchTokens(contact.name || "").join(" ");
  const qFold = qTokens.join(" ");
  if (nameFold && nameFold === qFold) return 100;

  const nameHits = qTokens.map((qt) => bestTokenScore(qt, nameTokens));
  if (nameHits.every((s) => s > 0)) {
    if (nameHits.every((s) => s >= 100)) return 95;
    if (nameHits.every((s) => s >= 85)) return 88;
    return 72 + Math.min(18, Math.round(Math.min(...nameHits) / 10));
  }

  const orgHits = qTokens.map((qt) => {
    const name = bestTokenScore(qt, nameTokens);
    // Company/email: avoid 1–2 char noise ("an", "co") flooding the list.
    const company = qt.length >= 3 ? bestTokenScore(qt, companyTokens) : 0;
    const email = qt.length >= 3 ? bestTokenScore(qt, mailTokens) : 0;
    return { name, org: Math.max(company, email) };
  });

  if (orgHits.every((h) => h.name > 0 || h.org > 0)) {
    if (orgHits.some((h) => h.name > 0)) return 52;
    return 24;
  }

  // Whole-query substring on the folded name (odd punctuation / glued tokens).
  const nameHay = foldSearchText(contact.name || "").replace(/[^a-z0-9]+/g, "");
  const qHay = foldSearchText(raw).replace(/[^a-z0-9]+/g, "");
  if (qHay.length >= 3 && nameHay.includes(qHay)) return 40;

  if (raw.includes("@")) {
    const emails = foldSearchText(contact.email || "");
    if (emails.includes(foldSearchText(raw))) return 30;
  }

  return 0;
}

export function matchesContactSearch(contact: ContactSearchFields, query: string): boolean {
  return scoreContactSearch(contact, query) > 0;
}
