#!/usr/bin/env node
/**
 * Examine an ABACUS band file's exact row structure, including any irregular tail.
 *
 *   node scripts/probe-band-shape.mjs <file>
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const target = resolve(process.argv[2]);
const lines = readFileSync(target, 'utf8')
  .split(/\r\n|\n|\r/)
  .filter((l) => l.trim() !== '');

console.log(`file    ${target}`);
console.log(`lines   ${lines.length}`);

const rows = lines.map((line, index) => {
  const t = line.trim().split(/\s+/);
  return { index, width: t.length, first: t[0], second: t[1], third: t[2] };
});

const widths = new Map();
for (const r of rows) widths.set(r.width, (widths.get(r.width) ?? 0) + 1);
console.log(`widths  ${[...widths.entries()].map(([w, n]) => `${w}x${n}`).join(' ')}`);

console.log('\nfirst 3 rows:');
for (const r of rows.slice(0, 3)) console.log(`  [${r.index}] width=${r.width} ${r.first} | ${r.second} | ${r.third}`);

console.log('\nlast 3 rows:');
for (const r of rows.slice(-3)) console.log(`  [${r.index}] width=${r.width} ${r.first} | ${r.second} | ${r.third}`);

// Where does the first column stop increasing by exactly 1?
console.log('\nfirst-column walk (any break):');
let prev = null;
let breaks = 0;
for (const r of rows) {
  const v = Number(r.first);
  if (prev !== null && v !== prev + 1) {
    if (breaks < 10) console.log(`  break at row ${r.index}: ${prev} -> ${r.first}`);
    breaks += 1;
  }
  prev = v;
}
if (breaks === 0) console.log('  none — contiguous 1..N');
else console.log(`  total breaks: ${breaks}`);

// Does the second column look like a monotonic k-path?
const kp = rows.map((r) => Number(r.second));
let kmono = true;
for (let i = 1; i < kp.length; i += 1) if (kp[i] < kp[i - 1]) { kmono = false; break; }
console.log(`\nkpath monotonic: ${kmono}  (${kp[0]} .. ${kp[kp.length - 1]})`);
if (!kmono) {
  for (let i = 1; i < kp.length; i += 1) {
    if (kp[i] < kp[i - 1]) {
      console.log(`  first decrease at row ${i}: ${kp[i - 1]} -> ${kp[i]}`);
      break;
    }
  }
}
