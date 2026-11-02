#!/usr/bin/env node
/**
 * Exercise the band HTTP route end to end against a real task, using the same code the
 * running host would use.
 *
 *   node scripts/probe-bands-route.mjs <task-dir> [--out OUT.suffix] [--iter N]
 *
 * This does what the browser does: resolve the task, then call the band reader with the
 * resolved output directories, and report the payload size the client would receive.
 */
import { resolve } from 'node:path';
import { scanSingleDir, scanProject } from '../lib/host/scanner.js';
import { buildTaskBundle } from '../lib/host/task-bundle.js';
import { readBands } from '../lib/host/bands.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const target = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));

const started = Date.now();
const task = await scanSingleDir(target, flag('--root') ?? resolve(target, '..', '..'));
const resolved =
  task ??
  (await scanProject(flag('--root') ?? target, { maxDepth: 4 })).tasks[0];

if (!resolved) {
  console.error(`no task at ${target}`);
  process.exit(1);
}

const bundle = buildTaskBundle(resolved, { includeScene: false });
const bands = readBands(resolved.absPath, {
  outDir: bundle.abacus?.outputDir ?? resolved.outputDir ?? null,
  librpaOutDir: bundle.librpa?.outputDir ?? null,
  lrpaIteration: flag('--iter') ? Number(flag('--iter')) : null,
});

const payload = JSON.stringify(bands);
const elapsed = Date.now() - started;

console.log(`task        ${resolved.relPath} [${resolved.kind}]`);
console.log(`abacus out  ${bundle.abacus?.outputDir ?? '—'}`);
console.log(`librpa out  ${bundle.librpa?.outputDir ?? '—'}`);
console.log(`channels    abacus ${bands.abacus.length}, librpa ${bands.librpa.length}`);
for (const c of bands.abacus) {
  console.log(`  ABACUS ${c.file}: ${c.nKpoint}k x ${c.nBand}b, ${c.nBlock} block(s)`);
}
for (const c of bands.librpa) {
  console.log(`  LibRPA ${c.kind} spin ${c.spin} iter ${c.iter}: ${c.nKpoint}k x ${c.nBand}b`);
}
console.log(`payload     ${(payload.length / 1024).toFixed(1)} KiB`);
console.log(`elapsed     ${elapsed} ms`);
for (const w of bands.warnings) console.log(`warning     ${w}`);
