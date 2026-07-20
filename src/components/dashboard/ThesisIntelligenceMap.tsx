import { useMemo, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Contact } from "@/lib/types";
import {
  buildThesisCells,
  layoutThesisMosaic,
  momentumStroke,
  warmthFill,
  type ThesisRect,
  type ThesisWindow,
} from "@/lib/thesis-intelligence";
import { cn } from "@/lib/utils";

const COMPACT_W = 640;
const COMPACT_H = 280;
const EXPANDED_W = 1100;
const EXPANDED_H = 620;

const WINDOWS: { id: ThesisWindow; label: string }[] = [
  { id: "30d", label: "30d" },
  { id: "90d", label: "90d" },
  { id: "1y", label: "1Y" },
  { id: "max", label: "Max" },
];

const TEMP_NODE: Record<string, string> = {
  Hot: "oklch(0.645 0.22 25)",
  Warm: "oklch(0.72 0.14 85)",
  Cold: "oklch(0.62 0.12 230)",
  Council: "oklch(0.55 0.08 280)",
};

const OPP_STYLE: Record<string, string> = {
  gap: "bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-300",
  concentrated: "bg-red-500/10 text-red-700 border-red-500/25 dark:text-red-300",
  elite: "bg-emerald-500/12 text-emerald-700 border-emerald-500/30 dark:text-emerald-300",
  decay: "bg-sky-500/10 text-sky-700 border-sky-500/25 dark:text-sky-300",
  rising: "bg-emerald-500/12 text-emerald-700 border-emerald-500/30 dark:text-emerald-300",
  falling: "bg-orange-500/12 text-orange-700 border-orange-500/25 dark:text-orange-300",
};

interface ThesisIntelligenceMapProps {
  contacts: Contact[];
  onSelectThesis: (sector: string) => void;
  className?: string;
}

export function ThesisIntelligenceMap({
  contacts,
  onSelectThesis,
  className,
}: ThesisIntelligenceMapProps) {
  const [window, setWindow] = useState<ThesisWindow>("90d");
  const [expanded, setExpanded] = useState(false);

  const handleSelect = (name: string) => {
    onSelectThesis(name);
    setExpanded(false);
  };

  return (
    <>
      <ThesisMapView
        contacts={contacts}
        window={window}
        onWindowChange={setWindow}
        onSelectThesis={handleSelect}
        viewW={COMPACT_W}
        viewH={COMPACT_H}
        svgClassName="h-[min(42vh,280px)]"
        clipPrefix="c"
        showExpand
        onExpand={() => setExpanded(true)}
        className={className}
      />

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="sm:max-w-[min(96vw,1140px)] max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Thesis Intelligence</DialogTitle>
            <DialogDescription>
              Relationship capital by thesis — larger view for reading labels and opportunities.
            </DialogDescription>
          </DialogHeader>
          <ThesisMapView
            contacts={contacts}
            window={window}
            onWindowChange={setWindow}
            onSelectThesis={handleSelect}
            viewW={EXPANDED_W}
            viewH={EXPANDED_H}
            svgClassName="h-[min(70vh,620px)]"
            clipPrefix="x"
            showExpand={false}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function ThesisMapView({
  contacts,
  window,
  onWindowChange,
  onSelectThesis,
  viewW,
  viewH,
  svgClassName,
  clipPrefix,
  showExpand,
  onExpand,
  className,
}: {
  contacts: Contact[];
  window: ThesisWindow;
  onWindowChange: (w: ThesisWindow) => void;
  onSelectThesis: (sector: string) => void;
  viewW: number;
  viewH: number;
  svgClassName: string;
  clipPrefix: string;
  showExpand?: boolean;
  onExpand?: () => void;
  className?: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const [gravity, setGravity] = useState<string | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTarget = useRef<string | null>(null);
  const gravityActive = useRef(false);

  const cells = useMemo(() => buildThesisCells(contacts, window), [contacts, window]);
  const rects = useMemo(() => layoutThesisMosaic(cells, viewW, viewH), [cells, viewW, viewH]);
  const hoverRect = hover ? rects.find((r) => r.name === hover) : null;

  const brief = useMemo(() => {
    if (!cells.length) return "No thesis-tagged relationships in view.";
    const top = cells[0]!;
    const gap = cells.find((c) => c.opportunities.some((o) => o.kind === "gap"));
    const rising = cells.find((c) => c.opportunities.some((o) => o.kind === "rising"));
    const parts = [
      `${top.name} holds the most relationship capital (RC ${top.rcIndex}).`,
      gap ? `${gap.name} looks under-covered.` : null,
      rising ? `${rising.name} is rising on momentum.` : null,
    ].filter(Boolean);
    return parts.join(" ");
  }, [cells]);

  const clearHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    holdTarget.current = null;
  };

  const onPointerDown = (name: string) => {
    clearHold();
    holdTarget.current = name;
    holdTimer.current = setTimeout(() => {
      if (holdTarget.current === name) {
        gravityActive.current = true;
        setGravity(name);
      }
    }, 420);
  };

  const onPointerUp = (name: string) => {
    const wasGravity = gravityActive.current && (gravity === name || holdTarget.current === name);
    clearHold();
    if (wasGravity) {
      gravityActive.current = false;
      setGravity(null);
      return;
    }
    gravityActive.current = false;
    setGravity(null);
    onSelectThesis(name);
  };

  if (!rects.length) {
    return (
      <div
        className={cn(
          "flex h-[280px] items-center justify-center rounded-xl border border-dashed border-border text-xs text-muted-foreground",
          className,
        )}
      >
        No sector / thesis data in view — tag contacts with a sector to populate the map.
      </div>
    );
  }

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Thesis relationship capital
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5 max-w-xl leading-snug">{brief}</p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/30 p-0.5">
          {WINDOWS.map((w) => (
            <Button
              key={w.id}
              type="button"
              size="sm"
              variant={window === w.id ? "default" : "ghost"}
              className="h-7 px-2.5 text-[11px]"
              onClick={() => onWindowChange(w.id)}
            >
              {w.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="relative rounded-xl border border-border bg-muted/15 overflow-hidden">
        {showExpand && (
          <Button
            type="button"
            size="icon"
            variant="secondary"
            className="absolute top-2 right-2 z-10 h-8 w-8 shadow-sm bg-card/90 hover:bg-card border border-border"
            onClick={onExpand}
            aria-label="Expand thesis map"
            title="Expand map"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        )}

        <svg
          viewBox={`0 0 ${viewW} ${viewH}`}
          className={cn("w-full touch-none", svgClassName)}
          role="img"
          aria-label="Thesis relationship capital map"
        >
          {rects.map((r) => (
            <ThesisCellSvg
              key={r.name}
              rect={r}
              clipPrefix={clipPrefix}
              dimmed={!!(gravity || hover) && gravity !== r.name && hover !== r.name}
              gravity={gravity === r.name}
              hovered={hover === r.name}
              onEnter={() => setHover(r.name)}
              onLeave={() => setHover((h) => (h === r.name ? null : h))}
              onPointerDown={() => onPointerDown(r.name)}
              onPointerUp={() => onPointerUp(r.name)}
              onPointerCancel={() => {
                clearHold();
                gravityActive.current = false;
                setGravity(null);
              }}
            />
          ))}
        </svg>

        {gravity && (
          <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full border border-primary/30 bg-card/95 px-3 py-1 text-[11px] font-medium text-foreground shadow-sm">
            Gravity well · {gravity} · release to restore · click to drill
          </div>
        )}

        {hoverRect && !gravity && (
          <div className="pointer-events-none absolute bottom-3 left-3 right-3 sm:right-auto sm:max-w-sm rounded-lg border border-border bg-card/95 px-3 py-2.5 text-xs backdrop-blur-sm">
            <div className="flex items-start justify-between gap-2">
              <p className="font-semibold text-foreground">{hoverRect.name}</p>
              <span className="tabular-nums text-muted-foreground shrink-0">
                RC {hoverRect.rcIndex}
              </span>
            </div>
            <p className="text-muted-foreground mt-1 leading-snug">
              {hoverRect.contactCount} contacts · {hoverRect.warmth}% warm+ ·{" "}
              {hoverRect.momentum >= 0 ? "+" : ""}
              {hoverRect.momentum}% momentum
              {hoverRect.freshnessDays != null ? ` · ${hoverRect.freshnessDays}d freshness` : ""}
              {hoverRect.portcoPaths > 0 ? ` · ${hoverRect.portcoPaths} portco paths` : ""}
            </p>
            {hoverRect.opportunities.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {hoverRect.opportunities.map((o) => (
                  <Badge
                    key={o.kind}
                    variant="outline"
                    className={cn("text-[9px]", OPP_STYLE[o.kind])}
                  >
                    {o.label}
                  </Badge>
                ))}
              </div>
            )}
            <p className="text-[10px] text-muted-foreground/70 mt-1.5">
              Click to filter · press & hold for Thesis Gravity Well
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground px-0.5">
        <span>Area = Relationship Capital</span>
        <span>·</span>
        <span>Fill = warmth</span>
        <span>·</span>
        <span>Edge = momentum</span>
        <span>·</span>
        <span>Hover small cells for detail</span>
      </div>
    </div>
  );
}

/** Truncate a string so it fits ~`maxPx` at `charPx` average advance. */
function fitLabel(text: string, maxPx: number, charPx = 6.4): string {
  if (maxPx < charPx * 2) return "";
  const maxChars = Math.max(1, Math.floor(maxPx / charPx));
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, 1);
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

function ThesisCellSvg({
  rect,
  clipPrefix,
  dimmed,
  gravity,
  hovered,
  onEnter,
  onLeave,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
}: {
  rect: ThesisRect;
  clipPrefix: string;
  dimmed: boolean;
  gravity: boolean;
  hovered: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onPointerDown: () => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const fill = warmthFill(rect.warmth);
  const stroke = momentumStroke(rect.momentum);
  const strokeW = Math.abs(rect.momentum) >= 25 ? 2.4 : hovered || gravity ? 2 : 1;
  const clipId = `thesis-clip-${clipPrefix}-${Math.round(rect.x)}-${Math.round(rect.y)}-${Math.round(rect.w)}`;

  const padX = 6;
  const padY = 5;
  const pipReserve = rect.opportunities.length > 0 && rect.w > 56 ? 14 : 0;
  const textW = Math.max(0, rect.w - padX * 2 - pipReserve);

  const showTitle = rect.w >= 56 && rect.h >= 28 && textW >= 28;
  const showMeta = rect.w >= 88 && rect.h >= 46 && textW >= 56;
  const showFullMeta = rect.w >= 118 && rect.h >= 52;
  const showNodes = rect.w >= 96 && rect.h >= 72;
  const showPips = rect.w >= 48 && rect.h >= 24;

  const title = showTitle ? fitLabel(rect.name, textW, 6.6) : "";
  const meta = showMeta
    ? fitLabel(
        showFullMeta
          ? `RC ${rect.rcIndex} · ${rect.warmth}% · n=${rect.contactCount}`
          : `RC ${rect.rcIndex}`,
        textW,
        5.6,
      )
    : "";

  const marks = showPips ? rect.opportunities.slice(0, 2) : [];

  return (
    <g
      opacity={dimmed ? 0.14 : 1}
      style={{
        cursor: "pointer",
        transition: "opacity 280ms ease",
      }}
      onPointerEnter={onEnter}
      onPointerLeave={() => {
        onLeave();
        onPointerCancel();
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        onPointerDown();
      }}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={6} />
        </clipPath>
      </defs>

      <rect
        x={rect.x}
        y={rect.y}
        width={rect.w}
        height={rect.h}
        rx={6}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeW}
        className={cn(
          rect.opportunities.some((o) => o.kind === "decay") && "opacity-90",
          (hovered || gravity) && "brightness-105",
        )}
      />

      <g clipPath={`url(#${clipId})`}>
        {rect.opportunities.some((o) => o.kind === "gap" || o.kind === "decay") && (
          <rect
            x={rect.x + 1.5}
            y={rect.y + 1.5}
            width={Math.max(0, rect.w - 3)}
            height={Math.max(0, rect.h - 3)}
            rx={5}
            fill="none"
            stroke="oklch(0.7 0.12 85)"
            strokeWidth={1}
            strokeDasharray="3 3"
            opacity={0.7}
          />
        )}

        {showNodes &&
          rect.nodes.slice(0, 8).map((n) => {
            const nx = rect.x + 8 + n.ux * Math.max(0, rect.w - 16);
            const ny =
              rect.y + (showMeta ? 36 : 22) + n.uy * Math.max(0, rect.h - (showMeta ? 52 : 36));
            return (
              <circle
                key={n.id}
                cx={nx}
                cy={ny}
                r={gravity ? 2.8 : 2}
                fill={TEMP_NODE[n.temperature] || TEMP_NODE.Cold}
                fillOpacity={0.85}
                className="pointer-events-none"
              />
            );
          })}

        {title && (
          <text
            x={rect.x + padX}
            y={rect.y + padY + 11}
            className="fill-foreground pointer-events-none"
            style={{ fontSize: 11, fontWeight: 650 }}
          >
            {title}
          </text>
        )}
        {meta && (
          <text
            x={rect.x + padX}
            y={rect.y + padY + 25}
            className="fill-muted-foreground pointer-events-none"
            style={{ fontSize: 9.5 }}
          >
            {meta}
          </text>
        )}

        {marks.map((m, i) => {
          const px = rect.x + rect.w - 7 - i * 9;
          const py = rect.y + 7;
          const color =
            m.kind === "gap" || m.kind === "decay"
              ? "oklch(0.7 0.14 85)"
              : m.kind === "concentrated" || m.kind === "falling"
                ? "oklch(0.6 0.18 25)"
                : "oklch(0.6 0.14 155)";
          return (
            <circle
              key={m.kind}
              cx={px}
              cy={py}
              r={m.kind === "elite" ? 2.2 : 2.6}
              fill={m.kind === "gap" ? "none" : color}
              stroke={color}
              strokeWidth={m.kind === "gap" ? 1.3 : 0}
              className="pointer-events-none"
            />
          );
        })}

        {gravity && (
          <circle
            cx={cx}
            cy={cy}
            r={Math.min(rect.w, rect.h) * 0.38}
            fill="none"
            stroke="var(--color-primary)"
            strokeOpacity={0.4}
            strokeWidth={1.5}
            className="pointer-events-none"
          />
        )}
      </g>
    </g>
  );
}
