import { UNKNOWN, evidence, listed, permissionValue } from "@/lib/present";
import type { AssetPassport } from "@/lib/types";

type Row = { label: string; value: (a: AssetPassport) => string };

/** The passport's own layers, in the passport's order. No new claims. */
const ROWS: Row[] = [
  { label: "Creator / vendor", value: (a) => a.publisher ?? UNKNOWN },
  { label: "Primary model", value: (a) => evidence(a.evidence ?? {}, "model") },
  { label: "Framework", value: (a) => evidence(a.evidence ?? {}, "framework") },
  { label: "Tools / MCP", value: (a) => evidence(a.evidence ?? {}, "tool_mcp") },
  { label: "Data sources", value: (a) => evidence(a.evidence ?? {}, "data_source") },
  { label: "Integrations", value: (a) => evidence(a.evidence ?? {}, "integration") },
  { label: "Hosting model", value: (a) => a.cert_hosting ?? UNKNOWN },
  { label: "Data residency", value: (a) => a.cert_data_location ?? UNKNOWN },
  { label: "Graph permissions", value: (a) => permissionValue(a) },
  { label: "Compliance", value: (a) => listed(a.compliance, 3) },
  { label: "Deployment", value: (a) => a.delivery ?? UNKNOWN },
  { label: "Access model", value: (a) => a.acquire_using ?? UNKNOWN },
];

/**
 * Three states, not two.
 *
 * All-Unknown is neither a match nor a difference: calling it a match asserts
 * the agents are the same, calling it a difference asserts the records differ
 * when they are identical. Both are inferences the source does not support.
 */
function rowState(values: string[]): "same" | "differs" | "no-evidence" {
  if (values.every((v) => v === UNKNOWN)) return "no-evidence";
  return new Set(values).size === 1 ? "same" : "differs";
}

export default function CompareTable({ agents }: { agents: AssetPassport[] }) {
  return (
    <>
      <div className="mkt-cmp-wrap">
        <table className="mkt-cmp">
          <thead>
            <tr>
              <th scope="col">Provenance layer</th>
              {agents.map((a) => (
                <th scope="col" key={a.asset_id}>
                  {a.name}
                  <div className="mkt-row-sub">{a.publisher ?? UNKNOWN}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => {
              const values = agents.map((a) => r.value(a));
              const state = rowState(values);
              return (
                <tr key={r.label} className={state === "differs" ? "mkt-diff" : undefined}>
                  <th scope="row">{r.label}</th>
                  {state === "no-evidence" ? (
                    // All agents are Unknown here. Printing "Unknown" once per
                    // column would look like the row confirms a match — three
                    // identical cells in a same/differ table read as "same" at
                    // a glance, which is exactly the false inference this row
                    // must not invite. A single message spanning every agent
                    // column says the row is not comparable, once, instead of
                    // asserting anything per agent.
                    <td className="mkt-none" colSpan={agents.length}>
                      No evidence to compare — every agent is Unknown here.
                    </td>
                  ) : (
                    values.map((v, i) => (
                      <td key={agents[i].asset_id} className={v === UNKNOWN ? "mkt-none" : undefined}>
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
      <div className="mkt-cmp-legend">
        <span>Highlighted rows differ</span>
        <span className="mkt-none">Unknown — the source is silent</span>
      </div>
    </>
  );
}
