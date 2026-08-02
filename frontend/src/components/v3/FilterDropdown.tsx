"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export type DropdownOption = { value: string; label: string; icon?: ReactNode };

// A custom dropdown (not a native <select>) so each option can carry a small
// illustration -- native <option> elements can't contain arbitrary markup.
export function FilterDropdown({
  label,
  value,
  onChange,
  options,
  placeholder = "Any",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: DropdownOption[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const selected = options.find((o) => o.value === value);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-sm"
      >
        <span className="flex min-w-0 items-center gap-2">
          {selected?.icon}
          <span className={`truncate ${selected ? "text-slate-800" : "text-slate-400"}`}>
            {selected?.label ?? placeholder}
          </span>
        </span>
        <span className="shrink-0 text-slate-400">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          <button
            type="button"
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-400 hover:bg-slate-50"
          >
            {placeholder}
          </button>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50 ${
                value === o.value ? "bg-sky-50 font-medium text-sky-700" : "text-slate-700"
              }`}
            >
              {o.icon}
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Illustrations ───────────────────────────────────────────────────────────

export function ColorSwatch({ color }: { color: string }) {
  return (
    <span
      className="inline-block h-4 w-4 shrink-0 rounded-full border border-slate-300"
      style={{ backgroundColor: color }}
    />
  );
}

const SHAPE_STYLES: Record<string, React.CSSProperties> = {
  round: { width: 16, height: 16, borderRadius: "50%" },
  oval: { width: 22, height: 13, borderRadius: "50%" },
  capsule: { width: 22, height: 11, borderRadius: 6 },
  rectangle: { width: 20, height: 11, borderRadius: 2 },
  square: { width: 15, height: 15, borderRadius: 2 },
  diamond: { width: 13, height: 13, transform: "rotate(45deg)" },
  triangle: { width: 16, height: 14, border: "none", background: "#94a3b8", clipPath: "polygon(50% 0%, 0% 100%, 100% 100%)" },
  pentagon: { width: 16, height: 15, border: "none", background: "#94a3b8", clipPath: "polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%)" },
  hexagon: { width: 16, height: 14, border: "none", background: "#94a3b8", clipPath: "polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)" },
};

export function ShapeIcon({ shape }: { shape: string }) {
  return (
    <span
      className="inline-block shrink-0 border border-slate-500 bg-slate-200"
      style={SHAPE_STYLES[shape] ?? { width: 16, height: 16 }}
    />
  );
}

export function ScoreMarkIcon({ marks }: { marks: "none" | "single" | "cross" }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className="shrink-0">
      <circle cx="8" cy="8" r="6.5" fill="#e2e8f0" stroke="#94a3b8" />
      {marks !== "none" && <line x1="2.5" y1="8" x2="13.5" y2="8" stroke="#475569" strokeWidth="1.2" />}
      {marks === "cross" && <line x1="8" y1="2.5" x2="8" y2="13.5" stroke="#475569" strokeWidth="1.2" />}
    </svg>
  );
}

export const COLOR_OPTIONS: DropdownOption[] = [
  { value: "white", label: "White", icon: <ColorSwatch color="#ffffff" /> },
  { value: "yellow", label: "Yellow", icon: <ColorSwatch color="#facc15" /> },
  { value: "orange", label: "Orange", icon: <ColorSwatch color="#fb923c" /> },
  { value: "pink", label: "Pink", icon: <ColorSwatch color="#f9a8d4" /> },
  { value: "red", label: "Red", icon: <ColorSwatch color="#ef4444" /> },
  { value: "brown", label: "Brown", icon: <ColorSwatch color="#92400e" /> },
  { value: "tan", label: "Tan / Beige", icon: <ColorSwatch color="#d2b48c" /> },
  { value: "gray", label: "Gray", icon: <ColorSwatch color="#9ca3af" /> },
  { value: "green", label: "Green", icon: <ColorSwatch color="#22c55e" /> },
  { value: "blue", label: "Blue", icon: <ColorSwatch color="#3b82f6" /> },
  { value: "purple", label: "Purple", icon: <ColorSwatch color="#a855f7" /> },
  { value: "black", label: "Black", icon: <ColorSwatch color="#1e293b" /> },
  { value: "clear", label: "Clear", icon: <ColorSwatch color="#f1f5f9" /> },
];

export const SHAPE_OPTIONS: DropdownOption[] = [
  { value: "round", label: "Round", icon: <ShapeIcon shape="round" /> },
  { value: "oval", label: "Oval", icon: <ShapeIcon shape="oval" /> },
  { value: "capsule", label: "Capsule / Oblong", icon: <ShapeIcon shape="capsule" /> },
  { value: "rectangle", label: "Rectangle", icon: <ShapeIcon shape="rectangle" /> },
  { value: "square", label: "Square", icon: <ShapeIcon shape="square" /> },
  { value: "diamond", label: "Diamond", icon: <ShapeIcon shape="diamond" /> },
  { value: "triangle", label: "Triangle", icon: <ShapeIcon shape="triangle" /> },
  { value: "pentagon", label: "Pentagon", icon: <ShapeIcon shape="pentagon" /> },
  { value: "hexagon", label: "Hexagon", icon: <ShapeIcon shape="hexagon" /> },
];

export const SCORE_OPTIONS: DropdownOption[] = [
  { value: "none", label: "No score line", icon: <ScoreMarkIcon marks="none" /> },
  { value: "bisect", label: "Single score (bisected)", icon: <ScoreMarkIcon marks="single" /> },
  { value: "cross", label: "Cross score (quadrisected)", icon: <ScoreMarkIcon marks="cross" /> },
];
