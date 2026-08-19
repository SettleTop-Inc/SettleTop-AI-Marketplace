# SettleTop AI Registry

A provenance registry for AI agents. It answers two questions a marketplace
listing will not: **what is this agent actually built from**, and **what changed
since last time**.

Every record traces to a captured observation of a public listing. Where a
source states nothing, the registry says `Unknown` — it does not guess, and it
does not let anything else guess on its behalf.

## Stack

- **Next.js** App Router on **Vercel**
- **Supabase** Postgres — immutable captures, derived current state, change events
- Capture by Claude for Chrome, archived to Google Drive, dual-written to Supabase

## Quick start

```bash
npm install
cp .env.example .env.local
npm run dev
```

## Where to look

| | |
|---|---|
| `CLAUDE.md` | How this project thinks, and the rules that are not negotiable |
| `docs/capture-integration.md` | The contract between the scraper and the registry |
| `docs/runbooks.md` | Deploy, migrate, ingest, health checks |
| `docs/backlog.md` | What is next, ranked, plus known data issues |

## Status

140 agents captured from the Microsoft Marketplace, every stated build fact
verified verbatim against its own source. The app has not been built or deployed
yet — see backlog item 1.
