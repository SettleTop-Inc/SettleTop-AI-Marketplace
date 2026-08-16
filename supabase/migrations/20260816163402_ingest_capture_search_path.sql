-- pgcrypto lives in the extensions schema on Supabase, so digest() is not on
-- the function's pinned search_path. Widen it rather than depending on the
-- caller's path.
alter function ingest_capture(jsonb) set search_path = public, extensions;;