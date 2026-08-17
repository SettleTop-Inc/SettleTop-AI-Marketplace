/**
 * The twelve use cases the registry organises agents by.
 *
 * These are the buyer's language, not the marketplace's. `name` must match the
 * values registry_function_category() returns in the database — if you add one
 * here, add the matching branch there in the same change.
 */
export interface UseCase {
  name: string;
  icon: string;
  desc: string;
}

export const USE_CASES: UseCase[] = [
  { name: "Acquisition & Procurement", icon: "§", desc: "Market research, sourcing, solicitation and procurement workflows" },
  { name: "Marketing & Sales", icon: "↗", desc: "Prospecting, sales coaching, campaigns and account intelligence" },
  { name: "Finance & Accounting", icon: "$", desc: "FP&A, payables, ledger analysis and finance operations" },
  { name: "Customer Service", icon: "◎", desc: "Autonomous service, case resolution and support" },
  { name: "Cybersecurity & IT", icon: "◇", desc: "Security, employee IT support and enterprise service workflows" },
  { name: "Intelligence & Research", icon: "⌕", desc: "Research, analysis, diligence and knowledge synthesis" },
  { name: "Software Development", icon: "</>", desc: "Coding, testing, development and agent building" },
  { name: "HR & Talent", icon: "○", desc: "Employee support, benefits, career planning and talent workflows" },
  { name: "Operations & Productivity", icon: "⚙", desc: "Cross-functional workflow automation and knowledge work" },
  { name: "Logistics & Supply Chain", icon: "⇄", desc: "Supplier, inventory and supply-chain workflows" },
  { name: "GovCon Growth", icon: "★", desc: "BD, capture, proposals and government-market growth" },
  { name: "Gov Acquisition", icon: "G", desc: "Federal acquisition and source-selection workflows" },
];
