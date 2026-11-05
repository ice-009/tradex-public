import type { ReactNode, SVGProps } from "react";
import type { Tool } from "@/chart/types";
import type { LayoutId } from "./store";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

const dot = (cx: number, cy: number) => <circle cx={cx} cy={cy} r={1.8} fill="currentColor" stroke="none" />;

export const Icons = {
  cursor: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 3l13 8-6 1.5L9 19z" />
    </Svg>
  ),
  trendline: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 19L19 5" />
      {dot(5, 19)}
      {dot(19, 5)}
    </Svg>
  ),
  ray: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 19L21 3" />
      {dot(5, 19)}
      {dot(12, 12)}
    </Svg>
  ),
  extended: (p: IconProps) => (
    <Svg {...p}>
      <path d="M2 22L22 2" />
      {dot(8, 16)}
      {dot(16, 8)}
    </Svg>
  ),
  hline: (p: IconProps) => (
    <Svg {...p}>
      <path d="M2 12h20" />
      {dot(12, 12)}
    </Svg>
  ),
  hray: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6 12h16" />
      {dot(6, 12)}
    </Svg>
  ),
  vline: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 2v20" />
      {dot(12, 12)}
    </Svg>
  ),
  rect: (p: IconProps) => (
    <Svg {...p}>
      <rect x={4} y={6} width={16} height={12} rx={1} />
      {dot(4, 6)}
      {dot(20, 18)}
    </Svg>
  ),
  fib: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 5h18M3 9.5h18M3 13h18M3 19h18" />
    </Svg>
  ),
  measure: (p: IconProps) => (
    <Svg {...p}>
      <rect x={4} y={5} width={16} height={14} rx={1} strokeDasharray="2 2" />
      <path d="M12 8v8M9.5 10.5L12 8l2.5 2.5M8 12h8" />
    </Svg>
  ),
  pricerange: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 4h14M5 20h14M12 6v12M9 9l3-3 3 3M9 15l3 3 3-3" />
    </Svg>
  ),
  daterange: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 5v14M20 5v14M6 12h12M9 9l-3 3 3 3M15 9l3 3-3 3" />
    </Svg>
  ),
  arrow: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 19L18 6" />
      <path d="M10 5h9v9" />
    </Svg>
  ),
  channel: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 15L15 4M9 20L21 9" />
      <path d="M6 17.5L18 6.5" strokeDasharray="2 2.5" />
      {dot(3, 15)}
      {dot(15, 4)}
      {dot(21, 9)}
    </Svg>
  ),
  brush: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 17c3-1 3-6 6-6s2 5 5 5 3-7 7-9" />
    </Svg>
  ),
  text: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 6V4h14v2M12 4v16M9 20h6" />
    </Svg>
  ),
  long: (p: IconProps) => (
    <Svg {...p}>
      <rect x={4} y={3} width={16} height={10} rx={1} fill="rgba(38, 166, 154, 0.3)" stroke="#26a69a" />
      <rect x={4} y={13} width={16} height={7} rx={1} fill="rgba(239, 83, 80, 0.26)" stroke="#ef5350" />
      <path d="M8 10l4-4 4 4" stroke="currentColor" />
    </Svg>
  ),
  short: (p: IconProps) => (
    <Svg {...p}>
      <rect x={4} y={4} width={16} height={7} rx={1} fill="rgba(239, 83, 80, 0.26)" stroke="#ef5350" />
      <rect x={4} y={11} width={16} height={10} rx={1} fill="rgba(38, 166, 154, 0.3)" stroke="#26a69a" />
      <path d="M8 14l4 4 4-4" stroke="currentColor" />
    </Svg>
  ),
  lock: (p: IconProps) => (
    <Svg {...p}>
      <rect x={5} y={11} width={14} height={10} rx={2} />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </Svg>
  ),
  unlock: (p: IconProps) => (
    <Svg {...p}>
      <rect x={5} y={11} width={14} height={10} rx={2} />
      <path d="M8 11V8a4 4 0 017.7-1.5" />
    </Svg>
  ),
  clone: (p: IconProps) => (
    <Svg {...p}>
      <rect x={8} y={8} width={12} height={12} rx={2} />
      <path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3" />
    </Svg>
  ),
  camera: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 8h3l2-3h6l2 3h3a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z" />
      <circle cx={12} cy={13.5} r={3.5} />
    </Svg>
  ),
  grip: (p: IconProps) => (
    <Svg {...p}>
      {dot(9, 6)}
      {dot(15, 6)}
      {dot(9, 12)}
      {dot(15, 12)}
      {dot(9, 18)}
      {dot(15, 18)}
    </Svg>
  ),
  undo: (p: IconProps) => (
    <Svg {...p}>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10a6 6 0 010 12h-3" />
    </Svg>
  ),
  redo: (p: IconProps) => (
    <Svg {...p}>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H10a6 6 0 000 12h3" />
    </Svg>
  ),
  sync: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3v18M3 12h18" strokeDasharray="2.5 2" />
      <circle cx={12} cy={12} r={2.5} />
    </Svg>
  ),
  extendRight: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 16L20 8" />
      <path d="M14 11l-10 5" strokeWidth={2.4} />
    </Svg>
  ),
  caret: (p: IconProps) => (
    <Svg {...p}>
      <path d="M8 16l8 0 0-8z" fill="currentColor" stroke="none" />
    </Svg>
  ),
  magnet: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6 3v9a6 6 0 0012 0V3" />
      <path d="M6 7h3M15 7h3" />
    </Svg>
  ),
  trash: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
    </Svg>
  ),
  plus: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  ),
  check: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Svg>
  ),
  x: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  ),
  eye: (p: IconProps) => (
    <Svg {...p}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx={12} cy={12} r={3} />
    </Svg>
  ),
  eyeOff: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 3l18 18M10.6 5.1A10 10 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.6 9.6 0 005.4-1.6" />
    </Svg>
  ),
  gear: (p: IconProps) => (
    <Svg {...p}>
      <circle cx={12} cy={12} r={3} />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </Svg>
  ),
  search: (p: IconProps) => (
    <Svg {...p}>
      <circle cx={11} cy={11} r={7} />
      <path d="M20 20l-3.5-3.5" />
    </Svg>
  ),
  star: ({ filled, ...p }: IconProps & { filled?: boolean }) => (
    <Svg {...p}>
      <path
        d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"
        fill={filled ? "currentColor" : "none"}
      />
    </Svg>
  ),
  bell: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </Svg>
  ),
  ticket: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 6h16v4a2 2 0 0 0 0 4v4H4v-4a2 2 0 0 0 0-4z" />
      <path d="M9 9h6M9 12h6M9 15h4" />
    </Svg>
  ),
  patterns: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 18l5-9 4 5 4-8 5 12" />
      <path d="M3 6h18" strokeDasharray="2 2.5" />
    </Svg>
  ),
  link: (p: IconProps) => (
    <Svg {...p}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </Svg>
  ),
  trending: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 17l6-6 4 4 7-7" />
      <path d="M14 8h6v6" />
    </Svg>
  ),
  sectors: (p: IconProps) => (
    <Svg {...p}>
      <rect x={3} y={3} width={8} height={10} rx={1.5} />
      <rect x={13} y={3} width={8} height={6} rx={1.5} />
      <rect x={13} y={11} width={8} height={10} rx={1.5} />
      <rect x={3} y={15} width={8} height={6} rx={1.5} />
    </Svg>
  ),
  calendar: (p: IconProps) => (
    <Svg {...p}>
      <rect x={3.5} y={5} width={17} height={15} rx={2} />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
      <path d="M8 14h3v3H8z" />
    </Svg>
  ),
  chevronUp: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6 15l6-6 6 6" />
    </Svg>
  ),
  list: (p: IconProps) => (
    <Svg {...p}>
      <path d="M8 6h12M8 12h12M8 18h12" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" strokeWidth={2.4} />
    </Svg>
  ),
  maximize: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </Svg>
  ),
  minimize: (p: IconProps) => (
    <Svg {...p}>
      <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
    </Svg>
  ),
  target: (p: IconProps) => (
    <Svg {...p}>
      <circle cx={12} cy={12} r={8} />
      <circle cx={12} cy={12} r={4} />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </Svg>
  ),
  chevronDown: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6 9l6 6 6-6" />
    </Svg>
  ),
  candles: (p: IconProps) => (
    <Svg {...p}>
      <path d="M8 3v3M8 16v5M16 3v6M16 17v4" />
      <rect x={6} y={6} width={4} height={10} rx={0.5} />
      <rect x={14} y={9} width={4} height={8} rx={0.5} fill="currentColor" />
    </Svg>
  ),
  indicators: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 17l5-6 4 3 4-6 5 5" />
      <path d="M3 21h18" />
    </Svg>
  ),
  sidebar: (p: IconProps) => (
    <Svg {...p}>
      <rect x={3} y={4} width={18} height={16} rx={2} />
      <path d="M15 4v16" />
    </Svg>
  ),
  realtime: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6 6l6 6-6 6M13 6l6 6-6 6" />
    </Svg>
  ),
  screener: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 5h18l-7 8v6l-4 2v-8z" />
    </Svg>
  ),
  logout: (p: IconProps) => (
    <Svg {...p}>
      <path d="M15 4h4a1 1 0 011 1v14a1 1 0 01-1 1h-4M10 17l5-5-5-5M15 12H3" />
    </Svg>
  ),
  reset: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 12a9 9 0 109-9 9.7 9.7 0 00-6.7 2.8L3 8" />
      <path d="M3 3v5h5" />
    </Svg>
  ),
};

export function ToolIcon({ tool, size }: { tool: Tool; size?: number }) {
  const Icon = Icons[tool];
  return <Icon size={size} />;
}

export function LayoutIcon({ layout }: { layout: LayoutId }) {
  const frame = { x: 3, y: 4, width: 18, height: 16, rx: 1.5 };
  return (
    <Svg size={18}>
      <rect {...frame} />
      {layout === "2v" && <path d="M12 4v16" />}
      {layout === "2h" && <path d="M3 12h18" />}
      {layout === "3" && <path d="M12 4v16M12 12h9" />}
      {layout === "4" && <path d="M12 4v16M3 12h18" />}
    </Svg>
  );
}
