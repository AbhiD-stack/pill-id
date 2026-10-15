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
  const [cropBox, setCropBox] = useState({ x: 0, y: 0, w: 0, h: 0 });
  // "move" drags the whole box; "nw"/"ne"/"sw"/"se" resizes from that corner.
  const [dragMode, setDragMode] = useState<"move" | "nw" | "ne" | "sw" | "se" | null>(null);
  const dragStartRef = useRef({ pointerX: 0, pointerY: 0, box: { x: 0, y: 0, w: 0, h: 0 } });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);

  // Redraw preview whenever rotation/crop changes
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
      ctx.translate(-150, -150);
      ctx.drawImage(img, 0, 0, 300, 300);
      ctx.restore();
    };
    img.src = previewSrc;
  }, [previewSrc, rotation, mode]);

  // Upload from device
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      setPreviewSrc(evt.target?.result as string);
      setMode("preview");
      setRotation(0);
      setCropBox({ x: 25, y: 25, w: 250, h: 250 });
    };
    reader.readAsDataURL(file);
  };

  const handleRotate = () => {
    setRotation((r) => (r + 90) % 360);
  };

  const beginDrag = (mode: "move" | "nw" | "ne" | "sw" | "se") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragStartRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      box: { ...cropBox },
    };
    setDragMode(mode);
  };

  useEffect(() => {
    // Pointer Events (not Mouse Events) so this works with touch and pen
    // input, not just a mouse -- the corners were silently drag-unresponsive
    // on phones before, which looked like "only zoom works" even though the
    // crop box was there the whole time.
    const handlePointerMove = (e: PointerEvent) => {
      if (!dragMode) return;

      const { pointerX, pointerY, box } = dragStartRef.current;
      const dx = e.clientX - pointerX;
      const dy = e.clientY - pointerY;
      const minSize = 50;
      const maxX = 300;
      const maxY = 300;

      setCropBox(() => {
        if (dragMode === "move") {
          const newX = Math.max(0, Math.min(maxX - box.w, box.x + dx));
          const newY = Math.max(0, Math.min(maxY - box.h, box.y + dy));
          return { ...box, x: newX, y: newY };
        }

        const x = box.x + dx;
        const y = box.y + dy;
        let newBox = { ...box };

        // Enforce a square crop box anchored at the opposite corner
        if (dragMode === "nw") {
          const candidateW = box.x + box.w - x;
          const candidateH = box.y + box.h - y;
          let newSize = Math.max(minSize, Math.min(candidateW, candidateH));
          newSize = Math.min(newSize, box.x + box.w, box.y + box.h, maxX, maxY);
          newBox.w = newBox.h = newSize;
          newBox.x = box.x + box.w - newSize;
          newBox.y = box.y + box.h - newSize;
        } else if (dragMode === "ne") {
          const candidateW = x - box.x;
          const candidateH = box.y + box.h - y;
          let newSize = Math.max(minSize, Math.min(candidateW, candidateH));
          newSize = Math.min(newSize, maxX - box.x, box.y + box.h, maxY);
          newBox.w = newBox.h = newSize;
          newBox.x = box.x;
          newBox.y = box.y + box.h - newSize;
        } else if (dragMode === "sw") {
          const candidateW = box.x + box.w - x;
          const candidateH = y - box.y;
          let newSize = Math.max(minSize, Math.min(candidateW, candidateH));
          newSize = Math.min(newSize, box.x + box.w, maxY - box.y, maxX);
          newBox.w = newBox.h = newSize;
          newBox.x = box.x + box.w - newSize;
          newBox.y = box.y;
        } else if (dragMode === "se") {
          const candidateW = x - box.x;
          const candidateH = y - box.y;
          let newSize = Math.max(minSize, Math.min(candidateW, candidateH));
          newSize = Math.min(newSize, maxX - box.x, maxY - box.y);
          newBox.w = newBox.h = newSize;
          newBox.x = box.x;
          newBox.y = box.y;
        }

        return newBox;
      });
    };

    const handlePointerUp = () => {
      setDragMode(null);
    };

    if (dragMode) {
      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", handlePointerUp);
      return () => {
        document.removeEventListener("pointermove", handlePointerMove);
        document.removeEventListener("pointerup", handlePointerUp);
      };
    }
  }, [dragMode]);

  const handleSubmit = async () => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;

    if (isSubmitting) return;
    setIsSubmitting(true);

    const adjustmentCount = Math.abs(rotation / 90);

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

              {/* Crop box: drag the body to move it, drag a corner to resize.
                  touchAction: "none" throughout stops the browser from
                  treating the drag as a page-scroll/pinch-zoom gesture. */}
              <div
                onPointerDown={beginDrag("move")}
                className="absolute border-2 border-yellow-400 bg-yellow-400/10 cursor-move"
                style={{
                  left: `${cropBox.x}px`,
                  top: `${cropBox.y}px`,
                  width: `${cropBox.w}px`,
                  height: `${cropBox.h}px`,
                  touchAction: "none",
                }}
              >
                {/* Corners. Hit target is a larger invisible touch area
                    (w-10 h-10) around a smaller visible yellow dot, since a
                    16px box is too small to reliably grab with a finger. */}
                {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                  <div
                    key={corner}
                    onPointerDown={beginDrag(corner)}
                    className={`absolute w-10 h-10 flex items-center justify-center cursor-${corner}-resize`}
                    style={{
                      [corner.includes("n") ? "top" : "bottom"]: "-20px",
                      [corner.includes("w") ? "left" : "right"]: "-20px",
                      touchAction: "none",
                    }}
                  >
                    <div className="w-4 h-4 bg-yellow-400 rounded-full border-2 border-white shadow" />
                  </div>
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

          </div>

          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
            <p className="text-xs text-yellow-800">
              💡 Drag inside the yellow box to move it, or drag a corner to resize it — crop in tight around the pill.
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