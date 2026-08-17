# Capture → registry contract

The scraper and the registry are separate systems joined by one payload shape
and one function call. This document is that contract.

## Dual write

Every capture performs two writes, in this order:

1. **Google Drive** — `create_file` with the capture JSON. This is the durable
   archive and the atomic "stored" event. Nothing is considered captured until
   this succeeds.
2. **Supabase** — `ingest_capture(payload)`. Retried once on failure.

If both Supabase attempts fail, the capture is still stored (Drive succeeded),
the Drive file id is recorded in the checkpoint under `pending_ingest`, and the
sweep continues rather than stalling. `scripts/ingest.mjs` replays those later.

The order matters. Drive-first means a Supabase outage can never lose a capture
that cost a page load to obtain. Supabase-first would.

## Payload shape

```jsonc
{
  "capture_meta": {
    "template_version": "2.0",
    "marketplace_id": "microsoft",
    "source_product_id": "anthropic.anthropic-claude-opus-4-8-offer",
    "listing_url": "https://marketplace.microsoft.com/en-us/product/...",
    "captured_at_utc": "2026-08-16T12:26:27Z",
    "capture_complete": true,
    "missing": [],
    "source_view_url": null,          // set when captured from a results page
    "drive_file_id": "1tFLIT...",     // the idempotency key
    "drive_file_name": "microsoft-marketplace_<id>_<date>.json"
  },

  "extract": {
    "extract_spec_version": "v2",
    "name": "", "publisher": "", "tagline": "",
    "surfaces": [], "categories": [], "industries": [], "works_with": [],
    "pricing": "", "acquire_using": "", "version": "", "updated": "YYYY-MM-DD",
    "overview_text": "",              // publisher's prose, nav stripped
    "support": "",
    "rating": null, "rating_count": 0,
    "native_rating": null, "native_count": null,
    "external_source": null, "external_rating": null, "external_count": null,
    "certification": "none",          // or microsoft_365_certified | publisher_attestation | not_eligible
    "cert_url": null,
    "cert_detail": {
      "hosting": null, "data_location": null, "data_handling": null,
      "graph_permissions": [], "compliance": [],
      "developer_last_updated": null, "page_last_updated": null,
      "full_text": null               // NEW in 2.0 — see below
    },
    "plans": [{ "name": "", "price": "", "unit": "", "billing": "" }],
    "product_links": [{ "label": "", "url": "" }],
    "legal_links": [{ "label": "", "url": "" }],
    "media_image_urls": [],
    "stated": {
      "models": [], "frameworks": [], "tools_mcp": [],
      "data_sources": [], "integrations": [], "deployment": [], "languages": []
    }
  },

  "raw": { /* the original capture object, stored whole */ },
  "ingest_source": "dual_write"
}
```

### Why `cert_detail.full_text` was added in 2.0

The database verifies every `stated` value against the capture's own text. In
template 1.0 the certification page was parsed into fields but its full text was
discarded, so values that were genuinely stated there — "SharePoint",
"OneDrive", "Active Directory" — could not be verified and were correctly
rejected. Carrying the full text closes that hole. 14 values across 12 assets in
the current backfill are waiting on it.

("Microsoft Graph" used to be in that list. It no longer is: a trigger on
`capture_permission` treats a named Graph scope as evidence of Graph use, which
is licensed by the permission list itself rather than by prose.)

## Calling the function

Over REST, as service_role:

```
POST {SUPABASE_URL}/rest/v1/rpc/ingest_capture
apikey: {SERVICE_ROLE_KEY}
Authorization: Bearer {SERVICE_ROLE_KEY}
Content-Type: application/json

{"payload": { ...the object above... }}
```

From a Cowork session with the Supabase MCP connector, dollar-quoting avoids all
escaping:

```sql
select ingest_capture($stm${ ...the object... }$stm$::jsonb);
```

## What comes back

```json
{
  "status": "created",         // or "updated" | "already_ingested"
  "asset_id": "...", "capture_id": "...",
  "content_hash": "...",
  "unchanged": false,          // true when nothing moved since the last capture
  "changes": 3,                // rows written to asset_change
  "reach": 83, "risk": "Low", "layers_known": 10,
  "evidence_rejected": 0       // stated values that failed the verbatim check
}
```

`evidence_rejected > 0` is a signal to inspect the capture, never a reason to
relax the gate.

## Idempotency

`drive_file_id` is unique. Replaying the same file returns
`{"status": "already_ingested"}` and writes nothing. Retry freely.

## What the registry does NOT accept

- Individual review text, reviewer names, or paginated review content. The
  reviews *summary* numbers are the only review data that travels.
- Any value in `stated` that is not a proper noun copied verbatim. "an LLM",
  "AI models", "our proprietary engine" are not entries — leave the list empty.
  Empty is a correct and common answer.
