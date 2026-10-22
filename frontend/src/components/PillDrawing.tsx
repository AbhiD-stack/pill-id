import { useId } from "react";
import { COLOR_OPTIONS, SHAPE_OPTIONS, scoreMarkLines, shapeIconPath } from "@/lib/pillAppearance";

// A drawing of a pill made from its FDA description (shape, color(s),
// imprint, score marks) -- drawn exactly from those facts, nothing made up.
// Used instead of package/label photos. Only drawn when the shape and color
// are both on file; otherwise the caller shows "No photo".

export type PillLookFacts = {
  imprint?: string | null;
  color?: string | null;
  shape?: string | null;
  scoreMarks?: string | null;
};

const SWATCH = new Map(COLOR_OPTIONS.map((c) => [c.label, c.swatch]));
const SHAPES = new Set<string>(SHAPE_OPTIONS);

// "BLUE(light blue),RED" / "white(white to off-white)" -> ["BLUE", "RED"] / ["WHITE"].
// Any color outside the FDA's standard list means we can't draw it faithfully.
function parseColors(color: string | null | undefined): string[] | null {
  const parts = (color ?? "")
    .split(",")
    .map((t) => t.replace(/\(.*$/, "").trim().toUpperCase())
    .filter(Boolean);
  if (parts.length === 0 || parts.some((p) => !SWATCH.has(p))) return null;
  return [...new Set(parts)].slice(0, 2);
}

// "HEXAGON (6 sided)" / "capsule " -> "HEXAGON" / "CAPSULE".
function parseShape(shape: string | null | undefined): string | null {
  const s = (shape ?? "").replace(/\(.*$/, "").trim().toUpperCase();
  return SHAPES.has(s) ? s : null;
}

export function canDrawPill(look: PillLookFacts | undefined): boolean {
  return !!look && !!parseShape(look.shape) && !!parseColors(look.color);
}

// Readable ink on the pill's color.
function inkFor(swatch: string): string {
  const n = parseInt(swatch.slice(1), 16);
  const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 140 ? "#334155" : "#f8fafc";
}

// Imprint tokens ("XANAX;0;5") on up to two lines.
function imprintLines(imprint: string | null | undefined): string[] {
  const tokens = (imprint ?? "").split(";").map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return [];
  const text = tokens.join(" ");
  if (text.length <= 7 || tokens.length === 1) return [text];
  let best = 1;
  let bestDiff = Infinity;
  for (let i = 1; i < tokens.length; i++) {
    const diff = Math.abs(tokens.slice(0, i).join(" ").length - tokens.slice(i).join(" ").length);
    if (diff < bestDiff) [best, bestDiff] = [i, diff];
  }
  return [tokens.slice(0, best).join(" "), tokens.slice(best).join(" ")];
}

// The capsule outline is small in the shared 24x24 icon space; draw it larger.
const SCALE: Record<string, number> = { CAPSULE: 1.3 };

// Room for the imprint inside each outline (24x24 space): [width, height].
function textBox(shape: string): [number, number] {
  if (shape === "CAPSULE") return [18, 8.5]; // drawn 1.3x larger, see SCALE
  if (shape === "OVAL" || shape === "RECTANGLE") return [15, 8.5];
  if (shape === "SEMI-CIRCLE") return [12, 5];
  return [12, 11];
}

export default function PillDrawing({ look, title }: { look: PillLookFacts; title: string }) {
  const rawId = useId();
  const shape = parseShape(look.shape);
  const colors = parseColors(look.color);
  if (!shape || !colors) return null;

  const [c1, c2 = c1] = colors.map((c) => SWATCH.get(c)!);
  const id = `pill${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const outline = shapeIconPath(shape);
  const capsule = shape === "CAPSULE";
  const lines = imprintLines(look.imprint);
  const ink = inkFor(c1);
  const halo = ink === "#334155" ? "#ffffff" : "#0f172a";
  const [boxW, boxH] = textBox(shape);
  const longest = Math.max(1, ...lines.map((l) => l.length));
  // Monospace glyphs are ~0.6em wide; lines are spaced 1.1em.
  const fontSize = Math.min(4.2, boxW / (0.62 * longest), boxH / (1.1 * Math.max(1, lines.length)));

  // Outline in the 24x24 icon space (shared with the appearance picker).
  const shapeEl = (fill: string, extra: Record<string, string> = {}) =>
    outline.kind === "ellipse" ? (
      (() => {
        const [cx, cy, rx, ry] = outline.d.split(",").map(Number);
        return <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill={fill} {...extra} />;
      })()
    ) : outline.kind === "polygon" ? (
      <polygon points={outline.d} fill={fill} strokeLinejoin="round" {...extra} />
    ) : (
      <path d={outline.d} fill={fill} fillRule="evenodd" {...extra} />
    );

  return (
    <svg viewBox="0 0 24 24" className="w-full h-full" role="img" aria-label={title}>
      <title>{title}</title>
      <defs>
        <clipPath id={`${id}-clip`}>{shapeEl("#000")}</clipPath>
        <radialGradient id={`${id}-shine`} cx="35%" cy="30%" r="75%">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g transform={`translate(12 12) scale(${SCALE[shape] ?? 1}) translate(-12 -12)`}>
      <g clipPath={`url(#${id}-clip)`}>
        <rect x="0" y="0" width="24" height="24" fill={c1} />
        {c2 !== c1 && <rect x="12" y="0" width="12" height="24" fill={c2} />}
        <rect x="0" y="0" width="24" height="24" fill={`url(#${id}-shine)`} />
        {!capsule &&
          scoreMarkLines(look.scoreMarks ?? "").map(([x1, y1, x2, y2], i) => (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={ink} strokeOpacity="0.35" strokeWidth="0.5" />
          ))}
        {capsule && c2 === c1 && <line x1="12" y1="0" x2="12" y2="24" stroke="#000" strokeOpacity="0.15" strokeWidth="0.3" />}
      </g>
      {shapeEl("none", { stroke: "#0f172a", strokeOpacity: "0.35", strokeWidth: "0.4" })}
      </g>
      {lines.map((l, i) => (
        <text
          key={i}
          x="12"
          y={12 + (i - (lines.length - 1) / 2) * fontSize * 1.1}
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily="ui-monospace, Menlo, Consolas, monospace"
          fontWeight="700"
          fontSize={fontSize}
          fill={ink}
          stroke={halo}
          strokeOpacity={c2 !== c1 ? 0.6 : 0}
          strokeWidth={fontSize * 0.12}
          paintOrder="stroke"
        >
          {l}
        </text>
      ))}
    </svg>
  );
}
