"use client";

type Tab = "scan" | "schedule" | "safety" | "passport" | "export";

export default function Nav({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const items: { key: Tab; label: string }[] = [
    { key: "scan", label: "📷 Scan" },
    { key: "schedule", label: "📋 Schedule" },
    { key: "safety", label: "⚠️ Safety" },
    { key: "passport", label: "🔐 Passport" },
    { key: "export", label: "📤 Export" },
  ];
  return (
    <nav className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-6">
      {items.map((item) => (
        <button
          key={item.key}
          onClick={() => setTab(item.key)}
          className={`px-4 py-3 text-sm font-semibold rounded-lg border-2 transition ${
            tab === item.key
              ? "bg-blue-600 text-white border-blue-700 shadow-md"
              : "bg-white text-slate-700 border-slate-200 hover:border-slate-300"
          }`}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}