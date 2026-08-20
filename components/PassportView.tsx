import Link from "next/link";
import type { AssetPassport } from "@/lib/types";
import AgentLogo from "@/components/AgentLogo";
import ListingPanels, { type ListingSummary } from "@/components/registry/ListingPanels";
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
 * infers, rounds, or fills a gap from a neighbouring field. The stamp on
 * each row records WHO said it: Verified means Microsoft assessed it on the
 * app certification page, Disclosed means the publisher stated it.
 *
 * Laid out as a document, not a card: an identity band carrying the name,
 * publisher and layer ledger, then the record itself in a centred measure.
 * It previously reused .modal-card — an 820px MODAL style — as its page
 * layout, which left the whole page flush-left inside a centred container.
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
  const unknown = !isKnown(value);
  return (
    <div className="st-record__row">
      <span className="st-record__label">{label}</span>
      <span
        className={`st-record__value${unknown ? " st-record__value--unknown" : ""}`}
      >
        {value}
      </span>
      <em className={`st-stamp st-stamp--${statusClass(status)}`}>{status}</em>
    </div>
  );
}

/**
 * The layer ledger.
 *
 * One cell per tracked layer, filled up to layers_known. Both numbers come
 * from the database — this renders them, it does not decide which specific
 * layers are known, which would be a second definition of a derived value.
 */
function LayerLedger({ known, tracked }: { known: number; tracked: number }) {
  return (
    <div className="st-ledger">
      <div className="st-ledger__head">
        <span className="st-ledger__label">Provenance reach</span>
        <span className="st-ledger__count">
          {known} of {tracked} layers traced
        </span>
      </div>
      <div
        className="st-ledger__cells"
        role="img"
        aria-label={`${known} of ${tracked} build layers traced`}
      >
        {Array.from({ length: tracked }, (_, i) => (
          <span
            key={i}
            className={`st-ledger__cell${i < known ? " st-ledger__cell--on" : ""}`}
          />
        ))}
      </div>
    </div>
  );
}

function SectionHead({ children, count }: { children: string; count?: string }) {
  return (
    <div className="st-section-head">
      <h2 className="st-display">{children}</h2>
      {count && <span className="st-section-head__count">{count}</span>}
    </div>
  );
}

/**
 * `AssetPassport` in lib/types.ts does not yet declare `listings`: see the
 * comment on `ListingPassport` there. The column exists on `v_asset_passport`
 * from phase 2 onward and is simply absent from a phase 1 row, so it is
 * always optional here rather than added to the shared type, which this
 * component does not own.
 */
type Passport = AssetPassport & { listings?: ListingSummary[] };

/**
 * Where the leading description came from.
 *
 * `overview_text` and `tagline` are the primary listing's own text, per
 * `20260820100000_asset_keyed_views.sql`'s `v_asset_passport`, which joins
 * `capture_extract` through the primary listing for everything outside the
 * certification group. `marketplace_name` on the passport is that same
 * primary listing's marketplace, in both the phase 1 and phase 2 shape, so
 * it is always the right attribution and needs no `listings` array at all.
 */
function descriptionSource(a: Passport): string {
  return a.marketplace_name;
}

/**
 * Where the certification badge came from.
 *
 * Certification resolves as ANY listing, not necessarily the primary one
 * (same migration, "rule 1"), so once an asset carries more than one
 * listing this can legitimately name a different marketplace than
 * descriptionSource() above. Under one listing, or with no `listings` array
 * at all (phase 1), there is only one candidate and this returns the same
 * name descriptionSource() does.
 *
 * Prefers the primary listing when its certification already equals the
 * resolved value, matching the SQL resolver's own tie-break. Past that, this
 * walks `listings` in the array's own order (primary first, then by
 * marketplace_name), while the resolver's own tie-break past the primary is
 * by listing_id. Those two orderings can only ever disagree with three or
 * more non-primary candidates tied on certification tier, so with at most
 * two listings total (today's ceiling) they always agree. If it ever
 * matters, listing_id is the one to match, not marketplace_name.
 */
function certificationSource(a: Passport): string {
  const listings = a.listings ?? [];
  if (listings.length <= 1) return a.marketplace_name;
  const primaryMatch = listings.find((l) => l.is_primary && l.certification === a.certification);
  if (primaryMatch) return primaryMatch.marketplace_name;
  const match = listings.find((l) => l.certification === a.certification);
  return match?.marketplace_name ?? a.marketplace_name;
}

/**
 * `back` is present on the standalone /agent/[id] route and absent when the
 * landing page renders the same record inside its modal, which supplies its
 * own close control and its own width.
 */
export default function PassportView({
  a,
  back,
}: {
  a: Passport;
  back?: { href: string; label: string };
}) {
  const listings = a.listings ?? [];
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
      <ul key={i} style={{ margin: "0 0 var(--s4)", paddingLeft: "1.1em" }}>
        {b.items.map((item, j) => (
          <li key={j} style={{ margin: "var(--s1) 0" }}>
            {item}
          </li>
        ))}
      </ul>
    ) : (
      <p key={i}>{b.text}</p>
    );

  return (
    <div className={`st-passport${back ? "" : " st-passport--embedded"}`}>
      <div className="st-passport-band">
        <div className="st-shell">
          {back && (
            <Link className="st-back" href={back.href}>
              ← {back.label}
            </Link>
          )}

          <div className="st-passport-id">
            <AgentLogo name={a.name} id={a.source_product_id} logo={a.logo} large />
            <div className="st-passport-id__text">
              <span className="st-eyebrow">Agent passport</span>
              <h1 className="st-display">{a.name}</h1>
              <p className="st-passport-id__by">
                <b>{a.publisher ?? UNKNOWN}</b> · {a.function_category}
              </p>
              <div className="st-tags">
                {(a.surfaces ?? []).map((s) => (
                  <span className="st-tag" key={s}>
                    {s}
                  </span>
                ))}
                {!a.capture_complete && <span className="st-tag">Partial capture</span>}
                <span className="st-tag">{a.cert_label}</span>
              </div>
              <p className="st-note" style={{ marginTop: "var(--s2)" }}>
                Certification per {certificationSource(a)}.
              </p>
            </div>
          </div>

          <LayerLedger known={a.layers_known} tracked={a.layers_tracked} />
        </div>
      </div>

      <div className="st-shell st-passport-body">
        <div className="st-fields">
          <div className="st-field">
            <span className="st-field__label">User rating</span>
            <span className="st-field__value">{ratingLabel(a)}</span>
            <span className="st-field__note">{ratingDetail(a)}</span>
          </div>
          <div className="st-field">
            <span className="st-field__label">Runs on</span>
            <span className="st-field__value">{runsOn(a)}</span>
            <span className="st-field__note">{a.delivery ?? UNKNOWN}</span>
          </div>
          <div className="st-field">
            <span className="st-field__label">Provenance</span>
            <span className="st-field__value">{a.provenance}</span>
            <span className="st-field__note">{a.reach}% of the build traced</span>
          </div>
          <div className="st-field">
            <span className="st-field__label">Evidence risk</span>
            <span
              className={`st-field__value st-field__value--${a.risk.toLowerCase()}`}
            >
              {a.risk}
            </span>
            <span className="st-field__note">{a.risk_basis}</span>
          </div>
        </div>

        <SectionHead>What the publisher says</SectionHead>
        <div className="st-prose">
          <p className="st-note" style={{ margin: "0 0 var(--s3)" }}>
            As described on {descriptionSource(a)}.
          </p>
          {blocks.length === 0 ? (
            <p>This listing publishes no overview text.</p>
          ) : (
            <>
              {head.map(renderBlock)}
              {rest.length > 0 && (
                <details>
                  <summary className="st-disclosure">
                    Show the rest of the publisher’s description ({restLines} more
                    line{restLines === 1 ? "" : "s"})
                  </summary>
                  <div style={{ marginTop: "var(--s4)" }}>{rest.map(renderBlock)}</div>
                </details>
              )}
            </>
          )}
        </div>

        <SectionHead>Agent build and provenance</SectionHead>
        <div className="st-record">
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
          <div className="st-callout">
            <p className="st-callout__title">
              Customer data, per the certification page
            </p>
            <p>{a.cert_data_handling}</p>
          </div>
        )}

        {a.plans?.length > 0 && (
          <>
            <SectionHead count={`${a.plans.length} listed`}>
              Plans and pricing as listed
            </SectionHead>
            <div className="st-record">
              {a.plans.slice(0, 12).map((p, i) => {
                const meters = planMeters(p.unit);
                return (
                  <div
                    key={i}
                    className="st-record__row"
                    style={{ gridTemplateColumns: "minmax(0,2fr) minmax(0,1fr)" }}
                  >
                    <div>
                      <span className="st-record__value">{p.name ?? "Plan"}</span>
                      {meters.length > 0 && (
                        <ul
                          style={{
                            margin: "var(--s2) 0 0",
                            paddingLeft: "1.1em",
                            fontSize: "var(--t-xs)",
                            color: "var(--c-ink-3)",
                            lineHeight: 1.6,
                          }}
                        >
                          {meters.slice(0, 6).map((m, j) => (
                            <li key={j}>{m}</li>
                          ))}
                          {meters.length > 6 && (
                            <li>and {meters.length - 6} more meters</li>
                          )}
                        </ul>
                      )}
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <span className="st-record__value">{p.price ?? "Not stated"}</span>
                      {p.billing && (
                        <div
                          style={{
                            fontSize: "var(--t-xs)",
                            color: "var(--c-ink-3)",
                            marginTop: "var(--s1)",
                          }}
                        >
                          {p.billing}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {a.plans.length > 12 && (
                <div
                  className="st-record__row"
                  style={{ gridTemplateColumns: "1fr" }}
                >
                  <span className="st-record__label">
                    and {a.plans.length - 12} more plans on the listing
                  </span>
                </div>
              )}
            </div>
          </>
        )}

        {listings.length > 0 && (
          <>
            <SectionHead
              count={`${listings.length} marketplace${listings.length === 1 ? "" : "s"}`}
            >
              Listed on
            </SectionHead>
            <ListingPanels listings={listings} />
          </>
        )}

        <SectionHead>Sources</SectionHead>
        <div className="st-record">
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

        <div className="st-access">
          <div>
            <span className="st-field__label">Pricing</span>
            <div className="st-field__value">{a.price_band ?? UNKNOWN}</div>
            <span className="st-field__note">{a.price_note ?? "Not stated"}</span>
          </div>
          <div>
            <span className="st-field__label">Delivery</span>
            <div className="st-field__value">{a.delivery ?? UNKNOWN}</div>
            <span className="st-field__note">{a.support ?? a.marketplace_name}</span>
          </div>
          <a
            className="st-btn st-btn--primary"
            href={a.listing_url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open the source listing ↗
          </a>
        </div>

        <p className="st-note">
          Evidence risk is the share of the build you cannot see before you deploy,
          not a security rating. It starts at the attestation level, then moves one
          band on how much of the build this source can disclose that it actually
          does. Three of the {a.layers_tracked} layers (hosting, data residency
          and permission scope) are only ever stated on an app certification page,
          so a listing without one is scored against the nine it can state. Every
          value above is copied from this listing or its certification page.
          Unknown means the source does not state it.
        </p>
      </div>
    </div>
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
    <div className="st-record__row">
      <span className="st-record__label">{label}</span>
      <span className="st-record__value">
        <a href={url} target="_blank" rel="noopener noreferrer">
          {note} ↗
        </a>
      </span>
      <em className={`st-stamp st-stamp--${verified ? "verified" : "disclosed"}`}>
        Source
      </em>
    </div>
  );
}
