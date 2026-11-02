/**
 * LibRPA status classification when `librpa.out` was not retained.
 *
 * Real case: the NiO QSGW run keeps `qsgw_iterations.dat` and six `*_band_spin_*.dat` in
 * `librpa.d/` but has no `librpa.out` at all. The classifier used to report
 * `NO_OUTPUT / 未开始` for it — a finished calculation described as "not started" — and the
 * agent tools inherited that verdict.
 *
 * Two distinct defects are pinned here:
 *   1. band files were only looked for in the task directory, missing `librpa.d/`;
 *   2. `hasOutput` only counted `librpa.out`, `qsgw_eigenvalues.dat` and `energy_qp`,
 *      ignoring `qsgw_iterations.dat` and the band files.
 *
 * A third distinction matters for honesty: results-without-a-log must not be called
 * "running" (the old fallback) nor a plain "finished" (which hides the missing log).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyLibrpaRun } from '../lib/host/librpa/output.js';
import { buildTaskBundle } from '../lib/host/task-bundle.js';
import { scanProject } from '../lib/host/scanner.js';

const ITER_HEADER =
  '# iter max_delta_eV residual_l2_Ha residual_max_Ha efermi_eV gap_eV electron_count beta converged';

function iterRow(iter, gap, delta) {
  return [
    iter,
    delta.toExponential(17),
    '0.0e+00',
    '0.0e+00',
    '1.57798556726621957e+01',
    gap.toExponential(17),
    '4.8e+01',
    '1.0e+00',
    '0',
  ].join(' ');
}

/** Build a LibRPA task with the output layout the NiO run really has. */
function makeLibrpaTask(root, { withLog = false } = {}) {
  const task = join(root, 'qsgw');
  mkdirSync(join(task, 'librpa.d'), { recursive: true });
  writeFileSync(
    join(task, 'librpa.in'),
    ['task = qsgw', 'input_preset = abacus-legacy', 'output_dir = librpa.d/'].join('\n'),
  );
  writeFileSync(
    join(task, 'librpa.d', 'qsgw_iterations.dat'),
    [ITER_HEADER, iterRow(0, 0.91988007050348941, 0), iterRow(1, 2.28854112364803619, 14.344975178)].join('\n'),
  );
  // Two k-points, two states: `ik kx ky kz`, then `occupation energy` pairs.
  const band = '1 0.0 0.0 0.0 2.0 -1.0 0.0 1.0\n2 0.5 0.0 0.0 2.0 -0.9 0.0 1.1\n';
  for (const name of ['KS_band_spin_1_1.dat', 'EXX_band_spin_1_1.dat', 'QSGW_band_spin_1_1.dat']) {
    writeFileSync(join(task, 'librpa.d', name), band);
  }
  if (withLog) {
    writeFileSync(join(task, 'librpa.out'), 'LibRPA CMake build info:\nlibRPA finished successfully\n');
  }
  return task;
}

test('classifyLibrpaRun: results without a retained log are not "running"', () => {
  const status = classifyLibrpaRun({
    hasOutput: true,
    logText: null,
    logMissing: true,
    completedOutputs: ['qsgw_iterations.dat 2 行', '3 个能带文件'],
  });
  assert.equal(status.code, 'FINISHED_NO_LOG');
  assert.match(status.label, /已完成/);
  assert.match(status.label, /无日志/);
  assert.ok(status.evidence.some((e) => e.includes('qsgw_iterations.dat')));
  assert.ok(status.evidence.some((e) => e.includes('librpa.out')));
});

test('classifyLibrpaRun: an unreadable log with output stays inconclusive', () => {
  // `logMissing` false means a log file exists but could not be read — do not claim finished.
  const status = classifyLibrpaRun({ hasOutput: true, logText: null, logMissing: false });
  assert.equal(status.code, 'RUNNING');
});

test('classifyLibrpaRun: no output at all is still "not started"', () => {
  const status = classifyLibrpaRun({ hasOutput: false });
  assert.equal(status.code, 'NO_OUTPUT');
});

test('band files are found inside librpa.d, not only the task directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'abacusflow-qsgw-'));
  try {
    makeLibrpaTask(root);
    // Use the real scanner: a hand-built task object would not prove the task is found.
    const scan = await scanProject(root, { maxDepth: 3 });
    const task = scan.tasks.find((t) => t.relPath === 'qsgw');
    assert.ok(task, `qsgw task scanned; got ${scan.tasks.map((t) => t.relPath).join(', ')}`);

    const bundle = buildTaskBundle(task);
    assert.equal(bundle.librpa.files.bandFiles.length, 3, 'KS/EXX/QSGW all seen');
    assert.equal(bundle.librpa.files.bandFiles.filter((n) => n.startsWith('QSGW_')).length, 1);
    assert.equal(Object.keys(bundle.librpa.bandEnergies).length, 3, 'and parsed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a run with results but no librpa.out is reported as finished, with evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'abacusflow-qsgw-'));
  try {
    makeLibrpaTask(root);
    const scan = await scanProject(root, { maxDepth: 3 });
    const task = scan.tasks.find((t) => t.relPath === 'qsgw');
    assert.ok(task);
    const bundle = buildTaskBundle(task);

    assert.equal(bundle.status.code, 'FINISHED_NO_LOG', 'not NO_OUTPUT, not RUNNING');
    assert.match(bundle.status.reason, /没有保存 librpa\.out/);
    assert.ok(
      bundle.status.evidence.some((e) => e.includes('qsgw_iterations')),
      `evidence names the iteration table: ${JSON.stringify(bundle.status.evidence)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeping librpa.out still yields the normal finished verdict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'abacusflow-qsgw-'));
  try {
    makeLibrpaTask(root, { withLog: true });
    const scan = await scanProject(root, { maxDepth: 3 });
    const task = scan.tasks.find((t) => t.relPath === 'qsgw');
    assert.ok(task);
    const bundle = buildTaskBundle(task);
    assert.equal(bundle.status.code, 'FINISHED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The async scanner is exercised by the tests above; this reference keeps the import alive
// so a signature change surfaces here rather than in a silent skip.
void scanProject;
