import type { ReactNode } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";
import type { CrossFilter } from "@/lib/use-chart-drill";

interface DrillSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The focused segment (dimension + value) whose records are listed. */
  drill: CrossFilter | null;
  count: number;
  /** Optional toolbar (e.g. a "Group by" selector) shown under the count. */
  controls?: ReactNode;
  children: ReactNode;
}

// Generic right-side drill-down panel: shows the records behind a clicked chart
// segment. Pages fill `children` with their own row components.
export function DrillSheet({ open, onOpenChange, drill, count, controls, children }: DrillSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md overflow-hidden flex flex-col">
        <SheetHeader className="pb-3 border-b border-border shrink-0">
          <SheetTitle className="text-base flex items-center gap-2">
            {drill ? (
              <>
                <span className="text-muted-foreground font-normal text-xs uppercase tracking-wider">
                  {drill.label}
                </span>
                <span className="flex flex-wrap gap-1">
                  {drill.values.map((v) => (
                    <Badge key={v} variant="outline" className="text-xs">
                      {v}
                    </Badge>
                  ))}
                </span>
              </>
            ) : (
              "Records"
            )}
          </SheetTitle>
          <SheetDescription className="text-xs">
            {count} record{count !== 1 ? "s" : ""}
          </SheetDescription>
          {controls && <div className="pt-1">{controls}</div>}
        </SheetHeader>
        <ScrollArea className="flex-1 -mx-6 px-6">
          <div className="py-4 space-y-1.5">
            {count === 0 ? (
              <p className="text-xs text-muted-foreground">No records in this segment.</p>
            ) : (
              children
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

// A removable chip row showing the active cross-filters from clicked charts.
export function DrillChips({
  filters,
  onClear,
  onClearAll,
}: {
  filters: CrossFilter[];
  onClear: (dim: string) => void;
  onClearAll: () => void;
}) {
  if (filters.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
        Focused on
      </span>
      {filters.map((f) => (
        <Badge key={f.dim} variant="secondary" className="gap-1 text-[11px] font-normal">
          <span className="text-muted-foreground">{f.label}:</span> {f.values.join(", ")}
          <button type="button" onClick={() => onClear(f.dim)} aria-label={`Clear ${f.label}`}>
            <X className="h-2.5 w-2.5" />
          </button>
        </Badge>
      ))}
      {filters.length > 1 && (
        <button
          type="button"
          onClick={onClearAll}
          className="text-[11px] text-muted-foreground hover:text-foreground underline"
        >
          Clear all
        </button>
      )}
    </div>
  );
}
