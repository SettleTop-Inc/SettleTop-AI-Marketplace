/**
 * parseCertificationPage, against two real pages.
 *
 *   node --test scripts/lib/sources/microsoft.cert.test.mjs
 *
 * The fixtures in fixtures/ are two certification pages saved byte for byte as
 * learn.microsoft.com served them, fetched through the same /forward/<id>
 * redirector the harvester uses:
 *
 *   cert-certified-WA104382005.html  Appfluence Priority Matrix, microsoft_365
 *                                    certified: has the audit result table and
 *                                    a Graph permission table.
 *   cert-attested-WA200006808.html   Dropbox, publisher attestation: no audit
 *                                    table, and the no-Graph sentence instead
 *                                    of a permission table.
 *
 * Between them they cover both tiers and both Graph branches, which is every
 * structural variation the 219 pages have.
 *
 * WHAT THESE TESTS ARE FOR. The parser's promise is that it transcribes and
 * never invents, and the way that promise breaks is silent: Microsoft edits the
 * Learn template, a header or a row moves, and a page that still answers the
 * questionnaire starts parsing as a publisher who disclosed less. Nothing about
 * that failure is loud. So half of what is below is not "does it read the page"
 * but "does it refuse a page it can no longer read", each mutation standing for
 * one template change: a relabelled ID row, a renamed Graph header, a missing
 * zone, a blanked answer, a column dropped from a table.
 *
 * Expected values are read off the fixtures, not copied from a previous run of
 * this parser. The saved pages are the source they are checked against.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseCertificationPage } from "./microsoft.mjs";
import { readCliArgs } from "../marketplace.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(HERE, "fixtures", name), "utf8");

const CERTIFIED = {
  id: "WA104382005",
  url: "https://learn.microsoft.com/en-us/microsoft-365-app-certification/teams/appfluence-inc-priority-matrix",
  html: fixture("cert-certified-WA104382005.html"),
};

const ATTESTED = {
  id: "WA200006808",
  url: "https://learn.microsoft.com/en-us/microsoft-365-app-certification/teams/dropbox-inc",
  html: fixture("cert-attested-WA200006808.html"),
};

/** Parse a fixture with one substitution applied, which is what a template change looks like. */
const mutate = (page, from, to, over = {}) => {
  assert.ok(page.html.includes(from), `fixture no longer contains ${JSON.stringify(from)}`);
  return parseCertificationPage({ ...page, html: page.html.replace(from, to), ...over });
};

// ------------------------------------------------------------ transcription

test("the certified page is transcribed, answer for answer", () => {
  const { ok, record } = parseCertificationPage(CERTIFIED);
  assert.equal(ok, true);

  assert.equal(record.id, "WA104382005");
  assert.equal(record.resolved_url, CERTIFIED.url);
  assert.equal(record.badge, "certified");

  // Both are the publisher's own words, copied from the page: "Iaas_Hybrid_Onprem"
  // is Microsoft's spelling of the answer and is stored as it is written.
  assert.equal(record.hosting, "Iaas_Hybrid_Onprem");
  assert.equal(record.data_location, "United States of America");

  // "Last updated by the developer on: April 15, 2026", read with a month table
  // so no machine's locale can move it.
  assert.equal(record.developer_last_updated, "2026-04-15");
  assert.equal(record.page_last_updated, "2026-05-15");
});

test("graph permissions are column 0 of the Graph table and nothing else", () => {
  const { record } = parseCertificationPage(CERTIFIED);

  // Exact, not a length. One element of any content writes a verified
  // "Microsoft Graph" evidence row, so what lands here is the whole claim.
  assert.deepEqual(record.graph_permissions, [
    "Calendars.Read",
    "Files.Read.All",
    "Mail.Read",
    "Tasks.Read",
    "TeamsActivity.Send",
    "User.Read",
    "User.ReadBasic.All",
    "email",
    "offline_access",
    "openid",
    "profile",
  ]);

  // The justification and the permission type are on the same rows and belong
  // to the prose, not to the permission list.
  assert.ok(!record.graph_permissions.some((p) => p.includes("delegated")));
  assert.ok(record.data_handling.includes("Calendars.Read (delegated):"));
});

test("compliance keeps the whole sentence, and only the Yes rows", () => {
  const { record } = parseCertificationPage(CERTIFIED);

  assert.deepEqual(record.compliance, [
    "Has the app been Cloud Security Alliance (CSA Star) certified? Yes",
  ]);

  // The page asks about ISO 27001 too and this publisher answered No. A label
  // list would have shown the question; the sentence form cannot.
  assert.ok(CERTIFIED.html.includes("ISO 27001"));
  assert.ok(!record.compliance.some((c) => c.includes("ISO 27001")));

  const attested = parseCertificationPage(ATTESTED).record;
  assert.equal(attested.compliance.length, 13);
  assert.ok(attested.compliance.every((c) => c.endsWith("? Yes")));
});

test("hosting holds the app's own answer, and the cloud provider rides in data_handling", () => {
  const { record } = parseCertificationPage(CERTIFIED);

  // hosting alone decides the public delivery facet by substring, so a provider
  // name in it would steer that facet. It reaches the same haystack either way.
  assert.ok(!record.hosting.includes("Aws"));
  assert.ok(record.data_handling.includes("Which hosting cloud providers does the app use?: Aws"));
});

test("residency is the storage answer, not the company's headquarters", () => {
  // Both cells read "United States of America" on this page, so the only way to
  // show which one was read is to move the other one.
  const moved = mutate(
    CERTIFIED,
    '<td style="text-align: left;">Company headquarter location</td>\n<td style="text-align: left;">United States of America</td>',
    '<td style="text-align: left;">Company headquarter location</td>\n<td style="text-align: left;">Ireland</td>'
  );
  assert.equal(moved.record.data_location, "United States of America");
});

test("the attested page parses, with no audit table and no Graph permissions", () => {
  const { ok, record } = parseCertificationPage(ATTESTED);
  assert.equal(ok, true);

  assert.equal(record.badge, "attested");
  assert.equal(record.certification_results, null);

  // The page says in words that it uses no Graph, which is a stated answer and
  // not an absence, so an empty list is the correct reading of it.
  assert.ok(ATTESTED.html.includes("This application does not use Microsoft Graph."));
  assert.deepEqual(record.graph_permissions, []);
  assert.ok(record.full_text.length > 1000);
});

test("the audit result table separates Microsoft's sections from its controls", () => {
  const { record } = parseCertificationPage(CERTIFIED);
  const results = record.certification_results;

  assert.equal(results.length, 27);
  assert.deepEqual(results[0], { control: "APPLICATION SECURITY", result: "PASS", level: "section" });
  assert.deepEqual(results[1], { control: "Penetration Testing", result: "In Scope", level: "control" });

  // Microsoft's own assessment, so none of it is allowed into compliance, where
  // every element is published as a certification the product holds.
  assert.ok(!record.compliance.some((c) => c.includes("In Scope") || c.includes("PASS")));
});

// ----------------------------------------------------------------- refusals

test("a page that states no ID is refused, not filed under the id we asked for", () => {
  // The exact failure this guard exists for: one relabelled row, and without
  // the check the questionnaire is filed under whatever id the caller passed.
  const renamed = mutate(
    CERTIFIED,
    '<td style="text-align: left;">ID</td>',
    '<td style="text-align: left;">Identifier</td>',
    { id: "TOTALLY.WRONG.PRODUCT" }
  );
  assert.equal(renamed.ok, false);
  assert.equal(renamed.reason, "page states no ID");

  // Same page, right id: still refused, because the page no longer proves it.
  const rightId = mutate(
    CERTIFIED,
    '<td style="text-align: left;">ID</td>',
    '<td style="text-align: left;">Identifier</td>'
  );
  assert.equal(rightId.ok, false);
});

test("a page that states another product's ID is refused", () => {
  const wrong = parseCertificationPage({ ...CERTIFIED, id: "someone.else_saas" });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, "page states ID WA104382005");
});

test("a URL that is not a certification page is refused before it is parsed", () => {
  const landing = parseCertificationPage({
    ...CERTIFIED,
    url: "https://learn.microsoft.com/en-us/microsoft-365-app-certification/overview",
  });
  assert.equal(landing.ok, false);
  assert.match(landing.reason, /did not resolve to a certification page/);
});

test("a missing zone is refused rather than read as a page that says less", () => {
  const gone = mutate(CERTIFIED, '<div class="zone has-pivot" data-pivot="data"', '<div class="zone"');
  assert.equal(gone.ok, false);
  assert.equal(gone.reason, "missing zones: data");
});

test("a renamed Graph header is refused, never read as zero permissions", () => {
  // Without the both-or-neither check this is the dangerous one: the page still
  // lists permissions, and an empty list would publish as "asks for none".
  const renamed = mutate(
    CERTIFIED,
    "<strong>Graph Permission</strong>",
    "<strong>Graph permissions</strong>"
  );
  assert.equal(renamed.ok, false);
  assert.equal(renamed.reason, "no Graph table and no no-Graph sentence");
});

test("a Graph table and the no-Graph sentence cannot both stand", () => {
  const both = mutate(
    CERTIFIED,
    '<h4 id="data-access-using-microsoft-graph">',
    '<p>This application does not use Microsoft Graph.</p><h4 id="data-access-using-microsoft-graph">'
  );
  assert.equal(both.ok, false);
  assert.equal(both.reason, "Graph table and the no-Graph sentence both present");
});

test("hosting is required, because everything downstream of it is", () => {
  const blank = mutate(
    CERTIFIED,
    '<td style="text-align: left;">Iaas_Hybrid_Onprem</td>',
    '<td style="text-align: left;"></td>'
  );
  assert.equal(blank.ok, false);
  assert.equal(blank.reason, "no hosting answer");
});

// -------------------------------------------------------------- blank cells

test("a blank answer leaves the field null instead of storing an empty string", () => {
  const geography =
    "If underlying infastructure processes or stores Microsoft customer data, where is this data geographically stored?";
  const blanked = mutate(
    CERTIFIED,
    `<td style="text-align: left;">${geography}</td>\n<td style="text-align: left;">United States of America</td>`,
    `<td style="text-align: left;">${geography}</td>\n<td style="text-align: left;"></td>`
  );

  assert.equal(blanked.ok, true);
  assert.equal(blanked.record.data_location, null);
  // The question does not survive either: a field backed by nothing is worse
  // than no field, in the haystack as much as in the column.
  assert.ok(!blanked.record.data_handling.includes(geography));
});

test("a Graph table missing its later columns never writes the word undefined", () => {
  const table = (CERTIFIED.html.match(/<table[\s\S]*?<\/table>/g) || []).find((t) =>
    t.includes("<strong>Graph Permission</strong>")
  );
  assert.ok(table, "fixture no longer has a Graph permission table");

  // Two columns instead of four, which is what a trimmed template would give.
  const narrowed = table.replace(/<tr>([\s\S]*?)<\/tr>/g, (_, inner) => {
    const first = inner.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/);
    return `<tr>${first ? first[0] : ""}</tr>`;
  });

  const { ok, record } = mutate(CERTIFIED, table, narrowed);
  assert.equal(ok, true);
  assert.ok(record.data_handling.includes("Calendars.Read:"));
  assert.ok(!record.data_handling.includes("(undefined)"));
  assert.deepEqual(record.graph_permissions.slice(0, 2), ["Calendars.Read", "Files.Read.All"]);
});

// ------------------------------------------------------------ the --dry rail

test("a stage script refuses an argument it does not recognise", () => {
  // npm hands `npm run harvest:ingest -- --dry --limit 5` to the child as
  // ["5"], having parsed both flags as its own configuration. A leftover bare
  // value is the fingerprint of that, and on the ingest script the flag npm
  // ate is the one that stops the run writing to the database.
  assert.deepEqual(readCliArgs({ booleans: ["dry"], numbers: ["limit"] }, ["5"]), {
    ok: false,
    error: 'Unrecognised argument "5".',
  });
  assert.equal(readCliArgs({ booleans: ["dry"] }, ["--dry-run"]).ok, false);
  assert.equal(readCliArgs({ numbers: ["limit"] }, ["--limit"]).ok, false);
  assert.equal(readCliArgs({ numbers: ["limit"] }, ["--limit", "0"]).ok, false);
  assert.equal(readCliArgs({ numbers: ["limit"] }, ["--limit", "half"]).ok, false);
});

test("the flags a stage script does recognise are read", () => {
  const spec = { booleans: ["dry", "refresh"], numbers: ["limit"] };
  assert.deepEqual(readCliArgs(spec, []), { ok: true, values: { dry: false, refresh: false, limit: 0 } });
  assert.deepEqual(readCliArgs(spec, ["--dry", "--limit", "40"]), {
    ok: true,
    values: { dry: true, refresh: false, limit: 40 },
  });
});
