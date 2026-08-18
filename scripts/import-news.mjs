/**
 * Import the news article bodies from settletop.com into this repo.
 *
 *   node scripts/import-news.mjs
 *
 * Re-runnable: it overwrites what it finds. The slug list is read out of
 * lib/site-content.ts rather than re-scraped, so the index and the articles
 * cannot disagree about which pieces exist.
 *
 * Only the body is imported. Title, date and categories already live in
 * site-content.ts and stay the single source for those.
 *
 * The markup is rebuilt from an allowlist rather than copied. Squarespace
 * wraps its content in ids, data attributes and inline styles that mean
 * nothing here, and pasting a remote page's raw HTML into a React render is
 * how you inherit somebody else's script tag.
 */
import { chromium } from "playwright";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const BASE = "https://www.settletop.com/news";
const OUT = "content/news";
const IMG_OUT = "public/news";

const src = await readFile("lib/site-content.ts", "utf8");
const slugs = [...src.matchAll(/^\s{4}slug:\s*"([^"]+)",$/gm)].map((m) => m[1]);
if (slugs.length === 0) {
  console.error("No slugs found in lib/site-content.ts — has NEWS moved?");
  process.exit(1);
}
console.log(`${slugs.length} articles to import\n`);

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });

/** Runs in the page. Rebuilds the body from an allowlist of semantic tags,
 *  dropping every attribute except href on links and src/alt on images. */
const EXTRACT = () => {
  const root =
    document.querySelector(".sqs-html-content") ||
    document.querySelector("article") ||
    document.querySelector("main");
  if (!root) return null;

  const KEEP = new Set([
    "P", "H2", "H3", "H4", "UL", "OL", "LI",
    "STRONG", "EM", "A", "BLOCKQUOTE", "BR", "IMG", "CODE", "PRE",
  ]);

  const clean = (node) => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return "";
    const tag = node.tagName;
    const inner = [...node.childNodes].map(clean).join("");

    if (!KEEP.has(tag)) return inner; // unwrap, keep the text
    if (tag === "BR") return "<br />";
    if (tag === "IMG") {
      const s = node.currentSrc || node.getAttribute("src") || "";
      if (!s) return "";
      const alt = (node.getAttribute("alt") || "").replace(/"/g, "&quot;");
      return `<img src="${s}" alt="${alt}" />`;
    }
    if (!inner.trim() && tag !== "IMG") return "";
    if (tag === "A") {
      const href = node.getAttribute("href") || "";
      if (!href) return inner;
      return `<a href="${href}">${inner}</a>`;
    }
    return `<${tag.toLowerCase()}>${inner}</${tag.toLowerCase()}>`;
  };

  return [...root.childNodes].map(clean).join("\n").trim();
};

let imported = 0;
const missing = [];

for (const slug of slugs) {
  const url = `${BASE}/${slug}`;
  const res = await page.goto(url, { waitUntil: "domcontentloaded" });
  if (!res || res.status() >= 400) {
    missing.push(`${slug} (HTTP ${res ? res.status() : "no response"})`);
    continue;
  }
  await page.waitForTimeout(700);

  let html = await page.evaluate(EXTRACT);
  if (!html || html.replace(/<[^>]+>/g, "").trim().length < 120) {
    missing.push(`${slug} (body too short to be real)`);
    continue;
  }

  // Squarespace authors most subheadings as a bold paragraph, which leaves
  // four of these articles with no heading outline at all — nothing for a
  // screen reader to navigate by. A paragraph whose entire content is one
  // short bold run, with no terminal full stop, is a heading in everything
  // but tag name; promote it. The length and punctuation guards keep genuine
  // bold-led sentences (e.g. "Components: describes the inventory of ...")
  // as paragraphs.
  html = html.replace(
    /<p><strong>([^<]{3,90})<\/strong><\/p>/g,
    (whole, text) => (text.trim().endsWith(".") ? whole : `<h3>${text.trim()}</h3>`)
  );

  // Pull remote images local so the site does not depend on the old CDN.
  const remote = [...html.matchAll(/<img src="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  if (remote.length) await mkdir(path.join(IMG_OUT, slug), { recursive: true });
  let n = 0;
  for (const r of remote) {
    n += 1;
    const ext = (r.split("?")[0].match(/\.(png|jpe?g|gif|webp|svg)$/i) || [".jpg"])[0];
    const local = `${IMG_OUT}/${slug}/${n}${ext}`;
    if (!existsSync(local)) {
      const buf = await page.request.get(r).then((x) => x.body());
      await writeFile(local, buf);
    }
    html = html.split(r).join(`/news/${slug}/${n}${ext}`);
  }

  // Site-relative links keep working; anything else stays absolute.
  html = html.replace(/href="\/(?!\/)/g, 'href="https://www.settletop.com/');

  await writeFile(path.join(OUT, `${slug}.html`), html + "\n", "utf8");
  const words = html.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
  console.log(`  ${String(words).padStart(5)} words  ${remote.length ? `${remote.length} img  ` : "       "}${slug}`);
  imported += 1;
}

await browser.close();

console.log(`\nimported ${imported}/${slugs.length}`);
if (missing.length) {
  console.log("not imported:");
  for (const m of missing) console.log(`  - ${m}`);
  process.exitCode = 1;
}
