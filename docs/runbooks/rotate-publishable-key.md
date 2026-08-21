# Rotate the Supabase publishable key

The current publishable key is already in git history and in shipped browser
bundles from before Access Foundation Phase A. Renaming the env var to
`SUPABASE_PUBLISHABLE_KEY` and moving it server-only (Task 1) stops the key
from being inlined into any new bundle, but it does not invalidate the key
value itself. Rotation is the step that does: it issues a new key and revokes
the old one, so the copy sitting in history and in old bundles stops working.

This is a production operations step, done by the maintainer, sequenced
after the code that reads the server-only key is live. Do not run it early:
steps 3 through 6 assume the deployed app already reads
`SUPABASE_PUBLISHABLE_KEY` from the server, not `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
from the browser.

**The rule that applies to every step below:** never re-add the key with a
`NEXT_PUBLIC_` prefix. `NEXT_PUBLIC_SUPABASE_URL` stays public and prefixed,
because it is not a secret. The publishable key is not the URL: it is the
credential, and it stays server-only from here on.

## Sequence

- [ ] **Step 1: Set `SUPABASE_PUBLISHABLE_KEY` in Vercel, before merging Phase A**

  In the Vercel project, Settings -> Environment Variables, set
  `SUPABASE_PUBLISHABLE_KEY` to the current key value, for all environments
  (Production, Preview, and Development). Keep `NEXT_PUBLIC_SUPABASE_URL` as
  it is; it is not part of this rotation. Do this before merging Phase A, so
  the first deploy that reads the renamed variable does not fail with a
  missing-env error.

- [ ] **Step 2: Merge and deploy Phase A**

  Merge the Phase A branch and let Vercel build and deploy it. Confirm the
  site reads (registry list and an agent passport both load data), then run
  `npm run check:bundle` manually against the deployed build's output.
  `check:bundle` is not wired into `next build` or into any CI workflow
  (`vercel.json` runs only `next build`), so it does not run on its own; you
  have to invoke it. It is a backstop, not the primary defense: the
  `server-only` import on the module that reads `SUPABASE_PUBLISHABLE_KEY`
  already fails the Vercel build outright if that key is ever pulled into
  client code. Treat the manual grep as confirmation, not as the thing
  standing between you and a leaked key.

- [ ] **Step 3: Apply the rate-limit migration**

  Apply `supabase/migrations/20260821140000_rate_limit.sql` to the live
  database (Task 3 Step 6: via the Supabase MCP `apply_migration`, using the
  exact bytes as committed). Confirm `rate_take` exists and is granted to
  `anon` via a catalog check. The limiter fails open until this migration is
  live, which is expected and safe, but it means the 429 behavior described
  in Phase A's Definition of Done is not real until this step runs.

- [ ] **Step 4: Issue a new publishable key and redeploy**

  In the Supabase dashboard, Project Settings -> API, issue a new
  publishable key. Set it as `SUPABASE_PUBLISHABLE_KEY` in Vercel (all
  environments), then redeploy. Confirm the site still reads with the new
  key in place before moving on.

- [ ] **Step 5: Revoke the old publishable key and verify it is dead**

  In the Supabase dashboard, revoke the old publishable key. Verify a direct
  PostgREST call made with the old key returns `401`, for example:

  ```bash
  curl -i "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/asset?select=id&limit=1" \
    -H "apikey: <old key>" \
    -H "authorization: Bearer <old key>"
  ```

  A `401` confirms the key that leaked into pre-Phase-A bundles and git
  history no longer works, even though it can still be found there.

- [ ] **Step 6: Remove the old browser-exposed variable from Vercel**

  Remove `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` from the Vercel project. It
  is unused once the app reads `SUPABASE_PUBLISHABLE_KEY` server-only; leaving
  it in place is a dead setting that invites someone to re-wire a client
  component to it later. Do not replace it with a new `NEXT_PUBLIC_`-prefixed
  variable: see the rule above.
