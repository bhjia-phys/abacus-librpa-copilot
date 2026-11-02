#!/usr/bin/env node
/**
 * Read the band data of a real task directory through the same path the panel uses.
 *
 *   node scripts/probe-bands-task.mjs <task-dir> [--out OUT.suffix] [--librpa-out librpa.d] [--iter N]
 */
import { resolve } from 'node:path';
import { readBands } from '../lib/host/bands.js';

const args = process.argv.slice(2);
const pick = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const taskDir = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true);
const target = resolve(taskDir ?? args[0]);

const result = readBands(target, {
  outDir: pick('--out'),
  librpaOutDir: pick('--librpa-out'),
  lrpaIteration: pick('--iter') ? Number(pick('--iter')) : null,
});

console.log(`task       ${target}`);
console.log(`error      ${JSON.stringify(result.error)}`);

console.log(`\nABACUS channels (${result.abacus.length}):`);
for (const c of result.abacus) {
  console.log(
    `  ${c.file.padEnd(12)} spin=${c.spin} blocks=${c.nBlock} nK=${c.nKpoint} nBand=${c.nBand} ` +
      `E ${c.minEnergyEv?.toFixed(3)}..${c.maxEnergyEv?.toFixed(3)} eV`,
  );
  for (const b of c.blocks) {
    console.log(`      block ${b.index}: nK=${b.nKpoint} kpath ${b.kpathRange[0]}..${b.kpathRange[1]}`);
  }
}

console.log(`\nLibRPA channels (${result.librpa.length}):`);
for (const c of result.librpa) {
  console.log(
    `  ${c.file.padEnd(26)} kind=${c.kind} spin=${c.spin} iter=${c.iter} ` +
      `nK=${c.nKpoint} nBand=${c.nBand} E ${c.minEnergyEv?.toFixed(3)}..${c.maxEnergyEv?.toFixed(3)} eV ` +
      `path 0..${c.kpath[c.kpath.length - 1]?.toFixed(4)}`,
  );
}

console.log(`\navailability (${result.availability.length} series):`);
for (const a of result.availability) {
  console.log(`  ${a.key}: ${a.fileCount} files, iterations ${a.iterations.join(',')}`);
}

for (const n of result.notes) console.log(`note    ${n}`);
for (const w of result.warnings) console.log(`warning ${w}`);
