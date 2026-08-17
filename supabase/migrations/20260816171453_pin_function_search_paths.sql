-- Pin search_path on every registry function. All of them are pure, but an
-- unpinned search_path is a standing invitation to schema shadowing and the
-- Supabase linter is right to flag it.
alter function public.immutable_array_text(text[])          set search_path = pg_catalog, public;
alter function public.registry_layers()                     set search_path = pg_catalog, public;
alter function public.registry_cert_only_layers()           set search_path = pg_catalog, public;
alter function public.registry_function_category(text, text, text[]) set search_path = pg_catalog, public;
alter function public.registry_delivery(text[], text)       set search_path = pg_catalog, public;
alter function public.registry_price(text, int)             set search_path = pg_catalog, public;
alter function public.registry_provenance(certification_status) set search_path = pg_catalog, public;
alter function public.registry_risk(certification_status, int) set search_path = pg_catalog, public;
alter function public.registry_safe_date(text)              set search_path = pg_catalog, public;
