import type { Contact } from "@/lib/types";
import { lastTouchDays } from "@/lib/dashboard-intelligence";

export type ThesisWindow = "30d" | "90d" | "1y" | "max";

export type OpportunityKind =
  | "gap"
  | "concentrated"
  | "elite"
  | "decay"
  | "rising"
  | "falling";

export interface ThesisOpportunity {
  kind: OpportunityKind;
  label: string;
}

export interface ThesisNode {
  id: string;
  name: string;
  temperature: string;
  /** 0–1 position within cell for micro-layout */
  ux: number;
  uy: number;
}

export interface ThesisCell {
  name: string;
  /** Relationship Capital (raw, pre-normalize) */
  rc: number;
  /** 0–100 normalized across theses for area */
  rcIndex: number;
  contactCount: number;
  warmth: number;
  momentum: number;
  freshnessDays: number | null;
  influence: number;
  portcoPaths: number;
  nodes: ThesisNode[];
  opportunities: ThesisOpportunity[];
}

export interface ThesisRect extends ThesisCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

const DAY_MS = 86_400_000;
const TEMP_W: Record<string, number> = { Hot: 3, Warm: 2, Cold: 1, Council: 1.5 };

function windowMs(w: ThesisWindow): number | null {
  if (w === "30d") return 30 * DAY_MS;
  if (w === "90d") return 90 * DAY_MS;
  if (w === "1y") return 365 * DAY_MS;
  return null;
}

function contactActivityMs(c: Contact): number | null {
  const dates = [
    c.lastContact,
    c.dateAdded,
    ...(c.interactions || []).map((i) => i.date),
    ...(c.portCoEngagements || []).map((e) => e.date),
  ].filter(Boolean) as string[];
  let best = -Infinity;
  for (const d of dates) {
    const ms = Date.parse(d);
    if (!Number.isNaN(ms) && ms > best) best = ms;
  }
  return best === -Infinity ? null : best;
}

function inWindow(c: Contact, w: ThesisWindow, now = Date.now()): boolean {
  const ms = windowMs(w);
  if (ms == null) return true;
  const act = contactActivityMs(c);
  if (act == null) {
    // No activity stamp — include at half weight via caller; still "in" for Max only
    return w === "max";
  }
  return now - act <= ms;
}

function freshnessFactor(days: number | null): number {
  if (days == null) return 0.55;
  if (days <= 21) return 1.15;
  if (days <= 45) return 1;
  if (days <= 90) return 0.75;
  if (days <= 180) return 0.5;
  return 0.35;
}

function contactRc(c: Contact): number {
  const temp = TEMP_W[c.temperature] ?? 1;
  const days = lastTouchDays(c);
  const fresh = freshnessFactor(days);
  const intros = c.portCoIntros?.length ?? 0;
  const diversity = 1 + Math.min(0.5, intros * 0.08);
  const events = (c.eventsAttended?.length ?? 0) * 0.05;
  const followUpPenalty = c.followUpPending ? 0.85 : 1;
  return temp * fresh * diversity * (1 + events) * followUpPenalty;
}

function influenceScore(c: Contact): number {
  const portcos = new Set(c.portCoIntros || []).size;
  const events = c.eventsAttended?.length ?? 0;
  return (portcos >= 2 ? portcos : 0) + (events >= 2 ? 1 : 0);
}

/** Build thesis cells for a window. */
export function buildThesisCells(contacts: Contact[], window: ThesisWindow): ThesisCell[] {
  const now = Date.now();
  const priorMs = windowMs(window);
  const grouped = new Map<string, Contact[]>();

  for (const c of contacts) {
    const name = (c.sector || "").trim();
    if (!name) continue;
    const arr = grouped.get(name) || [];
    arr.push(c);
    grouped.set(name, arr);
  }

  const cells: ThesisCell[] = [];

  for (const [name, list] of grouped) {
    // Weight: full RC if active in window (or Max), else 0.45× for stale members
    let rc = 0;
    let hotWarm = 0;
    let influence = 0;
    const freshnessVals: number[] = [];
    const portcos = new Set<string>();

    for (const c of list) {
      const activeNow = window === "max" || inWindow(c, window, now);
      const weight = activeNow ? 1 : 0.45;
      rc += contactRc(c) * weight;
      if (c.temperature === "Hot" || c.temperature === "Warm") hotWarm += 1;
      influence += influenceScore(c);
      const d = lastTouchDays(c);
      if (d != null) freshnessVals.push(d);
      for (const p of c.portCoIntros || []) if (p.trim()) portcos.add(p.trim());
    }

    // Prior-window RC for momentum
    let priorRc = 0;
    if (priorMs != null) {
      const priorStart = now - 2 * priorMs;
      const priorEnd = now - priorMs;
      for (const c of list) {
        const act = contactActivityMs(c);
        if (act != null && act >= priorStart && act < priorEnd) {
          priorRc += contactRc(c);
        } else if (act != null && act < priorStart) {
          priorRc += contactRc(c) * 0.35;
        }
      }
    }
    const momentum =
      priorRc <= 0 ? (rc > 0 ? 100 : 0) : Math.round(((rc - priorRc) / Math.max(priorRc, 0.01)) * 100);

    const freshnessDays =
      freshnessVals.length === 0
        ? null
        : [...freshnessVals].sort((a, b) => a - b)[Math.floor(freshnessVals.length / 2)]!;

    // Micro-nodes: top contacts by RC, capped
    const ranked = [...list]
      .map((c) => ({ c, score: contactRc(c) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 14);

    const nodes: ThesisNode[] = ranked.map((r, i) => {
      const n = ranked.length;
      const ang = (i / Math.max(n, 1)) * Math.PI * 2 - Math.PI / 2;
      const rad = 0.22 + (i % 3) * 0.12;
      return {
        id: r.c.id,
        name: r.c.name,
        temperature: r.c.temperature,
        ux: 0.5 + Math.cos(ang) * rad,
        uy: 0.5 + Math.sin(ang) * rad * 0.85,
      };
    });

    cells.push({
      name,
      rc,
      rcIndex: 0,
      contactCount: list.length,
      warmth: list.length ? Math.round((hotWarm / list.length) * 100) : 0,
      momentum,
      freshnessDays,
      influence,
      portcoPaths: portcos.size,
      nodes,
      opportunities: [],
    });
  }

  const maxRc = Math.max(...cells.map((c) => c.rc), 0.0001);
  for (const c of cells) {
    c.rcIndex = Math.round((c.rc / maxRc) * 100);
  }

  const totalRc = cells.reduce((s, c) => s + c.rc, 0) || 1;
  const medianRc =
    [...cells].sort((a, b) => a.rc - b.rc)[Math.floor(cells.length / 2)]?.rc ?? 0;

  for (const c of cells) {
    const share = c.rc / totalRc;
    const ops: ThesisOpportunity[] = [];
    if (share > 0.32) {
      ops.push({ kind: "concentrated", label: "Over-concentrated" });
    }
    if (c.rc < medianRc * 0.55 && c.warmth < 45 && c.contactCount > 0) {
      ops.push({ kind: "gap", label: "Under-covered" });
    }
    if (c.contactCount <= 8 && c.warmth >= 65) {
      ops.push({ kind: "elite", label: "Small · elite" });
    }
    if (c.freshnessDays != null && c.freshnessDays > 90 && c.warmth >= 40) {
      ops.push({ kind: "decay", label: "Cooling" });
    }
    if (c.momentum >= 25) ops.push({ kind: "rising", label: "Rising" });
    if (c.momentum <= -25) ops.push({ kind: "falling", label: "Softening" });
    c.opportunities = ops.slice(0, 2);
  }

  return cells.sort((a, b) => b.rc - a.rc);
}

// ── Squarified treemap (Bruls et al., simplified) ─────────────────

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function worst(row: number[], w: number): number {
  if (!row.length) return Infinity;
  const s = row.reduce((a, b) => a + b, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  return Math.max((w * w * max) / (s * s), (s * s) / (w * w * min));
}

/** Layout cells into rectangles. Area ∝ Relationship Capital. */
export function layoutThesisMosaic(
  cells: ThesisCell[],
  width: number,
  height: number,
  padding = 3,
): ThesisRect[] {
  if (!cells.length) return [];
  const values = cells.map((c) => Math.max(c.rc, 0.01));
  const total = values.reduce((a, b) => a + b, 0);
  const areas = values.map((v) => (v / total) * width * height);

  const result: { cell: ThesisCell; box: Box }[] = [];
  let box: Box = { x: padding, y: padding, w: width - padding * 2, h: height - padding * 2 };
  let row: number[] = [];
  let rowCells: ThesisCell[] = [];
  let remaining = [...areas];
  let remainingCells = [...cells];

  const flush = (vertical: boolean) => {
    if (!row.length) return;
    const sum = row.reduce((a, b) => a + b, 0);
    if (vertical) {
      const rowW = sum / box.h;
      let y = box.y;
      row.forEach((a, i) => {
        const h = a / rowW;
        result.push({
          cell: rowCells[i]!,
          box: { x: box.x, y, w: rowW, h },
        });
        y += h;
      });
      box = { x: box.x + rowW, y: box.y, w: box.w - rowW, h: box.h };
    } else {
      const rowH = sum / box.w;
      let x = box.x;
      row.forEach((a, i) => {
        const w = a / rowH;
        result.push({
          cell: rowCells[i]!,
          box: { x, y: box.y, w, h: rowH },
        });
        x += w;
      });
      box = { x: box.x, y: box.y + rowH, w: box.w, h: box.h - rowH };
    }
    row = [];
    rowCells = [];
  };

  while (remaining.length) {
    const vertical = box.h >= box.w;
    const side = vertical ? box.h : box.w;
    const next = remaining[0]!;
    const nextCell = remainingCells[0]!;
    if (!row.length) {
      row = [next];
      rowCells = [nextCell];
      remaining = remaining.slice(1);
      remainingCells = remainingCells.slice(1);
      continue;
    }
    const withNext = [...row, next];
    if (worst(withNext, side) <= worst(row, side)) {
      row = withNext;
      rowCells = [...rowCells, nextCell];
      remaining = remaining.slice(1);
      remainingCells = remainingCells.slice(1);
    } else {
      flush(vertical);
    }
  }
  flush(box.h >= box.w);

  // Gap between cells
  const gap = 2;
  return result.map(({ cell, box: b }) => ({
    ...cell,
    x: b.x + gap / 2,
    y: b.y + gap / 2,
    w: Math.max(0, b.w - gap),
    h: Math.max(0, b.h - gap),
  }));
}

export function warmthFill(warmth: number): string {
  if (warmth >= 60) return "oklch(0.55 0.12 163 / 0.55)";
  if (warmth >= 35) return "oklch(0.68 0.12 85 / 0.5)";
  return "oklch(0.55 0.1 250 / 0.42)";
}

export function momentumStroke(momentum: number): string {
  if (momentum >= 25) return "oklch(0.55 0.16 155)";
  if (momentum <= -25) return "oklch(0.55 0.18 25)";
  return "var(--color-border)";
}
