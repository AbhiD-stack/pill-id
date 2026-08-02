"use client";

import { useState } from "react";

const SLIDES = [
  {
    emoji: "📷",
    title: "Scan a pill",
    body: "Take or upload a photo. Pinch to zoom and drag to frame the pill, then get up to 10 possible matches with a picture and confidence score for each.",
  },
  {
    emoji: "🔍",
    title: "Can't find it in the results?",
    body: "Open \"Search by appearance\" on the results screen and describe the pill's shape, color, or imprint instead — useful if the photo match didn't work.",
  },
  {
    emoji: "💊",
    title: "My Pills",
    body: "Save a photo of your own pill under a medication name. Later, this tab shows what that medication currently looks like on file — if a refill looks different, you'll see exactly what changed to ask your pharmacist about.",
  },
  {
    emoji: "⚙️",
    title: "One more thing",
    body: "This app is an experimental pilot, not a substitute for a pharmacist or doctor — never take a pill based only on this app. Your photos and saved pills stay on this device only; nothing here is uploaded to any account.",
  },
];

export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0);
  const slide = SLIDES[i];
  const isLast = i === SLIDES.length - 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-4">
      <div className="w-full max-w-sm rounded-3xl bg-white p-6 text-center shadow-2xl">
        <div className="mb-3 text-5xl">{slide.emoji}</div>
        <h2 className="mb-2 text-xl font-bold text-slate-900">{slide.title}</h2>
        <p className="text-sm leading-relaxed text-slate-600">{slide.body}</p>

        <div className="my-5 flex justify-center gap-1.5">
          {SLIDES.map((_, idx) => (
            <span
              key={idx}
              className={`h-1.5 rounded-full transition-all ${
                idx === i ? "w-6 bg-sky-600" : "w-1.5 bg-slate-200"
              }`}
            />
          ))}
        </div>

        <div className="flex gap-2">
          {i > 0 && (
            <button
              onClick={() => setI((n) => n - 1)}
              className="flex-1 rounded-xl bg-slate-100 py-3 font-semibold text-slate-600 hover:bg-slate-200"
            >
              Back
            </button>
          )}
          <button
            onClick={() => (isLast ? onDone() : setI((n) => n + 1))}
            className="flex-1 rounded-xl bg-sky-600 py-3 font-semibold text-white hover:bg-sky-700"
          >
            {isLast ? "Get Started" : "Next"}
          </button>
        </div>
        {!isLast && (
          <button onClick={onDone} className="mt-3 text-xs font-medium text-slate-400 hover:text-slate-600">
            Skip
          </button>
        )}
      </div>
    </div>
  );
}
