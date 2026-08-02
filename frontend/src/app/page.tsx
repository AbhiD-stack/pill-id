import Link from "next/link";
import { DisclaimerFooter } from "@/components/Disclaimer";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-4 py-12">
      <header className="mb-10 text-center">
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            <span aria-hidden="true">💊</span> Pill ID
          </h1>
          <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-semibold text-sky-700">
            Pilot
          </span>
        </div>
        <p className="mx-auto mt-3 max-w-xl text-sm text-slate-500">
          Upload a photo of a pill and get its most likely visual matches from
          a reference database. Choose a UI below — both use the same
          identification backend.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <Link
          href="/v1"
          className="group flex flex-col justify-between rounded-2xl border-2 border-slate-200 bg-white p-6 shadow-sm transition-all hover:border-sky-500 hover:shadow-md"
        >
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-sky-600">
              Version 1
            </p>
            <h2 className="mt-1 text-xl font-bold text-slate-900">
              Original UI
            </h2>
            <p className="mt-2 text-sm text-slate-500">
              The original crop-and-identify workflow.
            </p>
          </div>
          <span className="mt-6 inline-flex items-center text-sm font-semibold text-sky-600">
            Open Version 1 →
          </span>
        </Link>

        <Link
          href="/v2"
          className="group flex flex-col justify-between rounded-2xl border-2 border-slate-200 bg-white p-6 shadow-sm transition-all hover:border-indigo-500 hover:shadow-md"
        >
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-indigo-600">
              Version 2
            </p>
            <h2 className="mt-1 text-xl font-bold text-slate-900">
              New UI
            </h2>
            <p className="mt-2 text-sm text-slate-500">
              Camera capture, scheduling, and safety-check tabs.
            </p>
          </div>
          <span className="mt-6 inline-flex items-center text-sm font-semibold text-indigo-600">
            Open Version 2 →
          </span>
        </Link>

        <Link
          href="/v3"
          className="group flex flex-col justify-between rounded-2xl border-2 border-slate-200 bg-white p-6 shadow-sm transition-all hover:border-emerald-500 hover:shadow-md"
        >
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-emerald-600">
              Version 3
            </p>
            <h2 className="mt-1 text-xl font-bold text-slate-900">
              My Pills + Search
            </h2>
            <p className="mt-2 text-sm text-slate-500">
              Pinch-to-crop scanning, bottle-label OCR, appearance-change
              tracking, and a shape/color/imprint backup search.
            </p>
          </div>
          <span className="mt-6 inline-flex items-center text-sm font-semibold text-emerald-600">
            Open Version 3 →
          </span>
        </Link>
      </div>

      <DisclaimerFooter />
    </main>
  );
}
