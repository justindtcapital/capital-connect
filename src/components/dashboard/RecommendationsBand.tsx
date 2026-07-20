import { AlertTriangle, ArrowUpRight, Link2, Thermometer } from "lucide-react";
import type { Recommendation } from "@/lib/dashboard-intelligence";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const KIND_META: Record<
  Recommendation["kind"],
  { icon: typeof Link2; label: string; className: string }
> = {
  decay: {
    icon: Thermometer,
    label: "Decay",
    className: "border-amber-500/30 bg-amber-500/[0.04]",
  },
  opportunity: {
    icon: ArrowUpRight,
    label: "Opportunity",
    className: "border-primary/30 bg-primary/[0.04]",
  },
  coverage: {
    icon: AlertTriangle,
    label: "Coverage",
    className: "border-red-500/25 bg-red-500/[0.03]",
  },
  followup: {
    icon: Link2,
    label: "Follow-up",
    className: "border-border bg-card",
  },
};

interface RecommendationsBandProps {
  items: Recommendation[];
  onAct: (rec: Recommendation) => void;
}

export function RecommendationsBand({ items, onAct }: RecommendationsBandProps) {
  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
        No urgent recommendations in the current filter — network looks steady.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
      {items.map((rec) => {
        const meta = KIND_META[rec.kind];
        const Icon = meta.icon;
        return (
          <div
            key={rec.id}
            className={cn(
              "flex items-start gap-3 rounded-xl border px-3.5 py-3 transition-colors",
              meta.className,
            )}
          >
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-background/80">
              <Icon className="h-3.5 w-3.5 text-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {meta.label}
                </span>
              </div>
              <p className="text-sm font-medium text-foreground leading-snug">{rec.title}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground leading-snug">{rec.detail}</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 text-[11px]"
              onClick={() => onAct(rec)}
            >
              Act
            </Button>
          </div>
        );
      })}
    </div>
  );
}
