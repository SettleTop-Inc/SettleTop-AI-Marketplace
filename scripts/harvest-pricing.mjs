#!/usr/bin/env node
/**
 * Pass 3 of 4 — plan pricing. The only pass that needs a real browser.
 *
 *   npx playwright install chromium     # once
 *   node scripts/harvest-pricing.mjs [--limit N] [--concurrency 4]
 *
 * Plan pricing is the one thing NOT in the server-rendered state. It stays in
 * React component state after hydration — `pricingPayload` and
 * `offerPricingData` are empty even once the page has fully loaded — so it has
 * to be read out of the rendered DOM. Everything else is a plain fetch.
 *
 * Only products with hasPrices are visited: about 49% of the catalog.
 * Resumable — already-scraped ids are skipped.
 */
import { PRODUCT_URL, readJsonl, writeJsonl, sleep } from "./lib/marketplace.mjs";

const TILES = "data/tiles.jsonl";
const OUT = "data/plans.jsonl";

const argN = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? Number(process.argv[i + 1]) : dflt;
};
const limit = argN("--limit", 0);
const CONCURRENCY = argN("--concurrency", 4);

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("Playwright not installed. Run:  npm i -D playwright && npx playwright install chromium");
  process.exit(1);
}

/**
 * Parse one plan row.
 *
 * Fluent UI renders each plan as a .ms-List-cell whose innerText is ordered:
 *   [0]  plan name
 *   [1]  "Get it now"            call to action, dropped
 *   [2]  description
 *   [3]  price / billing frequency        e.g. $0.00/month
 *   [4]  "Plus:"                 marker, dropped
 *   [5+] metered rates           e.g. paygo-input-tokens: $5.00 per 1m tokens
 *   [-2] contract duration       e.g. 1-month subscription
 *   [-1] total for term          e.g. $0.00 for 1 month
 *
 * Anchored on .ms-List-cell and line position on purpose: the styling classes
 * carry hashed build suffixes (appsource-pricingCellRoot-323) that change on
 * every deploy. Never select on those.
 */
function parseCell(lines) {
  const drop = new Set(["Get it now", "Plus:", "Contact me", "Free trial", "Save"]);
  const kept = lines.filter((l) => !drop.has(l));
  if (!kept.length) return null;
  const meters = kept.filter((l) => /:\s*\$?[\d.,]+\s*per\s+/i.test(l));
  const priceLine = kept.find((l) => /\$[\d.,]+\s*\/\s*\w+|\/month|\/year|\/hour/i.test(l)) || null;
  const billing = kept.find((l) => /subscription|term|month|year/i.test(l) && l !== priceLine && !meters.includes(l)) || null;
  return {
    name: kept[0] || null,
    price: priceLine,
    unit: meters.length ? meters.join("; ") : null,
    billing,
  };
}

const tiles = await readJsonl(TILES);
if (!tiles.length) { console.error(`No ${TILES}. Run harvest-catalog.mjs first.`); process.exit(1); }

const existing = await readJsonl(OUT);
const done = new Set(existing.map((r) => r.id));
let todo = tiles.filter((t) => t.hasPrices && !done.has(t.entityId));
if (limit) todo = todo.slice(0, limit);

console.log(`${tiles.filter((t) => t.hasPrices).length} priced products, ${done.size} already scraped, ${todo.length} to go`);
console.log(`concurrency ${CONCURRENCY}\n`);

const browser = await chromium.launch();
const results = [];
const failures = [];
let processed = 0;

async function worker() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // images and fonts are pure cost here; the plan table is text
  await ctx.route("**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}", (r) => r.abort());
  const page = await ctx.newPage();
  while (todo.length) {
    const t = todo.pop();
    if (!t) break;
    try {
      await page.goto(PRODUCT_URL(t.entityId) + "?tab=PlansAndPrice", {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      await page.waitForSelector(".ms-List-cell", { timeout: 15000 });
      const cells = await page.$$eval(".ms-List-cell", (els) =>
        els.map((e) => (e.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean))
      );
      const plans = cells.map(parseCell).filter((p) => p && p.name);
      results.push({ id: t.entityId, plans });
    } catch (e) {
      // a product with hasPrices but no plan table is real data, not a bug
      const msg = e.message.split("\n")[0];
      if (/waitForSelector|Timeout/i.test(msg)) results.push({ id: t.entityId, plans: [] });
      else failures.push({ id: t.entityId, error: msg });
    }
    processed++;
    if (processed % 25 === 0) process.stdout.write(`\r  ${processed} processed, ${results.length} captured`);
    await sleep(120); // stay polite
  }
  await ctx.close();
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await browser.close();

const rows = existing.concat(results);
await writeJsonl(OUT, rows);

const withPlans = rows.filter((r) => r.plans.length).length;
const totalPlans = rows.reduce((n, r) => n + r.plans.length, 0);
console.log(`\n\n${rows.length} products scraped -> ${OUT}`);
console.log(`with at least one plan: ${withPlans}   plans total: ${totalPlans}   failed: ${failures.length}`);
if (failures.length) {
  console.log("\nfailures (re-run to retry):");
  failures.slice(0, 20).forEach((f) => console.log(`  ${f.id}: ${f.error}`));
}
