/**
 * ABACUS main-log parser.
 *
 * The fixtures reproduce the v3.9.0.25 grammar documented in SPEC.md §0: `#ION MOVE#`
 * iteration heads, the two-column energy table, `#TOTAL-FORCE#`, `TIME STATISTICS`, and
 * every verdict / fatal banner. `running_scf.log` models a 3-step relax rather than a
 * single SCF, so the per-ionic-step grouping is exercised too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseScfLog, classifyAbacusRun, ABACUS_ERROR_CODES } from '../lib/host/abacus/log.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', 'abacus', name), 'utf8');

// ------------------------------------------------------------- iterations --

test('a converged relax log yields every electronic step with both energy columns', () => {
  const log = parseScfLog(fixture('running_scf.log'));
  assert.equal(log.iterations.length, 6, '3 ionic steps x 2 electronic steps');
  assert.deepEqual(
    log.iterations.map((i) => [i.ionicStep, i.scfIter]),
    [[1, 1], [1, 2], [2, 1], [2, 2], [3, 1], [3, 2]],
  );

  const first = log.iterations[0];
  assert.ok(Math.abs(first.eKohnShamRy - -2.3121239863) < 1e-12);
  assert.ok(Math.abs(first.eKohnShamEv - -31.4580606961) < 1e-9);
  assert.ok(Math.abs(first.rhoDeviation - 0.439953) < 1e-12);
  assert.equal(first.eFermiEv, null, 'step 1 printed no Fermi line');

  const second = log.iterations[1];
  assert.ok(Math.abs(second.eHarrisEv - -30.5008884153) < 1e-9);
  assert.ok(Math.abs(second.eFermiEv - -1.3556753991) < 1e-9);
  assert.ok(Math.abs(second.gapEv - 15.4336025957) < 1e-9);

  // The final electronic step is where the run actually ended up.
  const last = log.iterations[5];
  assert.ok(Math.abs(last.eKohnShamEv - -31.552277937) < 1e-9);
  assert.ok(Math.abs(last.rhoDeviation - 0.009112) < 1e-12);
});

test('three SCF verdicts and total energies are captured across ionic steps', () => {
  const log = parseScfLog(fixture('running_scf.log'));
  assert.equal(log.scfConverged, true);
  assert.equal(log.scfNotConverged, false);
  assert.equal(log.finished, true);
  assert.equal(log.lastTotalEnergyEv.length, 3, 'one per RELAX STEP');
  assert.deepEqual(log.lastTotalEnergyEv.map((e) => e.ionicStep), [1, 2, 3]);
  assert.ok(Math.abs(log.lastTotalEnergyEv[2].energyEv - -31.552277937) < 1e-9);
  assert.deepEqual(log.errors, []);
});

test('an unconverged SCF log is flagged without being called a crash', () => {
  const log = parseScfLog(fixture('running_scf.unconverged.log'));
  assert.equal(log.scfConverged, false);
  assert.equal(log.scfNotConverged, true);
  assert.equal(log.finished, true);
  const codes = log.errors.map((e) => e.code);
  assert.deepEqual(codes, ['SCF_NOT_CONVERGED']);
  assert.ok(log.errors[0].evidence.includes('SCF IS NOT CONVERGED'));
  // A convergence failure is a result, not a hard error.
  assert.equal(classifyAbacusRun({
    hasOutputDir: true,
    logText: fixture('running_scf.unconverged.log'),
    logFileName: 'running_scf.log',
    mtimeAgeSeconds: 999,
  }).code, 'FINISHED_UNCONVERGED');
});

test('a truncated log without a terminator is reported unfinished', () => {
  const log = parseScfLog(fixture('running_scf.crashed.log'));
  assert.equal(log.finished, false);
  assert.equal(log.scfConverged, null);
  // The file stops mid-run: 2 electronic steps of ionic step 1, then 1 of step 2.
  assert.equal(log.iterations.length, 3);
  assert.deepEqual(
    log.iterations.map((i) => [i.ionicStep, i.scfIter]),
    [[1, 1], [1, 2], [2, 1]],
  );
  // It keeps the data it did see rather than discarding the file.
  assert.ok(Math.abs(log.iterations[2].eKohnShamEv - -31.5038) < 1e-9);
});

// ------------------------------------------------------------ force/stress --

test('only the last force table survives, and maxForce comes from it', () => {
  const log = parseScfLog(fixture('running_scf.log'));
  // Three force tables appear, one per ionic step; the last one wins.
  assert.equal(log.forces.length, 2);
  assert.deepEqual(log.forces[0], { label: 'Si1', fx: 0, fy: 0, fz: 0.0001234567 });
  assert.deepEqual(log.forces[1], { label: 'Si2', fx: 0, fy: 0, fz: -0.0001234567 });
  assert.ok(Math.abs(log.maxForce - 0.0001234567) < 1e-12, `maxForce ${log.maxForce}`);
  assert.match(log.forceUnit ?? '', /eV\/Angstrom/i);
});

test('force labels of the form element+index are recognised, column headers are not', () => {
  const log = parseScfLog([
    ' #TOTAL-FORCE (eV/Angstrom)#',
    '     Atoms          Force_x           Force_y           Force_z',
    '    Fe1       0.0000000000       0.0000000000       0.5000000000',
    '    Bi2       0.1000000000       0.0000000000      -0.5000000000',
  ].join('\n'));
  assert.equal(log.forces.length, 2);
  assert.deepEqual(log.forces.map((f) => f.label), ['Fe1', 'Bi2']);
  assert.ok(Math.abs(log.maxForce - Math.hypot(0.1, 0.5)) < 1e-9);
});

test('the 3x3 stress tensor and the pressure line are parsed when present', () => {
  const log = parseScfLog([
    ' #TOTAL-STRESS (kbar)#',
    '          Stress_x            Stress_y            Stress_z',
    '      -12.3456789012         1.0000000000         2.0000000000',
    '        1.0000000000       -12.3456789012         3.0000000000',
    '        2.0000000000         3.0000000000       -12.3456789012',
    ' #TOTAL-PRESSURE# (EXCLUDE KINETIC PART OF IONS): 3.4482 kbar',
  ].join('\n'));
  assert.ok(log.stress, 'stress block present');
  assert.ok(Array.isArray(log.stress), 'stress is the row array');
  assert.equal(log.stress.length, 3, 'three rows');
  // Row i is the i-th printed line of the tensor; each row holds three numbers.
  for (const row of log.stress) {
    assert.equal(row.values.length, 3);
  }
  assert.ok(Math.abs(log.stress[0].values[0] - -12.3456789012) < 1e-9);
  assert.ok(Math.abs(log.stress[1].values[1] - -12.3456789012) < 1e-9);
  assert.ok(Math.abs(log.stress[2].values[2] - -12.3456789012) < 1e-9);
  // Off-diagonals are the symmetric pairs.
  assert.ok(Math.abs(log.stress[0].values[1] - 1) < 1e-9);
  assert.ok(Math.abs(log.stress[1].values[0] - 1) < 1e-9);
  assert.ok(log.pressure, 'pressure line present');
  assert.ok(Math.abs(log.pressure.value - 3.4482) < 1e-9);
});

// ------------------------------------------------------------------ tables --

test('the TIME STATISTICS table is parsed into rows', () => {
  const log = parseScfLog(fixture('running_scf.log'));
  assert.ok(log.timings.length >= 2, `got ${log.timings.length} timing rows`);
  const total = log.timings.find((t) => /total/i.test(t.name));
  assert.ok(total, 'a total row exists');
  assert.ok(Math.abs(total.seconds - 0.41) < 1e-9);
  assert.equal(total.calls, 13);
  assert.ok(Math.abs(total.percent - 100) < 1e-9);
  // The Driver/atomic_world row keeps both name columns in one string.
  const row = log.timings.find((t) => /atomic_world/i.test(t.name));
  assert.ok(row, 'the Driver/atomic_world row is present');
  assert.ok(row.name.includes('Driver'), `name: ${row.name}`);
  assert.equal(row.calls, 1);
});

test('the memory table is parsed into rows', () => {
  const log = parseScfLog(fixture('running_scf.log'));
  assert.ok(log.memory.length >= 1, `got ${log.memory.length} memory rows`);
  const total = log.memory.find((m) => /total/i.test(m.name));
  assert.ok(total, `total row missing from ${JSON.stringify(log.memory)}`);
  assert.ok(Math.abs(total.mb - 7.605) < 1e-9);
});

// ------------------------------------------------------------------ errors --

test('the ABACUS !NOTICE! banner becomes a WARNING_QUIT with the real message', () => {
  const log = parseScfLog(fixture('running_scf.notice.log'));
  const quit = log.errors.find((e) => e.code === 'WARNING_QUIT');
  assert.ok(quit, `expected WARNING_QUIT in ${JSON.stringify(log.errors)}`);
  assert.ok(quit.evidence.includes('pseudopotential'), `evidence: ${quit.evidence}`);
  // v3.9 has no MPI_Abort path; the banner IS the abort.
  assert.ok(!log.errors.some((e) => e.code === 'MPI_ABORT'));
  assert.equal(classifyAbacusRun({
    hasOutputDir: true,
    logText: fixture('running_scf.notice.log'),
    logFileName: 'running_scf.log',
    mtimeAgeSeconds: 10,
  }).code, 'ERROR');
});

test('only documented error codes are emitted', () => {
  const allowed = new Set(ABACUS_ERROR_CODES);
  for (const name of ['running_scf.log', 'running_scf.unconverged.log', 'running_scf.crashed.log', 'running_scf.notice.log']) {
    const log = parseScfLog(fixture(name));
    for (const error of log.errors) {
      assert.ok(allowed.has(error.code), `${name} emitted undocumented code ${error.code}`);
    }
  }
});

// ------------------------------------------------------------- classifier --

test('classifyAbacusRun distinguishes the five states', () => {
  assert.equal(classifyAbacusRun({ hasOutputDir: false, logText: null, logFileName: null, mtimeAgeSeconds: null }).code, 'NO_OUTPUT');
  assert.equal(classifyAbacusRun({ hasOutputDir: true, logText: null, logFileName: 'running_scf.log', mtimeAgeSeconds: 5 }).code, 'NO_OUTPUT');

  const finished = classifyAbacusRun({
    hasOutputDir: true,
    logText: fixture('running_scf.log'),
    logFileName: 'running_scf.log',
    mtimeAgeSeconds: 99999,
  });
  assert.equal(finished.code, 'FINISHED');
  assert.equal(finished.label, '已完成');
  assert.ok(finished.evidence.length > 0);

  const unconverged = classifyAbacusRun({
    hasOutputDir: true,
    logText: fixture('running_scf.unconverged.log'),
    logFileName: 'running_scf.log',
    mtimeAgeSeconds: 99999,
  });
  assert.equal(unconverged.code, 'FINISHED_UNCONVERGED');
  assert.equal(unconverged.label, '完成但未收敛');

  const running = classifyAbacusRun({
    hasOutputDir: true,
    logText: fixture('running_scf.crashed.log'),
    logFileName: 'running_scf.log',
    mtimeAgeSeconds: 12,
  });
  assert.equal(running.code, 'RUNNING');
  assert.equal(running.label, '运行中');

  // A stale log is still RUNNING — the plugin never guesses "killed".
  const stale = classifyAbacusRun({
    hasOutputDir: true,
    logText: fixture('running_scf.crashed.log'),
    logFileName: 'running_scf.log',
    mtimeAgeSeconds: 86400,
  });
  assert.equal(stale.code, 'RUNNING');
  assert.ok(
    stale.reason.includes('可能仍在运行') || stale.reason.includes('被中断'),
    `reason: ${stale.reason}`,
  );
  assert.ok(stale.evidence.some((e) => e.includes('小时未更新')), JSON.stringify(stale.evidence));

  const errored = classifyAbacusRun({
    hasOutputDir: true,
    logText: fixture('running_scf.notice.log'),
    logFileName: 'running_scf.log',
    mtimeAgeSeconds: 5,
  });
  assert.equal(errored.code, 'ERROR');
  assert.equal(errored.label, '出错');
});

test('every status label is Chinese', () => {
  const labels = [
    classifyAbacusRun({ hasOutputDir: false, logText: null, logFileName: null, mtimeAgeSeconds: null }),
    classifyAbacusRun({ hasOutputDir: true, logText: fixture('running_scf.log'), logFileName: 'x', mtimeAgeSeconds: 1 }),
    classifyAbacusRun({ hasOutputDir: true, logText: fixture('running_scf.unconverged.log'), logFileName: 'x', mtimeAgeSeconds: 1 }),
    classifyAbacusRun({ hasOutputDir: true, logText: fixture('running_scf.crashed.log'), logFileName: 'x', mtimeAgeSeconds: 1 }),
    classifyAbacusRun({ hasOutputDir: true, logText: fixture('running_scf.notice.log'), logFileName: 'x', mtimeAgeSeconds: 1 }),
  ].map((s) => s.label);
  for (const label of labels) {
    assert.ok(/^[\u4e00-\u9fff]+$/.test(label), `label is not Chinese: ${label}`);
  }
});

test('a large log is parsed linearly with bounded retained state', () => {
  const block = ' --> #ION MOVE#         1  #ELEC ITER#         1\n Electron density deviation 0.1\n  E_KohnSham     -2.0        -27.2\n';
  const big = block.repeat(100000);
  const started = Date.now();
  const log = parseScfLog(big);
  const elapsed = Date.now() - started;
  assert.equal(log.iterations.length, 100000, `parsed ${log.iterations.length}`);
  assert.ok(elapsed < 60000, `parsing took ${elapsed} ms`);
  // No force/timing table in this text, so nothing extra is retained.
  assert.equal(log.timings.length, 0);
  assert.equal(log.forces.length, 0);
});
