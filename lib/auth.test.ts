import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("auth module is server-only, uses createServerClient with getAll/setAll and the server-only key", () => {
  const src = readFileSync(new URL("./auth.ts", import.meta.url), "utf8");
  assert.match(src, /^import "server-only";/m);
  assert.match(src, /createServerClient/);
  assert.match(src, /getAll\(\)/);
  assert.match(src, /setAll\(/);
  assert.match(src, /process\.env\.SUPABASE_PUBLISHABLE_KEY/);
  assert.doesNotMatch(src, /createBrowserClient/, "no browser Supabase client: the key stays server-only");
});
