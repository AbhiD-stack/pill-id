// Canonical appearance options for the "describe the pill" search, built
// from the real distinct values actually present in ndc_names.json (not
// invented) -- so every option here is guaranteed to match something.

export const SHAPE_OPTIONS = [
  "ROUND",
  "OVAL",
  "CAPSULE",
  "RECTANGLE",
  "TRIANGLE",
  "SQUARE",
  "DIAMOND",
  "HEXAGON",
  "PENTAGON",
  "OCTAGON",
  "TEAR",
  "BULLET",
  "FREEFORM",
  "DOUBLE CIRCLE",
  "SEMI-CIRCLE",
  "TRAPEZOID",
] as const;

export const COLOR_OPTIONS: { label: string; swatch: string }[] = [
  { label: "WHITE", swatch: "#f8fafc" },
  { label: "YELLOW", swatch: "#fde047" },
  { label: "ORANGE", swatch: "#fb923c" },
  { label: "PINK", swatch: "#f9a8d4" },
  { label: "RED", swatch: "#ef4444" },
  { label: "BROWN", swatch: "#92400e" },
  { label: "BLUE", swatch: "#3b82f6" },
  { label: "GREEN", swatch: "#22c55e" },
  { label: "PURPLE", swatch: "#a855f7" },
  { label: "GRAY", swatch: "#9ca3af" },
];

// Raw values in the data are just digit counts ("1".."4") with no
// documented visual convention we could confirm -- labeled plainly rather
// than guessing what each count looks like on a real tablet.
export const SCORE_MARK_OPTIONS = ["1", "2", "3", "4"] as const;

// Simple geometric SVG for each shape -- recognizable, not photorealistic.
export function shapeIconPath(shape: string): { kind: "polygon" | "ellipse" | "path"; d: string } {
  switch (shape) {
    case "ROUND":
      return { kind: "ellipse", d: "12,12,9,9" };
    case "OVAL":
      return { kind: "ellipse", d: "12,12,10,6" };
    case "CAPSULE":
      return { kind: "path", d: "M4 12a8 4 0 0 1 8-4h0a8 4 0 0 1 8 4a8 4 0 0 1-8 4h0a8 4 0 0 1-8-4Z" };
    case "RECTANGLE":
      return { kind: "polygon", d: "3,8 21,8 21,16 3,16" };
    case "TRIANGLE":
      return { kind: "polygon", d: "12,3 21,19 3,19" };
    case "SQUARE":
      return { kind: "polygon", d: "4,4 20,4 20,20 4,20" };
    case "DIAMOND":
      return { kind: "polygon", d: "12,2 22,12 12,22 2,12" };
    case "HEXAGON":
      return { kind: "polygon", d: "7,3 17,3 22,12 17,21 7,21 2,12" };
    case "PENTAGON":
      return { kind: "polygon", d: "12,2 22,10 18,21 6,21 2,10" };
    case "OCTAGON":
      return { kind: "polygon", d: "8,2 16,2 22,8 22,16 16,22 8,22 2,16 2,8" };
    case "TEAR":
      return { kind: "path", d: "M12 2C12 2 20 11 20 16a8 8 0 1 1-16 0C4 11 12 2 12 2Z" };
    case "BULLET":
      return { kind: "path", d: "M4 12a8 8 0 0 1 8-8h8v16h-8a8 8 0 0 1-8-8Z" };
    case "FREEFORM":
      return { kind: "path", d: "M5 8C7 3 15 2 19 6c3 3 1 7 2 10s-4 6-9 5S2 18 3 14 3 13 5 8Z" };
    case "DOUBLE CIRCLE":
      return { kind: "path", d: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-4a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" };
    case "SEMI-CIRCLE":
      return { kind: "path", d: "M3 12a9 9 0 0 1 18 0Z" };
    case "TRAPEZOID":
      return { kind: "polygon", d: "7,5 17,5 21,19 3,19" };
    default:
      return { kind: "ellipse", d: "12,12,9,9" };
  }
}
