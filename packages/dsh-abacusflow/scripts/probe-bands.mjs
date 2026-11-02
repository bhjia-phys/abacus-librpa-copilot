#!/usr/bin/env node
/**
 * Check the ABACUS band parser against real files.
 *
 *   node scripts/probe-bands.mjs <band-file> [...]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAbacusBands, pickMainBlock } from '../lib/host/abacus/bands.js';

for (const file of process.argv.slice(2)) {
  const target = resolve(file);
  let text;
  try {
    text = readFileSync(target, 'utf8');
  } catch (error) {
    console.error(`${target}: ${error.message}`);
    continue;
  }
  const parsed = parseAbacusBands(text, { fileName: target.split(/[\\/]/).pop() });
  console.log(`\n=== ${parsed.fileName}`);
  console.log(`  blocks   ${parsed.nBlock}   nBand ${parsed.nBand}`);
  for (const b of parsed.blocks) {
    console.log(
      `    block ${b.index}: nK=${b.nKpoint} nBand=${b.nBand} ` +
        `kpath ${b.kpathRange[0]}..${b.kpathRange[1]} ` +
        `E ${b.minEnergyEv?.toFixed(3)}..${b.maxEnergyEv?.toFixed(3)} eV ` +
        `monotone=${b.kPathMonotone}`,
    );
  }
  const main = pickMainBlock(parsed);
  console.log(`  main block: ${main ? `nK=${main.nKpoint} nBand=${main.nBand}` : 'none'}`);
  for (const w of parsed.warnings) console.log(`  warning  ${w}`);
}
