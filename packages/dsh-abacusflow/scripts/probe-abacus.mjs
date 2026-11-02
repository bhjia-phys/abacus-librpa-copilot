#!/usr/bin/env node
/**
 * Probe the ABACUS input-side parsers against a real task directory.
 *
 *   node scripts/probe-abacus.mjs <task-dir> [<task-dir> ...]
 */
import { resolve } from 'node:path';
import { parseAbacusInput, summarizeParams, kMeshSource } from '../lib/host/abacus/input-params.js';
import { parseStru, cellAngstrom, cellVolume, applyLatname } from '../lib/host/abacus/stru.js';
import { parseKpt } from '../lib/host/abacus/kpt.js';
import { parseInputInfo } from '../lib/host/abacus/input-info.js';
import { struToScene } from '../lib/host/abacus/stru-scene.js';
import { readTextCapped } from '../lib/host/shared/paths.js';

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: node scripts/probe-abacus.mjs <task-dir> ...');
  process.exit(2);
}

for (const dir of dirs) {
  const base = resolve(dir);
  console.log(`\n======== ${base}`);

  const inputRaw = readTextCapped(resolve(base, 'INPUT'), 4 << 20);
  if (inputRaw) {
    const input = parseAbacusInput(inputRaw.text);
    console.log(`INPUT            ${input.entries.length} entries, header=${input.headerPresent}`);
    console.log(`  calculation    ${input.params.calculation ?? '—'}`);
    console.log(`  basis_type     ${input.params.basis_type ?? '—'}`);
    console.log(`  nspin          ${input.params.nspin ?? '—'}`);
    const km = kMeshSource(input.params);
    console.log(`  k-mesh source  ${km.source}${km.kspacing !== null ? ` (${km.kspacing})` : ''}`);
    const summary = summarizeParams(input.params);
    for (const g of summary.groups) {
      console.log(`  [${g.category}] ${g.items.map((i) => `${i.key}=${i.value || '(flag)'}`).join(', ')}`);
    }
    if (summary.unknownKeys.length) console.log(`  unknown        ${summary.unknownKeys.join(', ')}`);
    for (const w of input.warnings) console.log(`  warning        ${w}`);
  } else {
    console.log('INPUT            missing');
  }

  const struRaw = readTextCapped(resolve(base, 'STRU'), 8 << 20);
  if (struRaw) {
    const stru = parseStru(struRaw.text);
    // Mirror task-bundle: a STRU under `latname` has no LATTICE_VECTORS.
    const latname = inputRaw ? parseAbacusInput(inputRaw.text).params.latname : null;
    if (latname) applyLatname(stru, latname);
    console.log(`STRU             natom=${stru.natom} species=${stru.species.map((s) => `${s.label}(${s.pp})`).join(' ')}`);
    console.log(`  coord mode     ${stru.coordinateMode} -> ${stru.coordinateSystem}, centered=${stru.originCentered}`);
    console.log(`  a0             ${stru.latticeConstant} ${stru.latticeConstantUnit}`);
    const cell = cellAngstrom(stru);
    console.log(`  cell (A)       ${cell ? JSON.stringify(cell.map((r) => r.map((v) => Math.round(v * 1e4) / 1e4))) : '—'}`);
    console.log(`  volume (A^3)   ${cellVolume(stru)}`);
    if (stru.atoms.length > 0) {
      const a = stru.atoms[0];
      console.log(
        `  atom 1         ${a.label} coords=${JSON.stringify(a.coords)} frac=${JSON.stringify(a.frac?.map((v) => Math.round(v * 1e4) / 1e4))} cart=${JSON.stringify(a.cartesian?.map((v) => Math.round(v * 1e4) / 1e4))} move=${JSON.stringify(a.move)}`,
      );
    }
    const scene = struToScene(stru, { includeConnectivity: true });
    console.log(`  scene          ${scene.formula} atoms=${scene.natom} bonds=${scene.bonds.length} limited=${scene.connectivityLimited}`);
    for (const w of stru.warnings) console.log(`  warning        ${w}`);
  } else {
    console.log('STRU             missing');
  }

  const kptRaw = readTextCapped(resolve(base, 'KPT'), 1 << 20);
  if (kptRaw) {
    const kpt = parseKpt(kptRaw.text);
    console.log(
      `KPT              mode=${kpt.mode} centering=${kpt.centering ?? '—'} grid=${JSON.stringify(kpt.grid)} ` +
        `shift=${JSON.stringify(kpt.shift)} kMode=${kpt.kMode ?? '—'} nkpts=${kpt.nkpts}`,
    );
    for (const w of kpt.warnings) console.log(`  warning        ${w}`);
  } else {
    console.log('KPT              missing');
  }

  const infoRaw = readTextCapped(resolve(base, 'OUT.autotest', 'INPUT.info'), 4 << 20);
  if (infoRaw) {
    const info = parseInputInfo(infoRaw.text);
    console.log(`INPUT.info       ${info.entries.length} entries, brackets=${info.brackets}`);
    console.log(`  sample         ${info.entries.slice(0, 3).map((e) => `${e.key}=${e.value}`).join(' | ')}`);
    for (const w of info.warnings.slice(0, 3)) console.log(`  warning        ${w}`);
  }
}
