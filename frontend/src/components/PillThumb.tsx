"use client";

import { useState } from "react";

// Reference thumbnail on match/search cards. Only ever shows a real image:
// a photo of the pill itself when one exists (C3PI / ePillID), otherwise
// the product's package/label photo, labeled as such so it isn't mistaken
// for what the pill looks like.
export default function PillThumb({
  url,
  kind,
  alt,
  className = "w-16 h-16",
}: {
  url: string | null;
  kind?: "pill_photo" | "package" | null;
  alt: string;
  className?: string;
}) {
  const frame = `${className} rounded-xl border border-slate-200 bg-white shrink-0 relative overflow-hidden`;
  const [failed, setFailed] = useState<string | null>(null);

  if (!url || failed === url) {
    return (
      <div className={`${frame} bg-slate-50 flex items-center justify-center text-slate-300 text-[10px]`}>No image</div>
    );
  }

  return (
    <div className={frame}>
      <img src={url} alt={alt} className="w-full h-full object-contain p-1" onError={() => setFailed(url)} />
      {kind === "package" && (
        <span className="absolute bottom-0 inset-x-0 bg-slate-900/60 text-white text-[8px] leading-tight text-center py-px">
          Package photo
        </span>
      )}
    </div>
  );
}
