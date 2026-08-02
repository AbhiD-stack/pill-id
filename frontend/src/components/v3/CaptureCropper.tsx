"use client";

import { useRef, useState } from "react";
import ReactCrop, { type Crop, centerCrop, makeAspectCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";

// Same crop/rotate mechanism as v1 (PillIdentifier.tsx): a single file input
// (no `capture` attribute, so mobile browsers show their native "Take Photo /
// Photo Library / Choose File" picker off one button) + react-image-crop's
// draggable/resizable crop rectangle + a rotate button. No pinch/zoom and no
// live camera preview -- both were removed after they caused crashes on
// mobile (a getUserMedia video stream plus a canvas redrawn on every pointer
// pinch move was too heavy for some devices' Safari/WebView and would tear
// down the page mid-gesture).
const MAX_DIMENSION = 600;

export default function CaptureCropper({
  onCapture,
  onCancel,
  title = "Take or upload a photo",
  helpText = "Crop tightly around the pill, rotate if needed, then tap Use This Photo.",
  initialBrightness = 1.0,
}: {
  onCapture: (canvas: HTMLCanvasElement, meta: { rotation: number; adjustments: number }) => void;
  onCancel?: () => void;
  title?: string;
  helpText?: string;
  initialBrightness?: number;
}) {
  const [imgSrc, setImgSrc] = useState("");
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<Crop | null>(null);
  const [rotation, setRotation] = useState(0);
  const [rotationCount, setRotationCount] = useState(0);
  const [cropAdjustmentCount, setCropAdjustmentCount] = useState(0);
  const isTrackingAdjustment = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const { width, height } = e.currentTarget;
    const initial = centerCrop(makeAspectCrop({ unit: "%", width: 40 }, 1, width, height), width, height);
    setCrop(initial);
    setCompletedCrop(initial);
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setRotation(0);
    setRotationCount(0);
    setCropAdjustmentCount(0);
    const reader = new FileReader();
    reader.onload = (evt) => setImgSrc((evt.target?.result as string) || "");
    reader.readAsDataURL(file);
  };

  const handleCropChange = (newCrop: Crop) => {
    setCrop(newCrop);
    if (!isTrackingAdjustment.current) {
      isTrackingAdjustment.current = true;
      setCropAdjustmentCount((c) => c + 1);
      setTimeout(() => {
        isTrackingAdjustment.current = false;
      }, 400);
    }
  };

  const handleUsePhoto = () => {
    if (!imgRef.current || !completedCrop) return;
    const image = imgRef.current;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const scaleX = image.naturalWidth / image.width;
    const scaleY = image.naturalHeight / image.height;
    const scaleFactor = Math.min(
      1,
      MAX_DIMENSION / Math.max(completedCrop.width * scaleX, completedCrop.height * scaleY)
    );
    canvas.width = completedCrop.width * scaleX * scaleFactor;
    canvas.height = completedCrop.height * scaleY * scaleFactor;

    ctx.save();
    if (initialBrightness !== 1) ctx.filter = `brightness(${initialBrightness})`;
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(
      image,
      completedCrop.x * scaleX,
      completedCrop.y * scaleY,
      completedCrop.width * scaleX,
      completedCrop.height * scaleY,
      -canvas.width / 2,
      -canvas.height / 2,
      canvas.width,
      canvas.height
    );
    ctx.restore();

    onCapture(canvas, { rotation, adjustments: cropAdjustmentCount + rotationCount });
  };

  const reset = () => {
    setImgSrc("");
    setCrop(undefined);
    setCompletedCrop(null);
    setRotation(0);
  };

  return (
    <div className="space-y-4">
      {!imgSrc ? (
        <div className="rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 p-6 text-center">
          <div className="mb-2 text-3xl">📷</div>
          <h3 className="mb-1 font-semibold text-slate-900">{title}</h3>
          <p className="mb-4 text-sm text-slate-500">Good lighting and a plain background work best.</p>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="rounded-xl bg-sky-600 px-6 py-3 font-semibold text-white transition hover:bg-sky-700"
          >
            Take or Upload Photo
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileSelect} />
          {onCancel && (
            <button onClick={onCancel} className="mt-4 block w-full text-sm font-medium text-slate-400 hover:text-slate-600">
              Cancel
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-center text-xs text-slate-500">{helpText}</p>
          <div className="flex justify-center rounded-2xl border border-slate-200 bg-slate-950 p-4">
            <ReactCrop crop={crop} onChange={handleCropChange} onComplete={(c) => setCompletedCrop(c)} aspect={1} keepSelection>
              <img
                ref={imgRef}
                alt="Source"
                src={imgSrc}
                onLoad={onImageLoad}
                style={{ transform: `rotate(${rotation}deg)` }}
                className="max-h-80 object-contain"
              />
            </ReactCrop>
          </div>

          <button
            onClick={() => {
              setRotation((r) => (r + 90) % 360);
              setRotationCount((c) => c + 1);
            }}
            className="w-full rounded-lg bg-slate-100 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-200"
          >
            Rotate 90°
          </button>

          <div className="flex gap-2">
            <button
              onClick={handleUsePhoto}
              className="flex-1 rounded-xl bg-emerald-600 py-3.5 text-base font-bold text-white hover:bg-emerald-700"
            >
              Use This Photo
            </button>
            <button
              onClick={reset}
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
