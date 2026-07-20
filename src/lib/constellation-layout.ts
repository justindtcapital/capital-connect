import type { Contact } from "@/lib/types";
import {
  isBridgeContact,
  nodeRole,
  type InfluenceBreakdown,
} from "@/lib/constellation-influence";
import { influenceAtHorizon, type TimeHorizon } from "@/lib/constellation-time";
import {
  buildPortCoCanonicalMap,
  canonicalizePortCo,
} from "@/lib/portco-canonical";

export type NodeKind = "person" | "portco";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  temperature?: string;
  sector?: string;
  prime?: string;
  contact?: Contact;
  influence?: InfluenceBreakdown;
  role?: ReturnType<typeof nodeRole>;
  bridge?: boolean;
  ghost?: boolean;
  opportunity?: boolean;
  decay?: boolean;
  x: number;
  y: number;
  r: number;
  halo: number;
  labelX?: number;
  labelY?: number;
  showLabel?: boolean;
  /** SVG text-anchor for outward-facing PortCo labels */
  labelAnchor?: "start" | "middle" | "end";
  /** Polar angle used for label collision pushes */
  angle?: number;
  /** Intro count for PortCo tick marks / active-label gating */
  introCount?: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  strength: 1 | 2 | 3;
  primary: boolean;
}

export const W = 960;
export const H = 480;
export const CX = W / 2;
export const CY = H / 2;
export const HIT_R = 18;
export const PORTCO_RING = 158;
export const PERSON_ORBIT = 52;

function rankScore(c: Contact, influence: InfluenceBreakdown): number {
  return (
    influence.score * 1.2 +
    (c.temperature === "Hot" || c.temperature === "Council" ? 20 : 0) +
    c.portCoIntros.length * 3
  );
}

function edgeStrength(c: Contact): 1 | 2 | 3 {
  if (c.temperature === "Council" || c.temperature === "Hot") return 3;
  if (c.temperature === "Warm") return 2;
  return 1;
}

function coreRadius(score: number, temperature?: string): number {
  const base =
    temperature === "Hot" || temperature === "Council" ? 5.2 : temperature === "Warm" ? 4.4 : 3.4;
  return base + (score / 100) * 1.8;
}

function haloRadius(score: number): number {
  return 6 + (score / 100) * 16;
}

export interface BuildOptions {
  horizon?: TimeHorizon;
  /** When set, reflow people into a solar system around this PortCo */
  orbitPortco?: string | null;
  decayIds?: Set<string>;
  opportunityIds?: Set<string>;
  /**
   * Canonical PortCo names from the Google Sheets "Portfolio Companies" tab.
   * Case-insensitive matching merges intro aliases (e.g. "ibex" → "IBEX").
   * All listed companies appear on the ring, including those with zero intros.
   */
  portfolioPortcos?: string[];
}

/** Deterministic radial layout — PortCos on a ring, people in influence orbits. */
export function buildConstellation(
  contacts: Contact[],
  options: BuildOptions = {},
): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  topPortcos: string[];
  influenceById: Map<string, InfluenceBreakdown>;
} {
  const horizon = options.horizon ?? "today";
  const influenceById = new Map<string, InfluenceBreakdown>();
  const ghostById = new Map<string, boolean>();
  const projectedById = new Map<string, Contact>();

  for (const c of contacts) {
    const { influence, projected, ghost } = influenceAtHorizon(c, contacts, horizon);
    influenceById.set(c.id, influence);
    ghostById.set(c.id, ghost);
    projectedById.set(c.id, projected);
  }

  const ranked = [...contacts].sort(
    (a, b) =>
      rankScore(b, influenceById.get(b.id)!) - rankScore(a, influenceById.get(a.id)!),
  );
  // Cap people for readability; PortCos come from the Portfolio Companies tab (+ any unmatched intros).
  const people = ranked.slice(0, 48);

  const portCoMap = buildPortCoCanonicalMap(options.portfolioPortcos || []);

  const portcoCounts = new Map<string, number>();
  // Seed with every canonical Portfolio Companies row so the ring is complete.
  for (const name of options.portfolioPortcos || []) {
    const canonical = canonicalizePortCo(name, portCoMap) || name.trim();
    if (canonical && !portcoCounts.has(canonical)) portcoCounts.set(canonical, 0);
  }
  for (const c of contacts) {
    const proj = projectedById.get(c.id) || c;
    for (const p of proj.portCoIntros || []) {
      const name = canonicalizePortCo(p, portCoMap) || p.trim();
      if (!name) continue;
      portcoCounts.set(name, (portcoCounts.get(name) || 0) + 1);
    }
  }
  // Prefer sheet order for portfolio names, then any leftover intro-only names by count.
  const sheetOrder = (options.portfolioPortcos || [])
    .map((n) => canonicalizePortCo(n, portCoMap) || n.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  let topPortcos: string[] = [];
  for (const name of sheetOrder) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    topPortcos.push(portCoMap.get(key) || name);
  }
  const extras = [...portcoCounts.entries()]
    .filter(([name]) => !seen.has(name.toLowerCase()))
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
  topPortcos = [...topPortcos, ...extras];

  // Orbit Focus: ensure the focused PortCo is included even if it had zero intros in this horizon
  let orbitTarget = options.orbitPortco?.trim() || null;
  if (orbitTarget) {
    orbitTarget = canonicalizePortCo(orbitTarget, portCoMap) || orbitTarget;
    if (!topPortcos.some((p) => p.toLowerCase() === orbitTarget!.toLowerCase())) {
      topPortcos = [orbitTarget, ...topPortcos];
    }
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const portcoAngle = new Map<string, number>();
  const orbitMode = Boolean(orbitTarget && topPortcos.some((p) => p.toLowerCase() === orbitTarget!.toLowerCase()));
  // Resolve to exact casing used in topPortcos
  if (orbitTarget) {
    orbitTarget =
      topPortcos.find((p) => p.toLowerCase() === orbitTarget!.toLowerCase()) || orbitTarget;
  }

  // Scale ring with count; dual rings when crowded so every PortCo stays visible.
  const nPortcos = topPortcos.length;
  const useDualRing = !orbitMode && nPortcos > 14;
  const ringOuter = Math.min(210, Math.max(PORTCO_RING, 130 + nPortcos * 1.8));
  const ringInner = ringOuter * 0.62;

  topPortcos.forEach((name, i) => {
    let ang: number;
    let ring = ringOuter;
    if (orbitMode && name === orbitTarget) {
      ang = -Math.PI / 2;
      ring = 0;
    } else if (orbitMode) {
      const others = topPortcos.filter((p) => p !== orbitTarget);
      const oi = others.indexOf(name);
      ang = -Math.PI / 2 + ((oi + 0.5) / Math.max(others.length, 1)) * Math.PI * 2;
      ring = ringOuter + 20;
    } else if (useDualRing) {
      const onInner = i % 2 === 0;
      const cohort = topPortcos.filter((_, j) => (j % 2 === 0) === onInner);
      const ci = cohort.indexOf(name);
      ang = -Math.PI / 2 + (ci / Math.max(cohort.length, 1)) * Math.PI * 2;
      // Offset inner ring slightly so labels don't stack on the same rays
      if (onInner) ang += Math.PI / Math.max(cohort.length * 2, 2);
      ring = onInner ? ringInner : ringOuter;
    } else {
      ang = -Math.PI / 2 + (i / Math.max(nPortcos, 1)) * Math.PI * 2;
      ring = ringOuter;
    }
    portcoAngle.set(name, ang);
    const x = ring === 0 ? CX : CX + Math.cos(ang) * ring;
    const y = ring === 0 ? CY : CY + Math.sin(ang) * ring * 0.88;
    const introCount = portcoCounts.get(name) || 0;

    // Outward labels: more pad at poles, hemisphere-aware anchor
    const poleBias = Math.abs(Math.sin(ang));
    const labelPad = ring === 0 ? 0 : 24 + poleBias * 20 + (nPortcos > 18 ? 10 : 0);
    const labelR = ring === 0 ? 0 : ring + labelPad;
    const cos = Math.cos(ang);
    const labelAnchor: "start" | "middle" | "end" =
      ring === 0 ? "middle" : cos > 0.28 ? "start" : cos < -0.28 ? "end" : "middle";

    nodes.push({
      id: `portco:${name}`,
      kind: "portco",
      label: name,
      x,
      y,
      r: ring === 0 ? 12 : Math.max(5.5, 7.5 - Math.min(2, nPortcos / 40) + Math.min(2, introCount * 0.12)),
      halo: ring === 0 ? 22 : 8 + Math.min(12, introCount * 1.0),
      labelX: ring === 0 ? CX : CX + cos * labelR,
      labelY: ring === 0 ? CY + 26 : CY + Math.sin(ang) * labelR * 0.88,
      labelAnchor,
      angle: ang,
      showLabel: introCount > 0 || ring === 0,
      introCount,
    });
  });

  separatePortcoLabels(nodes);

  const buckets = new Map<string, Contact[]>();
  for (const c of people) {
    const proj = projectedById.get(c.id) || c;
    const intros = (proj.portCoIntros || [])
      .map((p) => canonicalizePortCo(p, portCoMap) || p.trim())
      .filter(Boolean);
    let primary =
      intros.find((p) => topPortcos.some((t) => t.toLowerCase() === p.toLowerCase())) ||
      "__orphan__";
    if (primary !== "__orphan__") {
      primary = topPortcos.find((t) => t.toLowerCase() === primary.toLowerCase()) || primary;
    }
    if (orbitMode && orbitTarget && intros.some((p) => p.toLowerCase() === orbitTarget!.toLowerCase())) {
      primary = orbitTarget;
    }
    const arr = buckets.get(primary) || [];
    arr.push(c);
    buckets.set(primary, arr);
  }

  for (const [portcoName, group] of buckets) {
    if (portcoName === "__orphan__") {
      // In orbit mode, orphans stay on the outer rim
      group.forEach((c, i) => {
        const inf = influenceById.get(c.id)!;
        const tSlot =
          c.temperature === "Hot" || c.temperature === "Council"
            ? 0
            : c.temperature === "Warm"
              ? 1
              : 2;
        const ang = Math.PI * 0.15 + tSlot * 0.9 + (i / Math.max(group.length, 1)) * 0.7;
        const radius = (orbitMode ? 240 : 218) + (i % 3) * 16;
        pushPerson(nodes, c, inf, topPortcos, options, ghostById, {
          x: CX + Math.cos(ang) * radius,
          y: CY + Math.sin(ang) * radius * 0.75,
        });
      });
      continue;
    }

    const baseAng = portcoAngle.get(portcoName) ?? 0;
    const portcoNode = nodes.find((n) => n.id === `portco:${portcoName}`);
    const px = portcoNode?.x ?? CX + Math.cos(baseAng) * PORTCO_RING;
    const py = portcoNode?.y ?? CY + Math.sin(baseAng) * PORTCO_RING * 0.88;
    const isFocusOrbit = orbitMode && portcoName === orbitTarget;

    group.forEach((c, i) => {
      const inf = influenceById.get(c.id)!;
      const n = group.length;
      const spread = isFocusOrbit
        ? Math.min(Math.PI * 1.8, 0.4 + n * 0.12)
        : Math.min(1.15, 0.22 + n * 0.08);
      const t = n === 1 ? 0 : (i / (n - 1) - 0.5) * spread;
      const ang = isFocusOrbit ? -Math.PI / 2 + (i / Math.max(n, 1)) * Math.PI * 2 : baseAng + t;
      const orbit =
        (isFocusOrbit ? 72 : PERSON_ORBIT) + (i % 3) * 15 + (inf.score / 100) * 8;
      const x = px + Math.cos(ang) * orbit;
      const y = py + Math.sin(ang) * orbit * (isFocusOrbit ? 0.92 : 0.9);
      const id = `person:${c.id}`;

      pushPerson(nodes, c, inf, topPortcos, options, ghostById, {
        x: Math.max(28, Math.min(W - 28, x)),
        y: Math.max(32, Math.min(H - 32, y)),
      });

      edges.push({
        id: `${id}->portco:${portcoName}`,
        source: id,
        target: `portco:${portcoName}`,
        strength: edgeStrength(c),
        primary: true,
      });

      const proj = projectedById.get(c.id) || c;
      for (const p of proj.portCoIntros || []) {
        const raw = canonicalizePortCo(p, portCoMap) || p.trim();
        const name = topPortcos.find((t) => t.toLowerCase() === raw.toLowerCase());
        if (!name || name === portcoName) continue;
        edges.push({
          id: `${id}->portco:${name}:sec`,
          source: id,
          target: `portco:${name}`,
          strength: 1,
          primary: false,
        });
      }
    });
  }

  for (let iter = 0; iter < 40; iter++) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        // Keep centered orbit PortCo fixed — persons still separate from each other
        if (a.kind === "portco" && b.kind === "portco") continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const min = a.r + b.r + 14 + (a.halo + b.halo) * 0.12;
        if (dist >= min) continue;
        const pushAmt = ((min - dist) / dist) * 0.5;
        dx *= pushAmt;
        dy *= pushAmt;
        // PortCos stay fixed on the ring (especially Orbit Focus center)
        if (a.kind === "person") {
          a.x -= dx;
          a.y -= dy;
        }
        if (b.kind === "person") {
          b.x += dx;
          b.y += dy;
        }
      }
    }
  }

  for (const n of nodes) {
    if (n.kind !== "person") continue;
    n.x = Math.max(28, Math.min(W - 28, n.x));
    n.y = Math.max(32, Math.min(H - 32, n.y));
  }

  return { nodes, edges, topPortcos, influenceById };
}

function pushPerson(
  nodes: GraphNode[],
  c: Contact,
  inf: InfluenceBreakdown,
  topPortcos: string[],
  options: BuildOptions,
  ghostById: Map<string, boolean>,
  pos: { x: number; y: number },
) {
  nodes.push({
    id: `person:${c.id}`,
    kind: "person",
    label: c.name,
    temperature: c.temperature,
    sector: c.sector,
    prime: c.prime,
    contact: c,
    influence: inf,
    role: nodeRole(c),
    bridge: isBridgeContact(c, topPortcos),
    ghost: ghostById.get(c.id) || false,
    opportunity: options.opportunityIds?.has(c.id),
    decay: options.decayIds?.has(c.id),
    x: pos.x,
    y: pos.y,
    r: coreRadius(inf.score, c.temperature),
    halo: haloRadius(inf.score),
  });
}

function separatePortcoLabels(nodes: GraphNode[]) {
  const labels = nodes.filter(
    (n) => n.kind === "portco" && n.labelX != null && n.labelY != null && n.angle != null,
  );
  for (let iter = 0; iter < 28; iter++) {
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i]!;
        const b = labels[j]!;
        let dx = (b.labelX ?? 0) - (a.labelX ?? 0);
        let dy = (b.labelY ?? 0) - (a.labelY ?? 0);
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        // Approximate label footprint from name length
        const min =
          14 +
          Math.min(a.label.length, 12) * 2.4 +
          Math.min(b.label.length, 12) * 2.4;
        if (dist >= min * 0.55) continue;
        // Push both radially outward from canvas center
        const push = ((min * 0.55 - dist) / dist) * 0.35;
        const ax = (a.labelX! - CX) || 0.01;
        const ay = (a.labelY! - CY) || 0.01;
        const bx = (b.labelX! - CX) || 0.01;
        const by = (b.labelY! - CY) || 0.01;
        const aLen = Math.sqrt(ax * ax + ay * ay) || 1;
        const bLen = Math.sqrt(bx * bx + by * by) || 1;
        a.labelX = Math.max(8, Math.min(W - 8, a.labelX! + (ax / aLen) * push * 18));
        a.labelY = Math.max(14, Math.min(H - 10, a.labelY! + (ay / aLen) * push * 14));
        b.labelX = Math.max(8, Math.min(W - 8, b.labelX! + (bx / bLen) * push * 18));
        b.labelY = Math.max(14, Math.min(H - 10, b.labelY! + (by / bLen) * push * 14));
        // Slight tangential split so they don't stay stacked on the same ray
        dx *= push * 0.5;
        dy *= push * 0.5;
        a.labelX -= dx;
        a.labelY -= dy;
        b.labelX += dx;
        b.labelY += dy;
      }
    }
  }
}

export function shortLabel(name: string, max = 14): string {
  if (name.length <= max) return name;
  return `${name.slice(0, max - 1)}…`;
}

/** BFS shortest path on the undirected edge list. */
export function findPath(
  edges: GraphEdge[],
  fromId: string,
  toId: string,
  allowSecondary: boolean,
): string[] | null {
  const paths = findPaths(edges, fromId, toId, allowSecondary, 1);
  return paths[0] || null;
}

function buildAdj(edges: GraphEdge[], allowSecondary: boolean, blocked?: Set<string>) {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!e.primary && !allowSecondary) continue;
    const undirected = `${e.source}|${e.target}`;
    const rev = `${e.target}|${e.source}`;
    if (blocked?.has(undirected) || blocked?.has(rev)) continue;
    const a = adj.get(e.source) || [];
    a.push(e.target);
    adj.set(e.source, a);
    const b = adj.get(e.target) || [];
    b.push(e.source);
    adj.set(e.target, b);
  }
  return adj;
}

function bfsPath(
  adj: Map<string, string[]>,
  fromId: string,
  toId: string,
): string[] | null {
  if (fromId === toId) return [fromId];
  const prev = new Map<string, string | null>();
  const q = [fromId];
  prev.set(fromId, null);
  while (q.length) {
    const cur = q.shift()!;
    if (cur === toId) break;
    for (const next of adj.get(cur) || []) {
      if (prev.has(next)) continue;
      prev.set(next, cur);
      q.push(next);
    }
  }
  if (!prev.has(toId)) return null;
  const path: string[] = [];
  let walk: string | null = toId;
  while (walk) {
    path.push(walk);
    walk = prev.get(walk) ?? null;
  }
  path.reverse();
  return path;
}

/**
 * Up to k alternate paths (primary shortest, then alternatives by excluding
 * one edge from each prior path — lightweight Yen-style).
 */
export function findPaths(
  edges: GraphEdge[],
  fromId: string,
  toId: string,
  allowSecondary: boolean,
  k = 3,
): string[][] {
  if (fromId === toId) return [[fromId]];
  const results: string[][] = [];
  const seen = new Set<string>();
  const blocked = new Set<string>();

  const pushUnique = (path: string[] | null) => {
    if (!path || path.length < 2) return;
    const key = path.join(">");
    if (seen.has(key)) return;
    seen.add(key);
    results.push(path);
  };

  const baseAdj = buildAdj(edges, allowSecondary);
  pushUnique(bfsPath(baseAdj, fromId, toId));

  // Also try with secondary edges if primary-only failed or for richer alts
  if (allowSecondary === false) {
    pushUnique(bfsPath(buildAdj(edges, true), fromId, toId));
  }

  let guard = 0;
  while (results.length < k && guard < 12) {
    guard++;
    const seed = results[results.length - 1];
    if (!seed || seed.length < 2) break;
    let found = false;
    for (let i = 0; i < seed.length - 1; i++) {
      const a = seed[i]!;
      const b = seed[i + 1]!;
      blocked.add(`${a}|${b}`);
      const path = bfsPath(buildAdj(edges, true, blocked), fromId, toId);
      blocked.delete(`${a}|${b}`);
      if (path) {
        const before = results.length;
        pushUnique(path);
        if (results.length > before) {
          found = true;
          break;
        }
      }
    }
    if (!found) break;
  }

  return results.slice(0, k);
}
