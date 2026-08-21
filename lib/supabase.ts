import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Read-only client for the public registry, server-only.
 *
 * The publishable key is held on the server, never shipped to the browser:
 * `import "server-only"` makes a client-component import a build error. The URL
 * is not a secret and stays NEXT_PUBLIC_ (the ingest scripts read it too); it is
 * not inlined into any client bundle because no client module imports this file.
 * The database has public SELECT policies and no write policies, so this key is
 * structurally incapable of changing the record. Every write is service_role.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY. " +
      "Copy .env.example to .env.local, or set them in the Vercel project. " +
      "SUPABASE_PUBLISHABLE_KEY is server-only: never prefix it with NEXT_PUBLIC_."
  );
}

export const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
