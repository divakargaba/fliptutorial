"use client";

import { supabase } from "@/lib/supabase/client";

export function SupabaseStatus() {
  return <p role="status" data-testid="supabase-status" className="mt-3 text-xs text-[var(--muted)]">{supabase
    ? "Supabase configured. Verify the demo's first query at kickoff."
    : "Supabase not configured yet. Follow docs/CREDENTIALS.md."}</p>;
}
