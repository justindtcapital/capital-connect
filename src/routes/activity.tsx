import { useMemo, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { fetchOpsLog } from "@/utils/sheets.functions";
import type { OpsLogEntry } from "@/utils/sheets.server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ScrollText,
  Search,
  RefreshCw,
  ChevronRight,
  Download,
  Upload,
  RefreshCcw,
  Pencil,
  Trash2,
  Sparkles,
  Wrench,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

export const Route = createFileRoute("/activity")({
  head: () => ({
    meta: [
      { title: "Activity Log — VenturePulse" },
      { name: "description", content: "Audit trail of every import, export, sync, edit and delete" },
    ],
  }),
  loader: async (): Promise<{ entries: OpsLogEntry[] }> => ({ entries: await fetchOpsLog() }),
  component: ActivityPage,
});

// Per-action visual treatment. Keys match OpsLogAction; anything unknown falls
// back to a neutral style.
const ACTION_META: Record<
  string,
  { label: string; icon: typeof Download; className: string }
> = {
  import: { label: "Import", icon: Upload, className: "bg-blue-500/10 text-blue-600 border-blue-500/30" },
  export: { label: "Export", icon: Download, className: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30" },
  sync: { label: "Sync", icon: RefreshCcw, className: "bg-violet-500/10 text-violet-600 border-violet-500/30" },
  edit: { label: "Edit", icon: Pencil, className: "bg-amber-500/10 text-amber-600 border-amber-500/30" },
  delete: { label: "Delete", icon: Trash2, className: "bg-red-500/10 text-red-600 border-red-500/30" },
  enrich: { label: "Enrich", icon: Sparkles, className: "bg-cyan-500/10 text-cyan-600 border-cyan-500/30" },
  maintenance: { label: "Maintenance", icon: Wrench, className: "bg-slate-500/10 text-slate-600 border-slate-500/30" },
};

const ACTIONS = ["import", "export", "sync", "edit", "delete", "enrich", "maintenance"];

function formatTs(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ActionBadge({ action }: { action: string }) {
  const meta = ACTION_META[action];
  const Icon = meta?.icon ?? ScrollText;
  return (
    <Badge
      variant="outline"
      className={`gap-1 text-[10px] capitalize ${meta?.className ?? "bg-muted text-muted-foreground"}`}
    >
      <Icon className="h-2.5 w-2.5" />
      {meta?.label ?? (action || "—")}
    </Badge>
  );
}

function ActivityPage() {
  const { entries } = Route.useLoaderData() as { entries: OpsLogEntry[] };
  const router = useRouter();
  const [action, setAction] = useState("all");
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [refreshing, setRefreshing] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (action !== "all" && e.action !== action) return false;
      if (status !== "all" && e.status !== status) return false;
      if (q && !`${e.summary} ${e.source} ${e.details} ${e.items.join(" ")}`.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [entries, action, status, search]);

  const toggle = (i: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const refresh = async () => {
    setRefreshing(true);
    try {
      await router.invalidate();
    } finally {
      setRefreshing(false);
    }
  };

  const errorCount = entries.filter((e) => e.status === "error").length;

  return (
    <div className="p-6 max-w-[1200px] mx-auto">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold text-foreground">
            <ScrollText className="h-5 w-5 text-primary" />
            Activity Log
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Audit trail of every import, export, sync, edit, delete, enrichment and repair —
            written to the workbook's Ops Log tab.
          </p>
        </div>
        <Button variant="outline" size="sm" className="h-8 text-xs" onClick={refresh} disabled={refreshing}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search summaries, sources, items…"
            className="h-8 pl-8 text-sm"
          />
        </div>
        <Select value={action} onValueChange={setAction}>
          <SelectTrigger className="h-8 w-40 text-sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            {ACTIONS.map((a) => (
              <SelectItem key={a} value={a} className="capitalize">{ACTION_META[a]?.label ?? a}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-8 w-32 text-sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="ok">OK</SelectItem>
            <SelectItem value="error">Error</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-3 mb-3 text-xs text-muted-foreground">
        <span>
          <span className="font-semibold text-foreground">{filtered.length}</span> of {entries.length}{" "}
          event{entries.length !== 1 ? "s" : ""}
        </span>
        {errorCount > 0 && (
          <span className="flex items-center gap-1 text-red-600">
            <AlertCircle className="h-3 w-3" />
            {errorCount} error{errorCount !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {entries.length === 0 ? (
        <div className="text-center py-16 rounded-lg border border-dashed border-border">
          <ScrollText className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">No activity logged yet.</p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            Imports, exports, syncs, bulk edits/deletes, and enrichment runs will appear here.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-center py-12 text-sm text-muted-foreground">No events match your filters.</p>
      ) : (
        <div className="rounded-lg border border-border bg-card divide-y divide-border">
          {filtered.map((e, i) => {
            const isOpen = expanded.has(i);
            const hasDetail = e.items.length > 0 || !!e.details;
            return (
              <div key={`${e.timestamp}-${i}`}>
                <button
                  type="button"
                  onClick={() => hasDetail && toggle(i)}
                  className={`w-full flex items-start gap-3 px-3 py-2.5 text-left ${hasDetail ? "hover:bg-accent/40" : "cursor-default"}`}
                >
                  <ChevronRight
                    className={`h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""} ${hasDetail ? "" : "opacity-0"}`}
                  />
                  <span className="shrink-0 mt-0.5">
                    <ActionBadge action={e.action} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-foreground truncate">{e.summary || "—"}</span>
                      {e.status === "error" ? (
                        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-600" />
                      ) : (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600/70" />
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground">
                      <span className="font-mono">{e.source || "—"}</span>
                      {e.records != null && (
                        <>
                          <span>·</span>
                          <span>{e.records} record{e.records !== 1 ? "s" : ""}</span>
                        </>
                      )}
                      {e.items.length > 0 && (
                        <>
                          <span>·</span>
                          <span>{e.items.length} item{e.items.length !== 1 ? "s" : ""}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums mt-0.5">
                    {formatTs(e.timestamp)}
                  </span>
                </button>

                {isOpen && hasDetail && (
                  <div className="px-3 pb-3 pl-17 space-y-2">
                    {e.details && (
                      <div className="text-[11px] text-muted-foreground">
                        <span className="font-semibold uppercase tracking-wider text-[10px]">Details</span>
                        <div className="font-mono mt-0.5 wrap-break-word">{e.details}</div>
                      </div>
                    )}
                    {e.items.length > 0 && (
                      <div>
                        <span className="font-semibold uppercase tracking-wider text-[10px] text-muted-foreground">
                          Items ({e.items.length})
                        </span>
                        <ul className="mt-1 max-h-56 overflow-y-auto rounded border border-border bg-muted/30 p-2 space-y-0.5">
                          {e.items.map((it, k) => (
                            <li key={k} className="text-[11px] text-foreground font-mono wrap-break-word">
                              {it}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
