#!/usr/bin/env node
/**
 * Reproduce the handoff message the panel composes, using real scan data.
 *
 * The composer lives in the client's pure section (no React, no DOM), so it can be lifted
 * out and driven here. This exists to answer one question honestly: *would an agent reading
 * this message have enough to act, and is anything it says wrong?*
 *
 *   node scripts/probe-handoff.mjs <root-dir> [<run-substring>]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.argv[2];
const wanted = process.argv[3] ?? '';
if (!root) {
  console.error('usage: node scripts/probe-handoff.mjs <root-dir> [<run-substring>]');
  process.exit(2);
}

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const begin = source.indexOf('/* @pure-begin */');
const end = source.indexOf('/* @pure-end */');
if (begin < 0 || end < 0) {
  console.error('pure section markers not found');
  process.exit(1);
}
const pure = source.slice(begin, end);

// Build a tiny module out of the pure section: it references nothing external.
const factory = new Function(`${pure}
return {
  groupIntoRuns, buildRunSummary, buildStages, buildLedger,
  buildHandoffMessage, handoffIntents, PRODUCER_LABEL,
};`);
const api = factory();

// ---- real scan, through the host -------------------------------------------------------
const { scanProject } = await import('../lib/host/scanner.js');
const { buildTaskBundle, probeTaskStatus } = await import('../lib/host/task-bundle.js');
const { readBands, compactBands } = await import('../lib/host/bands.js');

const scan = await scanProject(resolve(root), { maxDepth: 4 });
console.log(`scanned ${scan.tasks.length} tasks under ${root}`);

// Enrich each task the way the panel does: bundle + status.
const bundles = new Map();
for (const task of scan.tasks) {
  let bundle = null;
  try {
    bundle = buildTaskBundle(task);
  } catch (error) {
    bundle = { task, error: String(error.message || error) };
  }
  bundles.set(task.id, bundle);
}

const runs = api.groupIntoRuns(scan.tasks);
console.log(`grouped into ${runs.length} run(s)`);

const target = wanted
  ? runs.find((r) => JSON.stringify(r).toLowerCase().includes(wanted.toLowerCase()))
  : runs[0];
if (!target) {
  console.error(`no run matching ${JSON.stringify(wanted)}`);
  process.exit(1);
}

// The panel derives stage state from the bundle; mirror that.
const items = (target.stages || []).map((stage) => {
  const bundle = bundles.get(stage.id) || { task: stage, status: { code: 'unknown', label: '未知' } };
  a = bundle;
});

console.log('\nrun:', target.name, '\n  absPath:', target.absPath);
console.log('  stages:', (target.stages || []).length);
for (const stage of target.stages || []) {
  const bundle = bundles.get(stage.id);
  const status = bundle && bundle.status ? bundle.status : null;
  console.log(`   - ${stage.rel || stage.name} [${stage.kind}] status=${status ? status.code : '?'} (${status ? status.label : '?'})`);
}
