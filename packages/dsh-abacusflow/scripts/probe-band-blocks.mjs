#!/usr/bin/env node
/**
 * Dump the region where a band file's k index restarts, to learn its block structure.
 *
 *   node scripts/probe-band-blocks.mjs <file>
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const target = resolve(process.argv[2]);
const lines = readFileSync(target, 'utf8')
  .split(/\r\n|\n|\r/)
  .filter((l) => l.trim() !== '');

const rows = lines.map((line) => {
  const t = line.trim().split(/\s+/);
  return { ik: Number(t[0]), kpath: Number(t[1]), n: t.length - 2 };
});

// Find every place the ik column restarts at 1.
const starts = [0];
for (let i = 1; i < rows.length; i += 1) {
  if (rows[i].ik !== rows[i - 1].ik + 1) starts.push(i);
}

console.log(`file    ${target}`);
console.log(`rows    ${rows.length}`);
console.log(`blocks  ${starts.length} (start indices: ${starts.join(', ')})`);

for (let b = 0; b < starts.length; b += 1) {
  const from = starts[b];
  const to = b + 1 < starts.length ? starts[b + 1] - 1 : rows.length - 1;
  const slice = rows.slice(from, to + 1);
  console.log(
    `\nblock ${b}: rows ${from}..${to} (${slice.length} rows) ` +
      `ik ${slice[0].ik}..${slice[slice.length - 1].ik} ` +
      `kpath ${slice[0].kpath}..${slice[slice.length - 1].kpath} ` +
      `nband ${slice[0].n}`,
  );
  // Is kpath monotone inside the block?
  let mono = true;
  for (let i = 1; i < slice.length; i += 1) {
    if (slice[i].kpath < slice[i - 1].kpath) { mono = false; break; }
  }
  console.log(`         kpath monotone: ${mono}`);
  if (slice.length <= 70) {
    console.log(`         kpath samples: ${slice.slice(0, 6).map((r) => r.kpath).join(', ')} …`);
  }
}

// Show the transition rows explicitly.
console.log('\ntransition rows:');
for (const s of starts) {
  if (s === 0) continue;
  for (let i = Math.max(0, s - 2); i <= Math.min(rows.length - 1, s + 1); i += 1) {
    console.log(`  [${i}] ik=${rows[i].ik} kpath=${rows[i].kpath} nband=${rows[i].n}`);
  }
}
