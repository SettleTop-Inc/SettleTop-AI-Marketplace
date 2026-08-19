/**
 * Product detail, one entry per product page.
 *
 * Claims are drawn from each product's own repository — its ProductDefinition,
 * its README, and in CodeRoot Open Source's case the running instance the
 * screenshots were captured from. Nothing here describes a capability the
 * product does not have.
 *
 * CodeRoot itself is absent: it remains a SettleTop product but is not
 * featured on this site.
 */

export type Shot = { src: string; alt: string; caption: string };

/** Two colourways of the same mark: the SVGs are single-fill, so each theme
 *  gets the one drawn for its ground rather than a filter applied to the
 *  other. The navy variant is filled #061C3B — the brand's own dark ground. */
export type Logo = { light: string; dark: string };

export type Product = {
  slug: string;
  logo?: Logo;
  name: string;
  line: string;
  summary: string;
  tags: string[];
  /** Shown on the products index and the homepage card. */
  points: string[];
  /** Long-form sections, product page only. */
  sections?: { title: string; body: string; items?: string[] }[];
  shots?: Shot[];
  /** A drawn diagram instead of screenshots, for products with no UI. */
  visual?: "mitre-chain" | "sbom-flow";
  audience?: string[];
  deploy?: { k: string; v: string }[];
  cta?: { label: string; href: string; external?: boolean };
};

export const PRODUCTS: Product[] = [
  {
    slug: "ai-registry",
    name: "AI Registry",
    line: "Provenance for the agents you are about to adopt",
    summary:
      "Every agent carries a passport recording what its build actually discloses — model, framework, tools, data sources, hosting, residency and permission scope — and who said so.",
    tags: ["Live registry"],
    points: [
      "Verified, Disclosed and Unknown are recorded separately",
      "Where a source is silent, the value reads Unknown",
      "Filter, compare and share a result set by link",
    ],
    sections: [
      {
        title: "The passport",
        body:
          "One record per agent, listing what the source states about the build and marking who stated it. A value is Verified when the marketplace assessed it on a certification page, Disclosed when the publisher asserted it, and Unknown when nothing was said. Those three are never collapsed into one.",
        items: [
          "Creator, primary model, agent framework, tools and MCP servers",
          "Data sources, integrations, hosting model and data residency",
          "Permission scope, compliance certifications and deployment readiness",
          "The listing version, the source it came from, and when it was captured",
        ],
      },
      {
        title: "Evidence risk is not a security rating",
        body:
          "The risk band measures how much of the build you cannot see before you deploy — not how dangerous the agent is. It starts at the attestation level and moves on how much of the build the source can disclose but does not. An agent with a thin record scores badly even if it is perfectly safe, because the point is what you can check.",
      },
      {
        title: "Comparison and hand-off",
        body:
          "Filter by function, source, deployment, evidence tier, provenance, pricing and evidence risk; put candidates side by side; and share the exact result set as a link. Facet counts exclude their own selection, so the numbers beside a filter tell you what would happen if you applied it.",
      },
    ],
    cta: { label: "Browse the registry", href: "/marketplace" },
  },
  {
    slug: "coderoot-open-source",
    logo: {
      light: "/brand/coderoot_logo_smooth_navy_tight.svg",
      dark: "/brand/coderoot_logo_smooth_white_tight.svg",
    },
    name: "CodeRoot Open Source",
    line: "Component intelligence, from an SBOM",
    summary:
      "Upload a bill of materials and every component resolves to its real source repository, enriched with maintenance, contributor, release, dependency and advisory signals — then assessed for where in the world it is actually maintained.",
    tags: ["Self-hosted", "Helm or Compose", "Runs locally"],
    visual: "sbom-flow",
    points: [
      "Citeable dossiers, versioned and time-stamped",
      "Verified facts kept separate from assessed judgments",
      "Contributor geography and concentration risk per component",
    ],
    sections: [
      {
        title: "What it answers",
        body:
          "The operational and acquisition-grade questions that decide whether software can be trusted, sustained and governed over time.",
        items: [
          "What is this component and what does it enable?",
          "Who controls it, who maintains it, and how resilient is that stewardship?",
          "How does it change, and what has changed since the last baseline?",
          "What are the security, operational and compliance risks in context?",
          "How does it connect to broader ecosystems and mission-relevant stacks?",
        ],
      },
      {
        title: "Component intelligence dossiers",
        body:
          "A stable, citeable record for each component, maintained as a living baseline. Every major claim is evidence-backed and time-stamped, with confidence levels distinguishing verified fact from analytic judgment.",
        items: [
          "Identification — canonical naming, aliases, forks, registry mappings and version lines",
          "Stewardship — maintainer structure, bus-factor signals, governance model, workflow maturity",
          "Operational readiness — release cadence, backlog aging, maintainer churn and continuity",
          "Security posture — vulnerability history, recurrence patterns, patch latency, signing and attestations",
          "Supply chain exposure — transitive footprint, publish pathways, shared-maintainer concentration",
          "Legal baseline — licensing, obligations, drift and notable exceptions",
        ],
      },
      {
        title: "Where your software is actually maintained",
        body:
          "Each resolved repository is mapped to the countries its contributors work from, then scored for concentration. Components maintained from watchlisted countries are flagged on the component itself, and the catalogue rolls up into a country view showing repositories present and risky components per country. This is the question an SBOM alone cannot answer.",
      },
      {
        title: "Editorial standards",
        body:
          "An analyst-led workflow with structured intake, verification and publication. Verified facts and assessments are labelled distinctly, sources and timestamps are retained for auditability, change logs record what moved and why, and the analytic language stays deliberately neutral about uncertainty.",
      },
    ],
    shots: [
      {
        src: "/product/coderoot-open-source/geography.png",
        alt: "A world map shading countries by how many of the catalogue's repositories have a contributor there, with watchlisted countries outlined, above a table of repositories present and risky components per country.",
        caption:
          "Contributor geography across the catalogue, with watchlisted countries outlined and a per-country risk roll-up.",
      },
      {
        src: "/product/coderoot-open-source/components.png",
        alt: "A component inventory table listing name, ecosystem, resolved repository, contributor geography with concentration badges and watchlist flags, and how each component was resolved.",
        caption:
          "Every component resolved to a repository, with concentration, watchlist flags, and how the resolution was reached.",
      },
      {
        src: "/product/coderoot-open-source/overview.png",
        alt: "An overview screen showing SBOMs processed, components found, repository homes resolved out of total, and how many need review.",
        caption:
          "Upload an SBOM and watch it resolve. What could not be matched goes to triage rather than being guessed.",
      },
      {
        src: "/product/coderoot-open-source/triage.png",
        alt: "A triage queue listing components whose source repository is ambiguous or unmatched, awaiting a decision.",
        caption:
          "Ambiguous matches queue for a human decision. An unresolved component stays unresolved.",
      },
    ],
    audience: [
      "Government agencies with mission systems and regulated environments",
      "Defense and intelligence organizations, commands and program offices",
      "Defense primes, integrators and major suppliers",
      "Critical infrastructure — energy, utilities, telecom, transportation",
      "Financial services, healthcare and life sciences with high-assurance programs",
      "Enterprises with formal governance, GRC and third-party risk processes",
    ],
    deploy: [
      { k: "Runs", v: "Entirely on your own infrastructure" },
      { k: "Install", v: "Docker Compose, or Helm on Kubernetes" },
      { k: "Stack", v: "FastAPI service, Next.js UI, Postgres, Redis, object storage" },
      { k: "Identity", v: "Keycloak single sign-on in production" },
      { k: "Formats", v: "CycloneDX SBOM ingest" },
    ],
  },
  {
    slug: "coderoot-vulnerability-intelligence",
    logo: {
      light: "/brand/coderoot_logo_smooth_navy_tight.svg",
      dark: "/brand/coderoot_logo_smooth_white_tight.svg",
    },
    name: "CodeRoot Vulnerability Intelligence",
    line: "The MITRE chain, self-updating, in your cluster",
    summary:
      "D3FEND to ATT&CK to CAPEC to CWE to CVE, with the CISA KEV catalog, EPSS scores, the NVD CPE dictionary and both tiers of GitHub Security Advisories. It comes up empty, populates itself and stays current with no operator intervention.",
    tags: ["Bring your own model", "Air-gap capable", "Read-only MCP"],
    visual: "mitre-chain",
    points: [
      "Nine ingest sources, unattended",
      "A read-only MCP server your own model can query",
      "Answers carry citations; no free-form SQL, no model credentials",
    ],
    sections: [
      {
        title: "One chain, joined up",
        body:
          "Defensive techniques through adversary techniques, attack patterns, weakness classes and specific vulnerabilities — held as one traversable graph rather than as separate downloads you join by hand. Exploitation signal comes from the KEV catalog and EPSS, and product matching from the CPE dictionary.",
      },
      {
        title: "Built for your model, not ours",
        body:
          "It ships a read-only MCP server so an agent can ask questions and get answers with citations. There is no bundled LLM client and no model credentials: you point your own model at it. Queries run against a fixed surface rather than free-form SQL, so an agent cannot wander outside what it is allowed to read.",
      },
      {
        title: "Nine sources, one fixed order",
        body:
          "The pipeline order is not incidental. Taxonomy first, then the product dictionary, then the known-exploited catalogue, then CVE records, then the operational enrichment that hangs off them, then a data-quality report. KEV deliberately loads before CVE: it keys on a CVE id as text with no foreign key into the CVE table, so a CVE outage still fails loudly while KEV, EPSS and the rest survive it.",
        items: [
          "Phase 1 — MITRE taxonomy: cwe, capec, attack, d3fend",
          "Phase 2 — product dictionary: nvd_cpe, roughly 1.3 million entries",
          "Phase 3 — known-exploited catalogue: kev",
          "Phase 4 — CVE records: cve",
          "Phase 5 — operational enrichment: epss, ghsa",
          "Phase 6 — data-quality report",
        ],
      },
      {
        title: "Unattended by design",
        body:
          "The database is empty on first start, populates itself from its sources, and keeps itself current on its own schedule. There is no curation step for an operator to forget, which is what makes it viable in environments where nobody is watching it day to day.",
      },
    ],
    deploy: [
      { k: "Runs", v: "In your cluster, reachable only from inside it" },
      { k: "Install", v: "Helm chart, or Compose for a local run" },
      { k: "Egress", v: "None to us — bring your own model" },
      { k: "Offline", v: "Suitable for secure and air-gapped environments" },
    ],
  },
];

export const byslug = (slug: string) => PRODUCTS.find((p) => p.slug === slug);
