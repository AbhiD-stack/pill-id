"use client";

import { useEffect, useRef, useState } from "react";

type CaptureMode = "upload" | "preview";

// The preview box is shown on screen at DISPLAY_SIZE CSS pixels (a fixed
// square, matches the w-80/h-80 container below), but the canvas's actual
// pixel buffer is rendered at DISPLAY_SIZE * RESOLUTION_SCALE -- a modern
// phone photo is typically 3000-4000px on a side; rendering/cropping at a
// tiny fixed 300x300 buffer (the previous behavior) threw away almost all
// of that detail before the backend (or OCR) ever saw it, which plausibly
// hurt real-world accuracy on its own, independent of the model's own
// ceiling. 1600px keeps memory/perf reasonable while preserving far more
// of what the camera actually captured.
const DISPLAY_SIZE = 320;
const RESOLUTION_SCALE = 5;
const BUFFER_SIZE = DISPLAY_SIZE * RESOLUTION_SCALE;

type Rect = { x: number; y: number; w: number; h: number };
type DragMode = "move" | "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

// "Contain" fit: the largest rect of the image's own aspect ratio that
// fits inside a boxSize x boxSize square, centered. Drawing the image into
// exactly this rect (instead of stretching it to fill the whole square)
// is what stops a non-square phone photo from being squished/distorted.
function containFit(naturalW: number, naturalH: number, boxSize: number): Rect {
  const scale = Math.min(boxSize / naturalW, boxSize / naturalH);
  const w = naturalW * scale;
  const h = naturalH * scale;
  return { x: (boxSize - w) / 2, y: (boxSize - h) / 2, w, h };
}

// A 90/270 rotation of a non-square photo swaps its visual footprint on
// screen (portrait becomes landscape, or vice versa). containFit() is
// computed from the image's unrotated natural dimensions, so without this,
// imageRect (used to keep the crop box clamped to the actual visible
// photo) would stay stale after rotating -- correct for 0/180, wrong for
// 90/270. Both rect and boxSize share the same center point (rect is
// always centered), so swapping w/h and recentering is all that's needed.
function rotatedRect(rect: Rect, rotation: number, boxSize: number): Rect {
  const r = ((rotation % 360) + 360) % 360;
  if (r === 90 || r === 270) {
    const w = rect.h;
    const h = rect.w;
    return { x: (boxSize - w) / 2, y: (boxSize - h) / 2, w, h };
  }
  return rect;
}

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
  // Where the actual photo content sits within the DISPLAY_SIZE square (the
  // rest is letterbox) -- used to give a sensible default crop and to stop
  // the crop box from being draggable into the empty letterbox area.
  const [imageRect, setImageRect] = useState<Rect>({ x: 0, y: 0, w: DISPLAY_SIZE, h: DISPLAY_SIZE });
  // "move" drags the whole box; "nw"/"ne"/"sw"/"se" resizes from that corner.
  const [dragMode, setDragMode] = useState<DragMode | null>(null);
  const dragStartRef = useRef({ pointerX: 0, pointerY: 0, box: { x: 0, y: 0, w: 0, h: 0 } });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);

  // Redraw preview whenever rotation/crop changes. Draws at full
  // BUFFER_SIZE resolution, "contain" fit (no stretch) -- the visible
  // canvas is still DISPLAY_SIZE CSS pixels via the w-80/h-80 container
  // below, the browser scales the high-res buffer down for display, and
  // the final crop (handleSubmit) reads back the full-resolution pixels.
  useEffect(() => {
    if (!previewSrc || mode !== "preview") return;

    const canvas = previewCanvasRef.current;
    if (!canvas) return;

    const img = new Image();
    img.onload = () => {
      canvas.width = BUFFER_SIZE;
      canvas.height = BUFFER_SIZE;
      const ctx = canvas.getContext("2d")!;

      // Letterbox fill so empty space around a non-square photo reads as
      // "not part of the photo," not a stretched/cropped edge.
      ctx.fillStyle = "#0f172a"; // slate-900, matches the container bg
      ctx.fillRect(0, 0, BUFFER_SIZE, BUFFER_SIZE);

      const fit = containFit(img.naturalWidth, img.naturalHeight, BUFFER_SIZE);

      ctx.save();
      ctx.translate(BUFFER_SIZE / 2, BUFFER_SIZE / 2);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.translate(-BUFFER_SIZE / 2, -BUFFER_SIZE / 2);
      ctx.drawImage(img, fit.x, fit.y, fit.w, fit.h);
      ctx.restore();

      // Account for rotation (see rotatedRect) before converting down to
      // display-space -- otherwise the crop box's clamp bounds go stale
      // the moment someone rotates a non-square photo.
      const visualFit = rotatedRect(fit, rotation, BUFFER_SIZE);
      setImageRect({
        x: visualFit.x / RESOLUTION_SCALE,
        y: visualFit.y / RESOLUTION_SCALE,
        w: visualFit.w / RESOLUTION_SCALE,
        h: visualFit.h / RESOLUTION_SCALE,
      });
    };
    img.src = previewSrc;
  }, [previewSrc, rotation, mode]);

  // Upload from device
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      const dataUrl = evt.target?.result as string;

      // Figure out the photo's real aspect ratio up front so the default
      // crop box matches the whole photo (not a generic square that may
      // include letterbox or miss part of a non-square image) -- this
      // runs once per new image, independent of the rotation-redraw effect
      // above, so rotating afterward doesn't reset a crop the user already
      // adjusted.
      const probe = new Image();
      probe.onload = () => {
        const fit = containFit(probe.naturalWidth, probe.naturalHeight, DISPLAY_SIZE);
        setImageRect(fit);
        setCropBox({ ...fit });
      };
      probe.src = dataUrl;

      setPreviewSrc(dataUrl);
      setMode("preview");
      setRotation(0);
    };
    reader.readAsDataURL(file);
  };

  const handleRotate = () => {
    setRotation((r) => (r + 90) % 360);
  };

  const beginDrag = (mode: DragMode) => (e: React.PointerEvent) => {
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
      const minSize = 30;
      // Clamp to the actual photo content, not the full square -- stops the
      // crop box from being draggable into the empty letterbox area around
      // a non-square photo, which used to be part of what made cropping
      // fiddly (nothing stopped you from grabbing dead space).
      const minX = imageRect.x;
      const minY = imageRect.y;
      const maxX = imageRect.x + imageRect.w;
      const maxY = imageRect.y + imageRect.h;

      setCropBox(() => {
        if (dragMode === "move") {
          const newX = Math.max(minX, Math.min(maxX - box.w, box.x + dx));
          const newY = Math.max(minY, Math.min(maxY - box.h, box.y + dy));
          return { ...box, x: newX, y: newY };
        }

        // Each edge moves independently based on which handle is active --
        // a corner just moves two edges at once ("nw" = top edge + left
        // edge). No forced-square constraint: free resizing is more
        // predictable to drag than a box that snaps to a different size
        // than your finger moved.
        const right = box.x + box.w;
        const bottom = box.y + box.h;
        let { x, y, w, h } = box;

        if (dragMode.includes("w")) {
          const newX = Math.max(minX, Math.min(right - minSize, box.x + dx));
          w = right - newX;
          x = newX;
        }
        if (dragMode.includes("e")) {
          const newRight = Math.min(maxX, Math.max(box.x + minSize, right + dx));
          w = newRight - x;
        }
        if (dragMode.includes("n")) {
          const newY = Math.max(minY, Math.min(bottom - minSize, box.y + dy));
          h = bottom - newY;
          y = newY;
        }
        if (dragMode.includes("s")) {
          const newBottom = Math.min(maxY, Math.max(box.y + minSize, bottom + dy));
          h = newBottom - y;
        }

        return { x, y, w, h };
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
  }, [dragMode, imageRect]);

  const handleSubmit = async () => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;

    if (isSubmitting) return;
    setIsSubmitting(true);

    const adjustmentCount = Math.abs(rotation / 90);

    // cropBox is tracked in display-space (CSS) pixels, but the canvas
    // buffer is rendered at RESOLUTION_SCALE x that -- scale up to read the
    // full-resolution pixels instead of the tiny display-space crop that
    // was being sent before (which threw away most of a real phone
    // photo's actual resolution).
    const srcX = cropBox.x * RESOLUTION_SCALE;
    const srcY = cropBox.y * RESOLUTION_SCALE;
    const srcW = cropBox.w * RESOLUTION_SCALE;
    const srcH = cropBox.h * RESOLUTION_SCALE;

    const croppedCanvas = document.createElement("canvas");
    croppedCanvas.width = srcW;
    croppedCanvas.height = srcH;
    try {
      const ctx = croppedCanvas.getContext("2d")!;
      ctx.drawImage(canvas, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);

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
                className="w-full h-full object-contain"
              />

              {/* Crop box: drag the body to move it, drag a corner or an
                  edge to resize. touchAction: "none" throughout stops the
                  browser from treating the drag as a page-scroll/pinch-zoom
                  gesture. A thicker border + bigger handles (both the
                  invisible touch target and the visible dot/bar) make this
                  much easier to grab precisely with a finger than the
                  original thin-line, small-corner-only version. */}
              <div
                onPointerDown={beginDrag("move")}
                className="absolute border-[3px] border-yellow-400 bg-yellow-400/10 cursor-move"
                style={{
                  left: `${cropBox.x}px`,
                  top: `${cropBox.y}px`,
                  width: `${cropBox.w}px`,
                  height: `${cropBox.h}px`,
                  touchAction: "none",
                }}
              >
                {/* Edge midpoints: drag to resize just that one side. */}
                {(["n", "s", "e", "w"] as const).map((edge) => {
                  const vertical = edge === "n" || edge === "s";
                  return (
                    <div
                      key={edge}
                      onPointerDown={beginDrag(edge)}
                      className={`absolute flex items-center justify-center ${
                        vertical ? "w-16 h-8 cursor-ns-resize" : "w-8 h-16 cursor-ew-resize"
                      }`}
                      style={{
                        ...(edge === "n" ? { top: "-16px", left: "50%", transform: "translateX(-50%)" } : {}),
                        ...(edge === "s" ? { bottom: "-16px", left: "50%", transform: "translateX(-50%)" } : {}),
                        ...(edge === "w" ? { left: "-16px", top: "50%", transform: "translateY(-50%)" } : {}),
                        ...(edge === "e" ? { right: "-16px", top: "50%", transform: "translateY(-50%)" } : {}),
                        touchAction: "none",
                      }}
                    >
                      <div
                        className={`bg-yellow-400 rounded-full border-2 border-white shadow ${
                          vertical ? "w-8 h-3" : "w-3 h-8"
                        }`}
                      />
                    </div>
                  );
                })}

                {/* Corners: bigger invisible hit area (w-14 h-14) around a
                    bigger visible dot than the edge handles, since a corner
                    is the fiddliest grab (easy to miss two axes at once). */}
                {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                  <div
                    key={corner}
                    onPointerDown={beginDrag(corner)}
                    className={`absolute w-14 h-14 flex items-center justify-center cursor-${corner}-resize`}
                    style={{
                      [corner.includes("n") ? "top" : "bottom"]: "-28px",
                      [corner.includes("w") ? "left" : "right"]: "-28px",
                      touchAction: "none",
                    }}
                  >
                    <div className="w-6 h-6 bg-yellow-400 rounded-full border-2 border-white shadow" />
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
              💡 Drag inside the box to move it. Drag a corner (big dot) or an edge (bar) to resize — crop in tight around the pill.
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