#!/usr/bin/env node
/**
 * Compare a real k-point convergence series and print what the panel would show.
 *
 *   node scripts/probe-kconvergence.mjs <runA> <runB> [<runC> ...] [--kind QSGW] [--iter N]
 *
 * Each argument is a task directory. Labels come from the parent directory name so a
 * k444/k666 pair is readable in the output.
 */
import { resolve } from 'node:path';
import { compareRuns } from '../lib/host/kconvergence.js';

const args = process.argv.slice(2);
const kindIndex = args.indexOf('--kind');
const kind = kindIndex >= 0 ? args[kindIndex + 1] : 'QSGW';
const iterIndex = args.indexOf('--iter');
const iteration = iterIndex >= 0 ? Number(args[iterIndex + 1]) : null;
const paths = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));

if (paths.length < 2) {
  console.error('usage: node scripts/probe-kconvergence.mjs <runA> <runB> [...] [--kind QSGW] [--iter N]');
  process.exit(2);
}

const runs = paths.map((p) => {
  const abs = resolve(p);
  const parts = abs.split(/[\\/]/);
  // Label = "<run>/<task>" so "k444/frozen" vs "k666/frozen" is obvious.
  const task = parts[parts.length - 1];
  const run = parts[parts.length - 2];
  return { label: `${run}/${task}`, absPath: abs, librpaOutDir: 'librpa.d' };
});

const result = compareRuns(runs, { kind, iteration });

console.log(`kind=${result.kind} spin=${result.spin} iteration=${result.iteration ?? 'latest'}`);
console.log(`k-path identical: ${result.kPathIdentical} ${result.kPathReason ? `(${result.kPathReason})` : ''}`);
console.log('');
console.log('label'.padEnd(46), 'nK'.padStart(5), 'nB'.padStart(4), 'iter'.padStart(5),
            'gap/eV'.padStart(9), 'VBM'.padStart(10), 'CBM'.padStart(10), 'Δgap'.padStart(9));
for (const row of result.rows) {
  const f = (v, d = 4) => (typeof v === 'number' ? v.toFixed(d) : '—');
  console.log(
    String(row.label).padEnd(46),
    String(row.nKpoint).padStart(5),
    String(row.nBand).padStart(4),
    String(row.iter ?? '—').padStart(5),
    f(row.gapEv).padStart(9),
    f(row.vbmEv).padStart(10),
    f(row.cbmEv).padStart(10),
    f(row.deltaGapVsReferenceEv).padStart(9),
  );
}
if (result.notes.length) {
  console.log('\nnotes:');
  for (const n of result.notes) console.log('  ·', n);
}
if (result.warnings.length) {
  console.log('\nwarnings:');
  for (const w of result.warnings) console.log('  !', w);
}
