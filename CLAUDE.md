# SettleTop AI Registry

A provenance registry for AI agents. Not a catalogue, not a directory — the
product is knowing **what is behind an agent, and what changed.**

Anyone can list what is in a marketplace today. The thing only this registry
can say is "this agent quietly dropped its data-residency claim on the 12th,
grew its Graph permission scope, and re-priced." Every design decision below
serves that, and several will look like over-engineering until you remember it.

---

## The rules that are not negotiable

These are the product. Breaking one of them does more damage than any outage,
because a registry that guesses is worse than no registry.

1. **Unknown means Unknown.** If a source does not state something, the answer
   is the literal string `Unknown`. Never infer it from a neighbouring field,
   never substitute a sensible default, never leave a blank that reads as zero.
   A Teams app is not "integrates with Microsoft Teams" unless the listing says
   so.

2. **Every stated build fact must be verbatim.** A model, framework, tool, data
   source or deployment target may only be recorded if that exact string
   appears, character for character, in that capture's own text. This is
   enforced in the database by `ingest_capture()`, not by convention — see
   "The honesty gate" below. Do not add a bypass. Do not "fix" casing.

3. **Captures are immutable.** A row in `capture` is an observation at a moment.
   Never update one, never delete one. Corrections arrive as a new capture.

4. **Derived values have exactly one definition.** Reach, evidence risk,
   delivery, price band and use-case classification are computed by SQL
   functions in `supabase/migrations/*_registry_derivation.sql`. The site reads
   them; it does not recompute them. If you need to change a rule, change the
   function so every consumer moves together.

5. **Evidence risk is not a security rating.** It measures how much of the build
   you cannot see before you deploy. Never present it as a safety score, and
   keep the explanatory footnote on the passport.

6. **Never re-capture what is already captured** unless a listing genuinely
   changed. The Drive archive and the `capture` table are the record of what was
   seen and when; re-scraping to "refresh" destroys the timeline.

7. **A URL is not a capture.** Pointing at someone else's CDN is not holding
   something: it rots, it can be swapped silently, and it cannot be hashed. An
   image counts as captured only once `capture_link.archived_url` and
   `content_hash` are set. `v_logo_status` exists so this gap is queryable
   rather than invisible — which is exactly how it went unnoticed the first
   time, when 521 image URLs were stored and zero images were.

---

## Architecture in one pass

```
Microsoft Marketplace
        │  Claude for Chrome, driven by the capture skill
        ▼
  capture JSON (template v2.0, carries its own verified extract)
        │
        ├──► Google Drive        the durable archive, written first
        │
        └──► ingest_capture()    Supabase RPC, the only write path
                    │
                    ▼
        asset ─ capture ─ capture_extract
                   ├─ capture_evidence   (verified build facts)
                   ├─ capture_plan / _link / _permission / _compliance
                   └─ asset_change       (what moved since last time)
                    │
                    ▼
        v_registry_card / v_asset_passport / v_asset_change_feed
                    │
                    ▼
             Next.js App Router → Vercel
```

| Path | What lives there |
|---|---|
| `app/` | App Router pages. `page.tsx` is the marketing landing page, `registry/` is the browsing tool with facets, sort, pagination and compare, `agent/[id]` is a shareable passport |
| `components/` | `LandingApp` is the marketing page at `/`, `registry/RegistryApp` is the browsing tool at `/registry`, `AgentCard` is shared by both, `PassportView` is the passport body shared by modal and page |
| `lib/` | `registry.ts` every read, `present.ts` display rules, `types.ts` view row shapes |
| `scripts/ingest.mjs` | Reconcile ingest, the safety net behind dual write |
| `supabase/migrations/` | Applied schema, byte-identical to the live database |
| `docs/` | Runbooks and the backlog |

---

## The honesty gate

`ingest_capture()` re-derives, from the capture's own text, whether each stated
value is real:

```
hay_listing = name + tagline + overview_text + works_with
hay_cert    = cert hosting + data location + data handling + permissions + compliance
```

A value found in `hay_listing` is stored `source = 'listing'`. Found only in
`hay_cert`, it is `source = 'certification'`. Found in neither, it is stored
with `verified = false` and **the public views never show it**. The row is kept
deliberately — an unverified row is a bug report about the capture, not a claim.

This lives in the database on purpose. A careless caller, a future script, or an
over-eager model cannot introduce a claim the source does not make.

To see what is currently rejected:

```sql
select a.source_product_id, e.kind, e.value
  from capture_evidence e
  join capture c on c.id = e.capture_id
  join asset a on a.id = c.asset_id
 where not e.verified;
```

**One exception, and it is a real one.** A certification page that names
Microsoft Graph permission scopes *is* first-party evidence of Graph use, even
though the words "Microsoft Graph" may not appear in any text we stored. That
inference is licensed by the permission list itself, so it is enforced as a
database invariant — a trigger on `capture_permission` guarantees any capture
holding a Graph scope also carries verified Graph tool evidence. It upgrades an
existing unverified row rather than deferring to it, which is the bug that
originally hid Tools / MCP behind `Unknown` on 26 attested apps.

**Known gap:** the pre-Supabase backfill did not carry the full certification
page text, only the parsed hosting / residency / permissions / compliance
fields. So 14 values across 12 assets that were genuinely stated on a
certification page cannot be verified against what we stored, and correctly show
as unverified. Capture template v2.0 adds `cert_detail.full_text`, so these
self-heal the next time each listing is captured. Do not paper over this by
relaxing the gate.

---

## Working on this

```bash
npm install
cp .env.example .env.local     # then fill nothing — the two public values are already correct
npm run dev
npm run typecheck              # do this before every commit
npm run build
```

`SUPABASE_SERVICE_ROLE_KEY` is only needed for `scripts/ingest.mjs`. It must
never appear in a `NEXT_PUBLIC_` variable, in a client component, or in a
commit.

Schema changes go through migrations, never through the dashboard:

```bash
supabase migration new some_change   # writes supabase/migrations/<ts>_some_change.sql
```

The GitHub → Supabase integration applies them on push. The existing files carry
the version timestamps already recorded in `supabase_migrations.schema_migrations`,
so they are skipped rather than re-run.

---

## Things that will bite you

- **`array_to_string` is STABLE, not IMMUTABLE.** It cannot appear in a
  generated column. Use `immutable_array_text()`. Same reason `to_tsvector`
  needs the explicit `'english'::regconfig` overload.
- **Postgres regex uses `\y` for a word boundary.** `\b` is a backspace. The
  use-case classifier depends on this.
- **`pgcrypto` lives in the `extensions` schema on Supabase.** `ingest_capture`
  pins `search_path`; content hashing uses the builtin `sha256()` to avoid the
  dependency entirely.
- **Collation.** `order by text` is not byte order. Use `collate "C"` when
  comparing checksums or aggregates against anything computed outside Postgres,
  or fingerprints will differ on ordering alone while the data is identical.
- **The use-case classifier reads name, tagline and categories only.**
  `industries` says who *buys* an agent, not what it *does*; matching on it put
  a graph database into Finance because it is sold to banks. Leave it out.

---

## Where the design came from

`styles.css` is the original design and ships unchanged — treat it as a fixed
constraint, not a starting point. The React components reproduce the markup the
mock produced; if you restyle, change the components, not the stylesheet.

The capture side lives outside this repo, in the `settletop-marketplace-capture`
skill and its Drive archive. `docs/capture-integration.md` explains the contract
between them.
