import type { AssetPassport } from "@/lib/types";
import AgentLogo from "@/components/AgentLogo";
import {
  UNKNOWN,
  evidence,
  isKnown,
  listed,
  overviewBlocks,
  permissionValue,
  planMeters,
  ratingDetail,
  ratingLabel,
  runsOn,
  statusClass,
  statusFor,
} from "@/lib/present";

/**
 * The agent passport.
 *
 * Every row prints what the capture says or it prints Unknown. Nothing here
 * infers, rounds, or fills a gap from a neighbouring field. The status chip on
 * each row records WHO said it: Verified means Microsoft assessed it on the
 * app certification page, Disclosed means the publisher stated it.
 */

function Row({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status: string;
}) {
  return (
    <div className="passport-row">
      <span>{label}</span>
      <b>{value}</b>
      <em className={`evidence ${statusClass(status)}`}>{status}</em>
    </div>
  );
}

export default function PassportView({ a }: { a: AssetPassport }) {
  const ev = a.evidence ?? {};
  const cert = a.certification;
  const fromListing = (v: string) => statusFor(v, "listing", cert);
  const fromCert = (v: string) => statusFor(v, "certification", cert);

  const llm = evidence(ev, "model");
  const framework = evidence(ev, "framework");
  const tools = evidence(ev, "tool_mcp");
  const data = evidence(ev, "data_source");
  const integrations =
    evidence(ev, "integration") !== UNKNOWN
      ? evidence(ev, "integration")
      : listed(a.works_with);
  const deployment = evidence(ev, "deployment");
  const hosting = a.cert_hosting ?? UNKNOWN;
  const residency = a.cert_data_location ?? UNKNOWN;
  const compliance = a.compliance?.length ? a.compliance.join(", ") : UNKNOWN;
  const permissions = permissionValue(a);
  const blocks = overviewBlocks(a.overview_text, a.tagline);
  const head = blocks.slice(0, 2);
  const rest = blocks.slice(2);
  const restLines = rest.reduce(
    (t, b) => t + (b.type === "ul" ? b.items.length : 1),
    0
  );

  const renderBlock = (b: (typeof blocks)[number], i: number) =>
    b.type === "ul" ? (
      <ul
        key={i}
        className="passport-description"
        style={{ margin: "0 0 9px", paddingLeft: 16 }}
      >
        {b.items.map((item, j) => (
          <li key={j} style={{ margin: "2px 0" }}>
            {item}
          </li>
        ))}
      </ul>
    ) : (
      <p key={i} className="passport-description" style={{ margin: "0 0 9px" }}>
        {b.text}
      </p>
    );

  return (
    <>
      <div className="passport-header">
        <AgentLogo name={a.name} id={a.source_product_id} logo={a.logo} large />
        <div>
          <span className="overline">AGENT PASSPORT</span>
          <h2>{a.name}</h2>
          <p>
            {a.publisher ?? UNKNOWN} · {a.function_category}
          </p>
        </div>
      </div>

      <div className="agent-tags" style={{ marginTop: 12 }}>
        {(a.surfaces ?? []).map((s) => (
          <span key={s}>{s}</span>
        ))}
        {!a.capture_complete && <span>Partial capture</span>}
        <span>{a.cert_label}</span>
      </div>

      <div className="passport-summary">
        <div>
          <span>User rating</span>
          <b>{ratingLabel(a)}</b>
          <small>{ratingDetail(a)}</small>
        </div>
        <div>
          <span>Runs on</span>
          <b>{runsOn(a)}</b>
          <small>{a.delivery ?? UNKNOWN}</small>
        </div>
        <div>
          <span>Provenance</span>
          <b>{a.provenance}</b>
          <small>{a.reach}% of the build traced</small>
        </div>
        <div>
          <span>Evidence risk</span>
          <b className={`risk-${a.risk.toLowerCase()}`}>{a.risk}</b>
          <small>{a.risk_basis}</small>
        </div>
      </div>

      <div className="modal-reach">
        <div>
          <b>Provenance reach</b>
          <span>
            {a.layers_known} of {a.layers_tracked} layers
          </span>
        </div>
        <div className="reach-track large-track">
          <i style={{ width: `${a.reach}%` }} />
        </div>
      </div>

      <h3 className="modal-section-title">What the publisher says</h3>
      {blocks.length === 0 ? (
        <p className="passport-description">
          This listing publishes no overview text.
        </p>
      ) : (
        <>
          {head.map(renderBlock)}
          {rest.length > 0 && (
            <details style={{ marginTop: 2 }}>
              <summary
                style={{
                  cursor: "pointer",
                  fontSize: 10,
                  color: "#0b2b52",
                  fontWeight: 700,
                  listStyle: "none",
                }}
              >
                Show the rest of the publisher’s description ({restLines} more
                line{restLines === 1 ? "" : "s"})
              </summary>
              <div style={{ marginTop: 9 }}>{rest.map(renderBlock)}</div>
            </details>
          )}
        </>
      )}

      <h3 className="modal-section-title">Agent build and provenance</h3>
      <div className="passport-table">
        <Row
          label="Creator / vendor"
          value={a.publisher ?? UNKNOWN}
          status={isKnown(a.publisher) ? "Disclosed" : UNKNOWN}
        />
        <Row label="Primary model / LLM" value={llm} status={fromListing(llm)} />
        <Row label="Agent framework" value={framework} status={fromListing(framework)} />
        <Row label="Tools / MCP" value={tools} status={fromListing(tools)} />
        <Row label="Data sources" value={data} status={fromListing(data)} />
        <Row
          label="Integrations / works with"
          value={integrations}
          status={fromListing(integrations)}
        />
        <Row label="Hosting model" value={hosting} status={fromCert(hosting)} />
        <Row label="Data residency" value={residency} status={fromCert(residency)} />
        <Row
          label="Microsoft Graph permissions"
          value={permissions}
          status={fromCert(permissions)}
        />
        <Row
          label="Compliance certifications"
          value={compliance}
          status={fromCert(compliance)}
        />
        <Row
          label="Deployment / government readiness"
          value={deployment}
          status={fromListing(deployment)}
        />
        <Row
          label="Access model"
          value={a.acquire_using ?? UNKNOWN}
          status={isKnown(a.acquire_using) ? "Disclosed" : UNKNOWN}
        />
        <Row
          label="Listing version"
          value={
            (a.listing_version ? `v${a.listing_version}` : "Not stated") +
            (a.listing_updated ? ` · updated ${a.listing_updated}` : "")
          }
          status={a.listing_version || a.listing_updated ? "Disclosed" : UNKNOWN}
        />
        <Row label="Marketplace / source" value={a.marketplace_name} status="Disclosed" />
        <Row label="Source type" value="Marketplace listing" status="Disclosed" />
        <Row
          label="Evidence tier"
          value={a.evidence_tier ?? UNKNOWN}
          status={cert === "microsoft_365_certified" ? "Verified" : "Disclosed"}
        />
      </div>

      {a.cert_data_handling && (
        <div className="modal-note">
          <b>Customer data, per the certification page</b>
          <p>{a.cert_data_handling}</p>
        </div>
      )}

      {a.plans?.length > 0 && (
        <>
          <h3 className="modal-section-title">Plans and pricing as listed</h3>
          <div className="passport-table">
            {a.plans.slice(0, 12).map((p, i) => {
              const meters = planMeters(p.unit);
              return (
                <div
                  key={i}
                  className="passport-row"
                  style={{ gridTemplateColumns: "1.5fr 1fr", alignItems: "start" }}
                >
                  <div>
                    <b style={{ fontSize: 10 }}>{p.name ?? "Plan"}</b>
                    {meters.length > 0 && (
                      <ul
                        style={{
                          margin: "5px 0 0",
                          paddingLeft: 14,
                          fontSize: 8.5,
                          color: "#7f899b",
                          lineHeight: 1.5,
                        }}
                      >
                        {meters.slice(0, 6).map((m, j) => (
                          <li key={j} style={{ margin: "2px 0" }}>
                            {m}
                          </li>
                        ))}
                        {meters.length > 6 && (
                          <li style={{ margin: "2px 0" }}>
                            and {meters.length - 6} more meters
                          </li>
                        )}
                      </ul>
                    )}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <b style={{ fontSize: 11 }}>{p.price ?? "Not stated"}</b>
                    {p.billing && (
                      <div
                        style={{ fontSize: 8.5, color: "#7f899b", marginTop: 3 }}
                      >
                        {p.billing}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {a.plans.length > 12 && (
              <div className="passport-row" style={{ gridTemplateColumns: "1fr" }}>
                <span>and {a.plans.length - 12} more plans on the listing</span>
              </div>
            )}
          </div>
        </>
      )}

      <h3 className="modal-section-title">Sources</h3>
      <div className="passport-table">
        <SourceRow
          label="Marketplace listing"
          url={a.listing_url}
          note="marketplace.microsoft.com"
          verified={false}
        />
        {a.cert_url && (
          <SourceRow
            label="App certification"
            url={a.cert_url}
            note="learn.microsoft.com"
            verified={cert === "microsoft_365_certified"}
          />
        )}
        {(a.product_links ?? []).slice(0, 5).map((l, i) => (
          <SourceRow
            key={`p${i}`}
            label={l.label ?? "Publisher link"}
            url={l.url}
            note={l.label ?? l.url}
            verified={false}
          />
        ))}
        {(a.legal_links ?? []).slice(0, 4).map((l, i) => (
          <SourceRow
            key={`l${i}`}
            label={l.label ?? "Legal"}
            url={l.url}
            note={l.label ?? l.url}
            verified={false}
          />
        ))}
      </div>

      <div className="access-box">
        <div>
          <span>Pricing</span>
          <b>{a.price_band ?? UNKNOWN}</b>
          <small>{a.price_note ?? "Not stated"}</small>
        </div>
        <div>
          <span>Delivery</span>
          <b>{a.delivery ?? UNKNOWN}</b>
          <small>{a.support ?? a.marketplace_name}</small>
        </div>
        <a
          className="primary-btn external-link"
          href={a.listing_url}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open the source listing ↗
        </a>
      </div>

      <p
        className="passport-description"
        style={{ marginTop: 14, fontSize: 9 }}
      >
        Evidence risk is the share of the build you cannot see before you deploy,
        not a security rating. It starts at the attestation level, then moves one
        band on how much of the build this source can disclose that it actually
        does. Three of the {a.layers_tracked} layers — hosting, data residency
        and permission scope — are only ever stated on an app certification page,
        so a listing without one is scored against the nine it can state. Every
        value above is copied from this listing or its certification page.
        Unknown means the source does not state it.
      </p>
    </>
  );
}

function SourceRow({
  label,
  url,
  note,
  verified,
}: {
  label: string;
  url: string;
  note: string;
  verified: boolean;
}) {
  return (
    <div className="passport-row">
      <span>{label}</span>
      <b>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#0b2b52" }}
        >
          {note} ↗
        </a>
      </b>
      <em className={`evidence ${verified ? "verified" : "disclosed"}`}>Source</em>
    </div>
  );
}
