#!/usr/bin/env node
/**
 * Probe `parseLibrpaLog` details (timings, QSGW progress lines, verdict).
 *
 *   node scripts/probe-librpa-log.mjs <librpa.out>
 */
import { parseLibrpaLog } from '../lib/host/librpa/output.js';
import { readTextCapped } from '../lib/host/shared/paths.js';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/probe-librpa-log.mjs <librpa.out>');
  process.exit(2);
}
const got = readTextCapped(target, 64 * 1024 * 1024);
if (!got) {
  console.error(`cannot read ${target}`);
  process.exit(1);
}
const r = parseLibrpaLog(got.text);
console.log(`mpi            ${JSON.stringify(r.mpi)}`);
console.log(`finished       ${r.finished}`);
console.log(`start / end    ${r.startTime ?? '—'} / ${r.endTime ?? '—'}`);
console.log(`build keys     ${Object.keys(r.build).length}`);
console.log(`driverParams   ${Object.keys(r.driverParams).length}`);
console.log(`timings        ${r.timings.length}`);
for (const t of r.timings.slice(0, 8)) {
  console.log(`   ${t.name.padEnd(42)} calls=${t.calls} seconds=${t.seconds} cumulative=${t.cumSeconds}`);
}
if (r.timings.length > 8) console.log(`   … ${r.timings.length - 8} more`);
console.log(`qsgwProgress   ${r.qsgwProgress.length}`);
for (const it of r.qsgwProgress) {
  console.log(`   iter ${it.iteration}: dE=${it.maxDeltaEv} eV gap=${it.gapEv} eV mixer=${it.mixer}`);
}
console.log(`qsgwVerdict    ${JSON.stringify(r.qsgwVerdict)}`);
for (const e of r.errors) console.log(`error          ${e.code}: ${e.message}`);
for (const w of r.warnings) console.log(`warning        ${w}`);
