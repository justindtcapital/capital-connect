import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Clock,
  ExternalLink,
  Lightbulb,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  ScanSearch,
  SearchCheck,
  Target,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import {
  promoteThesisMatchFn,
  runThesisScreen,
  setThesisMatchStatusFn,
  setThesisStatusFn,
} from "@/utils/platform.functions";
import {
  daysSinceScreened,
  fitScoreClasses,
  matchStatusLabel,
  thesisIsStale,
  type Thesis,
  type ThesisCoverage,
  type ThesisMatch,
  type ThesisMatchStatus,
} from "@/lib/platform-thesis";
import { ThesisDialog } from "./ThesisDialog";

const MATCH_STATUS_CLASS: Record<ThesisMatchStatus, string> = {
  sourced: "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900",
  qualified:
    "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
  passed: "bg-muted text-muted-foreground border-border",
  promoted:
    "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-900",
};

// Thesis registry + screened matches: the DealDesk slice worth keeping —
// theses as first-class objects, an on-demand screen (never a heartbeat),
// network coverage counts, and a promote gate into the Targeting pipeline.
export function ThesisPanel({
  theses,
  matches,
  coverage,
  companyContacts,
  userEmail,
  onThesesChanged,
  onMatchesChanged,
  onDiligence,
}: {
  theses: Thesis[];
  matches: ThesisMatch[];
  /** Coverage per thesis id (computed in the loader's deferred bundle). */
  coverage: Record<string, ThesisCoverage>;
  /** Contact count per lowercased company name — warm-path chips on matches. */
  companyContacts: Record<string, number>;
  userEmail: string;
  onThesesChanged: (next: Thesis[]) => void;
  onMatchesChanged: (next: ThesisMatch[]) => void;
  onDiligence: (company: string) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Thesis | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [screeningId, setScreeningId] = useState<string>("");
  const [busyMatchId, setBusyMatchId] = useState<string>("");

  const visible = theses.filter((t) => t.status !== "archived");
  const selected =
    visible.find((t) => t.id === selectedId) ??
    visible.find((t) => t.status === "active") ??
    visible[0];

  const matchesByThesis = useMemo(() => {
    const map = new Map<string, ThesisMatch[]>();
    for (const m of matches) {
      const list = map.get(m.thesisId) ?? [];
      list.push(m);
      map.set(m.thesisId, list);
    }
    return map;
  }, [matches]);

  const screen = async (thesis: Thesis) => {
    setScreeningId(thesis.id);
    try {
      const res = await runThesisScreen({
        data: { thesisId: thesis.id, screenedBy: userEmail },
      });
      const now = new Date().toISOString();
      onMatchesChanged([...res.added, ...matches]);
      onThesesChanged(
        theses.map((t) => (t.id === thesis.id ? { ...t, lastScreenedAt: now } : t)),
      );
      toast.success(
        res.added.length > 0
          ? `${res.added.length} new match${res.added.length !== 1 ? "es" : ""} for "${thesis.name}"${res.duplicates ? ` · ${res.duplicates} already known` : ""}.`
          : `No new matches${res.duplicates ? ` — ${res.duplicates} already known` : ""}.`,
      );
    } catch (e) {
      console.error("runThesisScreen failed", e);
      toast.error(e instanceof Error ? e.message : "Screen failed.");
    } finally {
      setScreeningId("");
    }
  };

  const toggleStatus = async (thesis: Thesis) => {
    const status = thesis.status === "paused" ? "active" : "paused";
    try {
      await setThesisStatusFn({ data: { id: thesis.id, status } });
      onThesesChanged(theses.map((t) => (t.id === thesis.id ? { ...t, status } : t)));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update the thesis.");
    }
  };

  const setMatchStatus = async (match: ThesisMatch, status: ThesisMatchStatus) => {
    setBusyMatchId(match.id);
    try {
      await setThesisMatchStatusFn({ data: { id: match.id, status } });
      onMatchesChanged(matches.map((m) => (m.id === match.id ? { ...m, status } : m)));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update the match.");
    } finally {
      setBusyMatchId("");
    }
  };

  const promote = async (match: ThesisMatch) => {
    setBusyMatchId(match.id);
    try {
      const res = await promoteThesisMatchFn({
        data: { matchId: match.id, promotedBy: userEmail },
      });
      onMatchesChanged(
        matches.map((m) => (m.id === match.id ? { ...m, status: "promoted" } : m)),
      );
      if (res.peopleAdded > 0) {
        toast.success(
          `Added ${res.peopleAdded} leader${res.peopleAdded === 1 ? "" : "s"} at ${res.company} to Targets — company is now on Companies.`,
        );
      } else if (res.unresolvedDomain || res.warning) {
        toast.warning(res.warning || `Marked ${res.company} promoted — no people added.`);
      } else {
        toast.success(`Marked ${res.company} promoted.`);
      }
    } catch (e) {
      console.error("promoteThesisMatch failed", e);
      toast.error(e instanceof Error ? e.message : "Promote failed.");
    } finally {
      setBusyMatchId("");
    }
  };

  const selectedMatches = selected ? (matchesByThesis.get(selected.id) ?? []) : [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <Lightbulb className="h-4 w-4 text-primary" />
          Investment theses
          {visible.length > 0 && (
            <span className="text-[11px] font-normal text-muted-foreground">
              {visible.length}
            </span>
          )}
        </h2>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="h-3 w-3 mr-1" /> New thesis
        </Button>
      </div>

      {visible.length === 0 ? (
        <div className="text-center py-8 rounded-xl border border-dashed border-border">
          <Lightbulb className="h-6 w-6 mx-auto text-muted-foreground mb-1.5" />
          <p className="text-xs text-muted-foreground">
            Define an investment thesis to screen the signal pool and the web against your
            criteria — matches arrive scored 0–100 with a promote gate into Targets.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {visible.map((t) => {
            const cov = coverage[t.id];
            const count = (matchesByThesis.get(t.id) ?? []).length;
            const stale = t.status === "active" && thesisIsStale(t);
            const days = daysSinceScreened(t);
            const isSelected = selected?.id === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setSelectedId(t.id)}
                className={`text-left rounded-lg border px-3.5 py-3 transition-colors ${
                  isSelected ? "border-primary/60 bg-primary/[0.04]" : "border-border bg-card hover:bg-accent/50"
                } ${t.status === "paused" ? "opacity-60" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground truncate">{t.name}</span>
                  <span className="flex items-center gap-1 shrink-0">
                    {stale && (
                      <Badge
                        variant="outline"
                        className="text-[10px] bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900"
                      >
                        <Clock className="h-2.5 w-2.5 mr-0.5" />
                        {days == null ? "never screened" : `${days}d stale`}
                      </Badge>
                    )}
                    {t.status === "paused" && (
                      <Badge variant="outline" className="text-[10px]">
                        Paused
                      </Badge>
                    )}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                  {[t.sectors.join(", "), t.stages.join("/") || "any stage", t.geos.join(", ")]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Users className="h-3 w-3" />
                    {cov ? `${cov.contacts} contacts (${cov.warmContacts} warm)` : "—"}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Target className="h-3 w-3" />
                    {cov ? `${cov.targets} targets` : "—"}
                  </span>
                  <span className="tabular-nums">{count} match{count !== 1 ? "es" : ""}</span>
                </div>
                <div className="flex items-center gap-1.5 mt-2.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-[11px] px-2"
                    disabled={screeningId === t.id || t.status === "paused"}
                    onClick={(e) => {
                      e.stopPropagation();
                      void screen(t);
                    }}
                  >
                    {screeningId === t.id ? (
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    ) : (
                      <ScanSearch className="h-3 w-3 mr-1" />
                    )}
                    Screen
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-[11px] px-2"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditing(t);
                      setDialogOpen(true);
                    }}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-[11px] px-2"
                    title={t.status === "paused" ? "Resume screening" : "Pause thesis"}
                    onClick={(e) => {
                      e.stopPropagation();
                      void toggleStatus(t);
                    }}
                  >
                    {t.status === "paused" ? (
                      <Play className="h-3 w-3" />
                    ) : (
                      <Pause className="h-3 w-3" />
                    )}
                  </Button>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {selected && selectedMatches.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="px-3.5 py-2 bg-muted/40 flex items-center justify-between">
            <p className="text-xs font-medium text-foreground">
              Matches — {selected.name}
            </p>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Sorted by fit
            </p>
          </div>
          <div className="divide-y divide-border">
            {selectedMatches.map((m) => {
              const warm = companyContacts[m.company.trim().toLowerCase()] ?? 0;
              const busy = busyMatchId === m.id;
              const dimmed = m.status === "passed";
              return (
                <div
                  key={m.id}
                  className={`px-3.5 py-2.5 ${dimmed ? "opacity-50" : ""}`}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground">{m.company}</span>
                    <Badge
                      variant="outline"
                      className={`text-[10px] tabular-nums ${fitScoreClasses(m.fitScore)}`}
                    >
                      Fit {m.fitScore}
                    </Badge>
                    <Badge variant="outline" className={`text-[10px] ${MATCH_STATUS_CLASS[m.status]}`}>
                      {matchStatusLabel(m.status)}
                    </Badge>
                    <Badge variant="outline" className="text-[10px]">
                      {m.origin === "web" ? "Web" : "Signals"}
                    </Badge>
                    {warm > 0 && (
                      <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
                        <Users className="h-3 w-3" /> {warm} warm path{warm !== 1 ? "s" : ""}
                      </span>
                    )}
                    {m.sourceUrl && (
                      <a
                        href={m.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] text-primary hover:underline inline-flex items-center gap-0.5"
                      >
                        Source <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {[m.stage, m.sector, m.geo].filter(Boolean).join(" · ")}
                    {m.fitRationale ? ` — ${m.fitRationale}` : ""}
                  </p>
                  {!dimmed && (
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[11px] px-2"
                        disabled={busy}
                        onClick={() => void promote(m)}
                      >
                        {busy ? (
                          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                        ) : (
                          <Target className="h-3 w-3 mr-1" />
                        )}
                        {m.status === "promoted" ? "Find leaders → Targets" : "Promote to Targets"}
                      </Button>
                      {m.status === "sourced" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-[11px] px-2"
                          disabled={busy}
                          onClick={() => void setMatchStatus(m, "qualified")}
                        >
                          Qualify
                        </Button>
                      )}
                      {m.status !== "promoted" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-[11px] px-2 text-muted-foreground"
                          disabled={busy}
                          onClick={() => void setMatchStatus(m, "passed")}
                        >
                          Pass
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-[11px] px-2 ml-auto"
                        onClick={() => onDiligence(m.company)}
                      >
                        <SearchCheck className="h-3 w-3 mr-1" /> Diligence
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <ThesisDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        userEmail={userEmail}
        editing={editing}
        onSaved={(created, updated) => {
          if (created) {
            onThesesChanged([created, ...theses]);
            setSelectedId(created.id);
          } else if (updated && editing) {
            onThesesChanged(
              theses.map((t) =>
                t.id === editing.id
                  ? { ...t, ...updated, updatedAt: new Date().toISOString() }
                  : t,
              ),
            );
          }
        }}
      />
    </div>
  );
}
