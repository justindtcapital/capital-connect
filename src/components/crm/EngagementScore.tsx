import type { Contact } from "@/lib/types";
import { effectiveScore, scoreContact } from "@/lib/activity-score";
import { cn } from "@/lib/utils";
import { PulseRing } from "@/components/pulse/PulseRing";

function tempFromScore(score: number): "Council" | "Hot" | "Warm" | "Cold" {
  if (score >= 80) return "Council";
  if (score >= 55) return "Hot";
  if (score >= 25) return "Warm";
  return "Cold";
}

/** Compact score: Pulse Ring + tabular number. */
export function EngagementScore({
  contact,
  className,
}: {
  contact: Contact;
  className?: string;
}) {
  const score = Math.round(effectiveScore(contact));
  const temp = tempFromScore(score);
  return (
    <span
      className={cn("inline-flex items-center gap-1.5", className)}
      title={`Network engagement ${score}/100`}
    >
      <PulseRing value={score} size="xs" temperature={temp} />
      <span className="text-[11px] font-semibold tabular-nums text-foreground">{score}</span>
    </span>
  );
}

/** Full breakdown for the contact detail panel. */
export function EngagementBreakdown({ contact }: { contact: Contact }) {
  const { score, drivers } = scoreContact(contact);
  const rounded = Math.round(score);
  const temp = tempFromScore(rounded);
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[10px] font-semibold text-muted-foreground tracking-wide">
          Network Engagement
        </h3>
        <span className="text-[10px] text-muted-foreground">activity-derived · 0–100</span>
      </div>
      <div className="flex items-center gap-3">
        <PulseRing value={rounded} size="lg" temperature={temp} label={`${rounded}`} />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground mb-1">Relationship strength</p>
          {drivers.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {drivers.map((d) => (
                <span
                  key={d}
                  className="text-[10px] rounded border border-border bg-card px-2 py-0.5 text-muted-foreground"
                >
                  {d}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
