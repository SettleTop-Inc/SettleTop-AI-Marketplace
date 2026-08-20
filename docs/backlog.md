# Backlog

Ranked. The top three are what stand between this and a defensible public MVP.

## 1. First build and deploy

`next build` has never run against this code — the authoring environment had no
npm access. Run `npm install && npm run typecheck && npm run build`, push, and
confirm the Vercel deployment renders the 140 agents and that a passport opens.

What *has* been verified, so you know where to look and where not to:

- **Type-checked with the real compiler**, using ambient stubs for `next`,
  `react` and `@supabase/supabase-js`. Zero errors in our own code. This
  covers property access against `lib/types.ts`, arity, typos and imports. It
  does not cover the real package type signatures.
- **`PassportView` server-rendered** with `react-dom/server` against two real
  rows pulled from Supabase — a bare listing and an attested one — and
  screenshotted against `globals.css`. It renders, matches the mock, and threw
  nothing. That run is what caught the Graph evidence bug now fixed in
  `20260816172429`.
- **Every field in `lib/types.ts` confirmed to exist** in its view, by diffing
  against `information_schema`. No silent `undefined` at runtime.

Not verified: `LandingApp` has never executed (client component, needs a real
React runtime), Next's routing and metadata have never run, and no page has been
built or server-rendered as a Next route. Expect small things — a React 19
`params` signature, an eslint unescaped-entity rule — not structural problems.

## 2. Capture template 2.0 with `cert_detail.full_text`

The capture skill needs to carry the certification page's full text so the
honesty gate can verify values that page states. Today 14 stated values across
12 assets are correctly rejected purely because the text they came from was not
stored. See `docs/capture-integration.md`.

This also closes the loop on `capture.raw`: once 2.0 is live, every new capture
stores its own source, and extraction can be re-run without re-scraping.

**Done for the Microsoft harvester** by `scripts/harvest-certification.mjs`,
which reads all 219 certification pages and lands their text. Two things it
learned that the rest of this item should absorb:

- `cert_detail.full_text` is read by nothing. It is absent from `hay_cert` and
  has no column in `capture_extract`, so a value placed only there verifies
  nothing. The haystack is `hosting + data_location + data_handling +
  graph_permissions + compliance`, and **`data_handling` is the field that has
  to carry the page's prose**.
- `capture.raw` comes from `payload.raw` alone, never from `extract`. The
  harvester adds the certification record there so the text is actually stored.

Measured against the 14 rejected values, all of which are Microsoft listings
with a certification page: **9 of the 14 now sit inside `hay_cert`** and would
verify if proposed again. `Aws` on WA200004554 is one of them, and it verifies
only because the cloud provider answer is carried in `data_handling`.

The other 5 are on the page but outside the zones `data_handling` carries: four
are inside "Core functionality of the app" and one inside the authentication
library question. Widening a field the passport displays as data handling to
take in an app's functional description is a product decision, not a parser
one, so it was left alone.

None of the 14 changes on its own: they sit on captures already written, and
nothing re-evaluates a stored capture. They verify when a capture proposes them
again.

## 3. Logos: run the pass, then the archiver

All 140 assets read `no_logo_identified` in `v_logo_status`. Two halves, in order:

1. The capture worker's **logo pass** (`LOGO PASS` in the capture skill) visits
   each listing and calls `set_capture_logo(product_id, url)`. Only a live DOM
   can say which image is the logo — the old template dumped logos and
   screenshots into one bucket, and only 87 of 521 stored URLs are even
   identifiable as an icon by filename.
2. `node scripts/archive-logos.mjs` fetches the bytes, stores them in the
   `logos` Supabase Storage bucket, and records a sha256 so a later re-fetch can
   prove the publisher swapped the image.

Needs `catalogartifact.azureedge.net` and `store-images.s-microsoft.com` on the
network allowlist for whatever runs the archiver.

Until both halves run, the UI shows initials. That is deliberate: `AgentLogo`
renders only our archived copy and never hotlinks a publisher CDN, because a
hotlinked image can be swapped or deleted under us and cannot be hashed.

## 4. Make change history visible

`listing_change` is populated on every re-capture and nothing in the UI shows it.
This is the product's differentiator sitting unused. Minimum: a "What changed"
strip on the passport, and a `/changes` feed page reading `v_asset_change_feed`.

Nothing here shows up until assets are captured a second time, so it lands
naturally alongside the next sweep.

---

## 4. Move filtering into the query

The card list ships whole and filters in the browser, which is right at 140 rows
and wrong at 5,000. `v_registry_card` already carries every filter column and
`capture_extract.search` is a GIN-indexed tsvector. Switch when the payload
crosses roughly a megabyte.

## 5. Real full-text search

The browser filter is substring matching over a concatenated blob. Postgres
already has the proper index; wiring `websearch_to_tsquery` gives stemming,
phrase search and ranking.

## 6. Evidence cross-cutting views

The normalized `capture_evidence` table makes questions possible that no other
registry can answer: who uses Model Context Protocol, which agents name a model
at all, which certified apps request the widest Graph scope. None are surfaced
yet. An `/evidence/[kind]/[value]` page would be cheap and would demonstrate the
whole point of the schema.

## 7. Vendor claim flow

The "For vendors" modal describes a four-step flow that does not exist. Needs
Supabase Auth, a `vendor_claim` table, RLS on writes, and an approval path.
Deliberately out of the read-only MVP.

## 8. More marketplaces

`marketplace` is a table and `asset` is keyed by `(marketplace_id,
source_product_id)`, so a second source needs no schema change — only a capture
procedure and a `registry_delivery()` branch for its surface vocabulary.

## 9. Public registry API

`v_registry_card` and `v_asset_passport` are already reachable through PostgREST
with the publishable key. Making that a supported product surface means
versioning, documentation and rate limits.

---

## Known data issues

- **Xero (`WA200011459`)** — the stored capture's certification text describes
  Yealink Space, not Xero. Nothing was derived from it, so no false claim
  reached the registry, but the listing needs re-capturing.
- **140 backfilled rows have `capture.raw = NULL`.** They came from the
  pre-Supabase index, which is recorded honestly in `capture.ingest_source =
  'backfill'`. They cannot be re-derived from source until re-captured.
- **Mojibake in some captured text** (`ð`, U+FFFD) is present in the source
  listings themselves and was preserved deliberately rather than "corrected".
  Do not clean it — it is what the marketplace publishes.
