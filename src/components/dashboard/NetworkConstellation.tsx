import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Contact } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  buildConstellationInsights,
  insightContactIds,
  insightPortcos,
  type ConstellationInsight,
} from "@/lib/constellation-insights";
import {
  buildConstellation,
  findPaths,
  shortLabel,
  CX,
  CY,
  H,
  HIT_R,
  PORTCO_RING,
  W,
  type GraphNode,
} from "@/lib/constellation-layout";
import {
  parseConstellationQuery,
  type ConstellationQueryResult,
} from "@/lib/constellation-query";
import { influenceAtHorizon, TIME_HORIZONS, type TimeHorizon } from "@/lib/constellation-time";
import { useAnimatedNodes } from "@/lib/use-constellation-animation";
import { interpretConstellationQuery } from "@/utils/constellation.functions";

interface NetworkConstellationProps {
  contacts: Contact[];
  /** Canonical names from Google Sheets "Portfolio Companies" tab */
  portfolioPortcos?: string[];
  focusContactId?: string | null;
  onSelectContact: (c: Contact) => void;
  onSelectPortco?: (name: string) => void;
  className?: string;
}

const TEMP_FILL: Record<string, string> = {
  Hot: "oklch(0.645 0.22 25)",
  Warm: "oklch(0.72 0.14 85)",
  Cold: "oklch(0.62 0.12 230)",
  Council: "oklch(0.55 0.08 280)",
};

type TraceState =
  | { mode: "idle" }
  | { mode: "picking"; anchorId: string }
  | {
      mode: "active";
      paths: string[][];
      pathIndex: number;
      fromId: string;
      toId: string;
    };

type AiOverlay = "all" | "decay" | "opportunity" | "blindspots" | "off";
type LabelMode = "active" | "all" | "none";

const LABEL_MODES: { id: LabelMode; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "all", label: "All" },
  { id: "none", label: "None" },
];

function applyQueryResult(
  result: ConstellationQueryResult,
  setAiOverlay: (o: AiOverlay) => void,
  setSelectedId: (id: string | null) => void,
  runTraceBetween: (fromId: string, toId: string) => void,
) {
  if (result.overlay === "decay") setAiOverlay("decay");
  if (result.overlay === "opportunity") setAiOverlay("opportunity");
  if (result.overlay === "blindspots") setAiOverlay("blindspots");
  if (result.overlay === "bridges") setAiOverlay("all");

  if (result.trace) {
    const fromId = result.trace.fromContactId
      ? `person:${result.trace.fromContactId}`
      : result.trace.fromPortco
        ? `portco:${result.trace.fromPortco}`
        : null;
    const toId = result.trace.toContactId
      ? `person:${result.trace.toContactId}`
      : result.trace.toPortco
        ? `portco:${result.trace.toPortco}`
        : null;
    if (fromId && toId) {
      runTraceBetween(fromId, toId);
      return;
    }
  }
  if (result.contactIds[0]) setSelectedId(`person:${result.contactIds[0]}`);
  else if (result.portcos[0]) setSelectedId(`portco:${result.portcos[0]}`);
}

export function NetworkConstellation({
  contacts,
  portfolioPortcos,
  focusContactId,
  onSelectContact,
  onSelectPortco,
  className,
}: NetworkConstellationProps) {
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [traceArmed, setTraceArmed] = useState(false);
  const [trace, setTrace] = useState<TraceState>({ mode: "idle" });
  const [horizon, setHorizon] = useState<TimeHorizon>("today");
  const [orbitPortco, setOrbitPortco] = useState<string | null>(null);
  const [aiOverlay, setAiOverlay] = useState<AiOverlay>("all");
  const [labelMode, setLabelMode] = useState<LabelMode>("active");
  const [diffMode, setDiffMode] = useState(false);
  const [query, setQuery] = useState("");
  const [queryResult, setQueryResult] = useState<ConstellationQueryResult | null>(null);
  const [querySource, setQuerySource] = useState<"gemini" | "local" | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [insightIndex, setInsightIndex] = useState(0);
  const queryRef = useRef<HTMLInputElement>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { nodes: rawNodes, edges, topPortcos, influenceById } = useMemo(
    () => buildConstellation(contacts, { horizon, orbitPortco, portfolioPortcos }),
    [contacts, horizon, orbitPortco, portfolioPortcos],
  );

  const insights = useMemo(
    () => buildConstellationInsights(contacts, topPortcos, influenceById),
    [contacts, topPortcos, influenceById],
  );

  const decayIds = useMemo(() => insightContactIds(insights, "decay"), [insights]);
  const opportunityIds = useMemo(
    () => insightContactIds(insights, "opportunity"),
    [insights],
  );
  const blindPortcos = useMemo(() => insightPortcos(insights), [insights]);

  /** Today vs comparison horizon influence deltas for Diff mode */
  const influenceDelta = useMemo(() => {
    if (!diffMode) return new Map<string, number>();
    const compareHorizon: TimeHorizon = horizon === "today" ? "quarter" : horizon;
    const map = new Map<string, number>();
    for (const c of contacts) {
      const today = influenceAtHorizon(c, contacts, "today").influence.score;
      const past = influenceAtHorizon(c, contacts, compareHorizon).influence.score;
      map.set(c.id, today - past);
    }
    return map;
  }, [contacts, diffMode, horizon]);

  const annotatedNodes = useMemo(
    () =>
      rawNodes.map((n) =>
        n.kind === "person" && n.contact
          ? {
              ...n,
              decay: decayIds.has(n.contact.id),
              opportunity: opportunityIds.has(n.contact.id),
            }
          : n,
      ),
    [rawNodes, decayIds, opportunityIds],
  );

  const nodes = useAnimatedNodes(annotatedNodes, 480);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const focusPersonId = focusContactId ? `person:${focusContactId}` : null;
  const activeFocusId = selectedId || focusPersonId;

  const queryHighlight = useMemo(() => {
    if (!queryResult) return null;
    const people = new Set(queryResult.contactIds.map((id) => `person:${id}`));
    const portcos = new Set(queryResult.portcos.map((p) => `portco:${p}`));
    return { people, portcos, all: new Set([...people, ...portcos]) };
  }, [queryResult]);

  const neighborIds = useMemo(() => {
    const seed = hoverId || activeFocusId;
    if (!seed) return new Set<string>();
    const s = new Set<string>([seed]);
    const showSecondary = Boolean(activeFocusId);
    for (const e of edges) {
      if (!e.primary && !showSecondary) continue;
      if (e.source === seed) s.add(e.target);
      if (e.target === seed) s.add(e.source);
    }
    return s;
  }, [hoverId, activeFocusId, edges]);

  const activeTracePath =
    trace.mode === "active" ? trace.paths[trace.pathIndex] || trace.paths[0] || [] : [];

  const alternateTraceEdges = useMemo(() => {
    if (trace.mode !== "active") return new Set<string>();
    const s = new Set<string>();
    trace.paths.forEach((path, idx) => {
      if (idx === trace.pathIndex) return;
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i]!;
        const b = path[i + 1]!;
        s.add(`${a}|${b}`);
        s.add(`${b}|${a}`);
      }
    });
    return s;
  }, [trace]);

  const tracePathSet = useMemo(() => new Set(activeTracePath), [activeTracePath]);

  const traceEdgeSet = useMemo(() => {
    const s = new Set<string>();
    for (let i = 0; i < activeTracePath.length - 1; i++) {
      const a = activeTracePath[i]!;
      const b = activeTracePath[i + 1]!;
      s.add(`${a}|${b}`);
      s.add(`${b}|${a}`);
    }
    return s;
  }, [activeTracePath]);

  const visibleInsights = useMemo(() => {
    if (aiOverlay === "off") return [] as ConstellationInsight[];
    if (aiOverlay === "all") return insights;
    if (aiOverlay === "decay") return insights.filter((i) => i.kind === "decay");
    if (aiOverlay === "opportunity") return insights.filter((i) => i.kind === "opportunity");
    return insights.filter((i) => i.kind === "blindspot");
  }, [insights, aiOverlay]);

  const activeInsight = visibleInsights[insightIndex % Math.max(visibleInsights.length, 1)];

  const hover = hoverId ? nodeById.get(hoverId) : null;
  const selected = activeFocusId ? nodeById.get(activeFocusId) : null;

  const clearTrace = useCallback(() => {
    setTrace({ mode: "idle" });
    setTraceArmed(false);
  }, []);

  const armTrace = useCallback(() => {
    setTraceArmed(true);
    if (activeFocusId) setTrace({ mode: "picking", anchorId: activeFocusId });
    else setTrace({ mode: "idle" });
  }, [activeFocusId]);

  const runTraceBetween = useCallback(
    (fromId: string, toId: string) => {
      const paths = findPaths(edges, fromId, toId, true, 3);
      if (paths.length) {
        setTrace({ mode: "active", paths, pathIndex: 0, fromId, toId });
        setTraceArmed(false);
        setSelectedId(toId);
      }
    },
    [edges],
  );

  const handleNodeActivate = useCallback(
    (n: GraphNode, openDetail: boolean) => {
      if (traceArmed || trace.mode === "picking") {
        const anchor =
          trace.mode === "picking" ? trace.anchorId : activeFocusId || null;
        if (!anchor) {
          setTrace({ mode: "picking", anchorId: n.id });
          setSelectedId(n.id);
          return;
        }
        if (anchor === n.id) {
          setTrace({ mode: "picking", anchorId: n.id });
          return;
        }
        const paths = findPaths(edges, anchor, n.id, true, 3);
        if (paths.length) {
          setTrace({ mode: "active", paths, pathIndex: 0, fromId: anchor, toId: n.id });
          setTraceArmed(false);
          setSelectedId(n.id);
        } else {
          setTrace({ mode: "picking", anchorId: n.id });
          setSelectedId(n.id);
        }
        return;
      }

      if (openDetail) {
        if (clickTimer.current) {
          clearTimeout(clickTimer.current);
          clickTimer.current = null;
        }
        setSelectedId(n.id);
        if (n.kind === "person" && n.contact) onSelectContact(n.contact);
        if (n.kind === "portco") {
          // Double-click PortCo → Orbit Focus
          setOrbitPortco((prev) => (prev === n.label ? null : n.label));
        }
        return;
      }

      setSelectedId(n.id);
      if (n.kind !== "portco") return;
      if (clickTimer.current) clearTimeout(clickTimer.current);
      clickTimer.current = setTimeout(() => {
        clickTimer.current = null;
        onSelectPortco?.(n.label);
      }, 220);
    },
    [traceArmed, trace, activeFocusId, edges, onSelectContact, onSelectPortco],
  );

  const applyQuery = useCallback(
    async (raw: string, opts?: { useGemini?: boolean }) => {
      const local = parseConstellationQuery(raw, contacts);
      setQueryResult(local);
      setQuerySource(local ? "local" : null);
      if (local) applyQueryResult(local, setAiOverlay, setSelectedId, runTraceBetween);

      // Local-first: only hit Vertex when the user explicitly asks for Gemini.
      // Auto-calling Gemini on every Explore was exhausting quota and blocking
      // the global rate limiter (429 retry storms).
      if (!opts?.useGemini) return;

      const index = contacts.slice(0, 100).map((c) => ({
        id: c.id,
        name: c.name,
        company: c.company || "",
        sector: c.sector || "",
        temperature: c.temperature,
        contactType: c.contactType || "",
        portCos: (c.portCoIntros || []).slice(0, 8),
        prime: c.prime || "",
      }));

      setQueryLoading(true);
      try {
        const ai = await interpretConstellationQuery({ data: { query: raw, index } });
        if (ai.ok && ai.result) {
          setQueryResult(ai.result);
          setQuerySource("gemini");
          applyQueryResult(ai.result, setAiOverlay, setSelectedId, runTraceBetween);
        }
      } catch {
        // keep local result
      } finally {
        setQueryLoading(false);
      }
    },
    [contacts, runTraceBetween],
  );

  const focusInsight = useCallback(
    (ins: ConstellationInsight) => {
      if (ins.contactId) {
        setSelectedId(`person:${ins.contactId}`);
        setQueryResult({
          summary: ins.title,
          contactIds: [ins.contactId],
          portcos: ins.portco ? [ins.portco] : [],
        });
      } else if (ins.portco) {
        setSelectedId(`portco:${ins.portco}`);
        setOrbitPortco(ins.portco);
        setQueryResult({
          summary: ins.title,
          contactIds: [],
          portcos: [ins.portco],
        });
      }
    },
    [],
  );

  useEffect(() => {
    setInsightIndex(0);
  }, [aiOverlay, visibleInsights.length]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName;
      const inField =
        tag === "INPUT" || tag === "TEXTAREA" || (ev.target as HTMLElement)?.isContentEditable;

      if (ev.key === "/" && !inField) {
        ev.preventDefault();
        queryRef.current?.focus();
        return;
      }
      if (inField) {
        if (ev.key === "Escape") {
          (ev.target as HTMLElement).blur();
          setQuery("");
          setQueryResult(null);
        }
        return;
      }
      if (ev.key === "t" || ev.key === "T") {
        ev.preventDefault();
        armTrace();
      }
      if (ev.key === "Escape") {
        clearTrace();
        setSelectedId(null);
        setQueryResult(null);
        setOrbitPortco(null);
      }
      if (ev.key === "f" || ev.key === "F") {
        ev.preventDefault();
        setSelectedId(null);
        clearTrace();
        setOrbitPortco(null);
      }
      if (ev.key === "[" || ev.key === "]") {
        const idx = TIME_HORIZONS.findIndex((h) => h.id === horizon);
        const next =
          ev.key === "]"
            ? TIME_HORIZONS[Math.min(idx + 1, TIME_HORIZONS.length - 1)]
            : TIME_HORIZONS[Math.max(idx - 1, 0)];
        if (next) setHorizon(next.id);
      }
      if ((ev.key === "p" || ev.key === "P") && trace.mode === "active" && trace.paths.length > 1) {
        ev.preventDefault();
        setTrace((t) =>
          t.mode === "active"
            ? { ...t, pathIndex: (t.pathIndex + 1) % t.paths.length }
            : t,
        );
      }
      if (ev.key === "d" || ev.key === "D") {
        ev.preventDefault();
        setDiffMode((v) => !v);
      }
      if ((ev.key === "n" || ev.key === "N") && visibleInsights.length) {
        setInsightIndex((i) => {
          const next = (i + 1) % visibleInsights.length;
          const ins = visibleInsights[next];
          if (ins) focusInsight(ins);
          return next;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armTrace, clearTrace, horizon, visibleInsights, focusInsight, trace]);

  const corridor = useMemo(() => {
    if (trace.mode === "active") {
      const from = nodeById.get(trace.fromId);
      const to = nodeById.get(trace.toId);
      const path = trace.paths[trace.pathIndex] || [];
      const bridges = path
        .map((id) => nodeById.get(id))
        .filter((n): n is GraphNode => Boolean(n && n.kind === "person"));
      return {
        title: "Pulse Trace",
        subtitle: `${from?.label ?? "—"} → ${to?.label ?? "—"}`,
        detail:
          bridges.length > 0
            ? `Path via ${bridges.map((b) => b.label).join(" · ")}`
            : "Direct bond",
        meta: `Route ${trace.pathIndex + 1}/${trace.paths.length} · ${Math.max(0, path.length - 1)} hop${path.length === 2 ? "" : "s"} · ${horizon}${trace.paths.length > 1 ? " · P next route" : ""}`,
        actionHint: "Open a bridge contact or filter the destination PortCo",
      };
    }
    if (selected?.kind === "person" && selected.influence) {
      const delta = selected.contact ? influenceDelta.get(selected.contact.id) : undefined;
      return {
        title: selected.label,
        subtitle: `Influence ${selected.influence.score} · ${selected.influence.momentum}${
          diffMode && delta != null ? ` · Δ ${delta > 0 ? "+" : ""}${delta}` : ""
        }`,
        detail: selected.influence.drivers.join(" · "),
        meta: [
          selected.temperature,
          selected.contact?.title,
          selected.contact?.company,
          selected.bridge ? "Bridge" : null,
          selected.decay ? "Decay alert" : null,
          selected.opportunity ? "Opportunity" : null,
          selected.ghost ? "Not yet present in this time view" : null,
        ]
          .filter(Boolean)
          .join(" · "),
        actionHint: "Double-click to open · T to Pulse Trace · / to ask · D diff",
      };
    }
    if (selected?.kind === "portco") {
      const orbit = edges.filter((e) => e.target === selected.id && e.primary).length;
      return {
        title: selected.label,
        subtitle: orbitPortco === selected.label ? "Orbit Focus" : "Portfolio company",
        detail: `${orbit} primary relationship${orbit === 1 ? "" : "s"} in view`,
        meta: blindPortcos.has(selected.label)
          ? "Blind spot — thin Hot/Warm coverage"
          : "Double-click for Orbit Focus · click to filter dashboard",
        actionHint: "T then pick a person to trace an intro path",
      };
    }
    if (queryResult) {
      return {
        title: queryResult.summary,
        subtitle:
          querySource === "gemini"
            ? "Gemini focus"
            : querySource === "local"
              ? "Local focus"
              : "Natural language focus",
        detail: `${queryResult.contactIds.length} people · ${queryResult.portcos.length} PortCos`,
        meta: "Esc to clear · refine with /",
        actionHint: "Click a highlighted node to inspect",
      };
    }
    return null;
  }, [
    trace,
    selected,
    nodeById,
    edges,
    horizon,
    orbitPortco,
    blindPortcos,
    queryResult,
    querySource,
    diffMode,
    influenceDelta,
  ]);

  const portcoCount = nodes.filter((n) => n.kind === "portco").length;

  if (contacts.length === 0) {
    return (
      <div
        className={cn(
          "flex h-[320px] items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 text-xs text-muted-foreground",
          className,
        )}
      >
        No relationships in the current filter — widen filters or sync Sheets.
      </div>
    );
  }

  const dimWorld = Boolean(
    activeFocusId || hoverId || trace.mode === "active" || queryHighlight,
  );

  const nodeEmphasized = (n: GraphNode) => {
    if (tracePathSet.has(n.id)) return true;
    if (neighborIds.has(n.id)) return true;
    if (queryHighlight?.all.has(n.id)) return true;
    if (aiOverlay !== "off") {
      if (n.kind === "person" && n.decay && (aiOverlay === "all" || aiOverlay === "decay"))
        return true;
      if (
        n.kind === "person" &&
        n.opportunity &&
        (aiOverlay === "all" || aiOverlay === "opportunity")
      )
        return true;
      if (
        n.kind === "portco" &&
        blindPortcos.has(n.label) &&
        (aiOverlay === "all" || aiOverlay === "blindspots")
      )
        return true;
    }
    return false;
  };

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-border/80 bg-[oklch(0.18_0.01_250)] text-foreground shadow-[inset_0_1px_0_oklch(1_0_0/0.04)]",
        className,
      )}
    >
      {/* Top chrome */}
      <div className="absolute top-3 left-3 right-3 z-10 flex flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-wrap gap-2.5 text-[10px] text-white/55 pointer-events-none">
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ background: TEMP_FILL.Hot }} /> Hot
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ background: TEMP_FILL.Warm }} /> Warm
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-primary" /> PortCo
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-full border border-amber-400/70 border-dashed" />{" "}
              Opportunity
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-sky-400/80" /> Decay
            </span>
            <span className="text-white/35">· halo = influence</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex rounded-md border border-white/15 bg-black/30 p-0.5">
              {TIME_HORIZONS.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => setHorizon(h.id)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors",
                    horizon === h.id
                      ? "bg-white/15 text-white"
                      : "text-white/50 hover:text-white/80",
                  )}
                >
                  {h.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 rounded-md border border-white/15 bg-black/30 p-0.5">
              <span className="px-1 text-[9px] uppercase tracking-wide text-white/40">Labels</span>
              {LABEL_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setLabelMode(m.id)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors",
                    labelMode === m.id
                      ? "bg-white/15 text-white"
                      : "text-white/50 hover:text-white/80",
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setDiffMode((v) => !v)}
              className={cn(
                "rounded-md border px-2 py-1 text-[10px] font-medium transition-colors",
                diffMode
                  ? "border-emerald-400/40 bg-emerald-400/15 text-white"
                  : "border-white/15 bg-white/5 text-white/60 hover:bg-white/10",
              )}
              title="Compare Today influence vs selected (or Quarter) horizon"
            >
              Diff · D
            </button>
            <button
              type="button"
              onClick={() =>
                setAiOverlay((o) =>
                  o === "off" ? "all" : o === "all" ? "decay" : o === "decay" ? "opportunity" : o === "opportunity" ? "blindspots" : "off",
                )
              }
              className={cn(
                "rounded-md border px-2 py-1 text-[10px] font-medium transition-colors",
                aiOverlay === "off"
                  ? "border-white/15 bg-white/5 text-white/60"
                  : "border-primary/40 bg-primary/15 text-white",
              )}
            >
              AI · {aiOverlay}
            </button>
            <button
              type="button"
              onClick={() => (traceArmed || trace.mode !== "idle" ? clearTrace() : armTrace())}
              className={cn(
                "rounded-md border px-2 py-1 text-[10px] font-medium transition-colors",
                traceArmed || trace.mode === "picking"
                  ? "border-primary/60 bg-primary/20 text-white"
                  : trace.mode === "active"
                    ? "border-primary/40 bg-primary/10 text-white"
                    : "border-white/15 bg-white/5 text-white/70 hover:bg-white/10",
              )}
            >
              {trace.mode === "active"
                ? "Clear Trace"
                : traceArmed || trace.mode === "picking"
                  ? "Pick endpoint"
                  : "Pulse Trace · T"}
            </button>
            {(activeFocusId || orbitPortco) && (
              <button
                type="button"
                onClick={() => {
                  setSelectedId(null);
                  clearTrace();
                  setOrbitPortco(null);
                  setQueryResult(null);
                }}
                className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[10px] text-white/70 hover:bg-white/10"
              >
                Exit · F
              </button>
            )}
          </div>
        </div>

        {/* NL command — local by default; Gemini only on explicit Ask AI */}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void applyQuery(query);
          }}
        >
          <div className="relative flex-1 min-w-[200px]">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[10px] text-white/35">
              /
            </span>
            <input
              ref={queryRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Explore locally — “bridges”, “cooling”, “connected to Acme”'
              className="w-full rounded-md border border-white/12 bg-black/40 py-1.5 pl-6 pr-3 text-[11px] text-white placeholder:text-white/30 outline-none focus:border-primary/50"
            />
          </div>
          <button
            type="submit"
            className="rounded-md border border-white/15 bg-white/10 px-2.5 py-1 text-[10px] text-white/80 hover:bg-white/15"
          >
            Explore
          </button>
          <button
            type="button"
            disabled={queryLoading || !query.trim()}
            onClick={() => void applyQuery(query, { useGemini: true })}
            className="rounded-md border border-primary/40 bg-primary/15 px-2.5 py-1 text-[10px] text-white hover:bg-primary/25 disabled:opacity-50"
            title="Uses Gemini — only when you need richer NL. Avoid while rate-limited."
          >
            {queryLoading ? "Gemini…" : "Ask AI"}
          </button>
        </form>
      </div>

      {trace.mode === "picking" && (
        <p className="pointer-events-none absolute top-[5.5rem] left-1/2 z-10 -translate-x-1/2 rounded-full border border-primary/30 bg-black/50 px-3 py-1 text-[10px] text-primary backdrop-blur-sm">
          Pulse Trace armed — click the destination node
        </p>
      )}
      {orbitPortco && (
        <p className="pointer-events-none absolute top-[5.5rem] left-1/2 z-10 -translate-x-1/2 rounded-full border border-white/15 bg-black/50 px-3 py-1 text-[10px] text-white/70 backdrop-blur-sm">
          Orbit Focus · {orbitPortco}
        </p>
      )}

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="relative z-0 mt-14 h-[min(56vh,480px)] w-full"
        role="img"
        aria-label="Network constellation intelligence surface"
      >
        <defs>
          <radialGradient id="vp-field" cx="50%" cy="48%" r="60%">
            <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.09" />
            <stop offset="55%" stopColor="oklch(0.22 0.02 250)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="transparent" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="vp-trace" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.15" />
            <stop offset="50%" stopColor="var(--color-primary)" stopOpacity="0.95" />
            <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0.15" />
          </linearGradient>
          <filter id="vp-soft" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="2.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <rect width={W} height={H} fill="oklch(0.16 0.012 250)" />
        <ellipse cx={CX} cy={CY} rx={320} ry={185} fill="url(#vp-field)" className="pointer-events-none" />

        <ellipse
          cx={CX}
          cy={CY}
          rx={orbitPortco ? PORTCO_RING + 28 : PORTCO_RING}
          ry={(orbitPortco ? PORTCO_RING + 28 : PORTCO_RING) * 0.88}
          fill="none"
          stroke="oklch(1 0 0 / 0.06)"
          strokeWidth={1}
          className="pointer-events-none"
        />

        {edges.map((e) => {
          const a = nodeById.get(e.source);
          const b = nodeById.get(e.target);
          if (!a || !b) return null;

          const onTrace = traceEdgeSet.has(`${e.source}|${e.target}`);
          const onAltTrace = !onTrace && alternateTraceEdges.has(`${e.source}|${e.target}`);
          const inFocusNeighborhood =
            !activeFocusId ||
            (neighborIds.has(e.source) && neighborIds.has(e.target));
          const hoverLit =
            !hoverId || (neighborIds.has(e.source) && neighborIds.has(e.target));
          const queryLit =
            queryHighlight &&
            queryHighlight.all.has(e.source) &&
            queryHighlight.all.has(e.target);

          if (
            !e.primary &&
            !onTrace &&
            !onAltTrace &&
            !(activeFocusId && inFocusNeighborhood) &&
            !queryLit
          ) {
            return null;
          }

          let opacity = e.primary ? 0.11 : 0.06;
          let width = e.strength === 3 ? 1.1 : e.strength === 2 ? 0.85 : 0.65;
          let stroke = "oklch(0.92 0.01 250)";

          if (onTrace) {
            opacity = 0.95;
            width = 2.25;
            stroke = "var(--color-primary)";
          } else if (onAltTrace) {
            opacity = 0.28;
            width = 1.15;
            stroke = "oklch(0.75 0.06 250)";
          } else if (queryLit) {
            opacity = 0.45;
            width = 1.3;
          } else if (dimWorld) {
            if (hoverLit && inFocusNeighborhood) {
              opacity = e.primary ? 0.38 : 0.22;
              width = e.primary ? 1.35 : 1;
            } else {
              opacity = 0.025;
            }
          }

          return (
            <line
              key={e.id}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={onTrace ? "url(#vp-trace)" : stroke}
              strokeWidth={width}
              strokeOpacity={opacity}
              strokeDasharray={e.primary || onTrace ? undefined : onAltTrace ? "2 5" : "3 4"}
              className="pointer-events-none transition-[stroke-opacity] duration-200"
              style={
                onTrace
                  ? { filter: "url(#vp-soft)", animation: "vp-trace-pulse 1.4s ease-in-out infinite" }
                  : undefined
              }
            />
          );
        })}

        {nodes
          .filter((n) => {
            if (n.kind !== "portco") return false;
            const forced =
              hoverId === n.id ||
              activeFocusId === n.id ||
              tracePathSet.has(n.id) ||
              (queryHighlight?.all.has(n.id) ?? false);
            if (labelMode === "all") return true;
            if (labelMode === "none") return forced;
            // active: PortCos with intros, plus anything forced into attention
            return forced || (n.introCount ?? 0) > 0 || n.showLabel === true;
          })
          .map((n) => {
            const dimmed = dimWorld && !nodeEmphasized(n);
            const blind =
              blindPortcos.has(n.label) &&
              (aiOverlay === "all" || aiOverlay === "blindspots");
            const anchor = n.labelAnchor ?? "middle";
            return (
              <g key={`label-${n.id}`}>
                <text
                  x={n.labelX ?? n.x}
                  y={n.labelY ?? n.y + 16}
                  textAnchor={anchor}
                  dominantBaseline="middle"
                  fill={blind ? "oklch(0.85 0.08 75)" : "oklch(0.86 0.01 250)"}
                  opacity={dimmed ? 0.18 : 0.9}
                  style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.02em" }}
                  className="pointer-events-none transition-opacity duration-200"
                >
                  {shortLabel(n.label, labelMode === "all" && portcoCount > 24 ? 11 : 14)}
                </text>
                {blind && labelMode !== "none" && (
                  <text
                    x={n.labelX ?? n.x}
                    y={(n.labelY ?? n.y + 16) + 11}
                    textAnchor={anchor}
                    fill="oklch(0.78 0.1 75)"
                    opacity={dimmed ? 0.2 : 0.75}
                    style={{ fontSize: 8 }}
                    className="pointer-events-none"
                  >
                    under-connected
                  </text>
                )}
              </g>
            );
          })}

        {nodes.map((n) => {
          const emphasized = nodeEmphasized(n);
          const dimmed = dimWorld && !emphasized;
          const focused = n.id === activeFocusId || n.contact?.id === focusContactId;
          const hovered = hoverId === n.id;
          const fill =
            n.kind === "portco"
              ? "var(--color-primary)"
              : TEMP_FILL[n.temperature || "Cold"] || TEMP_FILL.Cold;
          const conf = n.influence ? n.influence.confidence / 100 : 0.7;
          const rising = n.influence?.momentum === "rising";
          const showDecay =
            n.decay && (aiOverlay === "all" || aiOverlay === "decay");
          const showOpp =
            n.opportunity && (aiOverlay === "all" || aiOverlay === "opportunity");

          return (
            <g
              key={n.id}
              opacity={n.ghost ? (dimmed ? 0.06 : 0.28) : dimmed ? 0.14 : 1}
              style={{ cursor: "pointer", transition: "opacity 220ms ease" }}
              onPointerEnter={() => setHoverId(n.id)}
              onPointerLeave={() => setHoverId(null)}
              onClick={(ev) => {
                ev.stopPropagation();
                handleNodeActivate(n, false);
              }}
              onDoubleClick={(ev) => {
                ev.stopPropagation();
                handleNodeActivate(n, true);
              }}
            >
              <circle cx={n.x} cy={n.y} r={HIT_R} fill="transparent" />

              {n.kind === "person" && (
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={n.r + n.halo * 0.55}
                  fill={fill}
                  fillOpacity={0.08 + conf * 0.1}
                  stroke={fill}
                  strokeOpacity={0.22 + conf * 0.25}
                  strokeWidth={1}
                  className="pointer-events-none"
                  style={
                    rising && !dimmed
                      ? { animation: "vp-halo-breath 2.8s ease-in-out infinite" }
                      : undefined
                  }
                />
              )}

              {n.kind === "portco" && (
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={n.r + 7}
                  fill="var(--color-primary)"
                  fillOpacity={0.12}
                  className="pointer-events-none"
                />
              )}

              {showOpp && (
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={n.r + 11}
                  fill="none"
                  stroke="oklch(0.82 0.14 85)"
                  strokeWidth={1.2}
                  strokeDasharray="3 3"
                  className="pointer-events-none"
                  style={{ animation: "vp-opp-ignite 2.2s ease-in-out infinite" }}
                />
              )}

              {showDecay && (
                <path
                  d={`M ${n.x + n.r + 6} ${n.y - n.r - 2} l 3 5 l -6 0 z`}
                  fill="oklch(0.7 0.12 230)"
                  opacity={0.9}
                  className="pointer-events-none"
                />
              )}

              {diffMode && n.kind === "person" && n.contact && (() => {
                const delta = influenceDelta.get(n.contact.id) ?? 0;
                if (Math.abs(delta) < 4) return null;
                const gain = delta > 0;
                return (
                  <text
                    x={n.x}
                    y={n.y - n.r - n.halo * 0.35 - 4}
                    textAnchor="middle"
                    fill={gain ? "oklch(0.78 0.14 145)" : "oklch(0.72 0.12 230)"}
                    style={{ fontSize: 8, fontWeight: 600 }}
                    className="pointer-events-none"
                    opacity={dimmed ? 0.2 : 0.9}
                  >
                    {gain ? `+${delta}` : `${delta}`}
                  </text>
                );
              })()}

              {(focused || tracePathSet.has(n.id)) && (
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={n.r + 9}
                  fill="none"
                  stroke="var(--color-primary)"
                  strokeWidth={1.6}
                  strokeOpacity={0.9}
                  className="pointer-events-none"
                />
              )}
              {hovered && !focused && (
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={n.r + 6}
                  fill="none"
                  stroke="oklch(1 0 0 / 0.35)"
                  strokeWidth={1}
                  className="pointer-events-none"
                />
              )}

              {n.bridge && (
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={n.r + 3.5}
                  fill="none"
                  stroke="oklch(1 0 0 / 0.45)"
                  strokeWidth={1}
                  className="pointer-events-none"
                />
              )}

              <circle
                cx={n.x}
                cy={n.y}
                r={n.r}
                fill={fill}
                fillOpacity={
                  n.kind === "portco" ? 0.95 : n.temperature === "Cold" ? 0.72 : 0.92
                }
                stroke="oklch(0.16 0.012 250)"
                strokeWidth={n.kind === "portco" ? 2 : 1}
                className="pointer-events-none"
              />

              {n.role === "investor" && (
                <path
                  d={`M ${n.x - n.r * 0.15} ${n.y - n.r * 0.7}
                      A ${n.r * 0.85} ${n.r * 0.85} 0 1 1 ${n.x - n.r * 0.15} ${n.y + n.r * 0.7}`}
                  fill="none"
                  stroke="oklch(1 0 0 / 0.55)"
                  strokeWidth={1.1}
                  className="pointer-events-none"
                />
              )}
            </g>
          );
        })}
      </svg>

      {/* Insight rail */}
      {visibleInsights.length > 0 && aiOverlay !== "off" && (
        <div className="absolute top-[6.75rem] right-3 z-20 w-[min(100%,220px)] max-h-[42%] overflow-auto rounded-lg border border-white/10 bg-black/55 p-2 backdrop-blur-md">
          <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-white/45 px-1 mb-1.5">
            Insights · N next
          </p>
          <ul className="space-y-1">
            {visibleInsights.slice(0, 6).map((ins, i) => (
              <li key={ins.id}>
                <button
                  type="button"
                  onClick={() => {
                    setInsightIndex(i);
                    focusInsight(ins);
                  }}
                  className={cn(
                    "w-full rounded-md px-2 py-1.5 text-left transition-colors",
                    activeInsight?.id === ins.id
                      ? "bg-primary/20 text-white"
                      : "hover:bg-white/8 text-white/75",
                  )}
                >
                  <span
                    className={cn(
                      "text-[9px] uppercase tracking-wide",
                      ins.kind === "decay"
                        ? "text-sky-300/90"
                        : ins.kind === "opportunity"
                          ? "text-amber-300/90"
                          : ins.kind === "blindspot"
                            ? "text-amber-200/80"
                            : "text-white/50",
                    )}
                  >
                    {ins.kind}
                  </span>
                  <p className="text-[11px] font-medium leading-snug mt-0.5">{ins.title}</p>
                  <p className="text-[10px] text-white/45 leading-snug mt-0.5 line-clamp-2">
                    {ins.detail}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {hover && !corridor && (
        <div className="pointer-events-none absolute bottom-3 left-3 right-3 z-10 sm:right-auto sm:max-w-sm rounded-lg border border-white/10 bg-black/55 px-3 py-2 text-xs text-white shadow-lg backdrop-blur-md">
          <p className="font-semibold truncate">{hover.label}</p>
          {hover.kind === "person" && hover.influence && (
            <p className="text-white/60 truncate mt-0.5">
              Influence {hover.influence.score} · {hover.temperature}
              {hover.bridge ? " · Bridge" : ""}
              {hover.ghost ? " · ghost in this time" : ""}
            </p>
          )}
          {hover.kind === "portco" && (
            <p className="text-white/60 mt-0.5">
              PortCo · click filter · double-click Orbit Focus
            </p>
          )}
        </div>
      )}

      {corridor && (
        <div className="absolute bottom-3 left-3 right-3 z-20 sm:right-auto sm:max-w-md rounded-xl border border-white/12 bg-black/65 px-3.5 py-3 text-xs text-white shadow-xl backdrop-blur-md">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary/90">
                {trace.mode === "active"
                  ? "Pulse Trace"
                  : orbitPortco && selected?.label === orbitPortco
                    ? "Orbit Focus"
                    : queryResult && !selected
                      ? "Query"
                      : "Focus"}
              </p>
              <p className="font-semibold text-sm mt-0.5 truncate">{corridor.title}</p>
              <p className="text-white/70 mt-0.5 truncate">{corridor.subtitle}</p>
              <p className="text-white/50 mt-1 leading-snug">{corridor.detail}</p>
              <p className="text-white/35 mt-1 text-[10px]">{corridor.meta}</p>
              <p className="text-white/45 mt-2 text-[10px]">{corridor.actionHint}</p>
            </div>
            <div className="flex shrink-0 flex-col gap-1">
              {selected?.kind === "person" && selected.contact && (
                <button
                  type="button"
                  className="rounded-md border border-white/15 bg-white/10 px-2 py-1 text-[10px] hover:bg-white/15"
                  onClick={() => onSelectContact(selected.contact!)}
                >
                  Open
                </button>
              )}
              {selected?.kind === "portco" && (
                <>
                  <button
                    type="button"
                    className="rounded-md border border-white/15 bg-white/10 px-2 py-1 text-[10px] hover:bg-white/15"
                    onClick={() => onSelectPortco?.(selected.label)}
                  >
                    Filter
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-primary/40 bg-primary/20 px-2 py-1 text-[10px] hover:bg-primary/30"
                    onClick={() =>
                      setOrbitPortco((p) => (p === selected.label ? null : selected.label))
                    }
                  >
                    {orbitPortco === selected.label ? "Exit orbit" : "Orbit"}
                  </button>
                </>
              )}
              {trace.mode === "active" && (
                <>
                  {trace.paths.length > 1 && (
                    <button
                      type="button"
                      className="rounded-md border border-primary/40 bg-primary/20 px-2 py-1 text-[10px] hover:bg-primary/30"
                      onClick={() =>
                        setTrace((t) =>
                          t.mode === "active"
                            ? { ...t, pathIndex: (t.pathIndex + 1) % t.paths.length }
                            : t,
                        )
                      }
                    >
                      Next route · P
                    </button>
                  )}
                  <button
                    type="button"
                    className="rounded-md border border-white/15 bg-white/10 px-2 py-1 text-[10px] hover:bg-white/15"
                    onClick={clearTrace}
                  >
                    Clear
                  </button>
                </>
              )}
              {!traceArmed && trace.mode === "idle" && activeFocusId && (
                <button
                  type="button"
                  className="rounded-md border border-primary/40 bg-primary/20 px-2 py-1 text-[10px] hover:bg-primary/30"
                  onClick={armTrace}
                >
                  Trace
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes vp-halo-breath {
          0%, 100% { opacity: 0.85; }
          50% { opacity: 1; }
        }
        @keyframes vp-trace-pulse {
          0%, 100% { stroke-opacity: 0.55; }
          50% { stroke-opacity: 1; }
        }
        @keyframes vp-opp-ignite {
          0%, 100% { opacity: 0.45; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
