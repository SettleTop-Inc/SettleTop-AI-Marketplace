const DISPOSABLE = new Set<string>([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com",
  "trashmail.com", "yopmail.com", "getnada.com", "dispostable.com",
]);

export function isDisposableDomain(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  return DISPOSABLE.has(email.slice(at + 1).trim().toLowerCase());
}
