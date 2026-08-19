import { UNKNOWN, attestsNoPermissions, evidence, listed, permissionValue } from "@/lib/present";
import type { AssetPassport } from "@/lib/types";

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
 */
type Row = {
  label: string;
  display: (a: AssetPassport) => string;
  compareValue: (a: AssetPassport) => string;
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

/** The passport's own layers, in the passport's order. No new claims. */
const ROWS: Row[] = [
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

export default function CompareTable({ agents }: { agents: AssetPassport[] }) {
  // Defense in depth: the route only ever renders this component when a read
  // succeeded AND resolved at least one agent, but an empty table would emit
  // an invalid colSpan={0} in the no-evidence branch below, so guard here too.
  if (agents.length === 0) return null;

  return (
    <>
      <div className="reg-cmp-wrap">
        <table className="reg-cmp">
          <thead>
            <tr>
              <th scope="col">Provenance layer</th>
              {agents.map((a) => (
                <th scope="col" key={a.asset_id}>
                  {a.name}
                  <div className="reg-row-sub">{a.publisher ?? UNKNOWN}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => {
              const displayValues = agents.map((a) => r.display(a));
              const compareValues = agents.map((a) => r.compareValue(a));
              const state = rowState(compareValues);
              return (
                <tr key={r.label} className={state === "differs" ? "reg-diff" : undefined}>
                  <th scope="row">
                    {r.label}
                    {state === "differs" && (
                      // Visible, not just visually-hidden: the tint and left
                      // border this row also gets are the only other signal,
                      // and neither reaches a colour-blind sighted visitor or
                      // (being decorative, not text) a screen reader.
                      <span className="reg-diff-flag">differs</span>
                    )}
                  </th>
                  {state === "no-evidence" ? (
                    // All agents are Unknown here. Printing "Unknown" once per
                    // column would look like the row confirms a match — three
                    // identical cells in a same/differ table read as "same" at
                    // a glance, which is exactly the false inference this row
                    // must not invite. A single message spanning every agent
                    // column says the row is not comparable, once, instead of
                    // asserting anything per agent.
                    <td className="reg-none" colSpan={agents.length}>
                      No evidence to compare — every agent is Unknown here.
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
            })}
          </tbody>
        </table>
      </div>
      <div className="reg-cmp-legend">
        <span>Highlighted rows (marked “differs”) have different stated values</span>
        <span className="reg-none">Unknown — the source is silent</span>
      </div>
    </>
  );
}
