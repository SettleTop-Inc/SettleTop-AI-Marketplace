import "server-only";
import { supabase } from "./supabase.ts";
import { clientIp } from "./client-ip.ts";

/**
 * Take one token from `${bucketPrefix}:${key}` (key defaults to the client IP).
 * Returns true when allowed. Fail-open: if the limiter RPC errors (for example
 * before the migration is applied), allow, so a limiter outage degrades to no
 * limiting rather than a down site.
 */
export async function rateLimit(
  bucketPrefix: string,
  rate: number,
  burst: number,
  keyOverride?: string
): Promise<boolean> {
  let key = keyOverride;
  if (key === undefined) {
    const { headers } = await import("next/headers");
    key = clientIp(await headers());
  }
  const { data, error } = await supabase.rpc("rate_take", {
    p_bucket: `${bucketPrefix}:${key}`,
    p_rate: rate,
    p_burst: burst,
  });
  if (error) {
    console.error("rateLimit", error.message);
    return true;
  }
  return data === true;
}

/**
 * A single global budget over all anon dynamic reads (the card/search surface
 * and the passport route). IP-independent, so it backstops a proxy pool that
 * rotates IPs to defeat the per-IP limit. Coarse by design. Fixed key, so it
 * never reads request headers.
 */
export async function globalReadTake(): Promise<boolean> {
  return rateLimit("global:reads", 40, 400, "all");
}
