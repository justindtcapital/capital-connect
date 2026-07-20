import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CONTENT_TYPE_LABELS, type PlatformContentRow, type PlatformContentType } from "@/lib/platform-content";

// Per-type badge treatment (ACTION_META pattern from the Activity log).
export const CONTENT_META: Record<PlatformContentType, string> = {
  exec_brief: "bg-blue-500/10 text-blue-600 border-blue-500/30",
  board_article: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30",
  mgmt_questions: "bg-amber-500/10 text-amber-600 border-amber-500/30",
  diligence: "bg-violet-500/10 text-violet-600 border-violet-500/30",
};

export function ContentTypeBadge({ type }: { type: PlatformContentType }) {
  return (
    <Badge variant="outline" className={`text-[10px] ${CONTENT_META[type] ?? ""}`}>
      {CONTENT_TYPE_LABELS[type]}
    </Badge>
  );
}

function formatTs(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Newest-first history of saved generations; click opens the detail sheet.
export function ContentHistoryList({
  rows,
  onOpen,
  emptyLabel,
}: {
  rows: PlatformContentRow[];
  onOpen: (row: PlatformContentRow) => void;
  emptyLabel: string;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground py-8 text-center">{emptyLabel}</p>;
  }
  return (
    <div className="rounded-lg border border-border bg-card divide-y divide-border">
      {rows.map((row) => (
        <button
          key={row.id || `${row.type}-${row.generatedAt}`}
          type="button"
          onClick={() => onOpen(row)}
          className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-accent/40"
        >
          <ContentTypeBadge type={row.type} />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-foreground truncate">{row.title || row.subject}</p>
            <p className="text-[11px] text-muted-foreground truncate">
              {row.subject}
              {row.generatedBy ? ` · ${row.generatedBy}` : ""}
            </p>
          </div>
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {formatTs(row.generatedAt)}
          </span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}
