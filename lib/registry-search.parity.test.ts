import test from "node:test";
import assert from "node:assert/strict";
import {
  type Criteria,
  type FacetGroup,
  type FacetKey,
  defaultCriteria,
  runQuery,
} from "./registry-query.ts";
import type { RegistryCard } from "./types.ts";

/**
 * registry_search() in Postgres and runQuery() in TypeScript must answer the
 * same question the same way.
 *
 * Filtering moved into the database so the browser stops receiving the whole
 * registry, but runQuery stays: it is the readable statement of what the
 * registry means by a match, a count and an order, and it is what the unit
 * tests in registry-query.test.ts pin down. This file is the join between
 * them — it runs both over the live registry and asserts they agree on rows,
 * order, totals and every facet count.
 *
 * Without this, the SQL could drift from the semantics the unit tests protect
 * and every one of those tests would still pass.
 *
 * Needs credentials, and skips cleanly without them so `npm test` stays green
 * offline and in CI. `npm run test:parity` loads .env.local and runs it.
 */

const haveDb = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.SUPABASE_PUBLISHABLE_KEY
);

type Over = Partial<Omit<Criteria, "facets">> & {
  facets?: Partial<Record<FacetKey, string[]>>;
};

const criteria = (over: Over = {}): Criteria => {
  const c = defaultCriteria();
  return { ...c, ...over, facets: { ...c.facets, ...(over.facets ?? {}) } };
};

const ids = (rows: RegistryCard[]) => rows.map((r) => r.asset_id);

test(
  "registry_search matches runQuery over the live registry",
  { skip: haveDb ? false : "no Supabase credentials in the environment" },
  async (t) => {
    // Imported here, not at module scope: lib/supabase.ts throws on import when
    // the credentials are absent, which would fail the file instead of skipping it.
    const { getCards, searchRegistry } = await import("./registry.ts");

    const cards = await getCards();
    assert.ok(cards.length > 0, "read no cards at all — check credentials");

    const baseline = await searchRegistry(defaultCriteria());
    assert.ok(baseline.ok, "unfiltered search failed");

    // The capture worker writes continuously. If the registry moved between the
    // corpus read and this call, the two sides are describing different data and
    // any mismatch below would be noise. Say so rather than failing or, worse,
    // passing for the wrong reason.
    if (baseline.ok && baseline.data.total !== cards.length) {
      t.skip(
        `registry changed under the test: read ${cards.length} cards, ` +
          `search reports ${baseline.data.total}. Re-run.`
      );
      return;
    }

    // Values that exist in this registry, so the facet scenarios below filter on
    // something real rather than on a guess that silently matches nothing.
    const pick = (key: FacetKey): string | null => {
      const g = baseline.ok ? baseline.data.facets.find((f) => f.key === key) : undefined;
      const withRows = g?.values.filter((v) => v.count > 0) ?? [];
      // Not the largest: a mid-sized value exercises the counts harder, because
      // a facet holding almost everything hides an off-by-one.
      return withRows.length ? withRows[Math.floor(withRows.length / 2)].value : null;
    };

    const source = pick("source");
    const fn = pick("function");
    const risk = pick("risk");

    const scenarios: Array<[string, Criteria]> = [
      ["defaults", criteria()],
      ["page 2", criteria({ page: 2 })],
      ["page size 96", criteria({ perPage: 96 })],
      ["sort name asc", criteria({ sort: "name", dir: "asc" })],
      ["sort name desc", criteria({ sort: "name", dir: "desc" })],
      ["sort rating desc (nulls last)", criteria({ sort: "rating", dir: "desc" })],
      ["sort rating asc (nulls still last)", criteria({ sort: "rating", dir: "asc" })],
      ["sort captured desc", criteria({ sort: "captured", dir: "desc" })],
      ["free-text q", criteria({ q: "security" })],
      ["q matching nothing", criteria({ q: "zzzznotathing" })],
      // % and _ are LIKE wildcards in SQL and ordinary characters in
      // String.includes. Unescaped, this would match the whole registry.
      ["q containing a LIKE wildcard", criteria({ q: "100%" })],
      ["q with an underscore", criteria({ q: "a_b" })],
      ["page past the end clamps to the last", criteria({ page: 9999 })],
    ];

    if (source) scenarios.push(["one source facet", criteria({ facets: { source: [source] } })]);
    if (fn) scenarios.push(["one function facet", criteria({ facets: { function: [fn] } })]);
    if (source && fn)
      scenarios.push([
        "two facet groups at once",
        criteria({ facets: { source: [source], function: [fn] } }),
      ]);
    if (risk)
      scenarios.push([
        "facet plus free text",
        criteria({ q: "a", facets: { risk: [risk] } }),
      ]);
    // A selected value that matches nothing must still appear in the rail, with
    // a count of 0, rather than vanishing while it is active in the URL.
    scenarios.push([
      "selected facet value with no rows",
      criteria({ facets: { source: ["definitely-not-a-marketplace"] } }),
    ]);

    for (const [name, c] of scenarios) {
      await t.test(name, async () => {
        const expected = runQuery(cards, c);
        const got = await searchRegistry(c);
        assert.ok(got.ok, `search failed: ${got.ok ? "" : got.error}`);
        if (!got.ok) return;

        assert.equal(got.data.total, expected.total, "total");
        assert.equal(got.data.page, expected.page, "clamped page");
        assert.equal(got.data.pageCount, expected.pageCount, "page count");
        assert.deepEqual(ids(got.data.rows), ids(expected.rows), "rows and their order");

        assert.deepEqual(
          got.data.facets.map((f) => f.key),
          expected.facets.map((f) => f.key),
          "facet groups and their order"
        );
        for (const want of expected.facets) {
          const mine: FacetGroup | undefined = got.data.facets.find(
            (f) => f.key === want.key
          );
          assert.deepEqual(mine?.values, want.values, `facet values for "${want.key}"`);
        }
      });
    }
  }
);
