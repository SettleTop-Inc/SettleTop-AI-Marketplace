import "server-only";
import { supabase } from "./supabase.ts";
import { isDisposableDomain } from "./disposable-domains.ts";

// rate is tokens/second; N/day = N/86400. Burst is the instantaneous allowance.
const PER_DAY = (n: number) => n / 86400;

async function take(bucket: string, rate: number, burst: number): Promise<boolean> {
  const { data, error } = await supabase.rpc("rate_take", { p_bucket: bucket, p_rate: rate, p_burst: burst });
  if (error) {
    console.error("account-limit", error.message);
    return true; // fail open on a limiter outage; Supabase Auth's own OTP limits are the floor
  }
  return data === true;
}

/**
 * Gate a sign-in / sign-up OTP request. Blocks disposable domains, then applies
 * a per-IP cap (short-circuited first) and a global new-account ceiling last.
 */
export async function accountRequestAllowed(ip: string, email: string): Promise<boolean> {
  if (isDisposableDomain(email)) return false;
  if (!(await take(`signup:ip:${ip}`, PER_DAY(5), 5))) return false; // ~5/day/IP, burst 5
  return take("signup:global:all", PER_DAY(500), 200); // ~500/day global ceiling, burst 200
}
