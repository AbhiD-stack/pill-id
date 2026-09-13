"use client";

import { useCallback, useRef, useState } from "react";
import type { TimeOfDay } from "@/lib/db";

// Fitts's Law: movement time to a target scales with distance and shrinks
// with target size (Fitts, 1954) -- so for a population with reduced fine
// motor control, the fix isn't a cleverer gesture, it's fewer/bigger/closer
// targets. These three drop zones are intentionally large (min-h-tap, a
// 5rem geriatric-UX token already used elsewhere), high-contrast, and
// always in the same fixed spot at the bottom of the Scan results -- never
// small buttons scattered per-card.
//
// Native HTML5 drag-and-drop (draggable/onDragStart/onDrop) has unreliable
// touch support on mobile Safari/Chrome, which is most of this app's real
// audience -- so this uses Pointer Events instead (same mechanism already
// proven in CaptureCropper's pinch/pan), which works consistently for
// mouse, touch, and pen.

const ZONES: { bucket: TimeOfDay; label: string; icon: string; className: string }[] = [
  { bucket: "morning", label: "Morning", icon: "🌅", className: "bg-bucket-morning" },
  { bucket: "noon", label: "Noon", icon: "☀️", className: "bg-bucket-noon" },
  { bucket: "night", label: "Night", icon: "🌙", className: "bg-bucket-night" },
];

export type DragHandleProps = {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: () => void;
};

export function useDragToSchedule<T>(onDrop: (payload: T, bucket: TimeOfDay) => void) {
  const zoneRefs = useRef<Record<TimeOfDay, HTMLDivElement | null>>({
    morning: null,
    noon: null,
    night: null,
  });
  const [activeZone, setActiveZone] = useState<TimeOfDay | null>(null);
  const [drag, setDrag] = useState<{ label: string; x: number; y: number } | null>(null);
  const draggingRef = useRef(false);
  const payloadRef = useRef<T | null>(null);

  const zoneAt = useCallback((x: number, y: number): TimeOfDay | null => {
    for (const z of ZONES) {
      const el = zoneRefs.current[z.bucket];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return z.bucket;
    }
    return null;
  }, []);

  const bindDragHandle = useCallback(
    (label: string, payload: T) => ({
      onPointerDown: (e: React.PointerEvent) => {
        (e.target as Element).setPointerCapture(e.pointerId);
        draggingRef.current = true;
        payloadRef.current = payload;
        setDrag({ label, x: e.clientX, y: e.clientY });
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (!draggingRef.current) return;
        setDrag({ label, x: e.clientX, y: e.clientY });
        setActiveZone(zoneAt(e.clientX, e.clientY));
      },
      onPointerUp: (e: React.PointerEvent) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        const bucket = zoneAt(e.clientX, e.clientY);
        setDrag(null);
        setActiveZone(null);
        if (bucket && payloadRef.current !== null) onDrop(payloadRef.current, bucket);
        payloadRef.current = null;
      },
      onPointerCancel: () => {
        draggingRef.current = false;
        payloadRef.current = null;
        setDrag(null);
        setActiveZone(null);
      },
    }),
    [onDrop, zoneAt]
  );

  return { zoneRefs, activeZone, drag, bindDragHandle };
}

export function ScheduleDropZones({
  zoneRefs,
  activeZone,
}: {
  zoneRefs: React.MutableRefObject<Record<TimeOfDay, HTMLDivElement | null>>;
  activeZone: TimeOfDay | null;
}) {
  return (
    <div className="space-y-2">
      <p className="text-center text-xs font-semibold text-slate-500">
        Drag a match below onto a time of day to add it to your schedule
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {ZONES.map((z) => (
          <div
            key={z.bucket}
            ref={(el) => {
              zoneRefs.current[z.bucket] = el;
            }}
            className={`flex min-h-tap flex-col items-center justify-center rounded-2xl border-4 border-dashed text-white transition-all ${z.className} ${
              activeZone === z.bucket ? "scale-105 border-white shadow-xl" : "border-white/40"
            }`}
          >
            <span className="text-3xl">{z.icon}</span>
            <span className="text-senior font-bold">{z.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DragGhost({ drag }: { drag: { label: string; x: number; y: number } | null }) {
  if (!drag) return null;
  return (
    <div
      className="pointer-events-none fixed z-50 flex max-w-[220px] items-center gap-2 rounded-xl border-2 border-sky-400 bg-white px-3 py-2 text-sm font-semibold text-slate-800 shadow-2xl"
      style={{ left: drag.x, top: drag.y, transform: "translate(-50%, -120%)" }}
    >
      💊 {drag.label}
    </div>
  );
}
