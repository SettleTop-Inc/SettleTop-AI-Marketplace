import type { AssetPassport, EvidenceMap, RegistryCard } from "@/lib/types";

/**
 * Display helpers shared by the card, the passport modal and the passport page.
 *
 * The single rule every function here obeys: if the source did not state it,
 * the answer is the string "Unknown". Never a guess, never a blank that reads
 * as a zero, never an inference from a neighbouring field.
 */

export const UNKNOWN = "Unknown";

export function isKnown(v: string | null | undefined): boolean {
  return !!v && v !== UNKNOWN && v !== "Not stated";
}

/** Join a list of stated values for one passport row, or Unknown if empty. */
export function listed(values: string[] | undefined | null, limit = 4): string {
  const v = (values ?? []).filter(Boolean);
  if (v.length === 0) return UNKNOWN;
  if (v.length <= limit) return v.join(", ");
  return `${v.slice(0, limit).join(", ")} +${v.length - limit} more`;
}

export function initials(name: string): string {
  const words = name.match(/[A-Za-z0-9]+/g) ?? [];
  const first = words[0] ?? "";
  const second = words[1] ?? "";
  if (!first) return "AI";
  if (!second) return first.slice(0, 2).toUpperCase();
  // charAt rather than [0]: a single-character word must not yield undefined
  return (first.charAt(0) + second.charAt(0)).toUpperCase();
}

const GRADIENTS = "abcdefghijkl".split("");

/** Stable per-agent colour: derived from the id so it never shifts on reorder. */
export function gradientFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `gradient-${GRADIENTS[h % GRADIENTS.length]}`;
}

export function ratingLabel(a: Pick<RegistryCard, "rating">): string {
  return a.rating ? `${a.rating} ★` : "Not rated";
}

export function ratingDetail(
  a: Pick<RegistryCard, "rating_count" | "external_source" | "external_rating">
): string {
  const n = `${a.rating_count} review${a.rating_count === 1 ? "" : "s"}`;
  if (a.external_source && a.external_rating) {
    return `${n} · ${a.external_source} ${a.external_rating}`;
  }
  return `${n} on the listing`;
}

/**
 * Evidence status for a passport row.
 *   Verified  — Microsoft assessed it on the app certification page
 *   Disclosed — the publisher stated it on the listing or in its attestation
 *   Unknown   — the source is silent
 * The distinction is the whole point of the registry; do not collapse it.
 */
export type EvidenceStatus = "Verified" | "Disclosed" | "Unknown";

export function statusFor(
  value: string,
  origin: "listing" | "certification",
  certification: string
): EvidenceStatus {
  if (!isKnown(value)) return UNKNOWN as EvidenceStatus;
  if (origin === "certification" && certification === "microsoft_365_certified") {
    return "Verified";
  }
  return "Disclosed";
}

export function statusClass(value: string): string {
  return String(value || "unknown").toLowerCase().replace(/\s+/g, "-");
}

export function evidence(map: EvidenceMap, key: keyof EvidenceMap): string {
  return listed(map?.[key]);
}

/**
 * True when an attestation exists at all, so an empty Graph-permissions list
 * means "attested to request nothing" rather than "the source never said."
 * Extracted so permissionValue's (truncated, display) string and compare's
 * (untruncated, comparison-only) value apply the exact same rule and cannot
 * drift apart.
 */
export function attestsNoPermissions(a: Pick<AssetPassport, "certification">): boolean {
  return (
    a.certification === "microsoft_365_certified" ||
    a.certification === "publisher_attestation"
  );
}

export function permissionValue(a: AssetPassport): string {
  const p = a.graph_permissions ?? [];
  if (p.length > 0) {
    return p.length <= 5 ? p.join(", ") : `${p.slice(0, 5).join(", ")} +${p.length - 5} more`;
  }
  if (attestsNoPermissions(a)) {
    // the attestation exists and requests nothing — different from unknown
    return "None requested";
  }
  return UNKNOWN;
}

/** Short surface summary for the "Runs on" tile. */
export function runsOn(a: Pick<RegistryCard, "surfaces">): string {
  return listed(a.surfaces, 2);
}

export type OverviewBlock =
  | { type: "p"; text: string }
  | { type: "ul"; items: string[] };

/**
 * Split captured overview text into paragraphs and bullet lists.
 * The capture repeats the headline as its first line; that echo is dropped.
 */
export function overviewBlocks(
  overview: string | null,
  tagline: string | null
): OverviewBlock[] {
  if (!overview) return [];
  const lines = overview
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    lines.length > 1 &&
    (lines[0] === tagline || lines[1].indexOf(lines[0].replace(/\W+$/, "")) === 0)
  ) {
    lines.shift();
  }
  const blocks: OverviewBlock[] = [];
  const bulletRe = /^([*•\-–‣]|\d+[.)])\s+/;
  for (const line of lines) {
    const isBullet = bulletRe.test(line);
    const text = isBullet ? line.replace(bulletRe, "") : line;
    const last = blocks[blocks.length - 1];
    if (isBullet && last && last.type === "ul") last.items.push(text);
    else if (isBullet) blocks.push({ type: "ul", items: [text] });
    else blocks.push({ type: "p", text });
  }
  return blocks;
}

/** Meter lines inside one pricing plan, e.g. per-token rates. */
export function planMeters(unit: string | null): string[] {
  return (unit ?? "")
    .split(/\s*;\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function marketplaceUrl(a: Pick<RegistryCard, "listing_url">): string {
  return a.listing_url;
}

/**
 * Marketplace id -> display name. Mirrors the `marketplace` table seeded by
 * migrations 20260816162955 (microsoft), 20260818192216 (drai) and
 * 20260820120000 (aws). v_registry_card carries marketplace_ids as IDS (see the
 * header of 20260820100100_registry_search_asset_keyed.sql), and the client
 * holds no marketplace table, so any marketplace past the asset's primary
 * listing has to be labelled from here. Kept in step with those rows the same
 * way CERT_LABELS in ListingPanels mirrors the certification enum: one small
 * map, repeated because the client cannot read the source of truth. A new
 * marketplace ships one line here in the same commit as its seed migration.
 */
export const MARKETPLACE_LABELS: Record<string, string> = {
  microsoft: "Microsoft Marketplace",
  drai: "DRAI Agentic-AI Marketplace",
  aws: "AWS Marketplace",
};

/**
 * Every marketplace an asset is listed on, as { id, name }, in the card's own
 * marketplace_ids order. One entry per marketplace: a 1:1 asset yields one, a
 * merged asset yields one per listing, so a card renders one badge per source
 * and hides none.
 *
 * The primary listing's id is labelled from marketplace_name, which the card
 * carries EXACTLY from the DB, so the primary is always right whatever this
 * client build knows; the rest resolve through MARKETPLACE_LABELS, falling back
 * to the raw id for a marketplace this build predates rather than dropping the
 * badge. Falls back to the single primary listing for a pre-phase-2 card that
 * carries no marketplace_ids column, so nothing here changes the 1:1 render.
 */
export function marketplaceBadges(
  c: Pick<RegistryCard, "marketplace_id" | "marketplace_name" | "marketplace_ids">
): { id: string; name: string }[] {
  const ids = c.marketplace_ids?.length ? c.marketplace_ids : [c.marketplace_id];
  return ids.map((id) => ({
    id,
    name: id === c.marketplace_id ? c.marketplace_name : MARKETPLACE_LABELS[id] ?? id,
  }));
}

export function formatChangeField(field: string): string {
  const labels: Record<string, string> = {
    pricing: "Pricing",
    price_band: "Price band",
    certification: "Attestation",
    cert_hosting: "Hosting model",
    cert_data_location: "Data residency",
    listing_version: "Listing version",
    listing_updated: "Listing updated",
    rating: "Rating",
    reach: "Provenance reach",
    risk: "Evidence risk",
    surfaces: "Surfaces",
    graph_permissions: "Graph permissions",
    compliance: "Compliance certifications",
    plans: "Plans",
    evidence: "Stated build evidence",
  };
  return labels[field] ?? field;
}
