#!/usr/bin/env node
/**
 * Inspect an ABACUS band file: exact column layout, band count and k-path extent.
 *
 *   node scripts/probe-band.mjs <bands1.txt|bands2.txt|band.txt> [...]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

for (const file of process.argv.slice(2)) {
  const target = resolve(file);
  let text;
  try {
    text = readFileSync(target, 'utf8');
  } catch (error) {
    console.error(`${target}: ${error.message}`);
    continue;
  }
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
  console.log(`\n=== ${target}`);
  console.log(`  lines        ${lines.length}`);

  const parse = (line) => line.trim().split(/\s+/);
  const first = parse(lines[0]);
  const last = parse(lines[lines.length - 1]);
  console.log(`  first row    ik=${first[0]} kpath=${first[1]} values=${first.length - 2}`);
  console.log(`  last row     ik=${last[0]} kpath=${last[1]} values=${last.length - 2}`);

  // Column count consistency across all rows.
  const widths = new Set(lines.map((l) => parse(l).length));
  console.log(`  column widths ${[...widths].join(', ')}${widths.size > 1 ? '  <-- INCONSISTENT' : ''}`);

  // k-path monotonic?
  const kpaths = lines.map((l) => Number(parse(l)[1]));
  const monotonic = kpaths.every((v, i) => i === 0 || v >= kpaths[i - 1]);
  console.log(`  kpath range  ${kpaths[0]} .. ${kpaths[kpaths.length - 1]} (monotonic=${monotonic})`);

  // Energy extent over the whole file.
  let min = Infinity;
  let max = -Infinity;
  let flat = 0;
  for (const line of lines) {
    const tokens = parse(line);
    for (let i = 2; i < tokens.length; i += 1) {
      const value = Number(tokens[i]);
      if (!Number.isFinite(value)) {
        flat += 1;
        continue;
      }
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  console.log(`  energy range ${min.toFixed(4)} .. ${max.toFixed(4)} eV (non-numeric ${flat})`);

  // The first band index column: is it 1-based and contiguous?
  const iks = lines.map((l) => Number(parse(l)[0]));
  const contiguous = iks.every((v, i) => v === i + 1);
  console.log(`  ik column    ${iks[0]} .. ${iks[iks.length - 1]} (1-based contiguous=${contiguous})`);
}
