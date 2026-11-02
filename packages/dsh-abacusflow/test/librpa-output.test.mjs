/**
 * LibRPA output parsers.
 *
 * Fixtures are small faithful excerpts of the real QSGW run
 * `librpa-qsgw-si-k333-1027891-20260724/.../librpa`:
 *   - `librpa.out`            build provenance, driver block, `Entry` timing table,
 *                             the `libRPA finished successfully` terminator;
 *   - `qsgw_eigenvalues.dat`  2 iterations x 3 k-points x 4 bands, real numbers;
 *   - `qsgw_iterations.dat`   the 17-column header of contract version 6.
 *
 * The numbers asserted here are the ones in those files, so a future format change
 * fails loudly instead of silently shifting a regression baseline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseQsgwEigenvalues,
  parseQsgwIterations,
  parseLibrpaLog,
  classifyLibrpaRun,
} from '../lib/host/librpa/output.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', 'librpa', name), 'utf8');

// ------------------------------------------------- qsgw_eigenvalues.dat --

test('qsgw_eigenvalues.dat: header, columns and long-format rows', () => {
  const eig = parseQsgwEigenvalues(fixture('qsgw_eigenvalues.dat'));

  // `# key value` comments become header metadata; `qsgw_contract_version` is the one
  // that tells us which generation of the format we are reading.
  assert.equal(eig.header.qsgw_contract_version, '6');
  assert.equal(eig.header.qsgw_mixer, 'none');
  assert.equal(eig.header.fixed_basis, 'immutable_mf0');
  // A value containing spaces is kept whole.
  assert.equal(eig.header.symmetry, 'exx_off_gw_off_rpa_off');

  // The last `#` line that names columns is the column header.
  assert.deepEqual(eig.columns, ['iter', 'channel', 'spin', 'kpoint', 'kx', 'ky', 'kz', 'band', 'energy_eV']);
  assert.equal(eig.headerLines.length, 15, '15 comment lines before the data');

  // Iteration 0 covers k-points 0/1/2 (4 bands each = 12 rows); iteration 1 stops after
  // k-point 0 (4 rows), which is exactly the shape a head-only QSGW run leaves behind.
  assert.equal(eig.rows.length, 16);
  assert.equal(eig.nIter, 2);
  assert.equal(eig.nKpoint, 3);
  assert.equal(eig.nBand, 4);
  assert.equal(eig.nSpin, 1);
  assert.deepEqual(eig.warnings, []);
});

test('qsgw_eigenvalues.dat: exact row values, including the k-vector', () => {
  const eig = parseQsgwEigenvalues(fixture('qsgw_eigenvalues.dat'));
  const first = eig.rows[0];
  assert.equal(first.iter, 0);
  assert.equal(first.channel, 0);
  assert.equal(first.spin, 0);
  assert.equal(first.kpoint, 0);
  assert.equal(first.band, 0);
  assert.deepEqual(first.k, [0, 0, 0]);
  assert.equal(first.energyEv, -1790.7751542667054);

  // The second k-point of the first iteration has k_z = 1/3.
  const kOne = eig.rows.find((r) => r.iter === 0 && r.kpoint === 1);
  assert.ok(kOne);
  assert.ok(Math.abs(kOne.k[2] - 1 / 3) < 1e-12);
  assert.equal(kOne.band, 0);
  assert.ok(Math.abs(kOne.energyEv - -1790.7751542662998) < 1e-9);

  // Iteration 1 shifts the energies (the QSGW update actually did something).
  const iterOne = eig.rows.find((r) => r.iter === 1 && r.kpoint === 0 && r.band === 0);
  assert.ok(iterOne);
  assert.ok(Math.abs(iterOne.energyEv - -1882.5884715301836) < 1e-9);
});

test('qsgw_eigenvalues.dat: energy range', () => {
  const eig = parseQsgwEigenvalues(fixture('qsgw_eigenvalues.dat'));
  assert.ok(eig.minEnergyEv !== null && eig.maxEnergyEv !== null);
  assert.ok(eig.minEnergyEv < eig.maxEnergyEv);
  // The lowest value in the fixture is iteration 1, k=0, band 0 (-1.882588...e3 eV).
  assert.ok(Math.abs(eig.minEnergyEv - -1882.5884715301836) < 1e-9, `min ${eig.minEnergyEv}`);
  // The highest is iteration 0, k=0, band 2 (-1.405390...e2 eV).
  assert.ok(Math.abs(eig.maxEnergyEv - -140.53119770411607) < 1e-9, `max ${eig.maxEnergyEv}`);
});

test('qsgw_eigenvalues.dat: an empty body warns instead of throwing', () => {
  const eig = parseQsgwEigenvalues('# iter channel spin kpoint kx ky kz band energy_eV\n');
  assert.deepEqual(eig.rows, []);
  assert.equal(eig.nIter, 0);
  assert.equal(eig.minEnergyEv, null);
  assert.equal(eig.warnings.length, 1);
});

// ------------------------------------------------- qsgw_iterations.dat --

test('qsgw_iterations.dat: the long header maps to keys of each row', () => {
  const it = parseQsgwIterations(fixture('qsgw_iterations.dat'));

  assert.equal(it.columns.length, 17);
  assert.deepEqual(it.columns, [
    'iter', 'max_delta_eV', 'residual_l2_Ha', 'residual_max_Ha', 'efermi_eV', 'gap_eV',
    'electron_count', 'requested_mode', 'applied_mode', 'beta', 'fallback', 'rcond',
    'coefficient_l1', 'coefficient_count', 'converged', 'coefficients', 'fallback_reason',
  ]);
  assert.equal(it.header.qsgw_contract_version, '6');
  assert.equal(it.rows.length, 2);
  assert.deepEqual(it.warnings, []);
});

test('qsgw_iterations.dat: numbers where parseable, strings for none/labels', () => {
  const it = parseQsgwIterations(fixture('qsgw_iterations.dat'));
  const [zero, one] = it.rows;

  assert.equal(zero.iter, 0);
  assert.equal(zero.max_delta_eV, 0);
  assert.equal(zero.gap_eV, 1.9098441978708243);
  assert.equal(zero.converged, 0);
  // `none` is not a number, so it stays a string.
  assert.equal(zero.coefficients, 'none');
  assert.equal(zero.fallback_reason, 'none');
  assert.equal(typeof zero.coefficients, 'string');

  assert.equal(one.iter, 1);
  assert.ok(Math.abs(one.max_delta_eV - 91.81527860713749) < 1e-9);
  assert.ok(Math.abs(one.gap_eV - 7.211480650845379) < 1e-9);
  assert.ok(Math.abs(one.efermi_eV - -2.8360362126576657) < 1e-9);
  assert.equal(one.converged, 0);
});

test('qsgw_iterations.dat: convergedIter is null when nothing converged', () => {
  // The real run stopped at qsgw_max_iter=1 with `converged = 0`, so this is the honest
  // reading: not converged, and the panel must show that.
  const it = parseQsgwIterations(fixture('qsgw_iterations.dat'));
  assert.equal(it.convergedIter, null);
  assert.equal(it.rows.every((r) => r.converged === 0), true);
});

test('qsgw_iterations.dat: convergedIter finds the first converged row', () => {
  const text = [
    '# iter max_delta_eV residual_l2_Ha residual_max_Ha efermi_eV gap_eV electron_count',
    '# requested_mode applied_mode beta fallback rcond coefficient_l1 coefficient_count',
    '# converged coefficients fallback_reason',
    '',
  ].join('\n');
  // Rebuild the header on one line, as the real writer does.
  const header = '# iter max_delta_eV residual_l2_Ha residual_max_Ha efermi_eV gap_eV electron_count requested_mode applied_mode beta fallback rcond coefficient_l1 coefficient_count converged coefficients fallback_reason';
  const rows = [
    '0 5.0e+01 1.0e+01 1.0 0.0 1.0 28 -1 -1 0.2 0 1.0 0.0 0 0 none none',
    '1 1.0e-04 1.0e-04 1.0e-04 0.0 1.0 28 -1 -1 0.2 0 1.0 0.0 0 1 none none',
    '2 1.0e-05 1.0e-05 1.0e-05 0.0 1.0 28 -1 -1 0.2 0 1.0 0.0 0 1 none none',
  ];
  const parsed = parseQsgwIterations([text, header, ...rows].join('\n'));
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.convergedIter, 1, 'first converged row');
});

test('qsgw_iterations.dat: a short row is padded with nulls, an over-long one is skipped', () => {
  const header = '# iter max_delta_eV gap_eV converged';
  const parsed = parseQsgwIterations(`${header}\n0 1.0 2.0 0\n1 3.0\n2 4.0 5.0 1 99\n`);
  // Row `1 3.0` is an older writer omitting trailing columns: it is kept, with nulls.
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[1].iter, 1);
  assert.equal(parsed.rows[1].max_delta_eV, 3);
  assert.equal(parsed.rows[1].gap_eV, null);
  assert.equal(parsed.rows[1].converged, null);
  // Row `2 ... 99` has more cells than columns, so it cannot be mapped and is dropped.
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /1 行/);
});

// ------------------------------------------------------------- librpa.out --

test('librpa.out: build provenance carries the git hash', () => {
  const log = parseLibrpaLog(fixture('librpa.out'));
  // This is the version-identification mechanism: a LibRPA number is only
  // interpretable together with the commit that produced it.
  assert.equal(log.build['Source code Git hash'], '1027891ffefa54af355da850736e96a451c456f9');
  assert.equal(log.build['Build type'], 'Debug');
  assert.equal(log.build['GreenX commit hash'], 'c90d131');
  assert.equal(log.build['Use LibRI'], 'ON');
  assert.equal(log.build['Source code Git reference'], 'refs/heads/validate/qsgw-symmetry-no-headwing-20260724');
  // A key whose value is genuinely empty is still recorded.
  assert.equal(log.build['Fortran compiler flags'], '');
});

test('librpa.out: MPI shape and start time', () => {
  const log = parseLibrpaLog(fixture('librpa.out'));
  assert.deepEqual(log.mpi, { tasks: 1, nodes: 1, threads: 1 });
  assert.equal(log.startTime, '2026-07-24 03:23:27.967');
});

test('librpa.out: the driver parameter block is keyed by name', () => {
  const log = parseLibrpaLog(fixture('librpa.out'));
  assert.equal(log.driverParams.task, 'qsgw');
  assert.equal(log.driverParams.constants_choice, 'aims');
  assert.equal(log.driverParams.qsgw_mixer, 'none');
  assert.equal(log.driverParams.qsgw_max_iter, '1');
  assert.equal(log.driverParams.qsgw_input_contract, 'qsgw_input.head-only.contract');
  assert.equal(log.driverParams.use_pyatb, 'false');
  // The block ends at the End marker, so the following text is not swallowed.
  assert.equal(log.driverParams['Mean-field dimensions set'], undefined);
});

test('librpa.out: the timing table is parsed with call counts and both time columns', () => {
  const log = parseLibrpaLog(fixture('librpa.out'));
  assert.ok(log.timings.length >= 5, `got ${log.timings.length}`);
  const total = log.timings.find((t) => t.name === 'Total for driver');
  assert.ok(total, `names: ${log.timings.map((t) => t.name).join(' | ')}`);
  assert.equal(total.calls, 1);
  assert.ok(Math.abs(total.seconds - 4.8426) < 1e-9);
  assert.ok(Math.abs(total.cumSeconds - 4.8626) < 1e-9);
  const read = log.timings.find((t) => t.name === 'Driver Read Input Parameters');
  assert.ok(read);
  assert.ok(Math.abs(read.seconds - 0.0006) < 1e-9);
});

test('librpa.out: the success terminator sets finished', () => {
  const log = parseLibrpaLog(fixture('librpa.out'));
  assert.equal(log.finished, true);
  const codes = log.errors.map((e) => e.code);
  assert.ok(!codes.includes('UNFINISHED'), `errors: ${JSON.stringify(log.errors)}`);
  assert.deepEqual(log.warnings, []);
});

test('librpa.out: a log without the terminator is unfinished but not an error', () => {
  const text = fixture('librpa.out').replace('libRPA finished successfully\n', '');
  const log = parseLibrpaLog(text);
  assert.equal(log.finished, false);
  const unfinished = log.errors.find((e) => e.code === 'UNFINISHED');
  assert.ok(unfinished);
  // `finished` is the fact; UNFINISHED is only a label for it.
  assert.equal(log.build['Source code Git hash'], '1027891ffefa54af355da850736e96a451c456f9');
});

// --------------------------------------------------- classifyLibrpaRun --

test('classifyLibrpaRun: no output at all is 未开始', () => {
  const status = classifyLibrpaRun({ hasOutput: false, logText: null, exitcode: null, mtimeAgeSeconds: null });
  assert.equal(status.code, 'NO_OUTPUT');
  assert.equal(status.label, '未开始');
  assert.deepEqual(status.evidence, []);
});

test('classifyLibrpaRun: a finished log is 已完成 even with a stale mtime', () => {
  const status = classifyLibrpaRun({
    hasOutput: true,
    logText: fixture('librpa.out'),
    exitcode: 0,
    mtimeAgeSeconds: 100000,
  });
  assert.equal(status.code, 'FINISHED');
  assert.equal(status.label, '已完成');
  assert.equal(status.reason, '日志以 `libRPA finished successfully` 结束');
  assert.ok(status.evidence.some((e) => e.includes('1027891ffefa54af355da850736e96a451c456f9')));
});

test('classifyLibrpaRun: the terminator outranks a non-zero exit code', () => {
  // This machine's real successful QSGW run leaves `librpa.exitcode = 2` while its log
  // ends with the success terminator, so exitcode alone must not mean failure.
  const status = classifyLibrpaRun({
    hasOutput: true,
    logText: fixture('librpa.out'),
    exitcode: 2,
    mtimeAgeSeconds: 10,
  });
  assert.equal(status.code, 'FINISHED');
  assert.ok(status.evidence.some((e) => e.includes('exitcode = 2')));
});

test('classifyLibrpaRun: a log with no terminator is 运行中', () => {
  const text = fixture('librpa.out').replace('libRPA finished successfully\n', '');
  const running = classifyLibrpaRun({
    hasOutput: true,
    logText: text,
    exitcode: null,
    mtimeAgeSeconds: 30,
  });
  assert.equal(running.code, 'RUNNING');
  assert.equal(running.label, '运行中');
  assert.ok(running.reason.includes('没有结束标记'));

  // A stale mtime stays RUNNING: the plugin never guesses "killed".
  const stale = classifyLibrpaRun({
    hasOutput: true,
    logText: text,
    exitcode: null,
    mtimeAgeSeconds: 86400,
  });
  assert.equal(stale.code, 'RUNNING');
  assert.ok(stale.evidence.some((e) => e.includes('86400 秒前更新')));
});

test('classifyLibrpaRun: a non-zero exit without a terminator is 出错', () => {
  const text = fixture('librpa.out').replace('libRPA finished successfully\n', '');
  const status = classifyLibrpaRun({
    hasOutput: true,
    logText: text,
    exitcode: 1,
    mtimeAgeSeconds: 30,
  });
  assert.equal(status.code, 'ERROR');
  assert.equal(status.label, '出错');
  assert.ok(status.reason.includes('exitcode = 1'));
});

test('classifyLibrpaRun: a crash signature is 出错', () => {
  const text = `${fixture('librpa.out')}\nterminate called after throwing an instance of 'LIBRPA_RUNTIME_ERROR'\n`;
  const status = classifyLibrpaRun({
    hasOutput: true,
    logText: text,
    exitcode: 134,
    mtimeAgeSeconds: 5,
  });
  assert.equal(status.code, 'ERROR');
  assert.ok(status.reason.includes('RUNTIME_ERROR'));
});

test('classifyLibrpaRun: output exists but librpa.out is missing is 运行中', () => {
  const status = classifyLibrpaRun({ hasOutput: true, logText: null, exitcode: null, mtimeAgeSeconds: 20 });
  assert.equal(status.code, 'RUNNING');
  assert.equal(status.label, '运行中');
});
