import type { Contact } from "@/lib/types";

export type AttentionReason = "overdue" | "stale" | "cooling";

export interface AttentionItem {
  id: string;
  name: string;
  title: string;
  company: string;
  email: string;
  reason: AttentionReason;
  detail: string;
  score: number;
}

export function hasOpenFollowUp(c: Contact): boolean {
  return c.interactions.some((i) => i.isFollowUp && !i.followUpComplete) || !!c.followUpPending;
}

function isPortfolioContact(c: Contact): boolean {
  return (c.sector || "").trim().toLowerCase() === "portfolio";
}

/** Exclude portfolio-tagged people from the Network / Home attention set. */
export function networkContacts(contacts: Contact[]): Contact[] {
  return contacts.filter((c) => !isPortfolioContact(c));
}

/**
 * Score contacts by importance × days-since-touch and surface ones that need
 * action: open follow-ups, important contacts going stale, warm/hot cooling off.
 */
export function buildAttentionQueue(contacts: Contact[]): AttentionItem[] {
  const now = Date.now();
  const DAY = 86_400_000;
  const tempW = (t: string) => (t === "Hot" ? 3 : t === "Warm" ? 2 : 1);
  const lastTouch = (c: Contact): number => {
    let ts = Date.parse(c.lastContact || "") || 0;
    for (const it of c.interactions) {
      const t = Date.parse(it.date || "");
      if (!Number.isNaN(t) && t > ts) ts = t;
    }
    return ts || Date.parse(c.dateAdded || "") || 0;
  };

  const out: AttentionItem[] = [];
  for (const c of contacts) {
    const ts = lastTouch(c);
    const days = ts ? Math.floor((now - ts) / DAY) : 999;
    const importance =
      tempW(c.temperature) + Math.min(c.portCoIntros.length, 5) * 0.6 + (c.activityScore || 0) / 40;
    const open = hasOpenFollowUp(c);

    let reason: AttentionReason | null = null;
    let detail = "";
    if (open) {
      reason = "overdue";
      detail = `Follow-up open · last touch ${days}d ago`;
    } else if (days >= 30 && importance >= 2.5) {
      reason = "stale";
      detail = `Last touch ${days} days ago`;
    } else if ((c.temperature === "Hot" || c.temperature === "Warm") && days >= 10 && days < 30) {
      reason = "cooling";
      detail = `Quiet ${days} days`;
    }
    if (!reason) continue;

    const boost = reason === "overdue" ? 100_000 : 0;
    out.push({
      id: c.id,
      name: c.name,
      title: c.title,
      company: c.company,
      email: c.email,
      reason,
      detail,
      score: boost + importance * days,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}
