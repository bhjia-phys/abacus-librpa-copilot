#!/usr/bin/env node
/**
 * Check the LibRPA band parser and iteration grouping against a real QSGW run.
 *
 *   node scripts/probe-librpa-bands.mjs <librpa.d dir>
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseLibrpaBand, parseBandFileName, groupBandIterations } from '../lib/host/librpa/bands.js';

const dir = resolve(process.argv[2]);
const names = readdirSync(dir).filter((n) => /^(KS|EXX|QSGW)_band_spin_\d+(_\d+)?\.dat$/i.test(n));
console.log(`dir    ${dir}`);
console.log(`files  ${names.length}`);

// Parse a bounded number so a 12-iteration run does not take minutes on a network path.
const sample = names.sort().slice(0, 6);
const entries = [];
for (const name of sample) {
  const full = join(dir, name);
  const meta = parseBandFileName(name);
  const parsed = parseLibrpaBand(readFileSync(full, 'utf8'), { fileName: name });
  entries.push({ fileName: name, parsed });
  console.log(
    `  ${name.padEnd(26)} kind=${meta?.kind} spin=${meta?.spin} iter=${meta?.iter} ` +
      `nK=${parsed.nKpoint} nState=${parsed.nState} ` +
      `E ${parsed.minEnergyEv?.toFixed(3)}..${parsed.maxEnergyEv?.toFixed(3)} eV`,
  );
  for (const w of parsed.warnings) console.log(`    warning ${w}`);
}

const grouped = groupBandIterations(
  names.map((name) => ({ fileName: name, parsed: { kind: parseBandFileName(name)?.kind, spin: parseBandFileName(name)?.spin, iter: parseBandFileName(name)?.iter, rows: [1] } })),
);
console.log('\ngroups (from file names):');
for (const g of grouped.series) {
  console.log(`  ${g.kind} spin ${g.spin}: iterations ${g.iterations.map((i) => i.iter).join(', ')}`);
}

// Size note: these files are ~870 KiB each on the real run.
const totalBytes = names.reduce((sum, n) => sum + statSync(join(dir, n)).size, 0);
console.log(`\ntotal size ${(totalBytes / 1024 / 1024).toFixed(1)} MiB across ${names.length} files`);
