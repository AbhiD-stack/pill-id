"use client";

import { useState } from "react";
import PillDrawing, { canDrawPill, type PillLookFacts } from "./PillDrawing";

// Reference thumbnail on match/search cards. A real photo of the pill itself
// when one exists (C3PI / ePillID); otherwise a drawing made from the pill's
// FDA description (labeled as a drawing), never the package/label photo.
// Without enough description to draw it (shape and color), "No photo".
export default function PillThumb({
  url,
  kind,
  alt,
  look,
  className = "w-16 h-16",
}: {
  url: string | null;
  kind?: "pill_photo" | "package" | null;
  alt: string;
  look?: PillLookFacts;
  className?: string;
}) {
  const frame = `${className} rounded-xl border border-slate-200 bg-white shrink-0 relative overflow-hidden`;
  const [failed, setFailed] = useState<string | null>(null);

  if (url && kind === "pill_photo" && failed !== url) {
    return (
      <div className={frame}>
        <img src={url} alt={alt} className="w-full h-full object-contain p-1" onError={() => setFailed(url)} />
      </div>
    );
  }

  if (canDrawPill(look)) {
    return (
      <div className={frame}>
        <div className="absolute inset-0 p-1.5 pb-3">
          <PillDrawing look={look!} title={`Drawing of ${alt} from its FDA description`} />
        </div>
        <span className="absolute bottom-0 inset-x-0 bg-slate-900/60 text-white text-[8px] leading-tight text-center py-px">
          Drawing
        </span>
      </div>
    );
  }

  return (
    <div className={`${frame} bg-slate-50 flex items-center justify-center text-slate-400 text-[10px]`}>No photo</div>
  );
}
