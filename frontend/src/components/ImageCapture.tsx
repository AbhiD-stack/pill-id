"use client";

import { useEffect, useRef, useState } from "react";

type CaptureMode = "upload" | "preview";

export default function ImageCapture({
  onImageReady,
  onCancel,
  sideLabel,
  allowSkip,
  onSkip,
}: {
  onImageReady: (canvas: HTMLCanvasElement, width: number, height: number, rotation: number, adjustments: number) => void;
  onCancel: () => void;
  /** e.g. "front" or "back" — shown to guide which face of the pill to capture. */
  sideLabel?: string;
  /** Show a "skip this side" option (used for the optional back-side step). */
  allowSkip?: boolean;
  onSkip?: () => void;
}) {
  const [mode, setMode] = useState<CaptureMode>("upload");
  const [previewSrc, setPreviewSrc] = useState<string>("");
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [cropBox, setCropBox] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const [draggingCorner, setDraggingCorner] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);

  // Redraw preview whenever rotation/zoom/crop changes
  useEffect(() => {
    if (!previewSrc || mode !== "preview") return;

    const canvas = previewCanvasRef.current;
    if (!canvas) return;

    const img = new Image();
    img.onload = () => {
      canvas.width = 300;
      canvas.height = 300;
      const ctx = canvas.getContext("2d")!;

      ctx.save();
      ctx.translate(150, 150);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.scale(zoom, zoom);
      ctx.translate(-150, -150);
      ctx.drawImage(img, 0, 0, 300, 300);
      ctx.restore();
    };
    img.src = previewSrc;
  }, [previewSrc, rotation, zoom, mode]);

  // Upload from device
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      setPreviewSrc(evt.target?.result as string);
      setMode("preview");
      setRotation(0);
      setZoom(1);
      setCropBox({ x: 25, y: 25, w: 250, h: 250 });
    };
    reader.readAsDataURL(file);
  };

  const handleRotate = () => {
    setRotation((r) => (r + 90) % 360);
  };

  const handleZoom = (delta: number) => {
    setZoom((z) => Math.max(0.5, Math.min(3, z + delta)));
  };

  const handleMouseDown = (corner: string) => (e: React.MouseEvent) => {
    setDraggingCorner(corner);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingCorner || !previewContainerRef.current) return;

      const rect = previewContainerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const minSize = 50;
      const maxX = 300;
      const maxY = 300;

      setCropBox((prev) => {
        let newBox = { ...prev };

        // Enforce a square crop box anchored at the opposite corner
        if (draggingCorner === "nw") {
          const candidateW = prev.x + prev.w - x;
          const candidateH = prev.y + prev.h - y;
          let newSize = Math.max(minSize, Math.min(candidateW, candidateH));
          newSize = Math.min(newSize, prev.x + prev.w, prev.y + prev.h, maxX, maxY);
          newBox.w = newBox.h = newSize;
          newBox.x = prev.x + prev.w - newSize;
          newBox.y = prev.y + prev.h - newSize;
        } else if (draggingCorner === "ne") {
          const candidateW = x - prev.x;
          const candidateH = prev.y + prev.h - y;
          let newSize = Math.max(minSize, Math.min(candidateW, candidateH));
          newSize = Math.min(newSize, maxX - prev.x, prev.y + prev.h, maxY);
          newBox.w = newBox.h = newSize;
          newBox.x = prev.x;
          newBox.y = prev.y + prev.h - newSize;
        } else if (draggingCorner === "sw") {
          const candidateW = prev.x + prev.w - x;
          const candidateH = y - prev.y;
          let newSize = Math.max(minSize, Math.min(candidateW, candidateH));
          newSize = Math.min(newSize, prev.x + prev.w, maxY - prev.y, maxX);
          newBox.w = newBox.h = newSize;
          newBox.x = prev.x + prev.w - newSize;
          newBox.y = prev.y;
        } else if (draggingCorner === "se") {
          const candidateW = x - prev.x;
          const candidateH = y - prev.y;
          let newSize = Math.max(minSize, Math.min(candidateW, candidateH));
          newSize = Math.min(newSize, maxX - prev.x, maxY - prev.y);
          newBox.w = newBox.h = newSize;
          newBox.x = prev.x;
          newBox.y = prev.y;
        }

        return newBox;
      });
    };

    const handleMouseUp = () => {
      setDraggingCorner(null);
    };

    if (draggingCorner) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      return () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };
    }
  }, [draggingCorner]);

  const handleSubmit = async () => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;

    if (isSubmitting) return;
    setIsSubmitting(true);

    // Count adjustments (rotations + zoom changes)
    const adjustmentCount = Math.abs(rotation / 90) + (zoom !== 1 ? 1 : 0);

    // Apply crop
    const croppedCanvas = document.createElement("canvas");
    croppedCanvas.width = cropBox.w;
    croppedCanvas.height = cropBox.h;
    try {
      const ctx = croppedCanvas.getContext("2d")!;
      ctx.drawImage(canvas, cropBox.x, cropBox.y, cropBox.w, cropBox.h, 0, 0, cropBox.w, cropBox.h);

      // Await the parent's handler to catch errors early and show feedback
      await onImageReady(croppedCanvas, croppedCanvas.width, croppedCanvas.height, rotation, Math.round(adjustmentCount));
    } catch (err: any) {
      console.error("Identify failed in ImageCapture:", err);
      alert("Identify failed: " + (err?.message || String(err)));
      setMode("preview");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      {mode === "upload" && (
        <div className="bg-blue-50 border-2 border-dashed border-blue-300 rounded-lg p-6 text-center">
          <div className="text-4xl mb-3">📸</div>
          <h3 className="font-semibold text-slate-900 mb-2">
            {sideLabel ? `Capture the ${sideLabel} of the pill` : "Upload or Capture Pill Image"}
          </h3>
          <p className="text-sm text-slate-600 mb-4">Get the best results with good lighting and tight crop.</p>

          {/* Single button: on mobile this opens the OS's native picker, which
              already offers "Take Photo" / "Photo Library" / "Browse" itself --
              a separate getUserMedia()-based "Take Photo" button was removed
              because it silently failed on some devices (camera permission /
              HTTPS quirks varied by browser), confusing doctors testing the
              app into thinking the scanner was broken when this button (the
              one that always works) was sitting right next to it.
              No `capture` attribute on the input below -- on several mobile
              browsers that attribute skips the native picker entirely and
              jumps straight to the camera, hiding the gallery option this
              button is supposed to offer. */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition"
          >
            📷 Take or Choose Photo
          </button>

          {allowSkip && (
            <button
              onClick={onSkip}
              className="mt-3 text-sm text-slate-500 hover:text-slate-700 underline"
            >
              Skip — I don't have this side
            </button>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileSelect}
            className="hidden"
          />
        </div>
      )}

      {mode === "preview" && (
        <div className="space-y-4">
          <div className="flex justify-center">
            <div
              ref={previewContainerRef}
              className="relative w-80 h-80 bg-slate-900 rounded-lg overflow-hidden border-2 border-slate-700"
            >
              <canvas
                ref={previewCanvasRef}
                className="w-full h-full object-cover"
              />

              {/* Crop box with draggable corners */}
              <div
                className="absolute border-2 border-yellow-400 bg-yellow-400/10"
                style={{
                  left: `${cropBox.x}px`,
                  top: `${cropBox.y}px`,
                  width: `${cropBox.w}px`,
                  height: `${cropBox.h}px`,
                }}
              >
                {/* Corners */}
                {["nw", "ne", "sw", "se"].map((corner) => (
                  <div
                    key={corner}
                    onMouseDown={handleMouseDown(corner)}
                    className={`absolute w-4 h-4 bg-yellow-400 cursor-${
                      corner === "nw" ? "nw" : corner === "ne" ? "ne" : corner === "sw" ? "sw" : "se"
                    }-resize`}
                    style={{
                      [corner.includes("n") ? "top" : "bottom"]: "-8px",
                      [corner.includes("w") ? "left" : "right"]: "-8px",
                    }}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
            <div>
              <label className="text-sm font-medium text-slate-700 block mb-2">Rotation</label>
              <button
                onClick={handleRotate}
                className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-900 rounded font-medium text-sm"
              >
                ↻ Rotate 90° ({rotation}°)
              </button>
            </div>

            <div>
              <label className="text-sm font-medium text-slate-700 block mb-2">Zoom</label>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleZoom(-0.1)}
                  className="px-3 py-2 bg-slate-200 hover:bg-slate-300 text-slate-900 rounded font-medium text-sm"
                >
                  −
                </button>
                <input
                  type="range"
                  min="0.5"
                  max="3"
                  step="0.1"
                  value={zoom}
                  onChange={(e) => setZoom(parseFloat(e.target.value))}
                  className="flex-1"
                />
                <button
                  onClick={() => handleZoom(0.1)}
                  className="px-3 py-2 bg-slate-200 hover:bg-slate-300 text-slate-900 rounded font-medium text-sm"
                >
                  +
                </button>
                <span className="text-sm text-slate-600">{zoom.toFixed(1)}×</span>
              </div>
            </div>
          </div>

          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
            <p className="text-xs text-yellow-800">
              💡 Drag the yellow corners to crop around the pill tightly.
            </p>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleSubmit}
              className="flex-1 px-4 py-3 bg-green-600 hover:bg-green-700 text-white font-semibold rounded-lg"
            >
              ✓ Identify Pill
            </button>
            <button
              onClick={() => {
                setMode("upload");
                setPreviewSrc("");
              }}
              className="flex-1 px-4 py-3 bg-slate-300 hover:bg-slate-400 text-slate-900 font-semibold rounded-lg"
            >
              ✕ Try Again
            </button>
          </div>
        </div>
      )}

    </div>
  );
}