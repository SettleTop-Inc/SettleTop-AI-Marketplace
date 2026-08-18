# DRAI source: verified facts and design decisions

Everything here was read off the live site, not inherited. Where a value is our
classification rather than something DRAI publishes, it says so — that
distinction is the whole point of the file.

Written while building the multi-source harvester. The adapter should be
implemented from this, not from memory of the capture skill: several of the
skill's values turned out to be constructions, and one is contradicted by the
site.

## How the site is read

Plain `fetch` with a Chrome UA. **No browser, no Playwright, no WebFetch.** DRAI
is a Wix site that server-renders: the platform page carries all 14 `/post/`
links in raw HTML, and post bodies including their TL;DR are present.

`wix-warmup-data` exists but **does not carry page content** — only a
contact-form definition and a compId→type map. Grepping it for agent names
returns nothing. Markup parsing is the only path. Do not build a warmup-data
reader for this source.

## Extraction traps, all confirmed on the live page

These are the things that make a naive scraper quietly wrong rather than
loudly broken:

- **The GovCon module heading is a styled `<p>`, not `<h3>`.** Selecting module
  headings with `h1..h6` silently drops the largest module — 12 of 34 agents.
- **Four different name/description separators on one page**: hyphen-minus +
  NBSP, en dash, em dash, and double ASCII hyphen. Split on a run of dash
  characters, never on one specific character.
- **Each `<li>` wraps a `<p>`.** A selector matching both double-counts every
  agent.
- **The agent name is the FIRST bold span only.** Some rows carry several —
  `Defense TechScout Agent` has four, because its description bolds `Pre-seed`,
  `Seed` and `Series A+`.
- **A `/post/` link in a module section is not necessarily an agent.** The
  GovCon tagline links to the Secure Workspace launch post; treating every post
  link as an agent invents a phantom.
- **The Financial section's list lead-in says "The GovCon module"** — a
  publisher copy-paste error. Never identify a module from the lead-in.
- **The "Recent Posts" sidebar is inside the article markup.** A naive body
  extraction pulls unrelated post titles into `overview_text`, and it is what
  produced a false "Tier" match during recon. It also names posts the platform
  page never links, which is why the press-room sweep is a real stage and not
  belt-and-braces.

## Register shape

34 named agents across 3 modules — 12 GovCon Growth, 10 Financial, 12 Gov
Acquisition. 14 post links resolving to 13 distinct URLs, all HTTP 200. 20
agents are named with a description and no post.

`Trusted Advisor Agent` is listed under both GovCon and Financial with the
**same** post URL but **different** description text. One asset, both module
names in `categories`, 33 distinct slugs from 34 rows.

## Compliance: store the sentence, not a label

The statement's section 4 is headed **"Compliance Roadmap"** and opens
**"Simple: We're building toward higher compliance."** Of its five lines, two
are present tense, two are explicitly future, and one is a customer obligation:

| line | reading |
|---|---|
| `CMMC Level 1: Aligned with DoD's final CMMC rule…` | current |
| `AI Security: Practices align with NIST AI Risk Management Framework (RMF).` | current |
| `CMMC Level 2: …planned for Q2 2026; …targeted by Q4 2026.` | roadmap |
| `SOC 2, HIPAA, & ISO 27001: Gap assessments to be conducted…` | roadmap |
| `Export Controls: Customers must comply with all applicable ITAR/EAR laws.` | customer obligation, not a DRAI posture |

**Decision: `cert_detail.compliance` holds DRAI's full sentences verbatim, not
distilled labels.** A bare `"CMMC Level 1"` on a registry card reads as
*certified*; the source sentence says *aligned with, including documented
exceptions and compensating controls*. DRAI hedged carefully and the registry
must not flatten the hedge. Storing the sentence also satisfies the evidence
gate, which compares verbatim.

The roadmap and obligation lines stay out of the array and remain in
`cert_detail.full_text`, which is stored whole.

## Pricing: only where the listing says so

The skill puts the same four-tier `plans` array on every DRAI capture. The site
contradicts this:

- **Opp Shredder's** post states it integrates into **Tier 1, Tier 2 and Tier 3**
  — not Tier 0.
- **GovEntity Dossier's** article states no tier at all.

So tier membership varies per agent and is often simply absent. `plans` is
populated only where the post states membership; `pricing` is null otherwise.
The full tier table belongs to the Secure Workspace asset, where it is actually
published.

Tier names carry an **en dash**, not a hyphen: `Tier 0 – Essentials`,
`Tier 1 – Pipeline Edge`, `Tier 2 – Growth Accelerator`, `Tier 3 – Hyperscaler`,
at `$1,499/mo`, `$3,999/mo`, `$9,999/mo`, `$29,999/mo`.

## Verified, having previously been assumed

- All four legal URLs return 200.
- `corey@product-ties.com` is genuinely on the pages.
- `Data Room AI (DRAI)` appears on agent posts.
- There is no review or rating system. The `review` matches were agent names
  (`Color Team Reviewer Agent`) and the phrase "review time".

## Ours, not DRAI's — never put these in `stated`

`surfaces`, `industries`, `delivery` and the slug are **our classification**.
The site publishes none of them. They are legitimate registry fields, the same
way `function_category` is derived for Microsoft, but they are not publisher
claims and must never enter the evidence block. The gate enforces this
structurally by only verifying against `name`, `tagline`, `overview_text`,
`works_with` and the five `cert_detail` fields.

`rating` is null and always will be, and that is a fact about the marketplace
rather than a gap in the record: DRAI has no review system to be unused.
