#!/usr/bin/env node
/**
 * Probe the LibRPA `energy_qp` / band-file parsers against real files.
 *
 *   node scripts/probe-energy-qp.mjs <energy_qp> [<GW_band_spin_1.dat> ...]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnergyQp, parseBandSpin } from '../lib/host/librpa/energy-qp.js';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/probe-energy-qp.mjs <energy_qp> [...]');
  process.exit(2);
}

for (const file of files) {
  const target = resolve(file);
  let text;
  try {
    text = readFileSync(target, 'utf8');
  } catch (error) {
    console.error(`cannot read ${target}: ${error.message}`);
    continue;
  }
  console.log(`\n=== ${target} (${text.length} bytes)`);

  if (/state\s+occ_num/i.test(text) || /K_point/.test(text)) {
    const qp = parseEnergyQp(text);
    console.log(`  rows        ${qp.rows.length}`);
    console.log(`  nK/nState   ${qp.nKpoint} / ${qp.nState} (nSpin ${qp.nSpin})`);
    console.log(`  QP range    ${qp.minQpEv} .. ${qp.maxQpEv} eV`);
    for (const row of qp.rows.slice(0, 4)) {
      console.log(
        `    k=${row.kpoint} state=${row.state} occ=${row.occupation} ` +
          `eGs=${row.eGsEv.toFixed(4)} eV eQp=${row.eQpEv.toFixed(4)} eV Δ=${row.deltaEv.toFixed(4)} eV`,
      );
    }
    for (const w of qp.warnings.slice(0, 3)) console.log(`  warning     ${w}`);
  } else {
    const band = parseBandSpin(text);
    console.log(`  k-points    ${band.nKpoint}, max states ${band.nState}`);
    for (const row of band.rows.slice(0, 2)) {
      console.log(
        `    ik=${row.ik} k=${JSON.stringify(row.k)} first state: occ=${row.states[0]?.occupation} E=${row.states[0]?.energyEv}`,
      );
    }
    for (const w of band.warnings.slice(0, 3)) console.log(`  warning     ${w}`);
  }
}
