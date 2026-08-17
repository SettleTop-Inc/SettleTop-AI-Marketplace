/**
 * Capture UI screenshots for the product pages.
 *
 * These are real screens from a running instance, not mockups — which is the
 * point: the product page should show what the product actually looks like.
 * Re-run it whenever the UI moves on:
 *
 *   node scripts/capture-product-shots.mjs
 *
 * Needs the target app running. CodeRoot Open Source is a local stack; see
 * that repo's README (docker compose up, then `npm run dev` in web/).
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const OUT = "public/product/coderoot-open-source";

/** Wide enough that the sidebar and the content column both breathe. */
const VIEWPORT = { width: 1600, height: 1000 };

const SHOTS = [
  { slug: "overview", path: "/", label: "SBOM overview" },
  { slug: "components", path: "/components", label: "Component inventory" },
  { slug: "repositories", path: "/repos", label: "Resolved repositories" },
  { slug: "triage", path: "/triage", label: "Triage queue" },
  { slug: "geography", path: "/geography", label: "Contributor geography" },
];

const BASE = process.env.CODEROOT_OSS_URL ?? "http://localhost:3100";

const reachable = async () => {
  try {
    const r = await fetch(BASE, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch {
    return false;
  }
};

if (!(await reachable())) {
  console.error(
    `Cannot reach ${BASE}. Start CodeRoot Open Source first, or set CODEROOT_OSS_URL.`
  );
  process.exit(1);
}

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: VIEWPORT,
  deviceScaleFactor: 2, // retina-sharp when displayed at half size
});

for (const shot of SHOTS) {
  await page.goto(`${BASE}${shot.path}`, { waitUntil: "networkidle" });
  // The tables render from a client fetch; networkidle lands before the rows
  // paint on a cold cache.
  await page.waitForTimeout(1200);
  const file = `${OUT}/${shot.slug}.png`;
  await page.screenshot({ path: file });
  console.log(`${shot.label.padEnd(24)} -> ${file}`);
}

await browser.close();
