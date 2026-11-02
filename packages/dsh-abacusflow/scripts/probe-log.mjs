#!/usr/bin/env node
/**
 * Ad-hoc check of one parser against real files. Not a test — a development probe.
 *
 *   node scripts/probe-log.mjs <log-file>
 */
import { parseScfLog, classifyAbacusRun } from '../lib/host/abacus/log.js';
import { readTextCapped } from '../lib/host/shared/paths.js';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/probe-log.mjs <log-file>');
  process.exit(2);
}

const got = readTextCapped(target, 64 * 1024 * 1024);
if (!got) {
  console.error(`cannot read ${target}`);
  process.exit(1);
}

const r = parseScfLog(got.text);
const last = r.iterations[r.iterations.length - 1];

console.log(`file            ${target}`);
console.log(`bytes / lines   ${got.text.length} / ${r.lineCount}`);
console.log(`calculation     ${r.calculation ?? '—'}`);
console.log(`code            ${r.code ?? '—'}`);
console.log(`iterations      ${r.iterations.length}`);
console.log(`ionic steps     ${new Set(r.iterations.map((i) => i.ionicStep)).size}`);
if (last) {
  console.log(
    `last iteration  ion=${last.ionicStep} scf=${last.scfIter} ` +
      `E=${last.eKohnShamEv} eV rho=${last.rhoDeviation} gap=${last.gapEv} eFermi=${last.eFermiEv}`,
  );
}
console.log(`scfConverged    ${r.scfConverged}`);
console.log(`ionicConverged  ${r.ionicConverged}`);
console.log(`finished        ${r.finished}  (${r.totalTimeText ?? 'no Total Time line'})`);
console.log(`lastTotalEnergy ${JSON.stringify(r.lastTotalEnergyEv)}`);
console.log(`forces          ${r.forces.length} rows, unit ${r.forceUnit ?? '—'}, maxForce ${r.maxForce}`);
console.log(`stress          ${r.stress ? JSON.stringify(r.stress) : '—'}`);
console.log(`pressure        ${r.pressure ? JSON.stringify(r.pressure) : '—'}`);
console.log(`timings         ${r.timings.length} rows`);
console.log(`memory          ${r.memory.length} rows`);
for (const e of r.errors) console.log(`error           ${e.code}: ${e.message} [${e.evidence}]`);
for (const w of r.warnings) console.log(`warning         ${w}`);

console.log(
  `status          ${JSON.stringify(
    classifyAbacusRun({
      hasOutputDir: true,
      logText: got.text,
      logFileName: target.split(/[\\/]/).pop(),
      mtimeAgeSeconds: 7200,
    }),
  )}`,
);
