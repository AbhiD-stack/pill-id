"use client";

// Decoupled Telemetry: the ONLY thing ever sent off-device. It is a random
// per-session token bound to quantitative UX numbers (latencies, clicks) —
// never a name, DOB, drug name, or anything identifying. If you don't set
// NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY, this silently
// no-ops and the app works exactly the same.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function getSessionToken(): string {
  const key = "pillid_anon_session";
  let token = sessionStorage.getItem(key);
  if (!token) {
    token = Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem(key, token);
  }
  return token;
}

export async function logTelemetry(event: string, valueMs?: number) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return; // telemetry disabled
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/telemetry`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        session_id: getSessionToken(),
        event,
        value_ms: valueMs ?? null,
        ts: new Date().toISOString(),
      }),
    });
  } catch {
    // telemetry failures should never interrupt the user experience
  }
}
