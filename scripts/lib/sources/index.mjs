/**
 * The source registry: every marketplace the harvester knows how to read.
 *
 * A source is its id plus the ordered stages that fill it. Stages are script
 * paths rather than functions on purpose — each one is already a standalone,
 * resumable program that can be run on its own when a single stage needs
 * re-running, and keeping them that way means the driver adds orchestration
 * without taking anything away. `npm run harvest:detail` still works exactly as
 * it did.
 *
 * Adding a marketplace is adding an entry here and the scripts it names. The
 * driver needs no changes, and neither does any existing source.
 *
 * Stage order matters within a source and is not incidental:
 *   - docs before catalog, because an agent capture copies text out of the
 *     publisher's security statement and the evidence gate verifies against it
 *   - catalog before detail, because detail walks what catalog enumerated
 *   - certification after catalog, because it reads the link the tile carries,
 *     and before ingest, because its record belongs to the same capture rather
 *     than to a second one
 *   - ingest last, because it joins every earlier file
 *
 * A source has the stages it needs and no placeholders. AWS has three: pricing
 * arrives in the same blob as the listing, so there is nothing for a pricing
 * stage to fetch, and AWS publishes no certification page at all, so a
 * certification stage would have no page to read.
 *
 * Logos are deliberately NOT a per-source stage. v_logo_status carries
 * marketplace_id, so one archiver pass covers every source at once, and running
 * it per source would just walk the same view twice.
 */

export const SOURCES = [
  {
    id: "microsoft",
    name: "Microsoft Marketplace",
    stages: [
      "harvest-catalog.mjs",
      "harvest-detail.mjs",
      "harvest-pricing.mjs",
      "harvest-certification.mjs",
      "harvest-ingest.mjs",
    ],
  },
  {
    id: "drai",
    name: "DRAI Agentic-AI Marketplace",
    stages: [
      "drai-docs.mjs",
      "drai-catalog.mjs",
      "drai-detail.mjs",
      "drai-ingest.mjs",
    ],
  },
  {
    id: "aws",
    name: "AWS Marketplace",
    stages: [
      // The sitemap, one request. It carries no category, so unlike Microsoft
      // this stage cannot filter and enumerates the whole marketplace.
      "aws-catalog.mjs",
      // The expensive pass, and the only place the category filter can live:
      // a listing states its categories on its own record and nowhere else.
      // Roughly seven of every eight pages fetched are read and rejected.
      "aws-detail.mjs",
      "aws-ingest.mjs",
    ],
  },
];

/** Shared stages, run once after every source rather than per source. */
export const SHARED_STAGES = ["archive-logos.mjs"];

export const sourceById = (id) => SOURCES.find((s) => s.id === id);
