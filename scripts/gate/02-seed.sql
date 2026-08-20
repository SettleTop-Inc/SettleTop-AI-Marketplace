-- Seed through the OLD ingest_capture, before any rename migration runs.
-- Every row the later checks read is therefore a row the backfill produced,
-- which is what production will actually do.
--
-- Called as service_role, which is also how production calls it, so the
-- execute grant is exercised rather than assumed.
set role service_role;

-- 1. microsoft/seed-alpha: full payload, graph_permissions so capture_permission
--    is populated, compliance, plans, evidence, links.
select ingest_capture($p$
{
  "capture_meta": {
    "marketplace_id": "microsoft",
    "source_product_id": "seed-alpha",
    "listing_url": "https://marketplace.microsoft.com/en-us/product/seed-alpha",
    "captured_at_utc": "2026-08-10T09:00:00Z",
    "template_version": "2.0",
    "capture_complete": true,
    "drive_file_id": "drive-seed-alpha-1",
    "drive_file_name": "seed-alpha-1.md",
    "source_view_url": "https://drive.example/seed-alpha-1"
  },
  "ingest_source": "dual_write",
  "raw": {"body": "seed alpha capture one"},
  "extract": {
    "extract_spec_version": "v2",
    "name": "Seed Alpha Agent",
    "publisher": "Seed Publisher Ltd",
    "tagline": "An agent that reads Microsoft Graph and writes summaries",
    "overview_text": "Seed Alpha Agent uses GPT-4o and LangChain to summarise mail. It integrates with SharePoint and Teams.",
    "support": "https://support.example/alpha",
    "pricing": "From 10 dollars per user per month",
    "acquire_using": "Subscription",
    "version": "1.4.0",
    "updated": "2026-08-01",
    "rating": 4.5, "rating_count": 22,
    "certification": "microsoft_365_certified",
    "cert_url": "https://cert.example/alpha",
    "surfaces": ["Teams", "Outlook"],
    "categories": ["Productivity"],
    "industries": ["Financial services"],
    "works_with": ["SharePoint", "Teams"],
    "media_image_urls": ["https://img.example/alpha-1.png"],
    "product_links": [{"label": "Docs", "url": "https://docs.example/alpha"}],
    "legal_links": [{"label": "Privacy", "url": "https://legal.example/alpha-privacy"}],
    "plans": [{"name": "Standard", "price": "10 dollars", "unit": "user", "billing": "monthly"}],
    "stated": {
      "models": ["GPT-4o"],
      "frameworks": ["LangChain"],
      "integrations": ["SharePoint", "Teams"],
      "tools_mcp": ["Microsoft Graph"]
    },
    "cert_detail": {
      "hosting": "Microsoft Azure",
      "data_location": "European Union",
      "data_handling": "Data is not used for training",
      "developer_last_updated": "2026-07-20",
      "page_last_updated": "2026-07-25",
      "graph_permissions": ["Mail.Read", "User.Read", "Sites.Read.All"],
      "compliance": ["ISO 27001", "SOC 2 Type II"]
    }
  }
}
$p$::jsonb) as alpha_capture_1;

-- 2. microsoft/seed-beta: a second listing, no graph permissions, no logo.
select ingest_capture($p$
{
  "capture_meta": {
    "marketplace_id": "microsoft",
    "source_product_id": "seed-beta",
    "captured_at_utc": "2026-08-11T09:00:00Z",
    "drive_file_id": "drive-seed-beta-1"
  },
  "ingest_source": "dual_write",
  "raw": {"body": "seed beta capture one"},
  "extract": {
    "name": "Seed Beta Copilot",
    "publisher": "Beta Works",
    "tagline": "A copilot for invoices",
    "overview_text": "Seed Beta Copilot runs on Claude and reads invoices.",
    "pricing": "Free",
    "certification": "none",
    "surfaces": ["Web"],
    "categories": ["Finance"],
    "stated": {"models": ["Claude"]}
  }
}
$p$::jsonb) as beta_capture_1;

-- 3. drai/seed-gamma: a second marketplace, so v_logo_status's marketplace_id
--    column is exercised over more than one value.
select ingest_capture($p$
{
  "capture_meta": {
    "marketplace_id": "drai",
    "source_product_id": "seed-gamma",
    "listing_url": "https://www.drai-commercial.com/agent/seed-gamma",
    "captured_at_utc": "2026-08-12T09:00:00Z",
    "drive_file_id": "drive-seed-gamma-1"
  },
  "ingest_source": "dual_write",
  "raw": {"body": "seed gamma capture one"},
  "extract": {
    "name": "Seed Gamma Assistant",
    "publisher": "Gamma Systems",
    "tagline": "Agentic support triage",
    "overview_text": "Seed Gamma Assistant uses Llama 3 and CrewAI.",
    "pricing": "Contact us",
    "certification": "publisher_attestation",
    "surfaces": ["Web"],
    "categories": ["Support"],
    "stated": {"models": ["Llama 3"], "frameworks": ["CrewAI"]},
    "cert_detail": {"hosting": "AWS", "data_location": "United States"}
  }
}
$p$::jsonb) as gamma_capture_1;

-- 4. Re-ingest seed-alpha with a changed price and a new permission, so the OLD
--    function writes asset_change rows. Those rows become listing_change rows
--    at the rename and are what v_asset_change_feed must return afterwards.
select ingest_capture($p$
{
  "capture_meta": {
    "marketplace_id": "microsoft",
    "source_product_id": "seed-alpha",
    "captured_at_utc": "2026-08-15T09:00:00Z",
    "drive_file_id": "drive-seed-alpha-2"
  },
  "ingest_source": "dual_write",
  "raw": {"body": "seed alpha capture two"},
  "extract": {
    "extract_spec_version": "v2",
    "name": "Seed Alpha Agent",
    "publisher": "Seed Publisher Ltd",
    "tagline": "An agent that reads Microsoft Graph and writes summaries",
    "overview_text": "Seed Alpha Agent uses GPT-4o and LangChain to summarise mail. It integrates with SharePoint and Teams.",
    "support": "https://support.example/alpha",
    "pricing": "From 18 dollars per user per month",
    "acquire_using": "Subscription",
    "version": "1.5.0",
    "updated": "2026-08-14",
    "rating": 4.6, "rating_count": 25,
    "certification": "microsoft_365_certified",
    "cert_url": "https://cert.example/alpha",
    "surfaces": ["Teams", "Outlook"],
    "categories": ["Productivity"],
    "industries": ["Financial services"],
    "works_with": ["SharePoint", "Teams"],
    "plans": [{"name": "Standard", "price": "18 dollars", "unit": "user", "billing": "monthly"}],
    "stated": {
      "models": ["GPT-4o"],
      "frameworks": ["LangChain"],
      "integrations": ["SharePoint", "Teams"],
      "tools_mcp": ["Microsoft Graph"]
    },
    "cert_detail": {
      "hosting": "Microsoft Azure",
      "data_location": "European Union",
      "data_handling": "Data is not used for training",
      "graph_permissions": ["Mail.Read", "User.Read", "Sites.Read.All", "Calendars.Read"],
      "compliance": ["ISO 27001", "SOC 2 Type II"]
    }
  }
}
$p$::jsonb) as alpha_capture_2;

-- 5. Logo links. seed-alpha gets an archived logo, seed-gamma an unarchived one,
--    so v_logo_status carries all three of its states across the seed.
select set_capture_logo('seed-alpha', 'https://img.example/alpha-logo.png', 'microsoft') as alpha_logo;
select set_capture_logo('seed-gamma', 'https://img.example/gamma-logo.png', 'drai')      as gamma_logo;

select record_link_archive(
         (select cl.id from capture_link cl
            join asset a on a.current_capture_id = cl.capture_id
           where a.source_product_id = 'seed-alpha' and cl.kind = 'logo'),
         'https://storage.example/logos/microsoft/seed-alpha.png',
         'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
         2048, 'image/png') as alpha_archive;

reset role;
