-- AWS Marketplace becomes the registry's third source, after microsoft and
-- drai. ingest_capture() reads capture_meta.marketplace_id and inserts into
-- listing, whose marketplace_id is a foreign key, so without this row every
-- AWS capture fails on the reference rather than on anything about the data.
--
-- This migration adds one row and changes nothing else. It does not touch
-- ingest_capture(), the evidence verification gate, or any derivation
-- function. Adding a source is not a change to the write path.
--
-- product_url_template is the real address of an AWS listing, the same shape
-- the microsoft row carries. It is filled in rather than left null (as the drai
-- row is) because AWS does publish a stable per-product URL and the adapter
-- already builds exactly this string in PRODUCT_URL().

insert into marketplace (id, name, base_url, product_url_template) values
  ('aws', 'AWS Marketplace', 'https://aws.amazon.com/marketplace',
   'https://aws.amazon.com/marketplace/pp/{id}')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- FOLLOW-UP, DELIBERATELY NOT DONE HERE: registry_delivery() returns 'Unknown'
-- for every AWS listing.
--
-- The function (20260816163106_registry_derivation.sql:71) decides delivery
-- from extract.surfaces first and falls back to cert_detail.hosting. AWS
-- listings have neither:
--
--   surfaces is empty, because the "Supported services" row rendered on an AWS
--   product page has no data node anywhere in the page blob. The string exists
--   only in the UI translation table, and overview.solution and
--   overview.integrationGuide, the two candidate holders, are null on every
--   page read. Filling surfaces from anything else would be our classification
--   presented as AWS's.
--
--   cert_hosting is null, because AWS publishes no certification questionnaire.
--
-- So every literal in that function's CASE misses, and every AWS listing loses
-- the delivery facet. What AWS states instead is a fulfilment option type, at
-- fulfillmentOptions[].fulfillmentOptionType.fulfillmentOptionTypeId, and the
-- adapter carries it verbatim into extract.acquire_using and keeps the machine
-- value in raw. Ten ids have been observed on live pages:
--
--   AMAZON_MACHINE_IMAGE      Amazon Machine Image
--   CONTAINER                 Container Image
--   HELM                      Helm Chart
--   CLOUDFORMATION_TEMPLATE   CloudFormation Template
--   SAAS                      SaaS
--   API                       API-Based Agents & Tools
--   SAGEMAKER_MODEL           SageMaker Model
--   SAGEMAKER_ALGORITHM       SageMaker Algorithm
--   DATA_EXCHANGE             Data Exchange
--   PROFESSIONAL_SERVICES     Professional Services
--
-- An AWS branch of registry_delivery() would switch on the id, never on the
-- display name. It is not written here on purpose: registry_delivery is a
-- shared function that every Microsoft row also derives through, so changing it
-- is a schema change needing its own review and its own migration, and it must
-- not ride along with a source being added. Until it lands, "Unknown" is a true
-- statement about what this function can read, not a defect in the AWS adapter.
-- ---------------------------------------------------------------------------
