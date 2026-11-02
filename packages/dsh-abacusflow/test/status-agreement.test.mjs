/**
 * The cheap status probe must agree with the full bundle.
 *
 * The task tree colours every row from `probeTaskStatus` (log tail only), while the detail
 * panes and the agent tools use `buildTaskBundle`. If those two ever disagreed, the panel
 * would show one state in the list and another after clicking — the exact class of bug
 * this plugin exists to prevent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanProject } from '../lib/host/scanner.js';
import { buildTaskBundle, probeTaskStatus } from '../lib/host/task-bundle.js';
import { physicsPath } from '../scripts/lib/local-data.mjs';

const CONVERGED_LOG = `                              ABACUS v3.9.0.25
 --> #ION MOVE#         1  #ELEC ITER#         1
 Electron density deviation 0.400000
  E_KohnSham     -2.3121239863        -31.4580606961
 #SCF IS CONVERGED#
 #TOTAL ENERGY# -31.552277937 eV
 Total  Time  : 0 h 0 mins 0 secs
`;

const UNCONVERGED_LOG = `                              ABACUS v3.9.0.25
 --> #ION MOVE#         1  #ELEC ITER#       100
 Electron density deviation 0.050000
  E_KohnSham     -2.2000000000        -29.9325000000
 !!SCF IS NOT CONVERGED!!
 Total  Time  : 0 h 2 mins 11 secs
`;

const CRASHED_LOG = `                              ABACUS v3.9.0.25
 --> #ION MOVE#         1  #ELEC ITER#         1
  E_KohnSham     -2.3121239863        -31.4580606961
`;

const NOTICE_LOG = `                              ABACUS v3.9.0.25
 --> #ION MOVE#         1  #ELEC ITER#         1
 ------------------------------------------------------------------------
                          !NOTICE!

  Can't find pseudopotential file: missing.UPF
 ------------------------------------------------------------------------
`;

function project() {
  const root = mkdtempSync(join(tmpdir(), 'abacusflow-probe-'));

  const addAbacus = (name, logText) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'INPUT'), 'INPUT_PARAMETERS\nsuffix t\ncalculation scf\n');
    writeFileSync(join(dir, 'STRU'), 'ATOMIC_SPECIES\nH 1 H.upf\nLATTICE_CONSTANT\n10\nLATTICE_VECTORS\n1 0 0\n0 1 0\n0 0 1\nATOMIC_POSITIONS\nDirect\nH\n0\n1\n0 0 0\n');
    if (logText !== null) {
      mkdirSync(join(dir, 'OUT.t'), { recursive: true });
      writeFileSync(join(dir, 'OUT.t', 'running_scf.log'), logText);
    }
  };

  const addLibrpa = (name, logText) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'librpa.in'), 'task = g0w0\n');
    if (logText !== null) writeFileSync(join(dir, 'librpa.out'), logText);
  };

  addAbacus('finished', CONVERGED_LOG);
  addAbacus('unconverged', UNCONVERGED_LOG);
  addAbacus('crashed', CRASHED_LOG);
  addAbacus('notice', NOTICE_LOG);
  addAbacus('no-output', null);
  addLibrpa('librpa-done', 'Initialized LibRPA global environment at [x]\nlibRPA finished successfully\n');
  addLibrpa('librpa-running', 'Initialized LibRPA global environment at [x]\n');
  addLibrpa('librpa-none', null);

  // A directory holding BOTH inputs is the ABACUS -> LibRPA handoff case. Its status must
  // come from the ABACUS half (the producer), not the LibRPA half, so that a coupled task
  // whose GW step has not started yet still does not read as "LibRPA 未开始".
  const coupled = join(root, 'coupled');
  mkdirSync(coupled, { recursive: true });
  writeFileSync(join(coupled, 'INPUT'), 'INPUT_PARAMETERS\nsuffix t\ncalculation scf\n');
  writeFileSync(join(coupled, 'STRU'), 'ATOMIC_SPECIES\nH 1 H.upf\nLATTICE_CONSTANT\n10\nLATTICE_VECTORS\n1 0 0\n0 1 0\n0 0 1\nATOMIC_POSITIONS\nDirect\nH\n0\n1\n0 0 0\n');
  writeFileSync(join(coupled, 'librpa.in'), 'task = g0w0\n');
  mkdirSync(join(coupled, 'OUT.t'), { recursive: true });
  writeFileSync(join(coupled, 'OUT.t', 'running_scf.log'), CONVERGED_LOG);

  return root;
}

test('probeTaskStatus agrees with the full bundle on every synthetic task', async () => {
  const root = project();
  try {
    const scan = await scanProject(root, { maxDepth: 3 });
    assert.equal(scan.error, '');
    assert.ok(scan.tasks.length >= 8, `expected >= 8 tasks, got ${scan.tasks.length}`);

    for (const task of scan.tasks) {
      const fast = probeTaskStatus(task);
      const full = buildTaskBundle(task, { includeScene: false }).status;
      assert.equal(fast.code, full.code, `${task.relPath}: probe ${fast.code} vs bundle ${full.code}`);
      assert.equal(fast.label, full.label, `${task.relPath}: probe ${fast.label} vs bundle ${full.label}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('probeTaskStatus yields the expected state for each fixture', async () => {
  const root = project();
  try {
    const scan = await scanProject(root, { maxDepth: 3 });
    const byRel = Object.fromEntries(scan.tasks.map((t) => [t.relPath, t]));

    assert.equal(probeTaskStatus(byRel.finished).code, 'FINISHED');
    assert.equal(probeTaskStatus(byRel.unconverged).code, 'FINISHED_UNCONVERGED');
    assert.equal(probeTaskStatus(byRel.crashed).code, 'RUNNING');
    assert.equal(probeTaskStatus(byRel.notice).code, 'ERROR');
    assert.equal(probeTaskStatus(byRel['no-output']).code, 'NO_OUTPUT');

    assert.equal(probeTaskStatus(byRel['librpa-done']).code, 'FINISHED');
    assert.equal(probeTaskStatus(byRel['librpa-running']).code, 'RUNNING');
    assert.equal(probeTaskStatus(byRel['librpa-none']).code, 'NO_OUTPUT');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a coupled task takes its status from the ABACUS producer half', async () => {
  const root = project();
  try {
    const scan = await scanProject(root, { maxDepth: 3 });
    const task = scan.tasks.find((t) => t.relPath === 'coupled');
    assert.ok(task, 'the coupled directory is recognised');
    assert.equal(task.kind, 'coupled');

    // ABACUS finished, LibRPA has no output at all.
    const fast = probeTaskStatus(task);
    const full = buildTaskBundle(task, { includeScene: false }).status;
    assert.equal(fast.code, 'FINISHED');
    assert.equal(full.code, 'FINISHED', 'the ABACUS half decides, not the LibRPA half');
    assert.equal(fast.code, full.code);

    // The bundle must still expose both halves even though only one has output.
    const bundle = buildTaskBundle(task, { includeScene: false });
    assert.ok(bundle.abacus, 'ABACUS half present');
    assert.ok(bundle.librpa, 'LibRPA half present');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('probeTaskStatus never throws on a malformed task record', () => {
  assert.equal(probeTaskStatus({ id: 'x', kind: 'abacus', absPath: '/nonexistent/xyz', outputDir: null }).code, 'NO_OUTPUT');
  assert.equal(probeTaskStatus({ id: 'y', kind: 'librpa', absPath: '/nonexistent/xyz' }).code, 'NO_OUTPUT');
  // An unknown kind is reported, not crashed on.
  assert.equal(probeTaskStatus({ id: 'z', kind: 'weird', absPath: '/nonexistent' }).label, '未开始');
});

// The real tree check runs only where the WSL checkouts are reachable from this machine.
const REAL_ROOT = physicsPath('repo', 'runs');

test('probeTaskStatus agrees with the bundle on the real runs tree', { skip: !existsSync(REAL_ROOT) }, async () => {
  const scan = await scanProject(REAL_ROOT, { maxDepth: 4 });
  assert.equal(scan.error, '');
  assert.ok(scan.tasks.length > 0, 'expected at least one real task');

  for (const task of scan.tasks) {
    const fast = probeTaskStatus(task);
    const full = buildTaskBundle(task, { includeScene: false }).status;
    assert.equal(fast.code, full.code, `${task.relPath} [${task.kind}]: probe ${fast.code} vs bundle ${full.code}`);
  }
});
