import { PillIdentifier } from "@/components/PillIdentifier";
import { DisclaimerBanner, DisclaimerFooter } from "@/components/Disclaimer";

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:py-10">
      <header className="mb-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            <span aria-hidden="true">💊</span> Med Recognition App
          </h1>
          <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-semibold text-sky-700">
            Pilot
          </span>
        </div>
        <p className="mt-1.5 max-w-2xl text-sm text-slate-500">
          Upload a photo of a pill and get its most likely visual matches from a
          reference database — with drug name, imprint, and color to help you
          verify.
        </p>
      </header>

      <div className="mb-6">
        <DisclaimerBanner />
      </div>

      <PillIdentifier />

      <DisclaimerFooter />
    </main>
  );
}
