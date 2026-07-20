import type { Contact, Interaction } from "@/lib/types";

/** Signed-in DTC teammate profile used for activity-ownership matching. */
export interface TeamProfile {
  email: string;
  /** Display first name for greetings. */
  firstName: string;
  /** Full display name when known. */
  displayName: string;
  /** Lowercased tokens used to match Asana/Gmail Owner fields. */
  nameTokens: string[];
}

// Explicit roster so Owner fields that say "Chris Falloon" match chris.falloon@….
const TEAM: Record<string, { displayName: string; firstName: string; aliases?: string[] }> = {
  "justin.adorante@dell.com": { displayName: "Justin Adorante", firstName: "Justin" },
  "chris.falloon@dell.com": {
    displayName: "Chris Falloon",
    firstName: "Chris",
    aliases: ["falloon, chris", "c. falloon"],
  },
  "julia.beech@dell.com": { displayName: "Julia Beech", firstName: "Julia" },
  "chris.hillock@dell.com": {
    displayName: "Chris Hillock",
    firstName: "Chris",
    aliases: ["hillock, chris"],
  },
};

function titleCaseLocal(local: string): string {
  return local
    .replace(/[._+]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** Build a team profile from the signed-in email (allowlisted or inferred). */
export function teamProfile(email: string | null | undefined): TeamProfile | null {
  if (!email?.trim()) return null;
  const normalized = email.trim().toLowerCase();
  const known = TEAM[normalized];
  const local = normalized.split("@")[0] || "";
  const inferred = titleCaseLocal(local);
  const displayName = known?.displayName || inferred || normalized;
  const firstName = known?.firstName || displayName.split(/\s+/)[0] || "there";
  const nameTokens = new Set<string>();
  nameTokens.add(normalized);
  nameTokens.add(displayName.toLowerCase());
  nameTokens.add(firstName.toLowerCase());
  for (const part of displayName.toLowerCase().split(/\s+/)) {
    if (part.length > 2) nameTokens.add(part);
  }
  for (const a of known?.aliases || []) nameTokens.add(a.toLowerCase());
  // Local-part as a whole token (chris.falloon).
  if (local) nameTokens.add(local);
  return {
    email: normalized,
    firstName,
    displayName,
    nameTokens: [...nameTokens],
  };
}

/** True when an Owner field value refers to this teammate. */
export function ownerMatches(
  ownerField: string | undefined | null,
  profile: TeamProfile,
): boolean {
  const raw = (ownerField || "").trim().toLowerCase();
  if (!raw) return false;
  // Exact email / token hit, or the Owner string contains the full display name / email.
  if (profile.nameTokens.some((t) => t.length >= 3 && (raw === t || raw.includes(t)))) {
    // Guard: single common first names ("chris") alone are too weak unless Owner is short
    // or clearly pairs with the surname / email.
    const weakOnly = profile.nameTokens.filter((t) => !t.includes("@") && !t.includes(" ") && t.length < 6);
    const strong = profile.nameTokens.filter(
      (t) => t.includes("@") || t.includes(" ") || t.includes(".") || t.length >= 6,
    );
    if (strong.some((t) => raw === t || raw.includes(t))) return true;
    // Allow weak first-name match only when Owner is exactly that token.
    if (weakOnly.some((t) => raw === t)) return true;
    return false;
  }
  return false;
}

/**
 * Normalize a Notes sourceRef or BD/GTM Activity GID into a comparable id.
 *   asana:123       → 123
 *   gmail-abc       → gmail-abc
 *   gmail:abc       → gmail-abc
 *   bare asana gid  → bare gid
 */
export function normalizeSourceRefToGid(ref?: string | null): string {
  const r = (ref || "").trim();
  if (!r) return "";
  if (r.startsWith("asana:")) return r.slice("asana:".length).trim();
  if (r.startsWith("gmail:")) return `gmail-${r.slice("gmail:".length).trim()}`;
  return r;
}

/**
 * From BD + GTM sheet rows (header + data), collect Activity GIDs whose Owner
 * matches the signed-in teammate.
 */
export function buildOwnedGidSet(
  sheetTabs: string[][][],
  profile: TeamProfile,
): Set<string> {
  const owned = new Set<string>();
  for (const rows of sheetTabs) {
    if (!rows.length) continue;
    const header = (rows[0] || []).map((h) => h.trim().toLowerCase());
    const gidIdx = header.indexOf("activity gid");
    const ownerIdx = header.indexOf("owner");
    if (gidIdx === -1 || ownerIdx === -1) continue;
    for (const row of rows.slice(1)) {
      const gid = normalizeSourceRefToGid(row[gidIdx] || "");
      const owner = row[ownerIdx] || "";
      if (gid && ownerMatches(owner, profile)) owned.add(gid);
    }
  }
  return owned;
}

/** Contact is "mine" via Notes Owner column or a sourceRef pointing at my activity GIDs. */
export function isMyContact(
  contact: Contact,
  ownedGids: Set<string>,
  profile: TeamProfile,
): boolean {
  for (const i of contact.interactions || []) {
    if (interactionOwnedBy(i, ownedGids, profile)) return true;
  }
  return false;
}

export function interactionOwnedBy(
  i: Pick<Interaction, "sourceRef" | "owner">,
  ownedGids: Set<string>,
  profile: TeamProfile,
): boolean {
  if (ownerMatches(i.owner, profile)) return true;
  const gid = normalizeSourceRefToGid(i.sourceRef);
  return !!gid && ownedGids.has(gid);
}

/** Filter contacts to those attributed to the signed-in user. */
export function filterMyContacts(
  contacts: Contact[],
  ownedGids: Set<string>,
  profile: TeamProfile,
): Contact[] {
  return contacts.filter((c) => isMyContact(c, ownedGids, profile));
}
