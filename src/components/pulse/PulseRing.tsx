import { cn } from "@/lib/utils";
import type { Temperature } from "@/lib/types";

/** Arc completeness (0–100) from relationship / engagement strength. */
export function strengthFromTemperature(temp: Temperature | string | undefined): number {
  switch (temp) {
    case "Council":
      return 95;
    case "Hot":
      return 78;
    case "Warm":
      return 52;
    case "Cold":
      return 22;
    default:
      return 40;
  }
}

const TEMP_FILL: Record<string, string> = {
  Council: "var(--council)",
  Hot: "var(--hot)",
  Warm: "var(--warm)",
  Cold: "var(--cold)",
};

const TEMP_STROKE: Record<string, string> = {
  Council: "var(--council-foreground)",
  Hot: "var(--hot-foreground)",
  Warm: "var(--warm-foreground)",
  Cold: "var(--cold-foreground)",
};

export type PulseRingSize = "xs" | "sm" | "md" | "lg" | "hero";

const SIZE_PX: Record<PulseRingSize, number> = {
  xs: 16,
  sm: 22,
  md: 36,
  lg: 72,
  hero: 160,
};

const STROKE: Record<PulseRingSize, number> = {
  xs: 1.5,
  sm: 1.75,
  md: 2,
  lg: 2.25,
  hero: 2.5,
};

export interface PulseRingProps {
  /** 0–100 arc completeness (relationship strength). */
  value: number;
  size?: PulseRingSize;
  /** Climate fill inside the ring (temperature). */
  temperature?: Temperature | string;
  /** Ambient breath — Home hero only. */
  breathe?: boolean;
  /** Faceted track for Council membership. */
  council?: boolean;
  className?: string;
  /** Optional center label (hero metrics). */
  label?: string;
  sublabel?: string;
  strokeColor?: string;
  trackColor?: string;
}

/**
 * Signature VenturePulse mark — arc length = strength, inner fill = climate.
 */
export function PulseRing({
  value,
  size = "md",
  temperature,
  breathe = false,
  council = false,
  className,
  label,
  sublabel,
  strokeColor,
  trackColor,
}: PulseRingProps) {
  const px = SIZE_PX[size];
  const stroke = STROKE[size];
  const r = (px - stroke) / 2 - 0.5;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, value));
  const dash = (clamped / 100) * c;
  const gap = c - dash;
  const isCouncil = council || temperature === "Council";
  const fill = temperature ? TEMP_FILL[temperature] : undefined;
  const arcStroke =
    strokeColor ||
    (temperature ? TEMP_STROKE[temperature] : undefined) ||
    "var(--primary)";
  const track = trackColor || "var(--border)";

  return (
    <div
      className={cn(
        "relative inline-flex items-center justify-center shrink-0",
        breathe && "pulse-ring--breathe",
        className,
      )}
      style={{ width: px, height: px }}
      role="img"
      aria-label={`Relationship pulse ${Math.round(clamped)}%${temperature ? `, ${temperature}` : ""}`}
    >
      <svg
        width={px}
        height={px}
        viewBox={`0 0 ${px} ${px}`}
        className="absolute inset-0"
        aria-hidden
      >
        {/* Track */}
        <circle
          cx={px / 2}
          cy={px / 2}
          r={r}
          fill="none"
          stroke={track}
          strokeWidth={stroke}
          opacity={0.9}
        />
        {/* Climate disc */}
        {fill && (
          <circle
            cx={px / 2}
            cy={px / 2}
            r={Math.max(1, r - stroke - 1)}
            fill={fill}
            opacity={0.85}
          />
        )}
        {/* Strength arc — starts at 12 o'clock */}
        <circle
          cx={px / 2}
          cy={px / 2}
          r={r}
          fill="none"
          stroke={arcStroke}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${gap}`}
          transform={`rotate(-90 ${px / 2} ${px / 2})`}
          className="transition-[stroke-dasharray] duration-500 ease-out"
          style={{ transitionTimingFunction: "var(--ease-out-quiet)" }}
        />
        {/* Council facet — subtle polygonal hint */}
        {isCouncil && size !== "xs" && (
          <polygon
            points={councilPoints(px / 2, px / 2, r * 0.42)}
            fill="none"
            stroke={arcStroke}
            strokeWidth={1}
            opacity={0.45}
          />
        )}
      </svg>
      {(label || sublabel) && (
        <div className="relative z-10 flex flex-col items-center justify-center text-center px-2">
          {label && (
            <span
              className={cn(
                "font-semibold tabular-nums text-foreground leading-none",
                size === "hero" ? "text-3xl" : size === "lg" ? "text-lg" : "text-xs",
              )}
            >
              {label}
            </span>
          )}
          {sublabel && (
            <span
              className={cn(
                "text-muted-foreground mt-1 leading-tight",
                size === "hero" ? "text-[11px]" : "text-[9px]",
              )}
            >
              {sublabel}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function councilPoints(cx: number, cy: number, r: number): string {
  const n = 6;
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    pts.push(`${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`);
  }
  return pts.join(" ");
}

/** Compact temperature + pulse for lists/cards. */
export function PulseTemperature({
  temperature,
  className,
  showLabel = true,
}: {
  temperature: Temperature;
  className?: string;
  showLabel?: boolean;
}) {
  return (
    <div className={cn("inline-flex items-center gap-1.5", className)}>
      <PulseRing
        value={strengthFromTemperature(temperature)}
        size="xs"
        temperature={temperature}
        council={temperature === "Council"}
      />
      {showLabel && (
        <span
          className={cn(
            "text-[10px] font-medium tracking-wide",
            temperature === "Council" && "text-council-foreground",
            temperature === "Hot" && "text-hot-foreground",
            temperature === "Warm" && "text-warm-foreground",
            temperature === "Cold" && "text-cold-foreground",
          )}
        >
          {temperature}
        </span>
      )}
    </div>
  );
}
