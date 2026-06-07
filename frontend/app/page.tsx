import { PillIdentifier } from "@/components/PillIdentifier";
import { DisclaimerBanner, DisclaimerFooter } from "@/components/Disclaimer";

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <header className="mb-6">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Pill ID
          </h1>
          <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-600">
            Pilot
          </span>
        </div>
        <p className="mt-1 text-sm text-slate-500">
          Upload a photo of a pill to see possible visual matches from a
          reference database.
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
