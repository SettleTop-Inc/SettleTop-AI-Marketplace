import { test } from "node:test";
import assert from "node:assert/strict";

const hasEnv = !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_PUBLISHABLE_KEY;

test("getPassportByAssetId returns a ReadResult, null for an unknown id", { skip: hasEnv ? false : "no Supabase credentials" }, async () => {
  const { getPassportByAssetId } = await import("./registry.ts");
  const r = await getPassportByAssetId("00000000-0000-0000-0000-000000000000");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.data, null);
});
