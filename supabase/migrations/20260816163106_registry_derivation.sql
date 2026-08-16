-- Derived values. One definition, used by ingest and by anything that
-- recomputes. Never hand-written into a row.

-- Manual use-case assignments win over the keyword classifier. A table rather
-- than a hardcoded CASE so corrections are data, not a deploy.
create table function_override (
  marketplace_id    text not null references marketplace(id) on delete cascade,
  source_product_id text not null,
  function_category text not null,
  reason            text,
  created_at        timestamptz not null default now(),
  primary key (marketplace_id, source_product_id)
);
alter table function_override enable row level security;
create policy function_override_public_read on public.function_override
  for select to anon, authenticated using (true);
grant select on public.function_override to anon, authenticated;

-- Twelve tracked build layers. Three of them (hosting, data residency,
-- permission scope) only ever appear on an app certification page, so a
-- listing without one is scored against the nine it can actually state.
create or replace function registry_layers() returns text[]
language sql immutable parallel safe as $$
  select array[
    'vendor identity','model','framework','tools and MCP','data sources',
    'integrations','hosting','data residency','permission scope',
    'pricing','access model','support channel']
$$;

create or replace function registry_cert_only_layers() returns text[]
language sql immutable parallel safe as $$
  select array['hosting','data residency','permission scope']
$$;

-- Keyword classifier. Ordered most specific first, first match wins.
-- Deliberately reads name, tagline and categories only: `industries` says who
-- buys the agent, not what it does, and matching on it put a graph database
-- into Finance because it is sold to banks.
-- NOTE: Postgres regex uses \y for a word boundary. \b is a backspace here.
create or replace function registry_function_category(
  p_name text, p_tagline text, p_categories text[]
) returns text language sql immutable parallel safe as $$
  with hay as (
    select lower(coalesce(p_name,'') || ' ' || coalesce(p_tagline,'') || ' ' ||
                 public.immutable_array_text(p_categories)) as h
  )
  select case
    when h ~ '\yhr\y|human resources|payroll|recruit|\ytalent\y|onboarding|employee (support|experience|engagement|recognition|wellbeing)|performance review|workforce|benefits enrol'
      then 'HR & Talent'
    when h ~ 'cybersecur|\ysecurity\y|threat|vulnerab|helpdesk|help desk|service desk|itsm|\yit support\y|remote support|governance|identity management|compliance monitoring'
      then 'Cybersecurity & IT'
    when h ~ '\yfinance\y|financial|accounting|invoice|receipt|payable|receivable|ledger|erp close|tax\y|billing|expense'
      then 'Finance & Accounting'
    when h ~ 'supply chain|logistics|inventory|supplier|warehouse|freight|shipment'
      then 'Logistics & Supply Chain'
    when h ~ 'procurement|sourcing|solicitation|\ycontract\y|\yrfp\y|tender|bid\y'
      then 'Acquisition & Procurement'
    when h ~ 'marketing|campaign|\ycrm\y|\ysales\y|prospect|lead gen|revenue|opportunity signal'
      then 'Marketing & Sales'
    when h ~ 'chatbot|virtual (agent|assistant)|conversational ai|customer (service|support|engagement|care)|contact cent|call cent|ticket deflect'
      then 'Customer Service'
    when h ~ 'developer|\ycoding\y|devops|\yjira\y|repositor|software delivery|\yapi\y|\ysdk\y|ubuntu|docker|kubernetes|\yllm\y|inference|\yocr\y|text to speech|speech to text|embedding|vector (db|database|search)|open source|runtime|model server|fine.?tun'
      then 'Software Development'
    when h ~ '\yresearch\y|analytics|business intelligence|\yintelligence\y|jurisprud|legal|geospatial|\ymaps\y|terrain|forecast|data.driven'
      then 'Intelligence & Research'
    else 'Operations & Productivity'
  end from hay
$$;

-- Delivery method, from the marketplace's own surface chips first.
create or replace function registry_delivery(p_surfaces text[], p_cert_hosting text)
returns text language sql immutable parallel safe as $$
  select case
    when 'Virtual Machines'    = any(p_surfaces) then 'Virtual machine'
    when 'Containers'          = any(p_surfaces) then 'Container'
    when 'Azure Applications'  = any(p_surfaces) then 'Azure application'
    when p_surfaces && array['Teams','Outlook','Office app','Microsoft 365 Copilot',
                             'Dragon Copilot','Power Apps','Power Automate',
                             'Power Virtual Agents','UiPath Autopilot',
                             'Dynamics 365 Sales','Dynamics 365 Customer Service',
                             'Dynamics 365 Field Service']
      then 'Microsoft 365 app'
    when 'SaaS' = any(p_surfaces) then 'SaaS'
    when lower(coalesce(p_cert_hosting,'')) like '%saas%' then 'SaaS'
    when lower(coalesce(p_cert_hosting,'')) like '%paas%' then 'Vendor cloud (PaaS)'
    when lower(coalesce(p_cert_hosting,'')) like '%iaas%' then 'Vendor cloud (IaaS)'
    when lower(coalesce(p_cert_hosting,'')) like '%isvhosted%' then 'ISV hosted'
    else 'Unknown'
  end
$$;

-- Price band must stay inside the values the registry filter offers.
create or replace function registry_price(p_pricing text, p_plan_count int)
returns jsonb language sql immutable parallel safe as $$
  select case
    when coalesce(trim(p_pricing),'') = '' and coalesce(p_plan_count,0) > 0
      then jsonb_build_object('band','Paid','note',
             p_plan_count || ' plan' || case when p_plan_count = 1 then '' else 's' end || ' listed')
    when coalesce(trim(p_pricing),'') = ''
      then jsonb_build_object('band','Unknown','note','Not stated')
    when lower(trim(p_pricing)) = 'free'
      then jsonb_build_object('band','Free','note','Free')
    when lower(p_pricing) like '%additional purchase%'
      then jsonb_build_object('band','Freemium','note',p_pricing)
    when lower(p_pricing) like '%bring your own licen%'
      then jsonb_build_object('band','Paid','note',p_pricing)
    when lower(p_pricing) like '%not available%'
      then jsonb_build_object('band','Unknown','note',p_pricing)
    else jsonb_build_object('band','Paid','note',p_pricing)
  end
$$;

create or replace function registry_provenance(p_cert certification_status)
returns jsonb language sql immutable parallel safe as $$
  select case p_cert
    when 'microsoft_365_certified' then
      jsonb_build_object('provenance','Verified','tier','Microsoft 365 Certified',
                         'label','Microsoft 365 Certified')
    when 'publisher_attestation' then
      jsonb_build_object('provenance','Disclosed','tier','Publisher Attested',
                         'label','Publisher attested')
    when 'not_eligible' then
      jsonb_build_object('provenance','Unknown','tier','Source Confirmed',
                         'label','Not eligible for certification')
    else
      jsonb_build_object('provenance','Unknown','tier','Source Confirmed',
                         'label','No attestation published')
  end
$$;

-- Evidence risk: the share of the build you cannot see before you deploy.
-- It is not a security rating and must never be presented as one.
create or replace function registry_risk(p_cert certification_status, p_known int)
returns jsonb language plpgsql immutable parallel safe as $$
declare
  attested   boolean := p_cert in ('microsoft_365_certified','publisher_attestation');
  disclosable int := case when attested
                       then array_length(registry_layers(),1)
                       else array_length(registry_layers(),1)
                            - array_length(registry_cert_only_layers(),1) end;
  band int := case p_cert
                when 'microsoft_365_certified' then 0
                when 'publisher_attestation'   then 1
                else 2 end;
  ratio numeric := case when disclosable > 0
                     then p_known::numeric / disclosable else 0 end;
begin
  if ratio >= 0.75 then band := band - 1;
  elsif ratio <= 0.5 then band := band + 1;
  end if;
  band := greatest(0, least(2, band));
  return jsonb_build_object(
    'risk', (array['Low','Medium','High'])[band + 1],
    'basis', (registry_provenance(p_cert) ->> 'label') || ' · ' ||
             p_known || ' of ' || disclosable || ' disclosable layers stated',
    'disclosable', disclosable);
end $$;

insert into function_override (marketplace_id, source_product_id, function_category, reason) values
  ('microsoft','WA104381816','Cybersecurity & IT','ServiceNow Otto'),
  ('microsoft','WA200000037','Cybersecurity & IT','ServiceDesk Plus Cloud'),
  ('microsoft','WA200002046','Cybersecurity & IT','TeamViewer'),
  ('microsoft','WA200000764','Cybersecurity & IT','Teams Manager, governance'),
  ('microsoft','WA200004554','HR & Talent','Matter'),
  ('microsoft','WA200001860','HR & Talent','Teamflect'),
  ('microsoft','WA200009524','HR & Talent','ADP Assist'),
  ('microsoft','WA104381467','HR & Talent','Learn365'),
  ('microsoft','WA200011459','Finance & Accounting','Xero'),
  ('microsoft','WA200008886','Finance & Accounting','LSEG Workspace'),
  ('microsoft','WA200010181','Intelligence & Research','Forrester AI'),
  ('microsoft','WA200007014','Intelligence & Research','Jurisprudencia GPT'),
  ('microsoft','WA200002859','Intelligence & Research','ArcGIS'),
  ('microsoft','WA200002140','Software Development','Jira Cloud'),
  ('microsoft','WA200002564','Operations & Productivity','Adobe Acrobat'),
  ('microsoft','WA200008645','Operations & Productivity','SAP Joule'),
  ('microsoft','366pitechnologies1588333292380.nexus-intelligence-fabric-starter','Intelligence & Research','Nexus Intelligence Fabric')
on conflict do nothing;;