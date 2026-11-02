#!/usr/bin/env node
/**
 * Exercise the `/bands` route's `only=` modes and report the payload each one costs.
 *
 *   node scripts/probe-bands-modes.mjs <task-dir> [--root R] [--iter N]
 */
import { resolve } from 'node:path';
import { scanSingleDir } from '../lib/host/scanner.js';
import { buildTaskBundle } from '../lib/host/task-bundle.js';
import { readBands, compactBands } from '../lib/host/bands.js';

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const target = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const root = flag('--root') ?? resolve(target, '..', '..');
const iter = flag('--iter') ? Number(flag('--iter')) : null;

const task = await scanSingleDir(target, root);
if (!task) {
  console.error(`no task at ${target}`);
  process.exit(1);
}
const bundle = buildTaskBundle(task, { includeScene: false });

const t0 = Date.now();
const bands = readBands(task.absPath, {
  outDir: bundle.abacus?.outputDir ?? null,
  librpaOutDir: bundle.librpa?.outputDir ?? null,
  lrpaIteration: iter,
});
const readMs = Date.now() - t0;

function simulate(only) {
  const allow = only ? new Set(only.split(',').map((s) => s.trim())) : null;
  const inventoryMode = Boolean(allow && allow.has('inventory'));
  let selected = bands;
  if (allow && !inventoryMode) {
    selected = {
      ...bands,
      abacus: allow.has('abacus') ? bands.abacus : [],
      librpa: bands.librpa.filter((c) => allow.has(`${c.kind}:${c.spin}`) || allow.has(c.kind)),
    };
  }
  const payload = compactBands(selected);
  if (inventoryMode) {
    for (const ch of [...payload.abacus, ...payload.librpa]) { ch.energies = []; ch.kpath = []; }
  }
  return payload;
}

console.log(`task      ${task.relPath}`);
console.log(`read      ${readMs} ms (done once; the route caches it)`);
console.log('');
for (const mode of [null, 'inventory', 'abacus', 'KS:1', 'QSGW:1', 'KS:1,QSGW:1']) {
  const payload = simulate(mode);
  const size = JSON.stringify(payload).length;
  const nA = payload.abacus.length;
  const nL = payload.librpa.length;
  const hasData = payload.abacus.some((c) => (c.energies || []).length > 0)
    || payload.librpa.some((c) => (c.energies || []).length > 0);
  console.log(
    `  only=${String(mode).padEnd(14)} ${(size / 1024).toFixed(0).padStart(5)} KiB  ` +
      `abacus ${nA} librpa ${nL}  bandArrays=${hasData}`,
  );
}
