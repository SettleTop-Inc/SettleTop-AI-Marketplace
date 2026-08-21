export function clientIp(h: Headers): string {
  // x-real-ip is set by the platform (Vercel) to the real connecting IP and is
  // not client-spoofable, so it is the trustworthy key for rate limiting.
  // x-forwarded-for's leftmost hop is client-supplied on platforms that append
  // the real IP, so it is only a fallback for local/non-Vercel dev.
  const real = h.get("x-real-ip")?.trim();
  if (real) return real;
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return "unknown";
}
