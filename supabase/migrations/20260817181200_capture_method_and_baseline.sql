create type capture_method as enum ('browser_dom','embedded_state','api','backfill');

alter table capture add column method capture_method not null default 'embedded_state';

-- everything captured before this point came from the pre-Supabase index
update capture set method = 'backfill' where ingest_source = 'backfill';

comment on column capture.method is
  'How the observation was obtained. Change events are only emitted between captures of the SAME method — a change of instrument is not a change in the marketplace.';

-- Baseline rule: swapping capture method would otherwise emit a wave of
-- asset_change rows describing our tooling rather than the listing. Suppress
-- them at the boundary instead of patching ingest_capture().
create or replace function suppress_cross_method_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
declare same boolean;
begin
  if new.from_capture_id is null then return new; end if;
  select c1.method = c2.method into same
    from capture c1, capture c2
   where c1.id = new.from_capture_id and c2.id = new.to_capture_id;
  if same is distinct from true then
    return null;   -- BEFORE INSERT returning null drops the row
  end if;
  return new;
end $fn$;

drop trigger if exists asset_change_suppress_cross_method on asset_change;
create trigger asset_change_suppress_cross_method
before insert on asset_change
for each row execute function suppress_cross_method_change();

create index capture_method_idx on capture (method);
