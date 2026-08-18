#!/usr/bin/env node
/**
 * DRAI pass 1 — enumerate the catalogue.
 *
 *   node scripts/drai-catalog.mjs
 *
 * Nothing like the Microsoft walk: there is no pagination, no result count and
 * no search. The whole catalogue is one page, so this is a single fetch plus a
 * press-room sweep for launch posts the platform page does not link.
 *
 * Writes data/drai/tiles.jsonl (agents with a catalog row, which become assets)
 * and data/drai/announced.jsonl (agents named only in a "coming soon" sentence,
 * which do not). Keeping them in separate files is the point: one is the
 * catalogue, the other is a watch list, and mixing them would put products DRAI
 * has not launched into the registry.
 */
import { writeJsonl, readJsonl, dataPath, sleep } from "./lib/marketplace.mjs";
import {
  ID, PLATFORM_URL, PRESS_URL, WORKSPACE_POST, WORKSPACE_SLUG,
  parsePlatform, parseComingSoon, parsePressRoom,
} from "./lib/sources/drai.mjs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const get = async (url) => {
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
};

const OUT = dataPath(ID, "tiles.jsonl");
const SOON_OUT = dataPath(ID, "announced.jsonl");

console.log("enumerating the DRAI Agentic-AI Marketplace\n");

const platform = await get(PLATFORM_URL);
const agents = parsePlatform(platform);
const announced = parseComingSoon(platform);

// The platform itself is an asset: it is the thing the tiers actually price,
// and the module descriptions live in its launch post rather than the catalog.
agents.unshift({
  slug: WORKSPACE_SLUG,
  name: "The DRAI Secure Workspace",
  modules: ["DRAI Platform"],
  description: "Mission-Grade Decision Infrastructure",
  post_url: WORKSPACE_POST,
  status: "posted",
  also_known_as: [],
});

console.log(`  platform : ${agents.length} agents with a catalog row`);
console.log(`             ${agents.filter((a) => a.status === "posted").length} posted, ${agents.filter((a) => a.status === "named_only").length} named only`);
console.log(`  announced: ${announced.length} "coming soon" sentence(s), kept verbatim as a watch list`);

// A post that exists is a listing whether or not the catalog points at it. The
// platform page demonstrably omits some — the Recent Posts sidebar names launch
// posts that appear nowhere in the three module lists.
await sleep(600);
const known = new Set(agents.map((a) => a.post_url).filter(Boolean));
let extra = 0;
try {
  for (const url of parsePressRoom(await get(PRESS_URL))) {
    if (known.has(url)) continue;
    // Enumerated, not invented: it has a post but no catalog row, so it has no
    // module and no description until the detail pass reads it.
    agents.push({
      slug: url.split("/post/")[1].replace(/^data-room-ai-launches-/, ""),
      name: null,
      modules: [],
      description: null,
      post_url: url,
      status: "posted",
      also_known_as: [],
      from_press_room: true,
    });
    known.add(url);
    extra++;
  }
  console.log(`  press    : ${extra} post(s) the platform page does not link`);
} catch (e) {
  // The press room is a supplement, not the catalogue. Losing it degrades
  // coverage; it must not fail the pass.
  console.error(`  press    : unavailable (${e.message}) — catalogue still written`);
}

const before = (await readJsonl(OUT)).length;
await writeJsonl(OUT, agents);
await writeJsonl(SOON_OUT, announced);

console.log(`\n${agents.length} agents -> ${OUT}${before ? `  (was ${before})` : ""}`);
console.log(`${announced.length} announced -> ${SOON_OUT}`);
if (!agents.length) process.exit(1);
