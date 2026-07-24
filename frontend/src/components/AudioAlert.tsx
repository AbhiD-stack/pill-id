"use client";

// Accessibility Audio Verification: converts alert text into large, high
// volume, high-priority speech using the browser's native SpeechSynthesis —
// helps users with macular degeneration, cataracts, or cognitive decline.
export function speak(text: string, opts?: { rate?: number; volume?: number }) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel(); // interrupt any prior utterance — safety alerts take priority
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = opts?.rate ?? 0.9; // slightly slower than default for clarity
  utter.volume = opts?.volume ?? 1.0;
  utter.pitch = 1.0;
  window.speechSynthesis.speak(utter);
}

export function vibrate(pattern: number | number[] = 200) {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    navigator.vibrate(pattern);
  }
}
