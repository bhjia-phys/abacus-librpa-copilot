/**
 * End-to-end checks over a synthetic project tree plus the real WSL files when reachable.
 *
 * The synthetic tree is always built, so this test is meaningful on any machine. The
 * real-file checks are skipped (not failed) when the checkouts are absent, because the
 * plugin must work on machines that never saw this particular WSL distribution.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanProject, scanSingleDir, inputSuffix } from '../lib/host/scanner.js';
import { TaskStore } from '../lib/host/task-store.js';
import { buildTaskBundle } from '../lib/host/task-bundle.js';
import { physicsPath } from '../scripts/lib/local-data.mjs';

const ABACUS_ROOT = physicsPath('repo', 'runs', 'h2-pr-master-ghj-20260724');
const LIBRPA_ROOT = physicsPath('repo', 'runs', 'librpa-qsgw-si-k333-1027891-20260724');

const INPUT_TEXT = `INPUT_PARAMETERS
suffix          si2
calculation     scf
ecutwfc         60
scf_nmax        100
scf_thr         1e-6
basis_type      lcao
nspin           1
# a comment
gamma_only
`;

const STRU_TEXT = `ATOMIC_SPECIES
Si 1.000 Si.pz-vbc.UPF

NUMERICAL_ORBITAL
./Si_lda_8.0au_50Ry_2s2p1d

LATTICE_CONSTANT
10.2

LATTICE_VECTORS
0.0 0.5 0.5
0.5 0.0 0.5
0.5 0.5 0.0

ATOMIC_POSITIONS
Cartesian
Si
0.0
2
0.00 0.00 0.00 0 0 0
0.25 0.25 0.25 1 1 1
`;

const KPT_TEXT = `K_POINTS
0
Gamma
4 4 4 0 0 0
`;

const LOG_TEXT = `                              ABACUS v3.9.0.25

 READING UNITCELL INFORMATION
                       Number of elements = 1

 --> #ION MOVE#         1  #ELEC ITER#         1
 Electron density deviation 0.439953
 ----------------------------------------------------------
      Energy           Rydberg                 eV
 ----------------------------------------------------------
  E_KohnSham     -2.3121239863        -31.4580606961
  E_Fermi        -0.2998687478        -4.0799236221
  E_gap(k)       1.2362915078         16.8206088956
 ----------------------------------------------------------

 --> #ION MOVE#         1  #ELEC ITER#         2
 Electron density deviation 0.091088
  E_KohnSham     -2.3185679050        -31.5457347082
  E_Fermi        -0.0996402683        -1.3556753991

 #SCF IS CONVERGED#
 #TOTAL ENERGY# -31.5522779370 eV

 ----------------------------------------------------------
   CLASS_NAME           NAME        TIME/s  CALLS   AVG/s  PER/%
 ----------------------------------------------------------
                 total              0.41   13       0.03   100.00

 Total  Time  : 0 h 0 mins 0 secs
`;

const LIBRPA_IN = `task = g0w0
input_dir = ../dataset
output_dir = ./librpa.d/
nfreq = 6
parallel_routing = libri
output_energy_qp = false
`;

const LIBRPA_LOG = `Initialized LibRPA global environment at [2026-07-24 03:23:27.967]
LibRPA CMake build info:
| Build type               : Debug
| Source code Git hash     : 1027891ffefa54af355da850736e96a451c456f9
| Use LibRI                : ON

========= Begin driver parameters =========
task = g0w0
constants_choice = aims
input_dir = ../dataset/
==========================================

libRPA finished successfully
`;

const QSGW_ITER = `# qsgw_contract_version 6
# qsgw_mixer none
# iter max_delta_eV residual_l2_Ha residual_max_Ha efermi_eV gap_eV electron_count requested_mode applied_mode beta fallback rcond coefficient_l1 coefficient_count converged coefficients fallback_reason
0 0.000000e+00 0.000000e+00 0.000000e+00 -4.624735 1.909844 28.00 -1 -1 0.2 0 1.0 0.0 0 0 none none
1 9.181527e+01 2.781502e+01 3.373594e+00 -2.836036 7.211480 28.00 -1 -1 0.2 0 1.0 0.0 0 1 none none
`;

const QSGW_EIG = `# qsgw_contract_version 6
# qsgw_mixer none
# iter channel spin kpoint kx ky kz band energy_eV
0 0 0 0 0.0 0.0 0.0 0 -1.79077515426670539e+03
0 0 0 0 0.0 0.0 0.0 1 -1.79077515426338664e+03
1 0 0 0 0.0 0.0 0.0 0 -1.79070000000000000e+03
`;

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'abacusflow-e2e-'));
  // ABACUS task with a finished run.
  const abacusDir = join(root, 'si2-scf');
  mkdirSync(abacusDir, { recursive: true });
  writeFileSync(join(abacusDir, 'INPUT'), INPUT_TEXT);
  writeFileSync(join(abacusDir, 'STRU'), STRU_TEXT);
  writeFileSync(join(abacusDir, 'KPT'), KPT_TEXT);
  mkdirSync(join(abacusDir, 'OUT.si2'), { recursive: true });
  writeFileSync(join(abacusDir, 'OUT.si2', 'running_scf.log'), LOG_TEXT);

  // ABACUS task with no output at all.
  const idleDir = join(root, 'nested', 'h2-notrun');
  mkdirSync(idleDir, { recursive: true });
  writeFileSync(join(idleDir, 'INPUT'), 'INPUT_PARAMETERS\ncalculation scf\n');
  writeFileSync(join(idleDir, 'STRU'), STRU_TEXT);

  // LibRPA-only task.
  const librpaDir = join(root, 'gw', 'si-g0w0');
  mkdirSync(join(librpaDir, 'librpa.d'), { recursive: true });
  writeFileSync(join(librpaDir, 'librpa.in'), LIBRPA_IN);
  writeFileSync(join(librpaDir, 'librpa.out'), LIBRPA_LOG);
  writeFileSync(join(librpaDir, 'librpa.d', 'qsgw_iterations.dat'), QSGW_ITER);
  writeFileSync(join(librpaDir, 'librpa.d', 'qsgw_eigenvalues.dat'), QSGW_EIG);

  // A directory that is not a task, and a nested OUTPUT dir that must be skipped.
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'README.md'), '# not a task\n');
  mkdirSync(join(root, 'si2-scf', 'OUT.si2', 'deeper'), { recursive: true });
  writeFileSync(join(root, 'si2-scf', 'OUT.si2', 'deeper', 'INPUT'), 'not a task\n');

  return root;
}

test('scanner finds ABACUS, LibRPA and coupled tasks and skips output dirs', async () => {
  const root = makeProject();
  try {
    const scan = await scanProject(root, { maxDepth: 4 });
    assert.equal(scan.error, '');
    const rels = scan.tasks.map((t) => t.relPath).sort();
    assert.deepEqual(rels, ['gw/si-g0w0', 'nested/h2-notrun', 'si2-scf']);
    const byRel = Object.fromEntries(scan.tasks.map((t) => [t.relPath, t]));
    assert.equal(byRel['si2-scf'].kind, 'abacus');
    assert.equal(byRel['si2-scf'].outputDir, 'OUT.si2');
    assert.equal(byRel['gw/si-g0w0'].kind, 'librpa');
    // A task directory with no OUTPUT folder still reports the default `OUT.<suffix>`
    // name it *would* use, so the row is informative rather than blank.
    assert.equal(byRel['nested/h2-notrun'].outputDir, 'OUT.ABACUS');
    // The nested INPUT inside OUT.si2 must not become a task.
    assert.ok(!scan.tasks.some((t) => t.relPath.includes('OUT.si2')));
    assert.equal(scan.counts.total, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('inputSuffix reads the suffix keyword and defaults to ABACUS', () => {
  assert.equal(inputSuffix('INPUT_PARAMETERS\nsuffix si2\n'), 'si2');
  assert.equal(inputSuffix('INPUT_PARAMETERS\ncalculation scf\n'), 'ABACUS');
  assert.equal(inputSuffix('INPUT_PARAMETERS\n#suffix fake\n'), 'ABACUS');
});

test('task bundle assembles status, structure and convergence for an ABACUS task', async () => {
  const root = makeProject();
  try {
    const scan = await scanProject(root, { maxDepth: 4 });
    const task = scan.tasks.find((t) => t.relPath === 'si2-scf');
    assert.ok(task);
    const bundle = buildTaskBundle(task);
    assert.equal(bundle.error, '');
    assert.ok(bundle.abacus, 'abacus section present');
    assert.equal(bundle.abacus.suffix, 'si2');
    assert.equal(bundle.abacus.logFile, 'running_scf.log');
    assert.equal(bundle.abacus.stru.natom, 2);
    assert.equal(bundle.abacus.stru.species[0].label, 'Si');
    assert.equal(bundle.abacus.kpt.mode, 'auto');
    assert.deepEqual(bundle.abacus.kpt.grid, [4, 4, 4]);
    assert.ok(bundle.abacus.log.iterations.length >= 2);
    assert.equal(bundle.abacus.log.scfConverged, true);
    assert.equal(bundle.abacus.log.finished, true);
    assert.equal(bundle.status.code, 'FINISHED');
    assert.equal(bundle.status.label, '已完成');
    // Structure scene must be present with two atoms and a cubic-ish cell.
    assert.ok(bundle.structureScene);
    assert.equal(bundle.structureScene.natom, 2);
    assert.ok(bundle.structureScene.formula.startsWith('Si'));
    assert.equal(bundle.structureScene.cell.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a task with no OUT directory is classified as not started', async () => {
  const root = makeProject();
  try {
    const scan = await scanProject(root, { maxDepth: 4 });
    const task = scan.tasks.find((t) => t.relPath === 'nested/h2-notrun');
    const bundle = buildTaskBundle(task);
    assert.equal(bundle.abacus.status.code, 'NO_OUTPUT');
    assert.equal(bundle.abacus.status.label, '未开始');
    assert.equal(bundle.structureScene.natom, 2, 'structure still renders without output');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('task bundle reads a LibRPA task: input, build hash and QSGW tables', async () => {
  const root = makeProject();
  try {
    const scan = await scanProject(root, { maxDepth: 4 });
    const task = scan.tasks.find((t) => t.relPath === 'gw/si-g0w0');
    const bundle = buildTaskBundle(task);
    assert.ok(bundle.librpa, 'librpa section present');
    assert.equal(bundle.librpa.task, 'g0w0');
    assert.equal(bundle.librpa.log.finished, true);
    assert.equal(
      bundle.librpa.log.build['Source code Git hash'],
      '1027891ffefa54af355da850736e96a451c456f9',
    );
    assert.equal(bundle.librpa.qsgw.iterations.rows.length, 2);
    assert.equal(bundle.librpa.qsgw.eigenvalues.rows.length, 3);
    assert.equal(bundle.status.code, 'FINISHED');
    assert.equal(bundle.abacus, null, 'no ABACUS half for a LibRPA-only task');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scan of a missing directory returns an error instead of throwing', async () => {
  const scan = await scanProject(join(tmpdir(), 'abacusflow-does-not-exist-xyz'), {});
  assert.ok(scan.error.length > 0);
  assert.deepEqual(scan.tasks, []);
});

test('scanSingleDir recognises one task and rejects a plain directory', async () => {
  const root = makeProject();
  try {
    const hit = await scanSingleDir(join(root, 'si2-scf'), root);
    assert.ok(hit);
    assert.equal(hit.relPath, 'si2-scf');
    const miss = await scanSingleDir(join(root, 'docs'), root);
    assert.equal(miss, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('task store caches a bundle until its source stamp changes', async () => {
  const root = makeProject();
  try {
    const scan = await scanProject(root, { maxDepth: 4 });
    const task = scan.tasks.find((t) => t.relPath === 'si2-scf');
    const store = new TaskStore();
    store.putScan(root, scan);
    assert.equal(store.taskById(task.id).relPath, 'si2-scf');

    const stamp = TaskStore.stampFor(task);
    const first = store.getBundle(task.id, stamp);
    assert.equal(first, null, 'nothing cached yet');
    const built = buildTaskBundle(task);
    store.putBundle(task.id, stamp, built);
    assert.equal(store.getBundle(task.id, stamp), built, 'cache hit on same stamp');
    assert.equal(store.getBundle(task.id, `${stamp}!`,), null, 'stamp change invalidates');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Real files: skipped when the WSL checkouts are not reachable from this machine.
// ---------------------------------------------------------------------------

test('real ABACUS run parses end to end', { skip: !existsSync(ABACUS_ROOT) }, async () => {
  const scan = await scanProject(ABACUS_ROOT, { maxDepth: 3 });
  assert.equal(scan.error, '');
  const task = scan.tasks.find((t) => t.relPath === 'serial');
  assert.ok(task, `expected a task at 'serial', got ${scan.tasks.map((t) => t.relPath).join(',')}`);
  const bundle = buildTaskBundle(task);
  assert.equal(bundle.abacus.logFile, 'running_scf.log');
  assert.ok(bundle.abacus.log.iterations.length > 10);
  assert.equal(bundle.abacus.log.scfConverged, true);
  assert.equal(bundle.abacus.stru.natom, 2);
  assert.equal(bundle.abacus.versions.version.startsWith('3.9'), true);
  assert.equal(bundle.status.code, 'FINISHED');
});

test('real LibRPA run parses end to end', { skip: !existsSync(LIBRPA_ROOT) }, async () => {
  const scan = await scanProject(LIBRPA_ROOT, { maxDepth: 5 });
  assert.equal(scan.error, '');
  const task = scan.tasks.find((t) => t.relPath.endsWith('librpa'));
  assert.ok(task, `expected a task ending in 'librpa', got ${scan.tasks.map((t) => t.relPath).join(',')}`);
  const bundle = buildTaskBundle(task);
  assert.equal(bundle.librpa.task, 'qsgw');
  assert.equal(bundle.librpa.log.finished, true);
  assert.equal(bundle.librpa.log.build['Source code Git hash'].length, 40);
  assert.ok(bundle.librpa.qsgw.iterations.rows.length >= 2);
  assert.ok(bundle.librpa.qsgw.eigenvalues.nBand > 0);
});
