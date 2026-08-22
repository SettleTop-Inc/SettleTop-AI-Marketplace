import { test, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * Session-aware passport reads (Access Foundation Phase B2, task 3): a
 * signed-in read earns v_asset_passport (full); a signed-out read earns
 * v_asset_passport_public (the 43-column allowlist), with a fallback to
 * v_asset_passport (still allowlist-only) when the public view does not
 * exist yet, the pre-migration window. PostgREST reports a missing relation
 * as PGRST205 ("Could not find the table in the schema cache"), not the raw
 * Postgres 42P01 (undefined_table) — the fallback guard must match PGRST205
 * for the pre-migration window to actually work in production; 42P01 is
 * accepted too, defensively. The same shape applies to the slug resolver rpc:
 * PostgREST reports a missing function as PGRST202, not the raw Postgres
 * 42883 (undefined_function). No network: the Supabase client and the
 * session are both mocked below.
 *
 * `--experimental-test-module-mocks` (added to the `test` script) is what
 * makes `mock.module` available. mock.module replaces the WHOLE module, so
 * lib/supabase.ts's real env-var guard (which throws without credentials)
 * never runs, and this file needs no Supabase project to pass.
 */

interface FakeError {
  message: string;
  code?: string;
}
interface FakeResult {
  data: unknown;
  error: FakeError | null;
}
interface RecordedCall {
  table: string;
  select?: string;
  eq?: [string, unknown];
}
type TableStub = (call: RecordedCall) => FakeResult;

/**
 * A stand-in for a PostgREST query builder: chainable and awaitable (both
 * `.maybeSingle()` and a bare `await` are used by the read layer), and it
 * records the table, column list and predicate a read actually used, so a
 * test can assert which view a tier reached without any network.
 */
class FakeQuery implements PromiseLike<FakeResult> {
  private readonly stub: TableStub;
  private readonly calls: RecordedCall[];
  private readonly call: RecordedCall;
  constructor(stub: TableStub, calls: RecordedCall[], table: string) {
    this.stub = stub;
    this.calls = calls;
    this.call = { table };
  }
  select(cols: string): this {
    this.call.select = cols;
    return this;
  }
  eq(col: string, val: unknown): this {
    this.call.eq = [col, val];
    return this;
  }
  in(col: string, val: unknown): this {
    this.call.eq = [col, val];
    return this;
  }
  order(): this {
    return this;
  }
  limit(): this {
    return this;
  }
  range(): this {
    return this;
  }
  private resolve(): FakeResult {
    this.calls.push(this.call);
    return this.stub(this.call);
  }
  maybeSingle(): Promise<FakeResult> {
    return Promise.resolve(this.resolve());
  }
  single(): Promise<FakeResult> {
    return Promise.resolve(this.resolve());
  }
  then<TResult1 = FakeResult, TResult2 = never>(
    onfulfilled?: ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.resolve()).then(onfulfilled, onrejected);
  }
}

const missing = (table: string): FakeResult => ({
  data: null,
  error: { message: `no stub configured for ${table}` },
});

// Mutable, per-test state. mock.module can only be called once per specifier
// (a second call throws "the module is already mocked"), so the mocked
// exports below are stable object/function references whose behaviour is
// driven by these variables, re-set at the top of every test.
type RpcStub = (args: unknown) => FakeResult;
let anonStubs: Record<string, TableStub> = {};
let sessionStubs: Record<string, TableStub> = {};
let rpcStubs: Record<string, RpcStub> = {};
let sessionUser: { id: string } | null = null;
let calls: RecordedCall[] = [];

function reset(): void {
  anonStubs = {};
  sessionStubs = {};
  rpcStubs = {};
  sessionUser = null;
  calls = [];
}

const anonClient = {
  from(table: string) {
    return new FakeQuery(anonStubs[table] ?? (() => missing(table)), calls, table);
  },
  rpc(name: string, args: unknown) {
    calls.push({ table: `rpc:${name}`, eq: ["args", args] });
    const stub = rpcStubs[name];
    return Promise.resolve(stub ? stub(args) : { data: null, error: null });
  },
};

const sessionClient = {
  from(table: string) {
    return new FakeQuery(sessionStubs[table] ?? (() => missing(table)), calls, table);
  },
};

mock.module("./supabase.ts", { namedExports: { supabase: anonClient } });
mock.module("./auth.ts", {
  namedExports: {
    supabaseServer: async () => sessionClient,
    getSessionUser: async () => sessionUser,
    getSessionProfile: async () => null,
  },
});

const ASSET_ID = "11111111-1111-1111-1111-111111111111";
const FULL_ROW = { asset_id: ASSET_ID, name: "Full Agent", evidence: { model: ["gpt"] } };
const PUBLIC_ROW = { asset_id: ASSET_ID, name: "Public Agent" };

test("PUBLIC_PASSPORT_COLUMNS excludes every depth column (the allowlist guard)", async () => {
  reset();
  const { PUBLIC_PASSPORT_COLUMNS } = await import("./registry.ts");
  const excluded = [
    "evidence",
    "known_layers",
    "risk_basis",
    "graph_permissions",
    "compliance",
    "listings",
    "cert_hosting",
    "cert_data_location",
    "cert_data_handling",
  ];
  const cols: readonly string[] = PUBLIC_PASSPORT_COLUMNS;
  for (const col of excluded) {
    assert.ok(!cols.includes(col), `PUBLIC_PASSPORT_COLUMNS must not include "${col}"`);
  }
  assert.equal(cols.length, 43, "the allowlist is exactly the 43 columns Task 1 Step 2 names");
});

test("a signed-in session reads v_asset_passport and returns gated:false", async () => {
  reset();
  sessionUser = { id: "u1" };
  sessionStubs["v_asset_passport"] = () => ({ data: FULL_ROW, error: null });

  const { getPassportByAssetId } = await import("./registry.ts");
  const r = await getPassportByAssetId(ASSET_ID);

  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.data);
  assert.equal(r.data?.gated, false);
  assert.deepEqual(r.data?.passport, FULL_ROW);

  assert.ok(
    calls.some((c) => c.table === "v_asset_passport"),
    "expected a read against v_asset_passport"
  );
  assert.ok(
    !calls.some((c) => c.table === "v_asset_passport_public"),
    "a signed-in read must never touch the public projection"
  );
});

test("a signed-out session reads v_asset_passport_public with the column allowlist and returns gated:true", async () => {
  reset();
  sessionUser = null;
  anonStubs["v_asset_passport_public"] = () => ({ data: PUBLIC_ROW, error: null });

  const { getPassportByAssetId, PUBLIC_PASSPORT_COLUMNS } = await import("./registry.ts");
  const r = await getPassportByAssetId(ASSET_ID);

  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.data?.gated, true);
  assert.deepEqual(r.data?.passport, PUBLIC_ROW);

  const hit = calls.find((c) => c.table === "v_asset_passport_public");
  assert.ok(hit, "expected a read against v_asset_passport_public");
  assert.equal(hit?.select, PUBLIC_PASSPORT_COLUMNS.join(","));

  assert.ok(
    !calls.some((c) => c.table === "v_asset_passport"),
    "a signed-out read must never touch the full view while the public view answers"
  );
});

test("a 42P01 on the public view falls back to v_asset_passport, still allowlist-only, still gated:true", async () => {
  reset();
  sessionUser = null;
  anonStubs["v_asset_passport_public"] = () => ({
    data: null,
    error: { message: 'relation "v_asset_passport_public" does not exist', code: "42P01" },
  });
  anonStubs["v_asset_passport"] = () => ({ data: PUBLIC_ROW, error: null });

  const { getPassportByAssetId, PUBLIC_PASSPORT_COLUMNS } = await import("./registry.ts");
  const r = await getPassportByAssetId(ASSET_ID);

  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.data?.gated, true, "the public tier is preserved by the projection, not by which view answered");
  assert.deepEqual(r.data?.passport, PUBLIC_ROW);

  const fallback = calls.find((c) => c.table === "v_asset_passport");
  assert.ok(fallback, "expected the pre-migration fallback to reach v_asset_passport");
  assert.equal(
    fallback?.select,
    PUBLIC_PASSPORT_COLUMNS.join(","),
    "the fallback must still select only the public allowlist, not the whole row"
  );
});

test("a PGRST205 on the public view falls back to v_asset_passport, still allowlist-only, still gated:true", async () => {
  reset();
  sessionUser = null;
  anonStubs["v_asset_passport_public"] = () => ({
    data: null,
    error: {
      message: "Could not find the table 'public.v_asset_passport_public' in the schema cache",
      code: "PGRST205",
    },
  });
  anonStubs["v_asset_passport"] = () => ({ data: PUBLIC_ROW, error: null });

  const { getPassportByAssetId, PUBLIC_PASSPORT_COLUMNS } = await import("./registry.ts");
  const r = await getPassportByAssetId(ASSET_ID);

  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(
    r.data?.gated,
    true,
    "PGRST205 (what PostgREST actually returns for a missing relation) must trigger the same fallback as 42P01"
  );
  assert.deepEqual(r.data?.passport, PUBLIC_ROW);

  const fallback = calls.find((c) => c.table === "v_asset_passport");
  assert.ok(fallback, "expected the pre-migration fallback to reach v_asset_passport on PGRST205");
  assert.equal(
    fallback?.select,
    PUBLIC_PASSPORT_COLUMNS.join(","),
    "the fallback must still select only the public allowlist, not the whole row"
  );
});

test("a non-42P01 error returns ok:false and never the raw PostgREST message", async () => {
  reset();
  sessionUser = null;
  const RAW_MESSAGE = "permission denied for table v_asset_passport_public";
  anonStubs["v_asset_passport_public"] = () => ({
    data: null,
    error: { message: RAW_MESSAGE, code: "42501" },
  });

  const { getPassportByAssetId } = await import("./registry.ts");
  const r = await getPassportByAssetId(ASSET_ID);

  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.notEqual(r.error, RAW_MESSAGE);
  assert.ok(
    !r.error.includes(RAW_MESSAGE),
    "the caller-facing error must never contain the raw PostgREST message"
  );
});

test("getPassports falls back to v_asset_passport on PGRST205, still allowlist-only, still gated:true", async () => {
  reset();
  sessionUser = null;
  const PUBLIC_ROWS = [PUBLIC_ROW];
  anonStubs["v_asset_passport_public"] = () => ({
    data: null,
    error: {
      message: "Could not find the table 'public.v_asset_passport_public' in the schema cache",
      code: "PGRST205",
    },
  });
  anonStubs["v_asset_passport"] = () => ({ data: PUBLIC_ROWS, error: null });

  const { getPassports, PUBLIC_PASSPORT_COLUMNS } = await import("./registry.ts");
  const r = await getPassports([ASSET_ID]);

  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(
    r.data.gated,
    true,
    "PGRST205 (what PostgREST actually returns for a missing relation) must trigger the same fallback getPassports uses for 42P01"
  );
  assert.deepEqual(r.data.passports, PUBLIC_ROWS);

  const fallback = calls.find((c) => c.table === "v_asset_passport");
  assert.ok(fallback, "expected getPassports' pre-migration fallback to reach v_asset_passport on PGRST205");
  assert.equal(
    fallback?.select,
    PUBLIC_PASSPORT_COLUMNS.join(","),
    "getPassports' fallback must still select only the public allowlist, not the whole row"
  );
});

test("resolveAssetSlug falls back to a direct asset_slug read on PGRST202 (function not found)", async () => {
  reset();
  const SLUG = "some-agent";
  rpcStubs["resolve_asset_slug"] = () => ({
    data: null,
    error: {
      message: "Could not find the function public.resolve_asset_slug(p_slug) in the schema cache",
      code: "PGRST202",
    },
  });
  anonStubs["asset_slug"] = () => ({ data: { asset_id: ASSET_ID }, error: null });

  const { resolveAssetSlug } = await import("./registry.ts");
  const result = await resolveAssetSlug(SLUG);

  assert.equal(
    result,
    ASSET_ID,
    "PGRST202 (function not found, the pre-migration window) must fall back to reading asset_slug directly"
  );

  const fallback = calls.find((c) => c.table === "asset_slug");
  assert.ok(fallback, "expected the pre-migration fallback to read the asset_slug table directly");
  assert.deepEqual(fallback?.eq, ["slug", SLUG]);
});

test("resolveAssetSlug returns undefined when the asset_slug fallback finds no row", async () => {
  reset();
  const SLUG = "missing-agent";
  rpcStubs["resolve_asset_slug"] = () => ({
    data: null,
    error: { message: "function not found", code: "PGRST202" },
  });
  anonStubs["asset_slug"] = () => ({ data: null, error: null });

  const { resolveAssetSlug } = await import("./registry.ts");
  const result = await resolveAssetSlug(SLUG);

  assert.equal(result, undefined, "a slug with no matching row is found-nothing, not a failure");
});

test("resolveAssetSlug returns null when the asset_slug fallback read itself errors", async () => {
  reset();
  const SLUG = "some-agent";
  rpcStubs["resolve_asset_slug"] = () => ({
    data: null,
    error: { message: "function not found", code: "PGRST202" },
  });
  anonStubs["asset_slug"] = () => ({
    data: null,
    error: { message: "permission denied for table asset_slug", code: "42501" },
  });

  const { resolveAssetSlug } = await import("./registry.ts");
  const result = await resolveAssetSlug(SLUG);

  assert.equal(result, null, "a genuine failure in the fallback read must still surface as null");
});

test("resolveAssetSlug returns null on a non-function-not-found rpc error, without reading asset_slug", async () => {
  reset();
  const SLUG = "some-agent";
  rpcStubs["resolve_asset_slug"] = () => ({
    data: null,
    error: { message: "permission denied for function resolve_asset_slug", code: "42501" },
  });
  anonStubs["asset_slug"] = () => ({ data: { asset_id: ASSET_ID }, error: null });

  const { resolveAssetSlug } = await import("./registry.ts");
  const result = await resolveAssetSlug(SLUG);

  assert.equal(result, null);
  assert.ok(
    !calls.some((c) => c.table === "asset_slug"),
    "a non-function-not-found rpc error must never fall back to reading asset_slug directly"
  );
});
