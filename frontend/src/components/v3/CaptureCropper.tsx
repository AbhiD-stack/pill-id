"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const VIEWPORT = 320; // on-screen preview size, px
const GUIDE_SIZE = 240; // the square that actually gets captured, px

type Mode = "choose" | "camera" | "edit";

type Point = { x: number; y: number };

function dist(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function mid(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export default function CaptureCropper({
  onCapture,
  onCancel,
  title = "Take or upload a photo",
  helpText = "Pinch or use the +/- buttons to zoom, drag to reposition, then tap Use This Photo.",
  initialBrightness = 1.0,
}: {
  onCapture: (canvas: HTMLCanvasElement, meta: { rotation: number; adjustments: number }) => void;
  onCancel?: () => void;
  title?: string;
  helpText?: string;
  initialBrightness?: number;
}) {
  const [mode, setMode] = useState<Mode>("choose");
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  const [rotation, setRotation] = useState(0);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [brightness, setBrightness] = useState(initialBrightness);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  // Counts distinct pinch/drag/zoom/rotate gestures during editing -- purely
  // a UX metric surfaced in the Share tab's export token, mirroring v1/v2's
  // rotation/adjustment telemetry. Never sent anywhere on its own.
  const adjustmentCount = useRef(0);
  const gestureMoved = useRef(false);

  const pointers = useRef<Map<number, Point>>(new Map());
  const lastDist = useRef<number | null>(null);
  const lastMid = useRef<Point | null>(null);

  const resetEdit = () => {
    setRotation(0);
    setScale(1);
    setOffset({ x: 0, y: 0 });
    adjustmentCount.current = 0;
    gestureMoved.current = false;
  };

  const loadImageFromDataUrl = (dataUrl: string) => {
    const img = new Image();
    img.onload = () => {
      setImgEl(img);
      resetEdit();
      setMode("edit");
    };
    img.src = dataUrl;
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => loadImageFromDataUrl(evt.target?.result as string);
    reader.readAsDataURL(file);
  };

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 1280 } },
      });
      setMode("camera");
      if (videoRef.current) videoRef.current.srcObject = stream;
    } catch {
      alert("Camera access denied or unavailable. Try uploading a photo instead.");
    }
  };

  const captureFromCamera = () => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    const stream = video.srcObject as MediaStream;
    stream?.getTracks().forEach((t) => t.stop());
    loadImageFromDataUrl(canvas.toDataURL("image/jpeg", 0.95));
  };

  const cancelCamera = () => {
    const stream = videoRef.current?.srcObject as MediaStream | undefined;
    stream?.getTracks().forEach((t) => t.stop());
    setMode("choose");
  };

  // Draws the current image + transform into the full VIEWPORT-sized canvas.
  // Both the live preview and the final captured crop use this same function
  // so what you see is exactly what gets sent for identification.
  const drawViewport = useCallback(
    (canvas: HTMLCanvasElement) => {
      canvas.width = VIEWPORT;
      canvas.height = VIEWPORT;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, VIEWPORT, VIEWPORT);
      ctx.fillStyle = "#0f172a";
      ctx.fillRect(0, 0, VIEWPORT, VIEWPORT);
      if (!imgEl) return;

      ctx.save();
      ctx.filter = `brightness(${brightness})`;
      ctx.translate(VIEWPORT / 2 + offset.x, VIEWPORT / 2 + offset.y);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.scale(scale, scale);

      // "object-fit: contain" sizing so the whole photo starts fully visible.
      const arImg = imgEl.naturalWidth / imgEl.naturalHeight;
      let drawW = VIEWPORT;
      let drawH = VIEWPORT / arImg;
      if (drawH < VIEWPORT) {
        drawH = VIEWPORT;
        drawW = VIEWPORT * arImg;
      }
      ctx.drawImage(imgEl, -drawW / 2, -drawH / 2, drawW, drawH);
      ctx.restore();
    },
    [imgEl, rotation, scale, offset, brightness]
  );

  useEffect(() => {
    if (mode !== "edit" || !previewCanvasRef.current) return;
    drawViewport(previewCanvasRef.current);
  }, [mode, drawViewport]);

  const handlePointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      lastDist.current = dist(a, b);
      lastMid.current = mid(a, b);
    } else {
      lastMid.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d = dist(a, b);
      const m = mid(a, b);
      if (lastDist.current) setScale((s) => clamp(s * (d / lastDist.current!), 0.4, 5));
      if (lastMid.current) {
        setOffset((o) => ({ x: o.x + (m.x - lastMid.current!.x), y: o.y + (m.y - lastMid.current!.y) }));
      }
      lastDist.current = d;
      lastMid.current = m;
      gestureMoved.current = true;
    } else if (pointers.current.size === 1) {
      const p = [...pointers.current.values()][0];
      if (lastMid.current) {
        setOffset((o) => ({ x: o.x + (p.x - lastMid.current!.x), y: o.y + (p.y - lastMid.current!.y) }));
      }
      lastMid.current = p;
      gestureMoved.current = true;
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      if (gestureMoved.current) adjustmentCount.current += 1;
      gestureMoved.current = false;
      lastDist.current = null;
      lastMid.current = null;
    } else if (pointers.current.size === 1) {
      lastMid.current = [...pointers.current.values()][0];
      lastDist.current = null;
    }
  };

  const handleUsePhoto = () => {
    if (!previewCanvasRef.current) return;
    const full = previewCanvasRef.current;
    const guideOffset = (VIEWPORT - GUIDE_SIZE) / 2;
    const cropped = document.createElement("canvas");
    cropped.width = GUIDE_SIZE;
    cropped.height = GUIDE_SIZE;
    cropped
      .getContext("2d")!
      .drawImage(full, guideOffset, guideOffset, GUIDE_SIZE, GUIDE_SIZE, 0, 0, GUIDE_SIZE, GUIDE_SIZE);
    onCapture(cropped, { rotation, adjustments: adjustmentCount.current });
  };

  return (
    <div className="space-y-4">
      {mode === "choose" && (
        <div className="rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 p-6 text-center">
          <div className="mb-2 text-3xl">📷</div>
          <h3 className="mb-1 font-semibold text-slate-900">{title}</h3>
          <p className="mb-4 text-sm text-slate-500">Good lighting and a plain background work best.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white transition hover:bg-slate-800"
            >
              Upload Photo
            </button>
            <button
              onClick={startCamera}
              className="rounded-xl bg-sky-600 px-5 py-3 font-semibold text-white transition hover:bg-sky-700"
            >
              Use Camera
            </button>
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileSelect} />
          {onCancel && (
            <button onClick={onCancel} className="mt-4 text-sm font-medium text-slate-400 hover:text-slate-600">
              Cancel
            </button>
          )}
        </div>
      )}

      {mode === "camera" && (
        <div className="space-y-3">
          <video ref={videoRef} autoPlay playsInline muted className="w-full rounded-2xl" />
          <div className="flex gap-2">
            <button
              onClick={captureFromCamera}
              className="flex-1 rounded-xl bg-sky-600 py-3 font-semibold text-white hover:bg-sky-700"
            >
              Capture
            </button>
            <button
              onClick={cancelCamera}
              className="flex-1 rounded-xl bg-slate-200 py-3 font-semibold text-slate-700 hover:bg-slate-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === "edit" && (
        <div className="space-y-4">
          <p className="text-center text-xs text-slate-500">{helpText}</p>
          <div className="flex justify-center">
            <div
              className="relative touch-none select-none overflow-hidden rounded-2xl border-2 border-slate-700 bg-slate-900"
              style={{ width: VIEWPORT, height: VIEWPORT }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            >
              <canvas ref={previewCanvasRef} width={VIEWPORT} height={VIEWPORT} />
              {/* Fixed crop guide -- pinch/drag the photo underneath this frame */}
              <div
                className="pointer-events-none absolute rounded-xl border-2 border-yellow-400/90"
                style={{
                  left: (VIEWPORT - GUIDE_SIZE) / 2,
                  top: (VIEWPORT - GUIDE_SIZE) / 2,
                  width: GUIDE_SIZE,
                  height: GUIDE_SIZE,
                  boxShadow: "0 0 0 999px rgba(15,23,42,0.55)",
                }}
              />
            </div>
          </div>

          <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-sm font-medium text-slate-700">Zoom</span>
              <button
                onClick={() => {
                  setScale((s) => clamp(s - 0.15, 0.4, 5));
                  adjustmentCount.current += 1;
                }}
                className="h-9 w-9 rounded-lg bg-slate-100 font-bold text-slate-700 hover:bg-slate-200"
              >
                −
              </button>
              <input
                type="range"
                min={0.4}
                max={5}
                step={0.05}
                value={scale}
                onChange={(e) => {
                  setScale(parseFloat(e.target.value));
                  adjustmentCount.current += 1;
                }}
                className="flex-1"
              />
              <button
                onClick={() => {
                  setScale((s) => clamp(s + 0.15, 0.4, 5));
                  adjustmentCount.current += 1;
                }}
                className="h-9 w-9 rounded-lg bg-slate-100 font-bold text-slate-700 hover:bg-slate-200"
              >
                +
              </button>
            </div>

            <div className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-sm font-medium text-slate-700">Brightness</span>
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                value={brightness}
                onChange={(e) => setBrightness(parseFloat(e.target.value))}
                className="flex-1"
              />
              <span className="w-10 shrink-0 text-right text-xs text-slate-500">{brightness.toFixed(1)}×</span>
            </div>

            <button
              onClick={() => {
                setRotation((r) => (r + 90) % 360);
                adjustmentCount.current += 1;
              }}
              className="w-full rounded-lg bg-slate-100 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-200"
            >
              Rotate 90°
            </button>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleUsePhoto}
              className="flex-1 rounded-xl bg-emerald-600 py-3.5 text-base font-bold text-white hover:bg-emerald-700"
            >
              Use This Photo
            </button>
            <button
              onClick={() => setMode("choose")}
              className="rounded-xl bg-slate-200 px-5 py-3.5 font-semibold text-slate-700 hover:bg-slate-300"
            >
              Retake
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
