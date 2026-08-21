import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Per-request, cookie-bound Supabase client for auth. Server-only: the
 * publishable key never reaches the browser. In an RSC render `setAll` cannot
 * write cookies (Next forbids it), so it is wrapped in try/catch; proxy.ts is
 * what refreshes the session cookie. In a Server Action or Route Handler
 * `setAll` works and persists the session.
 */
export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return store.getAll();
        },
        setAll(list) {
          try {
            for (const { name, value, options } of list) store.set(name, value, options);
          } catch {
            // RSC render: proxy.ts handles the refresh instead.
          }
        },
      },
    }
  );
}

export async function getSessionUser() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/** The current user's profile (id, email, role), or null if signed out. */
export async function getSessionProfile() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase.from("profile").select("role").eq("id", user.id).maybeSingle();
  return {
    id: user.id,
    email: user.email ?? null,
    role: ((data as { role?: string } | null)?.role ?? "signed_in") as "signed_in" | "admin",
  };
}
