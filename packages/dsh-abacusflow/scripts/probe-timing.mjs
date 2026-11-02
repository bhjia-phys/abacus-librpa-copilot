#!/usr/bin/env node
/**
 * Break down where a scan's wall time actually goes.
 *
 *   node scripts/probe-timing.mjs <root> [--depth N]
 *
 * A network/UNC path makes every `stat` a round trip, so "it feels slow" is usually one
 * specific phase; this says which.
 */
import { scanProject } from '../lib/host/scanner.js';
import { probeTaskStatus, buildTaskBundle } from '../lib/host/task-bundle.js';

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith('--'));
const depthIndex = args.indexOf('--depth');
const depth = depthIndex >= 0 ? Number(args[depthIndex + 1]) : 4;

if (!root) {
  console.error('usage: node scripts/probe-timing.mjs <root> [--depth N]');
  process.exit(2);
}

const mark = (label, started) => {
  const ms = Date.now() - started;
  console.log(`${label.padEnd(28)} ${String(ms).padStart(7)} ms`);
  return Date.now();
};

let t = Date.now();
const scan = await scanProject(root, { maxDepth: depth });
t = mark('scanProject (full)', t);
console.log(`  dirs=${scan.scannedDirs} tasks=${scan.tasks.length} truncated=${scan.truncated}`);

const tProbe0 = Date.now();
const probes = scan.tasks.map((task) => probeTaskStatus(task));
const tProbe1 = mark('probeTaskStatus x tasks', tProbe0);
console.log(`  codes: ${probes.map((p) => p.code).join(', ')}`);

const tFull0 = Date.now();
for (const task of scan.tasks) buildTaskBundle(task, { includeScene: false });
const tFull1 = mark('buildTaskBundle x tasks', tFull0);

const tScene0 = Date.now();
for (const task of scan.tasks) buildTaskBundle(task, { includeScene: true });
mark('buildTaskBundle + scene', tScene0);

console.log(`\nnote: probes ${tProbe1 - tProbe0} ms vs full ${tFull1 - tFull0} ms ` +
  `(${((tFull1 - tFull0) / Math.max(1, tProbe1 - tProbe0)).toFixed(1)}x)`);
