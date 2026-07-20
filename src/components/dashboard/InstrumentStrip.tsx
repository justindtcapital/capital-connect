import type { Instrument, InstrumentTone } from "@/lib/dashboard-intelligence";
import { cn } from "@/lib/utils";

function toneClass(tone: InstrumentTone): string {
  switch (tone) {
    case "positive":
      return "text-emerald-600 dark:text-emerald-400";
    case "caution":
      return "text-amber-600 dark:text-amber-400";
    case "critical":
      return "text-red-600 dark:text-red-400";
    default:
      return "text-foreground";
  }
}

function ScoreRing({ score, tone }: { score: number; tone: InstrumentTone }) {
  const r = 16;
  const c = 2 * Math.PI * r;
  const offset = c - (Math.max(0, Math.min(100, score)) / 100) * c;
  const stroke =
    tone === "positive"
      ? "stroke-emerald-500"
      : tone === "caution"
        ? "stroke-amber-500"
        : tone === "critical"
          ? "stroke-red-500"
          : "stroke-primary";
  return (
    <svg width="40" height="40" className="shrink-0 -rotate-90">
      <circle
        cx="20"
        cy="20"
        r={r}
        fill="none"
        className="stroke-border"
        strokeWidth="3"
      />
      <circle
        cx="20"
        cy="20"
        r={r}
        fill="none"
        className={cn(stroke, "transition-[stroke-dashoffset] duration-500 ease-out")}
        strokeWidth="3"
        strokeDasharray={c}
        strokeDashoffset={offset}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function InstrumentStrip({ instruments }: { instruments: Instrument[] }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
      {instruments.map((inst) => (
        <div
          key={inst.key}
          className="rounded-xl border border-border bg-card/60 px-3.5 py-3 transition-colors hover:bg-accent/40"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground leading-tight">
              {inst.label}
            </p>
            {inst.score != null && <ScoreRing score={inst.score} tone={inst.tone} />}
          </div>
          <p
            className={cn(
              "mt-1.5 text-xl font-semibold tabular-nums tracking-tight truncate",
              toneClass(inst.tone),
            )}
          >
            {inst.value}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground leading-snug line-clamp-2">
            {inst.detail}
          </p>
        </div>
      ))}
    </div>
  );
}
