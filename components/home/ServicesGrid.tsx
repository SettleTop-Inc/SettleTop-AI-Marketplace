/**
 * Services.
 *
 * A flat list, deliberately not mapped back to the products that inspired
 * each one — a buyer shops for the outcome, not for the internal lineage.
 *
 * Every entry is written as a capability. None of them claims a named
 * client, a sector, an engagement count or a testimonial, because none of
 * that has been cleared for publication.
 */

const SERVICES = [
  {
    name: "Enterprise Software Intelligence data pipelines",
    body:
      "Design and run the pipelines that turn a software estate into intelligence you can query — ingestion, resolution, enrichment and the store underneath it.",
    shape: "Build and deploy",
  },
  {
    name: "Code scan pipeline design and deployment",
    body:
      "Scanning built into your CI with the thresholds, gates and retained evidence that an auditor will accept, rather than a tool bolted on at the end.",
    shape: "Build and deploy",
  },
  {
    name: "Vendor Risk Assessments",
    body:
      "Evidence-backed assessments of the suppliers you depend on, delivered as citeable reports that separate what is verified from what is assessed.",
    shape: "Recurring deliverable",
  },
  {
    name: "Agentic-ready datasets",
    body:
      "Curated, richly structured datasets your agents can reason over inside secure and offline environments, with no internet access required.",
    shape: "Build and deploy",
  },
  {
    name: "Managed AI registries",
    body:
      "A vetted catalogue of the AI apps and agents approved for your organization, maintained as a living record rather than a spreadsheet.",
    shape: "Managed service",
  },
  {
    name: "AI monitoring",
    body:
      "Continuous monitoring of an item in your registry, with regular updates on what changed in its build, its evidence or its risk, and what that means for you.",
    shape: "Managed service",
  },
  {
    name: "Enterprise Agentic Scan Pipeline",
    body:
      "Automated evaluation of AI assets across quality, consistency, reliability and dependability, run continuously rather than once at procurement.",
    shape: "Build and deploy",
  },
];

export default function ServicesGrid() {
  return (
    <section className="hm-section" id="services">
      <div className="st-shell st-shell--wide">
        <header className="hm-section__head">
          <p className="st-eyebrow">Services</p>
          <h2 className="st-display">Work we do alongside the products</h2>
          <p className="st-lede">
            Engagements that stand up the pipelines, produce the assessments and
            run the registries — using the same evidence standard the products
            hold themselves to.
          </p>
        </header>

        <div className="hm-services">
          {SERVICES.map((s) => (
            <article className="hm-service" key={s.name}>
              <p className="hm-service__shape">{s.shape}</p>
              <h3 className="hm-service__name">{s.name}</h3>
              <p className="hm-service__body">{s.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
