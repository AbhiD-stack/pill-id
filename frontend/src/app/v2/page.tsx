"use client";

import MainApp from "@/components/MainApp";

export default function V2Page() {
  return (
    <main className="min-h-screen bg-slate-950 text-white flex flex-col">
      <MainApp onResetSession={() => {}} />
    </main>
  );
}
