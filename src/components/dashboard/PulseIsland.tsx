import { useState } from "react";
import { ChevronDown, ChevronUp, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "@tanstack/react-router";
import type { PulseInsight } from "@/lib/dashboard-intelligence";
import { cn } from "@/lib/utils";

interface PulseIslandProps {
  pulse: PulseInsight;
  onAct: (pulse: PulseInsight) => void;
  onFocusConstellation?: () => void;
}

export function PulseIsland({ pulse, onAct, onFocusConstellation }: PulseIslandProps) {
  const [expanded, setExpanded] = useState(false);
  const [snoozed, setSnoozed] = useState(false);

  if (snoozed) {
    return (
      <button
        type="button"
        onClick={() => setSnoozed(false)}
        className="mx-auto flex items-center gap-2 rounded-full border border-border/80 bg-card/80 px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground hover:border-border"
      >
        <Sparkles className="h-3 w-3 text-primary" />
        Pulse snoozed · show again
      </button>
    );
  }

  const severityRing =
    pulse.severity === "warning"
      ? "border-amber-500/40 bg-amber-500/[0.04]"
      : pulse.severity === "opportunity"
        ? "border-primary/35 bg-primary/[0.04]"
        : "border-border bg-card/90";

  return (
    <div
      className={cn(
        "relative mx-auto w-full max-w-2xl rounded-2xl border px-4 py-3 shadow-none transition-[padding,border-color] duration-300 ease-out",
        severityRing,
        expanded && "py-4",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Network Pulse
            </span>
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider",
                pulse.severity === "warning" && "bg-amber-500/15 text-amber-700 dark:text-amber-400",
                pulse.severity === "opportunity" && "bg-primary/15 text-primary",
                pulse.severity === "info" && "bg-muted text-muted-foreground",
              )}
            >
              {pulse.severity}
            </span>
          </div>
          <p className="mt-0.5 text-sm font-semibold text-foreground leading-snug">{pulse.headline}</p>
          {expanded && (
            <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
              {pulse.detail}
            </p>
          )}
          {!expanded && (
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{pulse.detail}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setExpanded((e) => !e)}
            aria-label={expanded ? "Collapse pulse" : "Expand pulse"}
          >
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setSnoozed(true)}
            aria-label="Snooze pulse"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 flex flex-wrap items-center gap-2 pl-10">
          <Button type="button" size="sm" className="h-7 text-[11px]" onClick={() => onAct(pulse)}>
            {pulse.actionLabel}
          </Button>
          {onFocusConstellation && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-[11px]"
              onClick={onFocusConstellation}
            >
              Focus constellation
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" className="h-7 text-[11px]" asChild>
            <Link to="/query">Open in Query</Link>
          </Button>
        </div>
      )}
    </div>
  );
}
