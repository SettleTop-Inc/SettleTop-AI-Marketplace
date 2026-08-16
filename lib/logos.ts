import type { RegistryCard } from "@/lib/types";

/**
 * Merge archived logos onto cards.
 *
 * Kept out of SQL deliberately: logos have a separate archival lifecycle from
 * the capture, and joining them in the view would imply they are part of the
 * observation. A product missing from the map has no logo we hold.
 */
export function withLogo<T extends { source_product_id: string }>(
  row: T,
  logos: Record<string, string>
): T & { logo: string | null } {
  return { ...row, logo: logos[row.source_product_id] ?? null };
}

export function withLogos(
  cards: RegistryCard[],
  logos: Record<string, string>
): RegistryCard[] {
  return cards.map((c) => withLogo(c, logos));
}
