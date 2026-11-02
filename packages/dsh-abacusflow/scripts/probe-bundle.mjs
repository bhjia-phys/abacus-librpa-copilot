#!/usr/bin/env node
/**
 * Inspect the exact shapes the bundle hands to the panel, for one task.
 *
 *   node scripts/probe-bundle.mjs <task-dir> [<root>]
 *
 * Prints the fields the UI renders, so a mismatch between parser output and a renderer
 * shows up as `undefined` here instead of a blank panel.
 */
import { scanSingleDir, scanProject } from '../lib/host/scanner.js';
import { buildTaskBundle } from '../lib/host/task-bundle.js';

const [target, rootArg] = process.argv.slice(2);
if (!target) {
  console.error('usage: node scripts/probe-bundle.mjs <task-dir> [<root>]');
  process.exit(2);
}
const root = rootArg ?? target;

let task = await scanSingleDir(target, root);
if (!task) {
  const scan = await scanProject(root, { maxDepth: 6 });
  task = scan.tasks.find((t) => t.relPath === target || t.absPath === target) ?? scan.tasks[0];
}
if (!task) {
  console.error(`no task at ${target}`);
  process.exit(1);
}

const bundle = buildTaskBundle(task);

console.log(`task          ${task.relPath} [${task.kind}]`);
console.log(`status        ${bundle.status.label} (${bundle.status.code})`);

const a = bundle.abacus;
if (a) {
  console.log(`\n--- abacus section`);
  console.log(`  calculation      ${a.calculation}`);
  console.log(`  basisType        ${a.basisType}`);
  console.log(`  outputDir        ${a.outputDir}`);
  console.log(`  logFile          ${a.logFile}`);
  console.log(`  latname          ${a.latname}`);
  console.log(`  cellVolumeA3     ${a.cellVolumeAngstrom3}`);
  console.log(`  versions         ${JSON.stringify(a.versions)}`);
  console.log(`  stru exists      ${Boolean(a.stru)}`);
  if (a.stru) {
    console.log(`    natom          ${a.stru.natom}`);
    console.log(`    species        ${JSON.stringify(a.stru.species)}`);
    console.log(`    speciesLabels  ${JSON.stringify(a.stru.species.map((s) => s.label))}`);
    console.log(`    coordinateMode ${a.stru.coordinateMode}`);
    console.log(`    latticeConst   ${a.stru.latticeConstant} ${a.stru.latticeConstantUnit}`);
    console.log(`    warnings       ${JSON.stringify(a.stru.warnings)}`);
  }
  console.log(`  kpt              ${a.kpt ? JSON.stringify({ mode: a.kpt.mode, centering: a.kpt.centering, grid: a.kpt.grid, nkpts: a.kpt.nkpts }) : 'null'}`);
  console.log(`  log exists       ${Boolean(a.log)}`);
  if (a.log) {
    console.log(`    iterations     ${a.log.iterations.length}`);
    console.log(`    scfConverged   ${a.log.scfConverged}`);
    console.log(`    finished       ${a.log.finished}`);
    console.log(`    maxForce       ${a.log.maxForce}`);
    console.log(`    errors         ${JSON.stringify(a.log.errors)}`);
  }
  console.log(`  paramsSummary    ${a.paramsSummary ? a.paramsSummary.groups.map((g) => `${g.category}(${g.items.length})`).join(' ') : 'null'}`);
}

const s = bundle.structureScene;
console.log(`\n--- structureScene`);
if (s) {
  console.log(`  natom            ${s.natom}`);
  console.log(`  formula          ${JSON.stringify(s.formula)}`);
  console.log(`  counts           ${JSON.stringify(s.counts)}`);
  console.log(`  volume           ${s.volume}`);
  console.log(`  bonds            ${s.bonds.length}`);
  console.log(`  cell             ${JSON.stringify(s.cell)}`);
  console.log(`  warnings         ${JSON.stringify(s.warnings)}`);
  console.log(`  atom0            ${JSON.stringify(s.atoms[0])}`);
} else {
  console.log('  null');
}

if (bundle.librpa) {
  const l = bundle.librpa;
  console.log(`\n--- librpa section`);
  console.log(`  task             ${l.task}`);
  console.log(`  outputDir        ${l.outputDir}`);
  console.log(`  log.build keys   ${Object.keys(l.log?.build ?? {}).length}`);
  console.log(`  qsgw.iterations  ${l.qsgw?.iterations?.rows?.length ?? 'null'}`);
  console.log(`  qsgw.eigenvalues ${l.qsgw?.eigenvalues ? `${l.qsgw.eigenvalues.nIter}x${l.qsgw.eigenvalues.nKpoint}x${l.qsgw.eigenvalues.nBand}` : 'null'}`);
  console.log(`  energyQp rows    ${l.energyQp?.rows?.length ?? 'null'}`);
}

console.log(`\n--- notes`);
for (const note of bundle.notes) console.log(`  · ${note}`);
