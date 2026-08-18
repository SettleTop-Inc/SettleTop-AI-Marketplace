#!/usr/bin/env node
/**
 * Run every marketplace, one command.
 *
 *   node scripts/harvest.mjs                     # all sources, then logos
 *   node scripts/harvest.mjs --marketplace drai  # one source
 *   node scripts/harvest.mjs --skip-logos
 *   node scripts/harvest.mjs --list
 *
 * The registry holds more than one catalogue and will hold more, so the thing
 * worth having is one command that brings all of them current rather than a
 * remembered sequence per source.
 *
 * FAILURE ISOLATION IS THE POINT. Sources are independent catalogues, so a
 * source that breaks must not stop the others: DRAI is ~15 assets and Microsoft
 * is 6,820, and letting the small new one abort the large established one would
 * be exactly backwards. Each source runs in its own child process, a failing
 * stage ends only that source, and the run reports what did and did not finish.
 * The exit code is non-zero if anything failed, so CI still notices.
 *
 * Every stage is independently resumable and idempotent, which is what makes
 * "just run it again" a real answer here rather than a hope.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SOURCES, SHARED_STAGES, sourceById } from "./lib/sources/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const only = args.includes("--marketplace") ? args[args.indexOf("--marketplace") + 1] : null;
const skipLogos = args.includes("--skip-logos");

if (args.includes("--list")) {
  for (const s of SOURCES) console.log(`${s.id.padEnd(12)} ${s.name}  (${s.stages.length} stages)`);
  process.exit(0);
}

if (only && !sourceById(only)) {
  console.error(`Unknown marketplace "${only}". Known: ${SOURCES.map((s) => s.id).join(", ")}`);
  process.exit(1);
}

const targets = only ? [sourceById(only)] : SOURCES;

/** Run one stage script as a child, inheriting stdio so its own output is the output. */
function runStage(script, env) {
  return new Promise((resolve) => {
    const path = join(HERE, script);
    if (!existsSync(path)) return resolve({ ok: false, skipped: true, reason: "not implemented yet" });
    const child = spawn(process.execPath, [path], {
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("close", (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, reason: `exit ${code}` })
    );
    child.on("error", (e) => resolve({ ok: false, reason: e.message }));
  });
}

const started = Date.now();
const report = [];

for (const source of targets) {
  console.log(`\n${"=".repeat(64)}\n${source.name}  (${source.id})\n${"=".repeat(64)}`);
  let failedAt = null;
  const skipped = [];

  for (const stage of source.stages) {
    console.log(`\n--- ${source.id} / ${stage} ---`);
    const r = await runStage(stage, { HARVEST_MARKETPLACE: source.id });
    if (r.skipped) {
      // A named-but-absent stage is a source mid-build, not a crash. Say so and
      // keep going rather than failing a run for work that has not landed yet.
      console.log(`    skipped: ${stage} ${r.reason}`);
      skipped.push(stage);
      continue;
    }
    if (!r.ok) {
      // Stop THIS source at its first failure — later stages consume earlier
      // output, so continuing would ingest a half-built catalogue.
      console.error(`    FAILED: ${stage} (${r.reason})`);
      failedAt = stage;
      break;
    }
  }

  report.push({
    source: source.id,
    failedAt,
    skipped,
    ranNothing: !failedAt && skipped.length === source.stages.length,
  });
}

if (!skipLogos && !report.every((r) => r.failedAt)) {
  console.log(`\n${"=".repeat(64)}\nLogos (all sources)\n${"=".repeat(64)}`);
  for (const stage of SHARED_STAGES) {
    const r = await runStage(stage, {});
    if (!r.ok && !r.skipped) console.error(`    FAILED: ${stage} (${r.reason})`);
    report.push({ source: "(shared)", failedAt: r.ok || r.skipped ? null : stage, skipped: [] });
  }
}

const mins = ((Date.now() - started) / 60000).toFixed(1);
console.log(`\n${"=".repeat(64)}`);
for (const r of report) {
  // "ok" has to mean work happened. A source whose every stage was absent ran
  // nothing at all, and reporting that as success is how a half-built pipeline
  // gets mistaken for a working one.
  const state = r.failedAt
    ? `FAILED at ${r.failedAt}`
    : r.ranNothing
      ? "nothing ran (no stages implemented)"
      : "ok";
  const note = r.skipped.length && !r.ranNothing ? `  (skipped: ${r.skipped.join(", ")})` : "";
  console.log(`  ${r.source.padEnd(12)} ${state}${note}`);
}
console.log(`  ${mins} minutes`);

process.exit(report.some((r) => r.failedAt) ? 1 : 0);
