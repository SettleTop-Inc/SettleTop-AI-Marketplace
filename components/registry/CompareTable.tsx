import { UNKNOWN, attestsNoPermissions, evidence, listed, permissionValue } from "@/lib/present";
import type { AssetPassport, PublicPassport } from "@/lib/types";
import DepthGate from "@/components/DepthGate";

/**
 * Every row needs two independent readings of the same underlying fact:
 *
 * `display` is what a visitor sees — it may truncate ("a, b, c +N more") the
 * same way the passport does, because the table's job is to stay legible.
 *
 * `compareValue` is what rowState() diffs — full, untruncated, and with
 * list-valued fields canonicalised (deduped + sorted) so two agents cannot be
 * marked "differs" merely because their evidence arrived in a different
 * order, and cannot be marked "same" merely because they agree on the first
 * few displayed items while actually diverging further down the list.
 *
 * Generic over the passport shape a row reads: `Row<AssetPassport>` for the
 * depth rows below (they read `evidence`, `cert_*`, `graph_permissions`,
 * `compliance` — none of which `PublicPassport` carries), `Row<PublicPassport>`
 * for the two public rows the gated render also shows. This is what makes a
 * depth-field read on the gated path a compile error rather than a cast: a
 * `Row<PublicPassport>`'s `display`/`compareValue` is simply not typeable
 * against `a.evidence` or `a.cert_hosting`.
 */
type Row<T> = {
  label: string;
  display: (a: T) => string;
  compareValue: (a: T) => string;
};

/**
 * Order- and truncation-independent key for a list-valued field. Never
 * rendered — only ever fed to rowState()'s equality check.
 */
function canonicalSet(values: string[] | null | undefined): string {
  const v = (values ?? []).filter(Boolean);
  if (v.length === 0) return UNKNOWN;
  return JSON.stringify([...new Set(v)].sort());
}

/**
 * Integrations mirrors PassportView's own fallback exactly (see
 * `components/PassportView.tsx`'s `integrations` local): a passport can
 * disclose integrations either as verified evidence or, absent that, as the
 * listing's own `works_with` list. Reading `evidence.integration` alone would
 * print "no evidence" for a passport that plainly lists integrations — a
 * false absence claim about a record that does show the data.
 *
 * Typed on `AssetPassport`, not `PublicPassport`, even though the fallback
 * branch (`works_with`) is itself a public field: the row's PRIMARY source is
 * `evidence`, which `PublicPassport` does not carry, so the row as a whole is
 * depth. It is gated along with the rest of the analysis rather than
 * special-cased to show only its public fallback.
 */
function integrationsRaw(a: AssetPassport): string[] {
  const stated = a.evidence?.integration ?? [];
  return stated.length > 0 ? stated : a.works_with ?? [];
}

function integrationsDisplay(a: AssetPassport): string {
  const stated = evidence(a.evidence ?? {}, "integration");
  return stated !== UNKNOWN ? stated : listed(a.works_with);
}

/**
 * Graph permissions has a sentinel the rest of the rows don't: "None
 * requested" is a *stated* value (an attestation that exists and asks for
 * nothing), distinct from Unknown (the source never said). permissionValue()
 * truncates its display at 5; this mirrors its exact branching over the full,
 * order-independent set so the untruncated comparison never drifts from what
 * is displayed.
 */
function permissionsCompareValue(a: AssetPassport): string {
  const p = a.graph_permissions ?? [];
  if (p.length > 0) return canonicalSet(p);
  return attestsNoPermissions(a) ? "None requested" : UNKNOWN;
}

/**
 * The passport's own layers, in the passport's order. No new claims.
 *
 * Row-by-row public/depth classification (Access Foundation Phase B2): a row
 * is DEPTH when it is sourced from `evidence`, `graph_permissions`,
 * `compliance`, or `cert_*` detail — none of which `PublicPassport` carries.
 * Only "Creator / vendor" (`publisher`) and "Access model" (`acquire_using`)
 * read fields `PublicPassport` also has, which is why those two — and only
 * those two — are re-declared against `PublicPassport` in `PUBLIC_ROWS`
 * below for the gated render. This array is unchanged from the pre-gate
 * table and remains exactly what the signed-in (non-gated) render uses.
 */
const ROWS: Row<AssetPassport>[] = [
  {
    label: "Creator / vendor",
    display: (a) => a.publisher ?? UNKNOWN,
    compareValue: (a) => a.publisher ?? UNKNOWN,
  },
  {
    label: "Primary model",
    display: (a) => evidence(a.evidence ?? {}, "model"),
    compareValue: (a) => canonicalSet(a.evidence?.model),
  },
  {
    label: "Framework",
    display: (a) => evidence(a.evidence ?? {}, "framework"),
    compareValue: (a) => canonicalSet(a.evidence?.framework),
  },
  {
    label: "Tools / MCP",
    display: (a) => evidence(a.evidence ?? {}, "tool_mcp"),
    compareValue: (a) => canonicalSet(a.evidence?.tool_mcp),
  },
  {
    label: "Data sources",
    display: (a) => evidence(a.evidence ?? {}, "data_source"),
    compareValue: (a) => canonicalSet(a.evidence?.data_source),
  },
  {
    label: "Integrations / works with",
    display: integrationsDisplay,
    compareValue: (a) => canonicalSet(integrationsRaw(a)),
  },
  {
    label: "Hosting model",
    display: (a) => a.cert_hosting ?? UNKNOWN,
    compareValue: (a) => a.cert_hosting ?? UNKNOWN,
  },
  {
    label: "Data residency",
    display: (a) => a.cert_data_location ?? UNKNOWN,
    compareValue: (a) => a.cert_data_location ?? UNKNOWN,
  },
  {
    label: "Graph permissions",
    display: (a) => permissionValue(a),
    compareValue: permissionsCompareValue,
  },
  {
    label: "Compliance",
    display: (a) => listed(a.compliance, 3),
    compareValue: (a) => canonicalSet(a.compliance),
  },
  {
    // Matches PassportView's "Deployment / government readiness" row: both
    // read evidence.deployment. The brief's original row read a.delivery
    // instead — a different column (the listing's SaaS/Teams-app delivery
    // mode) — which would have this row silently contradict the passport it
    // is transposing.
    label: "Deployment / government readiness",
    display: (a) => evidence(a.evidence ?? {}, "deployment"),
    compareValue: (a) => canonicalSet(a.evidence?.deployment),
  },
  {
    label: "Access model",
    display: (a) => a.acquire_using ?? UNKNOWN,
    compareValue: (a) => a.acquire_using ?? UNKNOWN,
  },
];

/**
 * The gated render's two public rows, re-declared against `PublicPassport`
 * rather than reused from `ROWS`: `Row<AssetPassport>`'s `display`/
 * `compareValue` accept an `AssetPassport`, which a `PublicPassport` is not
 * (it is missing dozens of required fields), so `ROWS[0]`/`ROWS[10]` cannot
 * be called with `PublicPassport` agents — the type system, not a review
 * comment, is what keeps these two definitions honest duplicates of
 * `ROWS[0]` and the last entry above.
 */
const PUBLIC_ROWS: Row<PublicPassport>[] = [
  {
    label: "Creator / vendor",
    display: (a) => a.publisher ?? UNKNOWN,
    compareValue: (a) => a.publisher ?? UNKNOWN,
  },
  {
    label: "Access model",
    display: (a) => a.acquire_using ?? UNKNOWN,
    compareValue: (a) => a.acquire_using ?? UNKNOWN,
  },
];

/**
 * Three states, not two.
 *
 * All-Unknown is neither a match nor a difference: calling it a match asserts
 * the agents are the same, calling it a difference asserts the records differ
 * when they are identical. Both are inferences the source does not support.
 */
function rowState(compareValues: string[]): "same" | "differs" | "no-evidence" {
  if (compareValues.every((v) => v === UNKNOWN)) return "no-evidence";
  return new Set(compareValues).size === 1 ? "same" : "differs";
}

/**
 * One data row. Shared by the full (signed-in) and gated (public-rows-only)
 * renders: the row markup and the same/differs/no-evidence logic are
 * identical either way, only which `Row<T>`/`agents` pair gets fed in
 * differs.
 */
function DataRow<T extends { asset_id: string }>({ row, agents }: { row: Row<T>; agents: T[] }) {
  const displayValues = agents.map((a) => row.display(a));
  const compareValues = agents.map((a) => row.compareValue(a));
  const state = rowState(compareValues);
  return (
    <tr className={state === "differs" ? "reg-diff" : undefined}>
      <th scope="row">
        {row.label}
        {state === "differs" && (
          // Visible, not just visually-hidden: the tint and left border
          // this row also gets are the only other signal, and neither
          // reaches a colour-blind sighted visitor or (being decorative,
          // not text) a screen reader.
          <span className="reg-diff-flag">differs</span>
        )}
      </th>
      {state === "no-evidence" ? (
        // All agents are Unknown here. Printing "Unknown" once per column
        // would look like the row confirms a match — three identical cells
        // in a same/differ table read as "same" at a glance, which is
        // exactly the false inference this row must not invite. A single
        // message spanning every agent column says the row is not
        // comparable, once, instead of asserting anything per agent.
        <td className="reg-none" colSpan={agents.length}>
          No evidence to compare: every agent is Unknown here.
        </td>
      ) : (
        displayValues.map((v, i) => (
          <td key={agents[i].asset_id} className={v === UNKNOWN ? "reg-none" : undefined}>
            {v}
          </td>
        ))
      )}
    </tr>
  );
}

/**
 * Replaces every depth row (`ROWS` minus `PUBLIC_ROWS`) with one spanning
 * affordance, positioned where that block of rows sits in `ROWS` (between
 * "Creator / vendor" and "Access model") so the gated table reads as the
 * same document with the analysis blocked out, not a different layout.
 */
function GatedRow({ agentCount }: { agentCount: number }) {
  return (
    <tr className="reg-cmp-gated">
      <th scope="row">Provenance analysis</th>
      <td colSpan={agentCount}>
        <DepthGate />
      </td>
    </tr>
  );
}

function Header<T extends { asset_id: string; name: string; publisher: string | null }>({
  agents,
}: {
  agents: T[];
}) {
  return (
    <tr>
      <th scope="col">Provenance layer</th>
      {agents.map((a) => (
        <th scope="col" key={a.asset_id}>
          {a.name}
          <div className="reg-row-sub">{a.publisher ?? UNKNOWN}</div>
        </th>
      ))}
    </tr>
  );
}

/**
 * `gated`/`agents` are correlated by construction (Access Foundation Phase
 * B2): a session that only earned `PublicPassport[]` cannot also claim
 * `gated` is false, and a full `AssetPassport[]` read is never marked
 * `gated`. Modelling that as a discriminated union — rather than
 * `agents: AssetPassport[] | PublicPassport[]; gated?: boolean` narrowed
 * with a cast — means a stray depth-field read on the gated branch is a
 * compile error instead of a runtime `undefined`. This is the hardening
 * Task 4's review asked for on `PassportView`'s `(a as FullPassport)` cast;
 * applied here from the start since `CompareTable` is new to `gated`.
 */
type Props =
  | { agents: AssetPassport[]; gated?: false }
  | { agents: PublicPassport[]; gated: true };

export default function CompareTable(props: Props) {
  // Defense in depth: the route only ever renders this component when a read
  // succeeded AND resolved at least one agent, but an empty table would emit
  // an invalid colSpan={0} in the no-evidence/gated branches below, so guard
  // here too. `agents.length` reads the same on either union member, so this
  // check does not need the `gated` narrowing below.
  if (props.agents.length === 0) return null;

  // Narrow on `props.gated` (not a destructure) so `props.agents` narrows
  // alongside it: TypeScript ties the two together only through the
  // discriminant on `props` itself, per the Props union above.
  if (props.gated) {
    const agents = props.agents;
    return (
      <>
        <div className="reg-cmp-wrap">
          <table className="reg-cmp">
            <thead>
              <Header agents={agents} />
            </thead>
            <tbody>
              <DataRow row={PUBLIC_ROWS[0]} agents={agents} />
              <GatedRow agentCount={agents.length} />
              <DataRow row={PUBLIC_ROWS[1]} agents={agents} />
            </tbody>
          </table>
        </div>
        <div className="reg-cmp-legend">
          <span>Highlighted rows (marked “differs”) have different stated values</span>
          <span className="reg-none">Unknown: the source is silent</span>
        </div>
      </>
    );
  }

  const agents = props.agents;
  return (
    <>
      <div className="reg-cmp-wrap">
        <table className="reg-cmp">
          <thead>
            <Header agents={agents} />
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <DataRow key={r.label} row={r} agents={agents} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="reg-cmp-legend">
        <span>Highlighted rows (marked “differs”) have different stated values</span>
        <span className="reg-none">Unknown: the source is silent</span>
      </div>
    </>
  );
}
