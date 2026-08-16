import { createClient } from "@supabase/supabase-js";

/**
 * Read-only client for the public registry.
 *
 * The publishable key is deliberately the only key the site ever holds. The
 * database has public SELECT policies and no write policies at all, so this
 * key is structurally incapable of changing the record — that is the point,
 * not an oversight. ingest_capture() is granted to service_role only.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. " +
      "Copy .env.example to .env.local, or set them in the Vercel project."
  );
}

export const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
