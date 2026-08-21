import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("supabase module is server-only and the key is not NEXT_PUBLIC_", () => {
  const src = readFileSync(new URL("./supabase.ts", import.meta.url), "utf8");
  assert.match(src, /^import "server-only";/, "must import server-only as the guard");
  assert.match(src, /process\.env\.SUPABASE_PUBLISHABLE_KEY/, "reads the server-only key");
  assert.doesNotMatch(src, /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/, "the key must no longer be NEXT_PUBLIC_");
});
