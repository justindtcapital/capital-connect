import { useEffect, useRef, useState } from "react";
import type { GraphNode } from "@/lib/constellation-layout";

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

/**
 * FLIP-style tween of node positions when the constellation layout changes
 * (time horizon, Orbit Focus). New nodes fade in at target; removed nodes drop out.
 */
export function useAnimatedNodes(targetNodes: GraphNode[], durationMs = 480): GraphNode[] {
  const [display, setDisplay] = useState(targetNodes);
  const displayRef = useRef(targetNodes);
  const rafRef = useRef<number | null>(null);
  const layoutKey = useRef("");

  useEffect(() => {
    displayRef.current = display;
  }, [display]);

  useEffect(() => {
    const key = targetNodes
      .map((n) => `${n.id}:${Math.round(n.x)}:${Math.round(n.y)}:${Math.round(n.halo)}`)
      .join("|");
    if (key === layoutKey.current) {
      setDisplay(targetNodes);
      return;
    }
    layoutKey.current = key;

    const fromMap = new Map(displayRef.current.map((n) => [n.id, n]));
    const start = performance.now();

    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const e = easeOutCubic(t);
      const next = targetNodes.map((n) => {
        const prev = fromMap.get(n.id);
        if (!prev) {
          // Enter: scale up from center bias
          return {
            ...n,
            r: lerp(n.r * 0.35, n.r, e),
            halo: lerp(0, n.halo, e),
            x: n.x,
            y: n.y,
          };
        }
        return {
          ...n,
          x: lerp(prev.x, n.x, e),
          y: lerp(prev.y, n.y, e),
          r: lerp(prev.r, n.r, e),
          halo: lerp(prev.halo, n.halo, e),
        };
      });
      setDisplay(next);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setDisplay(targetNodes);
        rafRef.current = null;
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // Intentionally only re-run when layout geometry changes (key above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetNodes, durationMs]);

  return display;
}
