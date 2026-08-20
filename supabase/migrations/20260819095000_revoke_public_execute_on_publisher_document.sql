-- ingest_publisher_document was created without the revoke/grant block that
-- every other write function in this schema carries, so Postgres left EXECUTE
-- granted to PUBLIC and the browser publishable key could call it. Verified
-- against production on 2026-08-19: an anon call reached the function's own
-- validation, which only happens after the permission check.
--
-- Nothing legitimate loses access. scripts/drai-docs.mjs calls this with the
-- service role key, exactly like every other ingest path.

revoke all on function ingest_publisher_document(jsonb) from public, anon, authenticated;
grant execute on function ingest_publisher_document(jsonb) to service_role;
