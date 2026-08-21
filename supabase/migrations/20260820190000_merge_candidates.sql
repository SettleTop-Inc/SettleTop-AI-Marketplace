-- Cross-marketplace duplicate DETECTION. Issue #64.
--
-- One real product is sometimes listed on more than one marketplace: Red Hat AI
-- Enterprise on Microsoft and on AWS, Kore.ai's "AI for Work" on both. The
-- registry's unit is the product, so those should become one asset with one
-- listing per marketplace. This file does NOT do that. It PROPOSES the pairs,
-- with the evidence for each, into a read-only queue a human confirms. Nothing
-- here merges anything, and nothing here mutates: merge_assets is #63, the
-- review UI is #65, and both consume this view rather than extend it.
--
-- Why a queue and not an automatic merge. Merging is a claim the registry makes
-- in its own voice, one no marketplace made: "these two pages are the same
-- product." A shared product NAME is not that claim. "Agentforce" is published
-- on AWS by Salesforce and "Agent Force" on Microsoft by XenonStack, same
-- normalised name, different companies, different products. So the name alone
-- can only ever be a LOW proposal, never a merge, and never high confidence.
--
-- The scope rule that makes the whole thing safe: a candidate pair must span two
-- DIFFERENT marketplaces. Two listings on the same marketplace are never
-- proposed, because "one product, one listing per marketplace" means a genuine
-- duplicate is by definition cross-marketplace. This also excludes families that
-- merely share a vendor within one marketplace, the n8n set being the standing
-- example: five Microsoft listings, five publishers, one product name lineage,
-- all intra-marketplace, none of which is ours to merge here.


-- registry_norm ---------------------------------------------------------------
--
-- The one normalisation, defined once and reused for both name and publisher:
-- lowercase, then drop everything that is not an ASCII letter or digit. That
-- collapses "Kore.ai, Inc." and "Kore.ai Inc" to the same koreaiinc, "Amdocs"
-- and "Amdocs " (a real trailing space in the data) to amdocs, and "Agent Force"
-- and "Agentforce" to agentforce. Unicode letters are dropped rather than folded,
-- which is fine because both sides of a pair get identical treatment; the value
-- is only ever compared to another value that went through this same function.
create or replace function registry_norm(p_text text)
returns text language sql immutable parallel safe as $$
  select regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]', '', 'g')
$$;

comment on function registry_norm(text) is
  'Lowercase and strip to ASCII alphanumerics. The single normalisation behind cross-marketplace name and publisher matching in v_merge_candidates. Never use on a value that will be displayed; it is a comparison key only.';

-- Pinned like every other registry function, so an unpinned search_path is not a
-- shadowing surface and the Supabase linter stays quiet.
alter function public.registry_norm(text) set search_path = pg_catalog, public;


-- v_merge_candidates ----------------------------------------------------------
--
-- One row per cross-marketplace candidate PAIR, with the evidence that put it
-- there and a confidence tier. It reads the current capture's extract for each
-- listing (name, publisher) and the current capture's stated links, joins listing
-- to listing across marketplaces on the normalised name, and scores the result.
--
-- Determinism. Each unordered pair must appear once, not twice, and always with
-- the same side as "a". The self-join keeps only pairs where a sorts strictly
-- below b by (marketplace_id, asset_id), which is a total order across the two
-- listings because their marketplace_ids already differ. So "a" is always the
-- lower marketplace/asset and the row is emitted exactly once.
--
-- The signals, weakest to strongest:
--   name match      the join key. Normalised names equal, and the normalised
--                   name at least 4 characters so a two-letter collision cannot
--                   seed a pair. Necessary, never sufficient.
--   publisher exact normalised publishers equal. koreaiinc = koreaiinc.
--   publisher prefix one normalised publisher is a prefix of the other, either
--                   direction, with the SHORTER at least 3 characters so "ai"
--                   cannot swallow "aitools". Catches "Kore.ai" vs "Kore.ai, Inc."
--                   (koreai / koreaiinc) and "PwC" vs "PwC (Global)" (pwc /
--                   pwcglobal). The name already matches, so even a 3-character
--                   prefix here is corroboration, not a lone claim.
--   link host       both listings link to the same external host, and that host
--                   is not a generic platform (see the denylist below). This is
--                   the STRONGEST signal, because a link is a value BOTH
--                   publishers independently stated, not an inference of ours.
--                   It lifts a name-only pair the publisher strings missed:
--                   Corvic AI ("Corvic AI" vs "Corvic, Inc.", neither a prefix of
--                   the other) and Kore.ai's "AI for Work" ("Kore.ai Software
--                   India Private Limited" vs "KoreaiAzureAgentMarketplace") both
--                   share a Kore.ai / Corvic host and are genuinely one product.
--
-- Confidence. HIGH when the name matches AND at least one corroborating signal
-- fires (publisher exact, publisher prefix, or a shared non-generic link host).
-- LOW when the name is all there is. A LOW row is still a real proposal for a
-- human; it is simply the tier that says "a shared name is not a shared product."
-- Agentforce/Agent Force lands here and stays here: different publishers, no
-- shared host.
--
-- The shared-link-host denylist. A shared host only corroborates when it belongs
-- to the publisher rather than to a platform everyone uses. In today's data no
-- generic host is ever the shared host of a name-matched cross-marketplace pair,
-- precisely because the name match already narrows the shared host to the
-- vendor's own domain; the denylist is defence for later data, where two
-- unrelated products of the same name might both link to github.com or a docs
-- host. Exact host is compared, not the registrable domain: reducing
-- docs.kore.ai and kore.ai to one domain would need a public-suffix list to be
-- correct across co.uk and friends, which is not worth a dependency for a signal
-- that already fires on the real pairs. The cost is a missed lift when the two
-- sides link to different subdomains, which is conservative and acceptable.

create or replace view v_merge_candidates
with (security_invoker = true) as
with listing_norm as (
  select
    l.asset_id,
    l.id            as listing_id,
    l.marketplace_id,
    l.current_capture_id,
    x.name,
    x.publisher,
    registry_norm(x.name)      as norm_name,
    registry_norm(x.publisher) as norm_publisher
  from listing l
  join asset a           on a.id = l.asset_id and a.merged_into is null
  join capture_extract x on x.capture_id = l.current_capture_id
),
-- Every non-generic external host each listing links to, from its current
-- capture's product and legal links. Distinct, so a listing that lists the same
-- host under several labels contributes it once.
listing_host as (
  select distinct
    l.id as listing_id,
    lower(regexp_replace(regexp_replace(regexp_replace(cl.url,
            '^https?://', ''), '^www\.', ''), '/.*$', '')) as host
  from listing l
  join capture_link cl on cl.capture_id = l.current_capture_id
  where cl.kind in ('product', 'legal')
    and cl.url ~* '^https?://'
),
pair as (
  select
    a.asset_id       as asset_id_a,
    b.asset_id       as asset_id_b,
    a.listing_id     as listing_id_a,
    b.listing_id     as listing_id_b,
    a.marketplace_id as marketplace_id_a,
    b.marketplace_id as marketplace_id_b,
    a.name           as name_a,
    b.name           as name_b,
    a.publisher      as publisher_a,
    b.publisher      as publisher_b,
    a.norm_name      as norm_name,
    a.norm_publisher as norm_publisher_a,
    b.norm_publisher as norm_publisher_b,
    (a.norm_publisher <> '' and a.norm_publisher = b.norm_publisher) as pub_exact,
    (a.norm_publisher <> '' and b.norm_publisher <> ''
       and a.norm_publisher <> b.norm_publisher
       and least(length(a.norm_publisher), length(b.norm_publisher)) >= 3
       and (b.norm_publisher like a.norm_publisher || '%'
         or a.norm_publisher like b.norm_publisher || '%')) as pub_prefix,
    (select ha.host
       from listing_host ha
       join listing_host hb on hb.host = ha.host and hb.listing_id = b.listing_id
      where ha.listing_id = a.listing_id
        and ha.host <> ''
        and ha.host <> all (array[
          'github.com','github.io','gitlab.com','bitbucket.org',
          'youtube.com','youtu.be','vimeo.com',
          'google.com','play.google.com','docs.google.com','drive.google.com',
          'sites.google.com','forms.gle','goo.gl',
          'apps.apple.com','microsoft.com','apps.microsoft.com',
          'aws.amazon.com','amazon.com','amazonaws.com','cloudfront.net',
          'azurewebsites.net','notion.so','notion.site','readthedocs.io',
          'readthedocs.org','gitbook.io','gitbook.com','medium.com',
          'linkedin.com','twitter.com','x.com','facebook.com','fb.com',
          'instagram.com','netlify.app','vercel.app','herokuapp.com',
          'wordpress.com','wixsite.com','webflow.io','gumroad.com',
          'substack.com','calendly.com','discord.com','discord.gg',
          'slack.com','t.me','wa.me'])
      order by ha.host
      limit 1) as shared_host
  from listing_norm a
  join listing_norm b
    on a.norm_name = b.norm_name
   and length(a.norm_name) >= 4
   and a.marketplace_id <> b.marketplace_id
   -- The pair key is (marketplace_id, asset_id), which emits each unordered pair
   -- once under today's strict one-listing-per-asset data. Once #63 lets an asset
   -- hold several listings, an asset pair could emit more than one row differing
   -- only in listing_id: #63 and #65 should revisit this key against the listing
   -- cardinality then, and dedupe to the asset pair if that is what the queue wants.
   and (a.marketplace_id, a.asset_id) < (b.marketplace_id, b.asset_id)
)
select
  asset_id_a, asset_id_b,
  listing_id_a, listing_id_b,
  marketplace_id_a, marketplace_id_b,
  name_a, name_b,
  publisher_a, publisher_b,
  norm_name,
  norm_publisher_a, norm_publisher_b,
  true                            as signal_name_match,
  pub_exact                       as signal_publisher_exact,
  pub_prefix                      as signal_publisher_prefix,
  (shared_host is not null)       as signal_link_host_shared,
  shared_host                     as shared_link_host,
  case
    when pub_exact or pub_prefix or shared_host is not null then 'high'
    else 'low'
  end                             as confidence
from pair;

comment on view v_merge_candidates is
  'Cross-marketplace duplicate CANDIDATES for human review (#64). One row per pair of listings on DIFFERENT marketplaces whose normalised names match, ordered so each pair appears once with side a the lower (marketplace_id, asset_id). Carries the evidence (normalised name, both publishers, which signals fired, the shared external link host if any) and a confidence tier: high when name plus a corroborating signal (publisher exact, publisher prefix, or shared non-generic link host), low when only the name matches. PROPOSES only; merges nothing and mutates nothing. merge_assets (#63) and the review UI (#65) consume it.';

grant select on public.v_merge_candidates to anon, authenticated;


-- The same tripwire the asset-keyed views carry, scoped to this one view: it
-- must keep its grants and it must be security_invoker, or a later drop-and-
-- recreate in the SQL editor could silently make it owner-run (RLS evaluated as
-- postgres) or ungranted (PostgREST answers [] and a caller cannot tell empty
-- from forbidden). Checking the outcome is cheaper than trusting the reasoning.
do $$
begin
  if not (has_table_privilege('anon', 'public.v_merge_candidates', 'SELECT')
      and has_table_privilege('authenticated', 'public.v_merge_candidates', 'SELECT')) then
    raise exception 'v_merge_candidates is missing its anon/authenticated select grant';
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'v_merge_candidates'
       and coalesce(c.reloptions, '{}') @> array['security_invoker=true']) then
    raise exception 'v_merge_candidates is not security_invoker, so RLS would run as the owner';
  end if;
end $$;
