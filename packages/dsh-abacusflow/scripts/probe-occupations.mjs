#!/usr/bin/env node
/**
 * Inspect the occupation columns of a LibRPA band file.
 *
 * The k-convergence comparison derives band edges from occupations. If a file's
 * occupations are not 0/1-like (or are scaled by the k-point count), that derivation must
 * be rejected rather than reported as a gap.
 *
 *   node scripts/probe-occupations.mjs <band-file>
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseLibrpaBand } from '../lib/host/librpa/bands.js';

const target = resolve(process.argv[2]);
const parsed = parseLibrpaBand(readFileSync(target, 'utf8'), {
  fileName: target.split(/[\\/]/).pop(),
});

console.log(`file      ${target.split(/[\\/]/).pop()}`);
console.log(`kind      ${parsed.kind} spin ${parsed.spin} iter ${parsed.iter}`);
console.log(`nK/nState ${parsed.nKpoint} / ${parsed.nState}`);

const occ = parsed.rows.flatMap((r) => r.occupations);
const unique = [...new Set(occ.map((v) => Number(v.toFixed(4))))].sort((a, b) => a - b);
console.log(`occupation values (rounded, sorted): ${unique.slice(0, 12).join(', ')}${unique.length > 12 ? ` … (${unique.length} distinct)` : ''}`);
console.log(`min/max occ: ${Math.min(...occ)} / ${Math.max(...occ)}`);

// How many states per k are occupied at a typical k point?
for (const ik of [0, Math.floor(parsed.rows.length / 2)]) {
  const row = parsed.rows[ik];
  const nOcc = row.occupations.filter((v) => v > 0.5).length;
  const occEnergies = row.energiesEv.filter((_, i) => row.occupations[i] > 0.5);
  const emptyEnergies = row.energiesEv.filter((_, i) => row.occupations[i] <= 0.5);
  console.log(
    `k[${ik}] occupied ${nOcc}/${row.energiesEv.length}` +
      `  HOMO ${occEnergies.length ? Math.max(...occEnergies).toFixed(3) : '—'}` +
      `  LUMO ${emptyEnergies.length ? Math.min(...emptyEnergies).toFixed(3) : '—'}`,
  );
}

// Occupied vs empty energy extents, to see whether "gap" is meaningful at all.
const occE = [];
const empE = [];
for (const row of parsed.rows) {
  for (let i = 0; i < row.energiesEv.length; i += 1) {
    if (row.occupations[i] > 0.5) occE.push(row.energiesEv[i]);
    else empE.push(row.energiesEv[i]);
  }
}
const rng = (arr) => (arr.length ? `${Math.min(...arr).toFixed(2)} .. ${Math.max(...arr).toFixed(2)}` : '—');
console.log(`occupied energies range: ${rng(occE)}  (n=${occE.length})`);
console.log(`empty energies range   : ${rng(empE)}  (n=${empE.length})`);
