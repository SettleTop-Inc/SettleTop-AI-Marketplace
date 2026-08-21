"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/auth";
import { clientIp } from "@/lib/client-ip";
import { accountRequestAllowed } from "@/lib/account-limit";

/** Absolute site origin for the email link. Prefer the request Origin; fall
    back to the Host header, then a configured SITE_URL. Fail closed. */
async function siteOrigin(): Promise<string | null> {
  const h = await headers();
  const origin = h.get("origin");
  if (origin) return origin;
  const host = h.get("host");
  if (host) return `https://${host}`;
  return process.env.SITE_URL ?? null;
}

export async function signIn(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) redirect("/signin?error=email");

  const ip = clientIp(await headers());
  if (!(await accountRequestAllowed(ip, email))) redirect("/signin?error=limited");

  const origin = await siteOrigin();
  if (!origin) redirect("/signin?error=send");

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${origin}/auth/confirm` },
  });
  if (error) redirect("/signin?error=send");
  redirect("/signin?sent=1");
}

/** Start a social OAuth flow (Google, GitHub, LinkedIn). signInWithOAuth on the
    server client sets the PKCE verifier cookie and returns the provider URL; the
    browser goes to the provider and returns to /auth/callback in the SAME
    browser, so exchangeCodeForSession there has the verifier. Bound per button
    via signInWithProvider.bind(null, provider). */
export async function signInWithProvider(
  provider: "google" | "github" | "linkedin_oidc",
  _formData?: FormData
) {
  const origin = await siteOrigin();
  if (!origin) redirect("/signin?error=oauth");
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${origin}/auth/callback` },
  });
  if (error || !data?.url) redirect("/signin?error=oauth");
  redirect(data.url);
}

export async function signOut() {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  redirect("/");
}
