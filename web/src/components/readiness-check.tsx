"use client";

import { useState } from "react";

export function ReadinessCheck() {
  const [status, setStatus] = useState("Not checked yet.");
  const [loading, setLoading] = useState(false);

  async function check() {
    setLoading(true);
    setStatus("Checking the app server…");
    try {
      const response = await fetch("/api/health", { signal: AbortSignal.timeout(5000) });
      if (!response.ok || (await response.json()).status !== "ok") throw new Error("Unavailable");
      setStatus("App server is responding. Cloud connections are not checked.");
    } catch {
      setStatus("Could not reach the app server. Check your terminal and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-8 border-t border-[var(--line)] pt-6">
      <button type="button" disabled={loading} onClick={check} className="flex min-h-12 w-full items-center justify-between rounded-lg bg-[var(--ink)] px-4 py-3 text-sm font-semibold text-[var(--paper)] disabled:opacity-60">
        {loading ? "Checking…" : "Check local app"}<span aria-hidden="true">↗</span>
      </button>
      <p role="status" aria-live="polite" className="mt-4 min-h-10 text-xs leading-5 text-[var(--muted)]">{status}</p>
    </div>
  );
}
