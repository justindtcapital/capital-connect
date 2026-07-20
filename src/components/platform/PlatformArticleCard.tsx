import { useEffect, useMemo, useState, type ReactNode } from "react";
import { companyLogoSources } from "@/lib/domain-utils";

/** Segment tints aligned with Signals feed badges. */
export const PLATFORM_SEGMENT_CLASS: Record<string, string> = {
  Security: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900",
  AI: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900",
  Data: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900",
  "Supply Chain":
    "bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/40 dark:text-teal-300 dark:border-teal-900",
  Cloud: "bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/40 dark:text-cyan-300 dark:border-cyan-900",
};

export function opportunityChipClass(score: number): string {
  if (score >= 70)
    return "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900";
  if (score >= 45)
    return "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900";
  return "bg-muted text-muted-foreground border-border";
}

export function CompanyMark({
  name,
  domain,
}: {
  name: string;
  domain?: string;
}) {
  const [stage, setStage] = useState(0);
  const sources = useMemo(
    () => (domain ? companyLogoSources(domain, "high") : []),
    [domain],
  );
  useEffect(() => setStage(0), [sources.join("|")]);

  if (domain && stage < sources.length) {
    const src = sources[stage]!;
    return (
      <img
        key={src}
        src={src}
        alt=""
        className="h-9 w-9 rounded-md border border-border object-contain bg-white shrink-0"
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setStage((s) => s + 1)}
      />
    );
  }
  const initial = (name.trim()[0] || "?").toUpperCase();
  return (
    <div className="h-9 w-9 rounded-md border border-border bg-primary/10 text-primary flex items-center justify-center text-sm font-semibold shrink-0">
      {initial}
    </div>
  );
}

/** Relative time label for diligence history (Signals-style). */
export function relativeTimeLabel(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso || "—";
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Signals-style news article shell used by Platform Sourcing / Diligence.
 * Clickable region (meta + headline) is separate from the footer so CTAs
 * never nest inside a button.
 */
export function PlatformArticleCard({
  company,
  domain,
  badges,
  timeLabel,
  headline,
  summary,
  footer,
  onOpen,
  active,
}: {
  company: string;
  domain?: string;
  badges?: ReactNode;
  timeLabel?: string;
  headline: string;
  summary?: string;
  footer?: ReactNode;
  onOpen?: () => void;
  active?: boolean;
}) {
  const meta = (
    <div className="flex items-start gap-4">
      <CompanyMark name={company} domain={domain} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-foreground shrink-0">{company}</span>
          {badges}
          {timeLabel && (
            <span className="ml-auto text-[11px] text-muted-foreground shrink-0">{timeLabel}</span>
          )}
        </div>
        <h3 className="text-lg font-bold tracking-tight mt-2 leading-snug text-foreground">
          {headline}
        </h3>
        {summary && <p className="text-sm text-muted-foreground mt-1.5 line-clamp-2">{summary}</p>}
      </div>
    </div>
  );

  return (
    <article
      className={`rounded-xl border bg-card overflow-hidden transition-colors ${
        active ? "border-primary/40 ring-1 ring-primary/20" : "border-border"
      }`}
    >
      <div className="p-5">
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="w-full text-left rounded-md -m-1 p-1 hover:bg-accent/30 transition-colors"
          >
            {meta}
          </button>
        ) : (
          meta
        )}
        {footer && (
          <div className="mt-4 pt-3 border-t border-border flex flex-wrap items-center gap-2">
            {footer}
          </div>
        )}
      </div>
    </article>
  );
}
