"use client";

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Keep the starter usable before the event's project is selected.
export const supabase = url && publishableKey ? createClient(url, publishableKey) : null;
