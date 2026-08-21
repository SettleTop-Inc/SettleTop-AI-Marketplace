// Fails if the Supabase publishable key is inlined into any client chunk.
// Run after `next build`. The key is server-only now (Access Foundation
// Phase A); if it appears in .next/static, a client component is importing it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const NEEDLES = ["sb_publishable_"];
if (KEY) NEEDLES.push(KEY);
const ROOT = ".next/static";

function* files(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.js$/.test(p)) yield p;
  }
}

let hits = 0;
for (const f of files(ROOT)) {
  const src = readFileSync(f, "utf8");
  for (const n of NEEDLES) {
    if (src.includes(n)) {
      console.error(`LEAK: "${n}" found in ${f}`);
      hits++;
    }
  }
}
if (hits) {
  console.error(`\nFAIL: ${hits} client-bundle leak(s). A client component is importing lib/supabase.`);
  process.exit(1);
}
console.log("OK: no Supabase publishable key in .next/static client chunks.");
