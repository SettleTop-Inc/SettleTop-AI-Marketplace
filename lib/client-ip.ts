/** First x-forwarded-for hop is the client on Vercel; fall back to x-real-ip. */
export function clientIp(h: Headers): string {
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return h.get("x-real-ip")?.trim() || "unknown";
}
