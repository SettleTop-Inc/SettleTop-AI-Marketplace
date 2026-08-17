/**
 * Row shapes for the two read views the site uses.
 *
 * These mirror v_registry_card and v_asset_passport. If you change a view,
 * change this file in the same commit — nothing else re-derives it.
 *
 * Note on nulls: a null here means the source did not state the value. It
 * never means "we could not be bothered to look". Render it as Unknown and
 * leave it at that; do not substitute a plausible default anywhere.
 */

export type CertificationStatus =
  | "microsoft_365_certified"
  | "publisher_attestation"
  | "none"
  | "not_eligible";

export type ProvenanceStatus = "Verified" | "Disclosed" | "Unknown";
export type RiskBand = "Low" | "Medium" | "High";

export interface RegistryCard {
  asset_id: string;
  source_product_id: string;
  listing_url: string;
  marketplace_id: string;
  marketplace_name: string;
  last_captured_at: string | null;
  capture_count: number;
  name: string;
  publisher: string | null;
  tagline: string | null;
  function_category: string | null;
  delivery: string | null;
  surfaces: string[];
  rating: number | null;
  rating_count: number;
  external_source: string | null;
  external_rating: number | null;
  certification: CertificationStatus;
  cert_label: string;
  provenance: ProvenanceStatus;
  evidence_tier: string | null;
  reach: number;
  risk: RiskBand;
  risk_basis: string | null;
  price_band: string | null;
  price_note: string | null;
  listing_version: string | null;
  listing_updated: string | null;
  known_layers: string[];
  layers_known: number;
  layers_tracked: number;
  /**
   * Our archived copy of the publisher's logo, merged in from v_logo_status.
   * Absent means the registry does not hold the logo — never a reason to
   * hotlink the publisher's CDN instead.
   */
  logo?: string | null;
}

export interface PlanRow {
  name: string | null;
  price: string | null;
  unit: string | null;
  billing: string | null;
}

export interface LinkRow {
  label: string | null;
  url: string;
}

/** Verified evidence, keyed by evidence_kind. Absent key means none stated. */
export interface EvidenceMap {
  model?: string[];
  framework?: string[];
  tool_mcp?: string[];
  data_source?: string[];
  integration?: string[];
  deployment?: string[];
  language?: string[];
}

export interface AssetPassport extends RegistryCard {
  first_seen_at: string;
  capture_id: string;
  captured_at: string;
  capture_complete: boolean;
  missing: string[];
  ingest_source: string;
  overview_text: string | null;
  categories: string[];
  industries: string[];
  works_with: string[];
  pricing: string | null;
  acquire_using: string | null;
  support: string | null;
  native_rating: number | null;
  native_count: number | null;
  external_count: number | null;
  cert_url: string | null;
  cert_hosting: string | null;
  cert_data_location: string | null;
  cert_data_handling: string | null;
  cert_developer_updated: string | null;
  cert_page_updated: string | null;
  evidence: EvidenceMap;
  plans: PlanRow[];
  product_links: LinkRow[];
  legal_links: LinkRow[];
  media: string[];
  graph_permissions: string[];
  compliance: string[];
}

export interface RegistryStats {
  agents: number;
  marketplaces: number;
  certified: number;
  attested: number;
  mean_reach: number | null;
  captures: number;
  changes: number;
  last_captured_at: string | null;
}

export interface ChangeRow {
  id: number;
  asset_id: string;
  source_product_id: string;
  name: string;
  publisher: string | null;
  field: string;
  old_value: unknown;
  new_value: unknown;
  observed_at: string;
}
