-- Visibility gate (Access Foundation Phase B2). READ privileges only; the write
-- path and ingest_capture()'s evidence gate are untouched. Every anon/authenticated
-- read becomes a security-definer surface owned by postgres (rolbypassrls), and
-- direct base-table SELECT is revoked from both browser roles, so provenance depth
-- and capture.raw cannot leak through any invoker view. Anon reads the reduced
-- public passport; a signed-in JWT reads the full passport; only service_role
-- touches base tables directly.

-- Public passport: a PROJECTING definer view over v_asset_passport. It carries the
-- vendor's own facts plus the top-line verdict, and NONE of the evidence, per-layer
-- tracing, risk basis, permissions, compliance detail, or cross-marketplace linkage.
create or replace view public.v_asset_passport_public as
select
  asset_id, source_product_id, listing_url, marketplace_id, marketplace_name,
  name, publisher, tagline, overview_text,
  surfaces, categories, industries, works_with,
  pricing, acquire_using, support,
  listing_version, listing_updated,
  rating, rating_count, native_rating, native_count,
  external_source, external_rating, external_count,
  certification, cert_label, cert_url,
  function_category, delivery, price_band, price_note,
  reach, provenance, evidence_tier, risk,
  plans, product_links, legal_links, media,
  listing_id, last_captured_at, capture_count
from public.v_asset_passport;
alter view public.v_asset_passport_public set (security_invoker = false);

-- Slug resolver: keeps slug-to-asset_id routing working after asset_slug SELECT
-- is revoked below. Security definer so browser roles never need a grant on
-- asset_slug itself; this is routing only, it exposes no provenance.
create or replace function public.resolve_asset_slug(p_slug text) returns uuid
language sql stable security definer set search_path = pg_catalog, public as $$
  select asset_id from public.asset_slug where slug = p_slug;
$$;
comment on function public.resolve_asset_slug(text) is
  'Slug to asset_id, security definer so browser roles need no asset_slug grant. Routing only, no provenance.';
revoke all on function public.resolve_asset_slug(text) from public;
grant execute on function public.resolve_asset_slug(text) to anon, authenticated;

-- registry_search: same body as today, taken verbatim from pg_get_functiondef,
-- with exactly two edits: SECURITY DEFINER added, and the page CTE's upper
-- bound capped at 100 rows per request regardless of what p_limit asks for.
CREATE OR REPLACE FUNCTION public.registry_search(p_q text DEFAULT ''::text, p_source text[] DEFAULT '{}'::text[], p_function text[] DEFAULT '{}'::text[], p_provenance text[] DEFAULT '{}'::text[], p_risk text[] DEFAULT '{}'::text[], p_tier text[] DEFAULT '{}'::text[], p_delivery text[] DEFAULT '{}'::text[], p_price text[] DEFAULT '{}'::text[], p_sort text DEFAULT 'reach'::text, p_dir text DEFAULT 'desc'::text, p_limit integer DEFAULT 24, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
with
  -- p_source resolved to canonical marketplace NAMES, accepting either ids or
  -- names on the way in and deduplicating on the way out. See the header for
  -- the resolution rule and the no-id-equals-another-name invariant.
  --
  -- One row, always: array_agg over no matching rows returns a single NULL,
  -- which coalesce turns into the empty array. That empty array is load
  -- bearing. An empty p_source (cardinality 0) means "no source filter" and is
  -- handled by the cardinality guard in `matched`; a non-empty p_source whose
  -- every element is unknown resolves to '{}' here and, because the cardinality
  -- guard does NOT fire, is tested as `f_sources && '{}'`, which is false for
  -- every row. That is the "unknown value returns total 0" branch, and it is
  -- why this cannot short-circuit on the resolved cardinality being 0.
  src_resolved as (
    select coalesce(array_agg(distinct m.name order by m.name), '{}'::text[]) as names
      from unnest(p_source) as ps(raw)
      join marketplace m on ps.raw = m.id or ps.raw = m.name
  ),

  -- The needle is matched with LIKE but comes from a text box, where % and _
  -- are ordinary characters. Escape them, or a visitor searching "100% managed"
  -- matches every row in the registry.
  --
  -- Unchanged, deliberately, including the order: the backslash goes first so
  -- that the escapes added after it are not themselves escaped. This is the
  -- model gate.like_literal() in scripts/gate/04-reads.sql copies.
  needle as (
    select case
      when nullif(btrim(p_q), '') is null then null
      else replace(replace(replace(lower(btrim(p_q)),
             '\', '\\'), '%', '\%'), '_', '\_')
    end as n
  ),

  -- Everything matching the free-text query, with each facet's value
  -- normalised once. null, the empty string and the literal 'Unknown' are one
  -- bucket, exactly as norm() in marketplace-query.ts collapses them. A third
  -- spelling means the rail offers a value the filter can never match.
  --
  -- source is the one exception and is now an ARRAY, f_sources, because a
  -- product can be sold on more than one marketplace and is not required to
  -- pick one. Every other facet stays single-valued.
  byq as (
    select
      v.asset_id, v.name, v.reach, v.rating, v.last_captured_at,
      -- Every marketplace the asset is listed on, as the NAMES the facet
      -- displays and the app filters on. See the note at the top of this file
      -- for why the mapping happens here and not in the view.
      --
      -- There is no 'Unknown' branch for the array as a whole and there cannot
      -- be one: marketplace_ids is aggregated over the asset's listings, and an
      -- asset with no listings has no row in v_registry_card at all, so this
      -- array is never empty. A branch for it could never run, and a check that
      -- cannot fail is worse than no check.
      --
      -- The per-name coalesce is a different case and does stay.
      -- marketplace.name is NOT NULL but not non-empty, and norm() on the
      -- client maps '' to 'Unknown', so dropping it would put a blank value in
      -- the rail. parseCriteria() strips empty strings out of every inbound
      -- URL, so that value could be shown and never selected.
      --
      -- distinct on the NAME, not merely on the id the view already
      -- de-duplicated: two marketplace ids sharing a display name are one
      -- bucket to the app, and without this the asset would be counted twice
      -- under the single value the rail shows.
      (select array_agg(distinct coalesce(nullif(m.name, ''), 'Unknown')
                           order by coalesce(nullif(m.name, ''), 'Unknown'))
         from marketplace m
        where m.id = any(v.marketplace_ids))               as f_sources,
      coalesce(nullif(v.function_category, ''), 'Unknown') as f_function,
      -- provenance and risk are enums (provenance_status, risk_band), so they
      -- need the text cast, and cannot carry the empty string that nullif()
      -- strips from the text columns. Casting inside nullif() instead would
      -- push '' into the enum and fail with 22P02.
      coalesce(v.provenance::text, 'Unknown')              as f_provenance,
      coalesce(v.risk::text, 'Unknown')                    as f_risk,
      coalesce(nullif(v.evidence_tier,     ''), 'Unknown') as f_tier,
      coalesce(nullif(v.delivery,          ''), 'Unknown') as f_delivery,
      coalesce(nullif(v.price_band,        ''), 'Unknown') as f_price
    from v_registry_card v, needle
    where needle.n is null
      -- search_blob is the same nine fields searchBlob() joins on the client,
      -- in the same order, concatenated across every listing of the asset. The
      -- field order that a needle spanning a boundary depends on now lives in
      -- v_registry_card, where the blob is built, rather than in this
      -- predicate: there is one definition of it and this side just matches.
      --
      -- The view lowercases the blob and coalesces it to '', so neither is
      -- repeated here. Restating the lowercasing would paper over a view that
      -- had stopped doing it; the gate asserts search_blob = lower(search_blob)
      -- against the view instead, which is where the fault would actually be.
      or v.search_blob like '%' || needle.n || '%' escape '\'
  ),

  -- One flag per facet group. An empty selection matches everything.
  --
  -- source overlaps rather than equals. && is true when ANY of the asset's
  -- marketplaces is among the selected values, which is the same "or within a
  -- group" rule = any() gives every other facet, lifted to a set on both sides.
  -- Under 1:1 f_sources has one element and the two are the same test.
  --
  -- The selected values are the RESOLVED names, not the raw p_source: an id and
  -- its name are the same selection, and an unknown value is no selection at
  -- all. The cardinality guard still reads the RAW p_source, so "no filter"
  -- (empty input) and "a filter that matched no marketplace" (unknown input,
  -- resolving to '{}') stay distinct: the first matches everything, the second
  -- overlaps nothing.
  matched as (
    select b.*,
      (cardinality(p_source)     = 0 or b.f_sources    && (select names from src_resolved)) as m_source,
      (cardinality(p_function)   = 0 or b.f_function   = any(p_function))   as m_function,
      (cardinality(p_provenance) = 0 or b.f_provenance = any(p_provenance)) as m_provenance,
      (cardinality(p_risk)       = 0 or b.f_risk       = any(p_risk))       as m_risk,
      (cardinality(p_tier)       = 0 or b.f_tier       = any(p_tier))       as m_tier,
      (cardinality(p_delivery)   = 0 or b.f_delivery   = any(p_delivery))   as m_delivery,
      (cardinality(p_price)      = 0 or b.f_price      = any(p_price))      as m_price
    from byq b
  ),

  hits as (
    select * from matched
    where m_source and m_function and m_provenance
      and m_risk and m_tier and m_delivery and m_price
  ),

  -- Rank inside the window function, not in a subquery's ORDER BY: a subquery's
  -- ordering is not contractually preserved by an outer select, so row_number()
  -- over () could number the rows in a different order than they were sorted.
  --
  -- Only the branch matching p_sort/p_dir is non-null; every other branch
  -- evaluates to NULL for all rows and so contributes no ordering. Nulls sort
  -- last in BOTH directions: a missing rating is not a rating of zero and must
  -- never outrank a stated one. asset_id breaks every remaining tie, without
  -- which a row can straddle a page boundary and be shown twice or not at all.
  ranked as (
    select asset_id, row_number() over (
      order by
        case when p_sort = 'reach'    and p_dir = 'desc' then reach            end desc nulls last,
        case when p_sort = 'reach'    and p_dir = 'asc'  then reach            end asc  nulls last,
        case when p_sort = 'rating'   and p_dir = 'desc' then rating           end desc nulls last,
        case when p_sort = 'rating'   and p_dir = 'asc'  then rating           end asc  nulls last,
        case when p_sort = 'captured' and p_dir = 'desc' then last_captured_at end desc nulls last,
        case when p_sort = 'captured' and p_dir = 'asc'  then last_captured_at end asc  nulls last,
        case when p_sort = 'name' and p_dir = 'desc' then name collate registry_name_ci end desc nulls last,
        case when p_sort = 'name' and p_dir = 'asc'  then name collate registry_name_ci end asc  nulls last,
        asset_id asc
    ) as rn
    from hits
  ),

  page as (
    select asset_id, rn from ranked
    where rn >  greatest(p_offset, 0)
      and rn <= greatest(p_offset, 0) + least(greatest(p_limit, 0), 100)
  ),

  -- The row JSON is built here, for the page, and not up in byq for the whole
  -- registry. Serialising 5,106 rows to return 24 of them cost about a fifth of
  -- this function's total runtime; the join back is by primary key.
  page_cards as (
    select to_jsonb(v) as card, p.rn
    from page p
    join v_registry_card v on v.asset_id = p.asset_id
  ),

  -- Counting each group over `matched` rather than `hits` is what makes a count
  -- self-excluding. The GROUP BY over the whole q-filtered set is also the
  -- seed: a value that a sibling selection has driven to zero still gets a row,
  -- with count 0, so the rail shows "still exists, narrowed away" instead of
  -- dropping it. An absent row is indistinguishable from "never existed".
  counted as (
    -- source unnests before grouping, so an asset on two marketplaces
    -- contributes a row to BOTH counts rather than to one. Counting the array
    -- as a single value instead is the easy half of this change to miss: the
    -- match would already be right, the totals would already be right, and only
    -- the number printed beside each marketplace would be short.
    --
    -- Once assets are multi-listed these counts sum to more than `total`, and
    -- that is correct rather than a discrepancy: the number beside a value
    -- answers "how many products would selecting this show", and one product
    -- can be the answer to two of them. Under 1:1 they still sum to `total`.
    select 'source' as key, src.value as value,
           count(*) filter (where m_function and m_provenance and m_risk and m_tier and m_delivery and m_price) as n
      from matched, unnest(matched.f_sources) as src(value) group by src.value
    union all select 'function', f_function,
           count(*) filter (where m_source and m_provenance and m_risk and m_tier and m_delivery and m_price)
      from matched group by f_function
    union all select 'provenance', f_provenance,
           count(*) filter (where m_source and m_function and m_risk and m_tier and m_delivery and m_price)
      from matched group by f_provenance
    union all select 'risk', f_risk,
           count(*) filter (where m_source and m_function and m_provenance and m_tier and m_delivery and m_price)
      from matched group by f_risk
    union all select 'tier', f_tier,
           count(*) filter (where m_source and m_function and m_provenance and m_risk and m_delivery and m_price)
      from matched group by f_tier
    union all select 'delivery', f_delivery,
           count(*) filter (where m_source and m_function and m_provenance and m_risk and m_tier and m_price)
      from matched group by f_delivery
    union all select 'price', f_price,
           count(*) filter (where m_source and m_function and m_provenance and m_risk and m_tier and m_delivery)
      from matched group by f_price
  ),

  -- A selected value with no rows anywhere in the q-filtered set still has to
  -- appear, or it vanishes from the rail while active in the URL: the visitor
  -- sees results narrowed by a filter they can neither see nor clear. Zero rows
  -- here; the max() below keeps the real count wherever the value was seeded.
  --
  -- source seeds the RESOLVED names, not the raw p_source. This is the trap the
  -- issue names: seeding the raw input would reintroduce the phantom bucket
  -- under the id's spelling ('microsoft' at count 0) instead of removing it. An
  -- unknown value resolves to '{}' in src_resolved, unnests to no rows, and so
  -- seeds nothing: the empty grid the fix is for, with no ghost value in the
  -- rail. Every real marketplace name it does seed also appears in `counted`,
  -- so the max() below keeps the real count.
  selected as (
    select 'source' as key, s as value from unnest((select names from src_resolved)) s
    union all select 'function',   s from unnest(p_function) s
    union all select 'provenance', s from unnest(p_provenance) s
    union all select 'risk',       s from unnest(p_risk) s
    union all select 'tier',       s from unnest(p_tier) s
    union all select 'delivery',   s from unnest(p_delivery) s
    union all select 'price',      s from unnest(p_price) s
  ),

  merged as (
    select key, value, max(n) as n
    from (
      select key, value, n from counted
      union all
      select key, value, 0 from selected
    ) u
    group by key, value
  ),

  grouped as (
    select key, jsonb_agg(
             jsonb_build_object(
               'value',    value,
               'count',    n,
               -- source compares against the RESOLVED names for the same
               -- reason the seed uses them: an asset filtered by 'microsoft'
               -- must show 'Microsoft Marketplace' as selected:true, and the
               -- raw p_source holds 'microsoft', which the facet value is not.
               'selected', value = any(
                 case key
                   when 'source'     then (select names from src_resolved)
                   when 'function'   then p_function
                   when 'provenance' then p_provenance
                   when 'risk'       then p_risk
                   when 'tier'       then p_tier
                   when 'delivery'   then p_delivery
                   else                   p_price
                 end)
             )
             order by value collate registry_name_ci
           ) as vals
    from merged group by key
  )

select jsonb_build_object(
  'total',  (select count(*) from hits),
  'rows',   coalesce((select jsonb_agg(card order by rn) from page_cards), '[]'::jsonb),
  'facets', coalesce((select jsonb_object_agg(key, vals) from grouped), '{}'::jsonb)
);
$function$;

-- v_merge_candidates: same body as today, taken verbatim from pg_get_viewdef,
-- with one appended predicate on the outer select. A signed-in non-admin gets
-- zero rows; anon is additionally denied by the grant revoke below.
create or replace view public.v_merge_candidates as
 WITH listing_norm AS (
         SELECT l.asset_id,
            l.id AS listing_id,
            l.marketplace_id,
            l.current_capture_id,
            x.name,
            x.publisher,
            registry_norm(x.name) AS norm_name,
            registry_norm(x.publisher) AS norm_publisher
           FROM listing l
             JOIN asset a ON a.id = l.asset_id AND a.merged_into IS NULL
             JOIN capture_extract x ON x.capture_id = l.current_capture_id
        ), listing_host AS (
         SELECT DISTINCT l.id AS listing_id,
            lower(regexp_replace(regexp_replace(regexp_replace(cl.url, '^https?://'::text, ''::text), '^www\.'::text, ''::text), '/.*$'::text, ''::text)) AS host
           FROM listing l
             JOIN capture_link cl ON cl.capture_id = l.current_capture_id
          WHERE (cl.kind = ANY (ARRAY['product'::link_kind, 'legal'::link_kind])) AND cl.url ~* '^https?://'::text
        ), pair AS (
         SELECT a.asset_id AS asset_id_a,
            b.asset_id AS asset_id_b,
            a.listing_id AS listing_id_a,
            b.listing_id AS listing_id_b,
            a.marketplace_id AS marketplace_id_a,
            b.marketplace_id AS marketplace_id_b,
            a.name AS name_a,
            b.name AS name_b,
            a.publisher AS publisher_a,
            b.publisher AS publisher_b,
            a.norm_name,
            a.norm_publisher AS norm_publisher_a,
            b.norm_publisher AS norm_publisher_b,
            a.norm_publisher <> ''::text AND a.norm_publisher = b.norm_publisher AS pub_exact,
            a.norm_publisher <> ''::text AND b.norm_publisher <> ''::text AND a.norm_publisher <> b.norm_publisher AND LEAST(length(a.norm_publisher), length(b.norm_publisher)) >= 3 AND (b.norm_publisher ~~ (a.norm_publisher || '%'::text) OR a.norm_publisher ~~ (b.norm_publisher || '%'::text)) AS pub_prefix,
            ( SELECT ha.host
                   FROM listing_host ha
                     JOIN listing_host hb ON hb.host = ha.host AND hb.listing_id = b.listing_id
                  WHERE ha.listing_id = a.listing_id AND ha.host <> ''::text AND (ha.host <> ALL (ARRAY['github.com'::text, 'github.io'::text, 'gitlab.com'::text, 'bitbucket.org'::text, 'youtube.com'::text, 'youtu.be'::text, 'vimeo.com'::text, 'google.com'::text, 'play.google.com'::text, 'docs.google.com'::text, 'drive.google.com'::text, 'sites.google.com'::text, 'forms.gle'::text, 'goo.gl'::text, 'apps.apple.com'::text, 'microsoft.com'::text, 'apps.microsoft.com'::text, 'aws.amazon.com'::text, 'amazon.com'::text, 'amazonaws.com'::text, 'cloudfront.net'::text, 'azurewebsites.net'::text, 'notion.so'::text, 'notion.site'::text, 'readthedocs.io'::text, 'readthedocs.org'::text, 'gitbook.io'::text, 'gitbook.com'::text, 'medium.com'::text, 'linkedin.com'::text, 'twitter.com'::text, 'x.com'::text, 'facebook.com'::text, 'fb.com'::text, 'instagram.com'::text, 'netlify.app'::text, 'vercel.app'::text, 'herokuapp.com'::text, 'wordpress.com'::text, 'wixsite.com'::text, 'webflow.io'::text, 'gumroad.com'::text, 'substack.com'::text, 'calendly.com'::text, 'discord.com'::text, 'discord.gg'::text, 'slack.com'::text, 't.me'::text, 'wa.me'::text]))
                  ORDER BY ha.host
                 LIMIT 1) AS shared_host
           FROM listing_norm a
             JOIN listing_norm b ON a.norm_name = b.norm_name AND length(a.norm_name) >= 4 AND a.marketplace_id <> b.marketplace_id AND ((ROW(a.marketplace_id, a.asset_id) < ROW(b.marketplace_id, b.asset_id)))
        )
 SELECT asset_id_a,
    asset_id_b,
    listing_id_a,
    listing_id_b,
    marketplace_id_a,
    marketplace_id_b,
    name_a,
    name_b,
    publisher_a,
    publisher_b,
    norm_name,
    norm_publisher_a,
    norm_publisher_b,
    true AS signal_name_match,
    pub_exact AS signal_publisher_exact,
    pub_prefix AS signal_publisher_prefix,
    shared_host IS NOT NULL AS signal_link_host_shared,
    shared_host AS shared_link_host,
        CASE
            WHEN pub_exact OR pub_prefix OR shared_host IS NOT NULL THEN 'high'::text
            ELSE 'low'::text
        END AS confidence
   FROM pair
  where exists (select 1 from public.profile where profile.id = auth.uid() and role = 'admin');
alter view public.v_merge_candidates set (security_invoker = false);

-- Flip the seven read views to definer. No body change.
alter view public.v_registry_card     set (security_invoker = false);
alter view public.v_registry_stats     set (security_invoker = false);
alter view public.v_logo_status        set (security_invoker = false);
alter view public.v_asset_passport     set (security_invoker = false);
alter view public.v_listing_passport   set (security_invoker = false);
alter view public.v_asset_evidence     set (security_invoker = false);
alter view public.v_asset_change_feed  set (security_invoker = false);

-- Public tier (anon + authenticated). registry_search + the three card/stats/logo
-- views are already granted to both; the new public passport view is added here.
grant select on public.v_asset_passport_public to anon, authenticated;

-- Passport-depth tier: authenticated only. Revoke anon from every depth view.
revoke select on public.v_asset_passport    from anon;
revoke select on public.v_listing_passport  from anon;
revoke select on public.v_asset_evidence    from anon;
revoke select on public.v_asset_change_feed from anon;
-- (authenticated keeps SELECT on these four; it already has it.)

-- Admin tier: anon revoked; authenticated keeps the grant, gated to zero rows by
-- the Step 5 predicate.
revoke select on public.v_merge_candidates from anon;

-- Base-table SELECT revoked from BOTH browser roles. capture.raw becomes reachable
-- only by service_role.
revoke select on public.asset, public.asset_merge, public.asset_slug,
  public.capture, public.capture_compliance, public.capture_evidence,
  public.capture_extract, public.capture_link, public.capture_permission,
  public.capture_plan, public.function_override, public.listing,
  public.listing_change, public.marketplace
  from anon, authenticated;
-- Explicit, so the raw column is provably out of reach even if a future object
-- re-exposes the table.
revoke select on public.capture from anon, authenticated;

-- Structural self-assertions. Catalog-only, environment-agnostic: this block runs
-- when the maintainer applies the migration to prod, and the migration refuses to
-- apply if it did not achieve the contract above.
do $$
declare
  v_secdef boolean;
  v_opts text[];
  v_bad text;
begin
  -- registry_search must be security definer.
  select prosecdef into v_secdef
    from pg_proc where proname = 'registry_search' and pronamespace = 'public'::regnamespace;
  if v_secdef is not true then
    raise exception 'visibility gate: registry_search is not security definer';
  end if;

  -- The nine flipped views must not be security_invoker=true.
  for v_bad in
    select v.name from unnest(array[
      'v_registry_card','v_registry_stats','v_logo_status','v_asset_passport',
      'v_listing_passport','v_asset_evidence','v_asset_change_feed',
      'v_asset_passport_public','v_merge_candidates'
    ]) as v(name)
  loop
    v_opts := null;
    select c.reloptions into v_opts
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_bad;
    if not found then
      raise exception 'visibility gate: view % not found', v_bad;
    end if;
    if v_opts @> array['security_invoker=true'] then
      raise exception 'visibility gate: % is still security_invoker=true', v_bad;
    end if;
  end loop;

  -- anon must hold no SELECT on any depth or admin view.
  for v_bad in
    select t.name from unnest(array[
      'v_asset_passport','v_listing_passport','v_asset_evidence',
      'v_asset_change_feed','v_merge_candidates'
    ]) as t(name)
  loop
    if exists (
      select 1 from information_schema.role_table_grants
      where grantee = 'anon' and table_schema = 'public'
        and table_name = v_bad and privilege_type = 'SELECT'
    ) then
      raise exception 'visibility gate: anon still holds SELECT on %', v_bad;
    end if;
  end loop;

  -- Neither browser role may hold SELECT on any base table, capture included.
  for v_bad in
    select t.name from unnest(array[
      'asset','asset_merge','asset_slug','capture','capture_compliance',
      'capture_evidence','capture_extract','capture_link','capture_permission',
      'capture_plan','function_override','listing','listing_change','marketplace'
    ]) as t(name)
  loop
    if exists (
      select 1 from information_schema.role_table_grants
      where grantee in ('anon','authenticated') and table_schema = 'public'
        and table_name = v_bad and privilege_type = 'SELECT'
    ) then
      raise exception 'visibility gate: a browser role still holds SELECT on base table %', v_bad;
    end if;
  end loop;

  -- v_asset_passport_public must carry none of the gate-asserted-absent columns.
  for v_bad in
    select c.name from unnest(array[
      'evidence','known_layers','risk_basis','graph_permissions','compliance'
    ]) as c(name)
  loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'v_asset_passport_public'
        and column_name = v_bad
    ) then
      raise exception 'visibility gate: v_asset_passport_public still carries column %', v_bad;
    end if;
  end loop;
end $$;
