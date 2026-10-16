"use client";

import { useEffect, useState } from "react";

const KEY = "pillid.welcomed.v1";

// Shown once per device: what the app is, its limits, and what happens to
// photos. Plain words, large text.
export default function WelcomeNotice() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      setShow(localStorage.getItem(KEY) !== "1");
    } catch {
      setShow(true);
    }
  }, []);

  if (!show) return null;
  const accept = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      // storage unavailable: shown again next visit
    }
    setShow(false);
  };

  return (
    <div className="fixed inset-0 z-[70] bg-slate-900/70 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <div className="bg-white w-full max-w-md max-h-[95dvh] overflow-y-auto rounded-3xl p-6 space-y-4">
        <h2 id="welcome-title" className="text-2xl font-bold text-slate-900">Welcome to Pill ID</h2>
        <p className="text-base text-slate-700">
          Pill ID helps you identify a pill from a photo and keep track of your daily medicines. It is a pilot being
          tested with doctors.
        </p>
        <div className="bg-amber-50 border-2 border-amber-300 rounded-2xl p-4 space-y-2">
          <p className="text-base font-bold text-amber-900">It can be wrong</p>
          <p className="text-sm text-amber-900">
            Always check a pill with your pharmacist, doctor, or the label on the bottle before taking it. Don&apos;t
            take a pill you can&apos;t identify.
          </p>
          <p className="text-sm text-amber-900">
            Emergency or possible overdose: call <strong>911</strong> or Poison Control at{" "}
            <a href="tel:18002221222" className="font-bold underline">1-800-222-1222</a>.
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-base font-bold text-slate-900">Your privacy</p>
          <ul className="text-sm text-slate-700 space-y-1 list-disc pl-5">
            <li>Your medicine list, reminders and saved photos stay on this phone.</li>
            <li>A pill photo is sent to our server only to identify it.</li>
            <li>When you tell us which pill it was, that photo is kept to improve matching.</li>
            <li>We never ask for your name, email or account.</li>
          </ul>
        </div>
        <button onClick={accept} className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white text-lg font-bold rounded-2xl">
          I understand — continue
        </button>
      </div>
    </div>
  );
}
