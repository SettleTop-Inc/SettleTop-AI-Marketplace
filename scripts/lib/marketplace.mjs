/**
 * Shared harvest helpers — everything true of any source.
 *
 * What lives here: fetching with backoff, bounded concurrency, jsonl, the
 * Supabase calls, and the embedded-state extractor. What does not: any URL,
 * any page shape, any field mapping. Those belong to a source adapter under
 * lib/sources, because they are the only things that actually differ between
 * marketplaces.
 *
 * The storefronts this reads are server-rendered and embed their whole payload
 * as JSON in the page — Microsoft as window.__INITIAL_STATE__, DRAI as Wix
 * warmup data. Same trick, different marker, so extractState takes the marker
 * as a parameter. That is why almost nothing here needs a browser: only
 * Microsoft plan pricing does, because it exists solely in React state after
 * hydration.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

const MS_STATE_MARKER = /__INITIAL_STATE__\s*=\s*/;

/**
 * Pull an embedded JSON blob out of a server-rendered page, given the marker that
 * precedes it. Microsoft ships window.__INITIAL_STATE__; other server-rendered
 * storefronts ship the same idea under a different name, so the marker is a
 * parameter and the brace-matching walk below is shared.
 */
export function extractState(html, marker = MS_STATE_MARKER) {
  const m = html.match(marker);
  if (!m) return null;
  const start = html.indexOf("{", m.index + m[0].length);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export async function fetchState(url, { retries = 3, parse = extractState } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
      });
      // 403 belongs with the retryable statuses, not the fatal ones. Nothing
      // here is authenticated, and the same URL succeeds on a later attempt —
      // it is how this storefront sheds load. Treating it as fatal is why the
      // detail pass used to need repeated whole-script runs to converge.
      if (res.status === 403 || res.status === 429 || res.status >= 500) {
        throw new Error(`http ${res.status}`);
      }
      if (!res.ok) return { ok: false, status: res.status, state: null };
      const state = parse(await res.text());
      if (!state) throw new Error("no embedded state in response");
      return { ok: true, status: res.status, state };
    } catch (e) {
      lastErr = e;
      // back off: the marketplace throttles bursts rather than blocking
      await sleep(400 * Math.pow(2, attempt) + Math.random() * 250);
    }
  }
  return { ok: false, status: 0, state: null, error: lastErr?.message };
}

/**
 * Fetch a page as text, with the same backoff and the same user agent.
 *
 * fetchState is for the storefronts that embed their payload as JSON. Some of
 * what a source must read is ordinary server-rendered HTML instead, and the
 * fetching part of that is no different: same UA, same throttle handling, same
 * refusal to treat a 403 as fatal.
 *
 * Redirects are followed, and the URL that answered is returned. A source that
 * enters through a redirector needs to record where it actually landed, or its
 * provenance points at a forwarding address rather than at the page read.
 *
 * A 4xx other than 403 comes straight back without retrying: the page is not
 * there, and asking again more slowly will not conjure it.
 */
export async function fetchText(url, { retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
        redirect: "follow",
      });
      if (res.status === 403 || res.status === 429 || res.status >= 500) {
        throw new Error(`http ${res.status}`);
      }
      if (!res.ok) return { ok: false, status: res.status, url: res.url, html: null };
      return { ok: true, status: res.status, url: res.url, html: await res.text() };
    } catch (e) {
      lastErr = e;
      await sleep(400 * Math.pow(2, attempt) + Math.random() * 250);
    }
  }
  return { ok: false, status: 0, url, html: null, error: lastErr?.message };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `worker` over `items` with bounded concurrency, reporting progress. */
export async function pool(items, concurrency, worker, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        results[i] = { error: e.message };
      }
      done++;
      if (onProgress && done % 25 === 0) onProgress(done, items.length);
    }
  });
  await Promise.all(runners);
  if (onProgress) onProgress(done, items.length);
  return results;
}

// ---------------------------------------------------------------- files ----

export async function writeJsonl(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

export async function readJsonl(path) {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** HTML description to plain text, preserving paragraph and list structure. */
export function htmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|h[1-6]|tr)\s*>/gi, "\n\n")
    .replace(/<\s*li[^>]*>/gi, "\n* ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// -------------------------------------------------------------- supabase ----

export function supabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  return { url, key, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" } };
}

export async function rpc(env, fn, body) {
  const res = await fetch(`${env.url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: env.headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ------------------------------------------------------------- data paths ----

/**
 * Where a source's harvest files live: data/{sourceId}/{name}.
 *
 * The files used to sit flat in data/ because there was only ever one source.
 * A second one makes the flat layout ambiguous — two sources both want a
 * tiles.jsonl, and joining them by bare id across sources would silently mix
 * catalogues, since nothing in an id says which marketplace it came from.
 */
export function dataPath(sourceId, name) {
  return `data/${sourceId}/${name}`;
}
