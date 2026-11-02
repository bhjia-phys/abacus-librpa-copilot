#!/usr/bin/env node
/**
 * Probe the LibRPA parsers against a real QSGW run.
 *
 *   node scripts/probe-librpa.mjs <task-dir>
 */
import { resolve } from 'node:path';
import { parseLibrpaIn, summarizeLibrpaParams } from '../lib/host/librpa/input.js';
import {
  parseLibrpaLog,
  parseQsgwEigenvalues,
  parseQsgwIterations,
  classifyLibrpaRun,
} from '../lib/host/librpa/output.js';
import { readTextCapped, safeStat, ageSeconds } from '../lib/host/shared/paths.js';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/probe-librpa.mjs <task-dir>');
  process.exit(2);
}

const base = resolve(dir);

const inputRaw = readTextCapped(resolve(base, 'librpa.in'), 1 << 20);
if (!inputRaw) {
  console.error(`no librpa.in in ${base}`);
  process.exit(1);
}
const input = parseLibrpaIn(inputRaw.text);
console.log(`librpa.in        ${input.entries.length} entries, duplicates: ${JSON.stringify(input.duplicates)}`);
console.log(`task             ${input.params.task ?? '—'}`);
const summary = summarizeLibrpaParams(input.params);
for (const g of summary.groups) {
  console.log(`  [${g.group}] ${g.items.map((i) => `${i.key}=${i.value}`).join(', ')}`);
}
if (summary.unknownKeys.length) console.log(`  unknown: ${summary.unknownKeys.join(', ')}`);

const logRaw = readTextCapped(resolve(base, 'librpa.out'), 64 << 20);
if (logRaw) {
  const log = parseLibrpaLog(logRaw.text);
  console.log(`\nlibrpa.out`);
  console.log(`  mpi            ${JSON.stringify(log.mpi)}`);
  console.log(`  finished       ${log.finished}`);
  console.log(`  startTime      ${log.startTime ?? '—'}`);
  console.log(`  build keys     ${Object.keys(log.build).length}`);
  for (const key of ['Build type', 'Source code Git hash', 'Use LibRI', 'GreenX commit hash', 'C++ compiler']) {
    if (log.build[key] !== undefined) console.log(`    ${key}: ${log.build[key]}`);
  }
  console.log(`  driverParams   ${Object.keys(log.driverParams).length}`);
  console.log(`  timings        ${log.timings.length}`);
  for (const e of log.errors) console.log(`  error ${e.code}: ${e.message} [${e.evidence.slice(0, 100)}]`);

  const outDirRel = (input.params.output_dir ?? './').replace(/^\.\//, '').replace(/\/+$/, '');
  const outDir = resolve(base, outDirRel || '.');

  const eigStat = safeStat(resolve(outDir, 'qsgw_eigenvalues.dat'));
  if (eigStat) {
    const eigRaw = readTextCapped(resolve(outDir, 'qsgw_eigenvalues.dat'), 64 << 20);
    const eig = parseQsgwEigenvalues(eigRaw.text);
    console.log(`\nqsgw_eigenvalues.dat`);
    console.log(`  rows           ${eig.rows.length}`);
    console.log(`  nIter/nK/nBand ${eig.nIter} / ${eig.nKpoint} / ${eig.nBand} (nSpin ${eig.nSpin}, nChannel ${eig.nChannel})`);
    console.log(`  energy range   ${eig.minEnergyEv} .. ${eig.maxEnergyEv} eV`);
    console.log(`  header keys    ${Object.keys(eig.header).length}`);
    for (const w of eig.warnings) console.log(`  warning ${w}`);
  }

  const iterStat = safeStat(resolve(outDir, 'qsgw_iterations.dat'));
  if (iterStat) {
    const iterRaw = readTextCapped(resolve(outDir, 'qsgw_iterations.dat'), 16 << 20);
    const iter = parseQsgwIterations(iterRaw.text);
    console.log(`\nqsgw_iterations.dat`);
    console.log(`  columns        ${iter.columns.join(' ')}`);
    console.log(`  rows           ${iter.rows.length}`);
    console.log(`  convergedIter  ${iter.convergedIter}`);
    for (const row of iter.rows.slice(0, 4)) {
      console.log(
        `    iter ${row.iter}: gap=${row.gap_eV} dE=${row.max_delta_eV} eFermi=${row.efermi_eV} converged=${row.converged}`,
      );
    }
    for (const w of iter.warnings) console.log(`  warning ${w}`);
  }

  const matrices = safeStat(resolve(outDir, 'qsgw_matrices.dat'));
  if (matrices) console.log(`\nqsgw_matrices.dat ${(matrices.size / 1024).toFixed(0)} KiB (not parsed, by design)`);

  const logStat = safeStat(resolve(base, 'librpa.out'));
  console.log(
    `\nstatus         ${JSON.stringify(
      classifyLibrpaRun({
        hasOutput: true,
        logText: logRaw.text,
        exitcode: null,
        mtimeAgeSeconds: ageSeconds(logStat ? logStat.mtimeMs : null),
      }),
    )}`,
  );
} else {
  console.log('\nlibrpa.out missing');
}
