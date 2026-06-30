/**
 * Bespoke animated workspace icons for the home "Jump into a workspace" grid.
 *
 * All icons share one visual language: a 24×24 viewBox, 1.6px rounded strokes,
 * and `currentColor` so the parent tile's text color drives the hue. Animation
 * is CSS-driven (see the `.wsi-*` rules in styles.css): elements are static at
 * rest and animate only while the enclosing `.group` is hovered OR the icon's
 * container carries `.wsi--active` (used by the idle choreography).
 *
 * Each glyph element is tagged with a `wsi-*` class that maps to a keyframe,
 * plus optional `wsi-d1/2/3` stagger-delay classes.
 */

type IconProps = { className?: string };

const SVG = (props: React.SVGProps<SVGSVGElement>) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  />
);

/** Home — a house whose doorway/window glows on hover. */
export function HomeIcon({ className }: IconProps) {
  return (
    <SVG className={`wsi ${className ?? ""}`}>
      <path d="M3.5 11 L12 4 L20.5 11" />
      <path d="M5.5 9.8 L5.5 19.5 L18.5 19.5 L18.5 9.8" />
      <rect
        className="wsi-win"
        x="10.4"
        y="13.2"
        width="3.2"
        height="6.3"
        rx="0.4"
        fill="currentColor"
        stroke="none"
      />
    </SVG>
  );
}

/** Network — a relationship graph: nodes pulse, links breathe. */
export function NetworkIcon({ className }: IconProps) {
  return (
    <SVG className={`wsi ${className ?? ""}`}>
      <line className="wsi-link" x1="6.5" y1="7.5" x2="17" y2="6.5" />
      <line className="wsi-link wsi-d2" x1="17" y1="6.5" x2="17.5" y2="16.5" />
      <line className="wsi-link wsi-d1" x1="17.5" y1="16.5" x2="7" y2="16.5" />
      <line className="wsi-link wsi-d3" x1="7" y1="16.5" x2="6.5" y2="7.5" />
      <line className="wsi-link wsi-d2" x1="6.5" y1="7.5" x2="17.5" y2="16.5" />
      <circle className="wsi-node" cx="6.5" cy="7.5" r="2.1" fill="currentColor" stroke="none" />
      <circle
        className="wsi-node wsi-d1"
        cx="17"
        cy="6.5"
        r="2.1"
        fill="currentColor"
        stroke="none"
      />
      <circle
        className="wsi-node wsi-d2"
        cx="17.5"
        cy="16.5"
        r="2.1"
        fill="currentColor"
        stroke="none"
      />
      <circle
        className="wsi-node wsi-d3"
        cx="7"
        cy="16.5"
        r="2.1"
        fill="currentColor"
        stroke="none"
      />
    </SVG>
  );
}

/** Targeting — crosshair with a rotating scan ring and a locking center dot. */
export function TargetingIcon({ className }: IconProps) {
  return (
    <SVG className={`wsi ${className ?? ""}`}>
      <circle className="wsi-scan" cx="12" cy="12" r="9" strokeDasharray="4 4" opacity="0.55" />
      <circle className="wsi-ping" cx="12" cy="12" r="5.5" opacity="0.6" />
      <circle cx="12" cy="12" r="3" />
      <circle className="wsi-center" cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <line x1="12" y1="1.8" x2="12" y2="4.4" />
      <line x1="12" y1="19.6" x2="12" y2="22.2" />
      <line x1="1.8" y1="12" x2="4.4" y2="12" />
      <line x1="19.6" y1="12" x2="22.2" y2="12" />
    </SVG>
  );
}

/** Events — calendar with a popping notification dot and a twinkling sparkle. */
export function EventsIcon({ className }: IconProps) {
  return (
    <SVG className={`wsi ${className ?? ""}`}>
      <rect x="3.5" y="5" width="13" height="14" rx="2" />
      <line x1="3.5" y1="9" x2="16.5" y2="9" />
      <line x1="7" y1="3" x2="7" y2="6" />
      <line x1="13" y1="3" x2="13" y2="6" />
      <circle className="wsi-dot" cx="7.5" cy="13.5" r="1.3" fill="currentColor" stroke="none" />
      <path
        className="wsi-spark"
        d="M19.5 3 L20.3 5.2 L22.5 6 L20.3 6.8 L19.5 9 L18.7 6.8 L16.5 6 L18.7 5.2 Z"
        fill="currentColor"
        stroke="none"
      />
    </SVG>
  );
}

/** PortCo — a small ecosystem of buildings; windows light up, a growth arrow rises. */
export function PortCoIcon({ className }: IconProps) {
  return (
    <SVG className={`wsi ${className ?? ""}`}>
      <rect x="3" y="8.5" width="7" height="11.5" rx="1" />
      <rect x="11.5" y="11.5" width="7" height="8.5" rx="1" />
      <rect
        className="wsi-win"
        x="4.7"
        y="10.5"
        width="1.6"
        height="1.6"
        rx="0.3"
        fill="currentColor"
        stroke="none"
      />
      <rect
        className="wsi-win wsi-d1"
        x="7.1"
        y="10.5"
        width="1.6"
        height="1.6"
        rx="0.3"
        fill="currentColor"
        stroke="none"
      />
      <rect
        className="wsi-win wsi-d2"
        x="4.7"
        y="13.4"
        width="1.6"
        height="1.6"
        rx="0.3"
        fill="currentColor"
        stroke="none"
      />
      <rect
        className="wsi-win wsi-d3"
        x="13.2"
        y="13.6"
        width="1.6"
        height="1.6"
        rx="0.3"
        fill="currentColor"
        stroke="none"
      />
      <rect
        className="wsi-win wsi-d1"
        x="15.6"
        y="13.6"
        width="1.6"
        height="1.6"
        rx="0.3"
        fill="currentColor"
        stroke="none"
      />
      <path className="wsi-arrow" d="M13.8 7 L16.3 4.5 L18.8 7 M16.3 4.5 L16.3 9.2" />
    </SVG>
  );
}

/** Signals — radar: concentric rings, a continuously sweeping wedge, a blinking blip. */
export function SignalsIcon({ className }: IconProps) {
  return (
    <SVG className={`wsi ${className ?? ""}`}>
      <circle cx="12" cy="12" r="9" opacity="0.45" />
      <circle cx="12" cy="12" r="5" opacity="0.45" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <path
        className="wsi-sweep"
        d="M12 12 L12 3 A9 9 0 0 1 19.4 7.4 Z"
        fill="currentColor"
        stroke="none"
        opacity="0.18"
      />
      <line className="wsi-sweep" x1="12" y1="12" x2="12" y2="3" />
      <circle className="wsi-blip" cx="16.5" cy="8" r="1.5" fill="currentColor" stroke="none" />
    </SVG>
  );
}

/** Companies — a single office tower; windows illuminate, mini chart bars rise alongside. */
export function CompaniesIcon({ className }: IconProps) {
  return (
    <SVG className={`wsi ${className ?? ""}`}>
      <rect x="4" y="4" width="9" height="16" rx="1.2" />
      <rect
        className="wsi-win"
        x="6"
        y="6.5"
        width="1.7"
        height="1.7"
        rx="0.3"
        fill="currentColor"
        stroke="none"
      />
      <rect
        className="wsi-win wsi-d1"
        x="9.3"
        y="6.5"
        width="1.7"
        height="1.7"
        rx="0.3"
        fill="currentColor"
        stroke="none"
      />
      <rect
        className="wsi-win wsi-d2"
        x="6"
        y="10"
        width="1.7"
        height="1.7"
        rx="0.3"
        fill="currentColor"
        stroke="none"
      />
      <rect
        className="wsi-win wsi-d3"
        x="9.3"
        y="10"
        width="1.7"
        height="1.7"
        rx="0.3"
        fill="currentColor"
        stroke="none"
      />
      <rect
        className="wsi-win wsi-d1"
        x="6"
        y="13.5"
        width="1.7"
        height="1.7"
        rx="0.3"
        fill="currentColor"
        stroke="none"
      />
      <rect
        className="wsi-win wsi-d2"
        x="9.3"
        y="13.5"
        width="1.7"
        height="1.7"
        rx="0.3"
        fill="currentColor"
        stroke="none"
      />
      <rect
        className="wsi-bar"
        x="15.5"
        y="13"
        width="1.8"
        height="7"
        rx="0.4"
        fill="currentColor"
        stroke="none"
        opacity="0.5"
      />
      <rect
        className="wsi-bar wsi-d2"
        x="18.2"
        y="9.5"
        width="1.8"
        height="10.5"
        rx="0.4"
        fill="currentColor"
        stroke="none"
        opacity="0.5"
      />
    </SVG>
  );
}

/** Query — a neural cluster: a central node, satellites pulse, a particle orbits. */
export function QueryIcon({ className }: IconProps) {
  return (
    <SVG className={`wsi ${className ?? ""}`}>
      <line className="wsi-link" x1="12" y1="12" x2="6" y2="7" />
      <line className="wsi-link wsi-d1" x1="12" y1="12" x2="18" y2="8" />
      <line className="wsi-link wsi-d2" x1="12" y1="12" x2="9" y2="18" />
      <circle className="wsi-node" cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
      <circle className="wsi-node wsi-d1" cx="6" cy="7" r="1.7" fill="currentColor" stroke="none" />
      <circle
        className="wsi-node wsi-d2"
        cx="18"
        cy="8"
        r="1.7"
        fill="currentColor"
        stroke="none"
      />
      <circle
        className="wsi-node wsi-d3"
        cx="9"
        cy="18"
        r="1.7"
        fill="currentColor"
        stroke="none"
      />
      <g className="wsi-orbit">
        <circle cx="12" cy="3.6" r="1" fill="currentColor" stroke="none" />
      </g>
    </SVG>
  );
}

/** Briefing — a morning sun rising over a briefing sheet; rays twinkle. */
export function BriefingIcon({ className }: IconProps) {
  return (
    <SVG className={`wsi ${className ?? ""}`}>
      <circle className="wsi-center" cx="12" cy="9" r="3" fill="currentColor" stroke="none" />
      <line className="wsi-spark" x1="12" y1="2.5" x2="12" y2="4" />
      <line className="wsi-spark wsi-d1" x1="5.6" y1="9" x2="4.1" y2="9" />
      <line className="wsi-spark wsi-d2" x1="19.9" y1="9" x2="18.4" y2="9" />
      <line className="wsi-spark wsi-d3" x1="7.4" y1="4.4" x2="6.4" y2="3.4" />
      <line className="wsi-spark wsi-d1" x1="16.6" y1="4.4" x2="17.6" y2="3.4" />
      <line className="wsi-win" x1="6" y1="15" x2="18" y2="15" />
      <line className="wsi-win wsi-d1" x1="6" y1="18" x2="18" y2="18" />
      <line className="wsi-win wsi-d2" x1="6" y1="21" x2="13" y2="21" />
    </SVG>
  );
}

/** Dashboard — axes with rising bars and a line graph that draws itself. */
export function DashboardIcon({ className }: IconProps) {
  return (
    <SVG className={`wsi ${className ?? ""}`}>
      <path d="M4.5 4 L4.5 19.5 L20 19.5" opacity="0.5" />
      <rect
        className="wsi-bar"
        x="6.5"
        y="12.5"
        width="2.4"
        height="7"
        rx="0.4"
        fill="currentColor"
        stroke="none"
        opacity="0.4"
      />
      <rect
        className="wsi-bar wsi-d1"
        x="10.6"
        y="9.5"
        width="2.4"
        height="10"
        rx="0.4"
        fill="currentColor"
        stroke="none"
        opacity="0.4"
      />
      <rect
        className="wsi-bar wsi-d2"
        x="14.7"
        y="6.5"
        width="2.4"
        height="13"
        rx="0.4"
        fill="currentColor"
        stroke="none"
        opacity="0.4"
      />
      <path className="wsi-line" d="M5.5 15.5 L9.5 11.5 L13 13.5 L19 6.5" />
    </SVG>
  );
}
