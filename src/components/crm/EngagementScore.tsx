import type { Contact } from "@/lib/types";
import { effectiveScore, scoreContact } from "@/lib/activity-score";
import { cn } from "@/lib/utils";

// Network Engagement Score — a first-class 0–100 metric derived from real
// activity signals (see activity-score.ts). It's the number behind the
// Council/Hot/Warm/Cold tier, surfaced here in its own right so partners can
// scan, sort, and drill into *how* engaged a relationship is, not just its tier.

// Bar/accent color follows the same bands as the Temperature tier, so the score
// reads consistently with the tier badge (Council violet → Cold blue).
function bandColor(score: number): string {
  if (score >= 80) return "bg-council";
  if (score >= 55) return "bg-hot";
  if (score >= 25) return "bg-warm";
  return "bg-cold";
}

/** Compact score: a mini progress bar + the number. Used on cards and table rows. */
export function EngagementScore({
  contact,
  className,
}: {
  contact: Contact;
  className?: string;
}) {
  const score = Math.round(effectiveScore(contact));
  return (
    <span
      className={cn("inline-flex items-center gap-1.5", className)}
      title={`Network engagement ${score}/100`}
    >
      <span className="relative h-1.5 w-10 rounded-full bg-muted overflow-hidden shrink-0">
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full", bandColor(score))}
          style={{ width: `${score}%` }}
        />
      </span>
      <span className="text-[11px] font-semibold tabular-nums text-foreground">{score}</span>
    </span>
  );
}

/** Full breakdown for the contact detail panel: big number, bar, and the
 *  human-readable drivers that produced it. Recomputes live so it reflects the
 *  contact's current interactions (not a value stamped at fetch time). */
export function EngagementBreakdown({ contact }: { contact: Contact }) {
  const { score, drivers } = scoreContact(contact);
  const rounded = Math.round(score);
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground">
          Network Engagement
        </h3>
        <span className="text-[10px] text-muted-foreground">activity-derived · 0–100</span>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-baseline gap-1">
          <span className="text-2xl font-bold tabular-nums text-foreground">{rounded}</span>
          <span className="text-xs text-muted-foreground">/100</span>
        </div>
        <div className="relative h-2 flex-1 rounded-full bg-muted overflow-hidden">
          <span
            className={cn("absolute inset-y-0 left-0 rounded-full", bandColor(rounded))}
            style={{ width: `${rounded}%` }}
          />
        </div>
      </div>
      {drivers.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {drivers.map((d) => (
            <span
              key={d}
              className="text-[10px] rounded-full border border-border bg-card px-2 py-0.5 text-muted-foreground"
            >
              {d}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
