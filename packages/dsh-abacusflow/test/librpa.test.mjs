/**
 * LibRPA input and output parsers.
 *
 * The fixtures are faithful excerpts of the real QSGW run in this repository
 * (`runs/librpa-qsgw-si-k333-1027891-20260724`), so the assertions pin the numbers the
 * panel shows for that specific calculation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseLibrpaIn,
  getLibrpaParam,
  getLibrpaFlag,
  getLibrpaNumber,
  summarizeLibrpaParams,
  LIBRPA_KEYS,
} from '../lib/host/librpa/input.js';
import {
  parseLibrpaLog,
  parseQsgwEigenvalues,
  parseQsgwIterations,
  classifyLibrpaRun,
} from '../lib/host/librpa/output.js';
import { parseEnergyQp, parseBandSpin, HARTREE_TO_EV } from '../lib/host/librpa/energy-qp.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', 'librpa', name), 'utf8');

// ------------------------------------------------------------ librpa.in ----

test('librpa.in parses every key = value pair', () => {
  const parsed = parseLibrpaIn(fixture('librpa.in'));
  assert.equal(parsed.entries.length, 39);
  assert.deepEqual(parsed.duplicates, []);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(getLibrpaParam(parsed.params, 'task'), 'qsgw');
  assert.equal(getLibrpaParam(parsed.params, 'input_dir'), '../dataset');
  assert.equal(getLibrpaParam(parsed.params, 'output_dir'), './librpa.d/');
  assert.equal(getLibrpaNumber(parsed.params, 'nfreq'), 6);
  assert.equal(getLibrpaNumber(parsed.params, 'qsgw_max_iter'), 1);
  assert.equal(getLibrpaParam(parsed.params, 'parallel_routing'), 'libri');
  assert.equal(getLibrpaParam(parsed.params, 'constants_choice'), 'aims');
});

test('librpa.in booleans accept true/false spellings', () => {
  const parsed = parseLibrpaIn(fixture('librpa.in'));
  assert.equal(getLibrpaFlag(parsed.params, 'replace_w_head'), true);
  assert.equal(getLibrpaFlag(parsed.params, 'use_pyatb'), false);
  assert.equal(getLibrpaFlag(parsed.params, 'use_fullcoul_eps'), true);
  assert.equal(getLibrpaFlag(parsed.params, 'use_fullcoul_exx'), false);
  // Unknown key and absent key both yield undefined rather than throwing.
  assert.equal(getLibrpaFlag(parsed.params, 'no_such_key'), undefined);
});

test('librpa.in accepts `t`/`f` and numeric booleans, and reports duplicate keys', () => {
  const parsed = parseLibrpaIn('task = rpa\nuse_shrink_chi = t\nuse_shrink_abfs = .f.\nnfreq = 6\nnfreq = 8\n');
  assert.equal(getLibrpaFlag(parsed.params, 'use_shrink_chi'), true);
  assert.equal(getLibrpaFlag(parsed.params, 'use_shrink_abfs'), false);
  assert.equal(getLibrpaNumber(parsed.params, 'nfreq'), 8, 'last value wins');
  assert.deepEqual(parsed.duplicates, ['nfreq']);
});

test('summarizeLibrpaParams groups the QSGW keys and flags unknown ones', () => {
  const parsed = parseLibrpaIn(`${fixture('librpa.in')}\nsome_future_librpa_key = 7\n`);
  const summary = summarizeLibrpaParams(parsed.params);
  const groups = summary.groups.map((g) => g.group);
  for (const expected of ['Task', 'Paths', 'Screening', 'Frequency', 'QSGW', 'Output']) {
    assert.ok(groups.includes(expected), `missing group ${expected}; got ${groups.join(',')}`);
  }
  assert.deepEqual(summary.unknownKeys, ['some_future_librpa_key']);
  const qsgw = summary.groups.find((g) => g.group === 'QSGW');
  const mixer = qsgw.items.find((i) => i.key === 'qsgw_mixer');
  assert.equal(mixer.value, 'none');
  assert.equal(mixer.known, true);
  assert.ok(mixer.doc && mixer.doc.length > 4);
});

test('LIBRPA_KEYS documents the keys the driver actually consumes', () => {
  for (const key of ['task', 'input_dir', 'output_dir', 'restart_from_dir', 'nfreq',
    'parallel_routing', 'option_dielect_func', 'replace_w_head', 'use_fullcoul_eps',
    'qsgw_mixer', 'qsgw_max_iter', 'qsgw_input_contract', 'use_symmetry_gw',
    'version_coul_reader', 'prefix_coul_cut', 'version_lri_reader']) {
    const meta = LIBRPA_KEYS[key];
    assert.ok(meta, `LIBRPA_KEYS missing ${key}`);
    assert.ok(meta.group, `${key} has no group`);
    assert.ok(meta.doc && meta.doc.length > 4, `${key} has no doc`);
  }
});

// ----------------------------------------------------------- librpa.out ----

test('librpa.out yields the MPI shape, build provenance and driver parameters', () => {
  const log = parseLibrpaLog(fixture('librpa.out'));
  assert.deepEqual(log.mpi, { tasks: 1, nodes: 1, threads: 1 });
  assert.equal(log.finished, true);
  assert.equal(log.startTime, '2026-07-24 03:23:27.967');
  assert.equal(log.endTime, '2026-07-24 03:23:32.830');

  // Build provenance is the version-identification mechanism.
  assert.equal(log.build['Build type'], 'Debug');
  assert.equal(log.build['Source code Git hash'], '1027891ffefa54af355da850736e96a451c456f9');
  assert.equal(log.build['Use LibRI'], 'ON');
  assert.equal(log.build['GreenX commit hash'], 'c90d131');
  assert.ok(log.build['C++ compiler'].includes('mpiicpx'));

  assert.equal(log.driverParams.task, 'qsgw');
  assert.equal(log.driverParams.qsgw_mixer, 'none');
  assert.equal(log.driverParams.qsgw_max_iter, '1');
  assert.equal(log.driverParams.parallel_routing, undefined, 'this excerpt omits it');
});

test('librpa.out timing rows carry seconds and a cumulative value', () => {
  const log = parseLibrpaLog(fixture('librpa.out'));
  assert.ok(log.timings.length >= 4, `got ${log.timings.length}`);
  const total = log.timings.find((t) => /Total for driver/i.test(t.name));
  assert.ok(total);
  assert.equal(total.calls, 1);
  assert.ok(Math.abs(total.seconds - 4.8426) < 1e-9);
  assert.ok(Math.abs(total.cumSeconds - 4.8626) < 1e-9);
});

test('librpa.out QSGW progress and the non-convergence verdict are captured', () => {
  const log = parseLibrpaLog(fixture('librpa.out'));
  assert.equal(log.qsgwProgress.length, 1);
  const first = log.qsgwProgress[0];
  assert.equal(first.iteration, 1);
  assert.ok(Math.abs(first.maxDeltaEv - 91.8152786) < 1e-6);
  assert.ok(Math.abs(first.gapEv - 7.21148065) < 1e-8);
  assert.equal(first.mixer, 'none');
  assert.equal(first.converged, false);

  assert.ok(log.qsgwVerdict, 'verdict recorded');
  assert.equal(log.qsgwVerdict.converged, false);
  assert.ok(log.qsgwVerdict.message.includes('without convergence'));
});

test('a log without the terminator is not reported finished', () => {
  const log = parseLibrpaLog('Initialized LibRPA global environment at [x]\nTotal number of tasks    :     4\n');
  assert.equal(log.finished, false);
  assert.equal(log.mpi.tasks, 4);
  assert.ok(log.errors.some((e) => e.code === 'UNFINISHED' || e.code === 'INTERRUPTED'), JSON.stringify(log.errors));
});

test('`Error: libRPA failed` is recognised as a failure', () => {
  const log = parseLibrpaLog('Initialized LibRPA global environment at [x]\nError on MPI rank 0: boom\nError: libRPA failed\n');
  assert.equal(log.finished, false);
  assert.ok(log.errors.length > 0);
  const codes = log.errors.map((e) => e.code);
  assert.ok(codes.some((c) => c === 'FAILED' || c === 'MPI_ERROR' || c === 'ERROR_LINE' || c === 'UNFINISHED'), codes.join(','));
});

// --------------------------------------------------------- qsgw_*.dat ------

test('qsgw_iterations.dat maps the header to keys and finds no converged row', () => {
  const iterations = parseQsgwIterations(fixture('qsgw_iterations.dat'));
  assert.ok(iterations.columns.includes('max_delta_eV'));
  assert.ok(iterations.columns.includes('gap_eV'));
  assert.ok(iterations.columns.includes('converged'));
  assert.equal(iterations.columns.length, 17);
  assert.equal(iterations.rows.length, 2);
  // Nothing converged: this run stopped at qsgw_max_iter=1.
  assert.equal(iterations.convergedIter, null);

  const first = iterations.rows[0];
  assert.equal(first.iter, 0);
  assert.ok(Math.abs(first.gap_eV - 1.9098441978708243) < 1e-12);
  assert.ok(Math.abs(first.efermi_eV - -4.624735360962444) < 1e-12);
  assert.equal(first.converged, 0);

  const second = iterations.rows[1];
  assert.equal(second.iter, 1);
  assert.ok(Math.abs(second.max_delta_eV - 91.81527860713749) < 1e-9);
  assert.ok(Math.abs(second.gap_eV - 7.211480650845379) < 1e-9);
});

test('qsgw_eigenvalues.dat is a long table of per-band rows', () => {
  const eig = parseQsgwEigenvalues(fixture('qsgw_eigenvalues.dat'));
  assert.deepEqual(eig.columns, ['iter', 'channel', 'spin', 'kpoint', 'kx', 'ky', 'kz', 'band', 'energy_eV']);
  assert.equal(eig.nIter, 2);
  assert.equal(eig.nKpoint, 3);
  assert.equal(eig.nBand, 4);
  // The fixture is a faithful excerpt: 2 iterations x 2 k-points x 4 bands.
  assert.equal(eig.rows.length, 16);
  assert.deepEqual([...new Set(eig.rows.map((r) => r.iter))], [0, 1]);
  assert.deepEqual([...new Set(eig.rows.map((r) => r.band))], [0, 1, 2, 3]);
  assert.equal(eig.rows[0].iter, 0);
  assert.equal(eig.rows[0].band, 0);
  assert.ok(Number.isFinite(eig.minEnergyEv));
  assert.ok(Number.isFinite(eig.maxEnergyEv));
  assert.ok(eig.maxEnergyEv > eig.minEnergyEv);
  // k vectors are triplets, not scalars.
  assert.equal(eig.rows[0].k.length, 3);
});

// ------------------------------------------------------------ energy_qp ----

test('energy_qp parses the Hartree table into QP energies in eV', () => {
  const text = [
    '  state     occ_num        e_gs(Ha)        e_qp(Ha)',
    '---------------------------------------------------------------------------------------------------',
    '  K_point    1 :           0.0000          0.0000          0.0000',
    '---------------------------------------------------------------------------------------------------',
    '       1    2.0000   -1.8788617373E+01   -2.0337919716E+01',
    '       2    2.0000   -9.2724995039E-01   -1.1155511630E+00',
    '       3    0.0000    3.0206619582E-03    1.3002422996E-01',
  ].join('\n');
  const qp = parseEnergyQp(text);
  assert.equal(qp.rows.length, 3);
  assert.equal(qp.nKpoint, 1);
  assert.equal(qp.nState, 3);
  assert.equal(qp.rows[0].kpoint, 1);
  assert.deepEqual(qp.rows[0].k, [0, 0, 0]);
  assert.equal(qp.rows[0].occupation, 2);
  assert.ok(Math.abs(qp.rows[0].eGsHa - -18.788617373) < 1e-9);
  assert.ok(Math.abs(qp.rows[0].eQpHa - -20.337919716) < 1e-9);
  // Hartree -> eV conversion is applied to both columns.
  assert.ok(Math.abs(qp.rows[0].eQpEv - -20.337919716 * HARTREE_TO_EV) < 1e-9);
  assert.ok(Math.abs(qp.rows[0].deltaEv - (qp.rows[0].eQpEv - qp.rows[0].eGsEv)) < 1e-9);
  assert.ok(qp.maxQpEv > qp.minQpEv);
});

test('energy_qp handles the two-spin layout', () => {
  const text = [
    '  state     occ_num        e_gs(Ha)        e_qp(Ha)',
    '---------------------------------------------------------------------------------------------------',
    '  K_point    1 :           0.0000          0.0000          0.0000',
    '---------------------------------------------------------------------------------------------------',
    'Spin Up',
    '       1    1.0000   -5.0000000000E-01   -6.0000000000E-01',
    'Spin Down',
    '       1    1.0000   -4.0000000000E-01   -5.0000000000E-01',
  ].join('\n');
  const qp = parseEnergyQp(text);
  assert.equal(qp.rows.length, 2);
  assert.equal(qp.nSpin, 2);
  assert.equal(qp.rows[0].spinLabel, 'Up');
  assert.equal(qp.rows[1].spinLabel, 'Down');
  assert.equal(qp.rows[0].spin, 0);
  assert.equal(qp.rows[1].spin, 1);
});

test('parseBandSpin reads the eV band layout', () => {
  const text = '    1      0.0000000      0.0000000      0.0000000        2.00000      -13.34367        0.00000        9.71387\n';
  const band = parseBandSpin(text);
  assert.equal(band.nKpoint, 1);
  assert.equal(band.nState, 2);
  assert.deepEqual(band.rows[0].k, [0, 0, 0]);
  assert.equal(band.rows[0].states[0].occupation, 2);
  assert.ok(Math.abs(band.rows[0].states[0].energyEv - -13.34367) < 1e-9);
  assert.ok(Math.abs(band.rows[0].states[1].energyEv - 9.71387) < 1e-9);
});

// ------------------------------------------------------------- classifier --

test('classifyLibrpaRun distinguishes the four states', () => {
  assert.equal(classifyLibrpaRun({ hasOutput: false, logText: null, exitcode: null, mtimeAgeSeconds: null }).code, 'NO_OUTPUT');
  assert.equal(classifyLibrpaRun({ hasOutput: true, logText: fixture('librpa.out'), exitcode: 0, mtimeAgeSeconds: 10 }).code, 'FINISHED');
  assert.equal(classifyLibrpaRun({ hasOutput: true, logText: null, exitcode: null, mtimeAgeSeconds: 5 }).code, 'RUNNING');
  const partial = classifyLibrpaRun({ hasOutput: true, logText: 'Initialized LibRPA global environment at [x]\n', exitcode: null, mtimeAgeSeconds: 5 });
  assert.equal(partial.code, 'RUNNING');
  const failed = classifyLibrpaRun({ hasOutput: true, logText: 'Error: libRPA failed\n', exitcode: 1, mtimeAgeSeconds: 5 });
  assert.equal(failed.code, 'ERROR');
});

test('classifyLibrpaRun reports the git hash as evidence for a finished run', () => {
  const status = classifyLibrpaRun({
    hasOutput: true,
    logText: fixture('librpa.out'),
    exitcode: 0,
    mtimeAgeSeconds: 10,
  });
  assert.equal(status.code, 'FINISHED');
  assert.equal(status.label, '已完成');
  assert.ok(status.evidence.some((e) => e.includes('1027891ffefa54af355da850736e96a451c456f9')));
  assert.ok(status.evidence.some((e) => e.includes('libRPA finished successfully')));
});

test('the success terminator outranks a non-zero exit code', () => {
  // The regression harness records whatever the shell reported, and that is not always 0
  // (SIGPIPE after a closed pipe, MPI teardown, wrapper scripts). A log that ended with
  // `libRPA finished successfully` must not be reported as failed.
  for (const exitcode of [0, 1, 2, 137, null]) {
    const status = classifyLibrpaRun({
      hasOutput: true,
      logText: fixture('librpa.out'),
      exitcode,
      mtimeAgeSeconds: 99999,
    });
    assert.equal(status.code, 'FINISHED', `exitcode ${exitcode} misclassified as ${status.code}`);
  }
});

test('a failed run with no terminator is not rescued by exitcode 0', () => {
  const status = classifyLibrpaRun({
    hasOutput: true,
    logText: 'Initialized LibRPA global environment at [x]\nTotal number of tasks    :     1\n',
    exitcode: 0,
    mtimeAgeSeconds: 5,
  });
  assert.equal(status.code, 'RUNNING');
});
