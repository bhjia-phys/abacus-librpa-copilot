/**
 * `librpa.in` parser.
 *
 * The fixture is a verbatim copy of the real QSGW input of
 * `librpa-qsgw-si-k333-1027891-20260724`, so the key set and the value shapes below are
 * the ones the driver actually consumes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseLibrpaIn,
  summarizeLibrpaParams,
  getLibrpaParam,
  getLibrpaFlag,
  getLibrpaNumber,
  LIBRPA_KEYS,
} from '../lib/host/librpa/input.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', 'librpa', name), 'utf8');

// --------------------------------------------------------------- parsing --

test('the real librpa.in parses into entries and a params record', () => {
  const parsed = parseLibrpaIn(fixture('librpa.in'));
  assert.equal(parsed.entries.length, 39, 'one entry per key = value line');
  assert.equal(Object.keys(parsed.params).length, 39);
  assert.deepEqual(parsed.warnings, []);

  assert.equal(parsed.params.task, 'qsgw');
  assert.equal(parsed.params.input_dir, '../dataset');
  assert.equal(parsed.params.output_dir, './librpa.d/');
  assert.equal(parsed.params.restart_from_dir, '../dataset/sigcrf/');
  assert.equal(parsed.params.constants_choice, 'aims');
  assert.equal(parsed.params.parallel_routing, 'libri');
  assert.equal(parsed.params.qsgw_input_contract, 'qsgw_input.head-only.contract');
  assert.equal(parsed.params.qsgw_mixer, 'none');

  // Booleans and numbers stay strings at this layer; typed accessors convert.
  assert.equal(parsed.params.use_scalapack_gw_wc, 'true');
  assert.equal(parsed.params.qsgw_max_iter, '1');
  assert.equal(parsed.params.n_params_anacon_resample, '-1');
  assert.equal(parsed.params.anacon_nfreq, '-1');
  assert.equal(parsed.params.nfreq, '6');
});

test('entries keep the 1-based source line and the raw line', () => {
  const parsed = parseLibrpaIn(fixture('librpa.in'));
  const task = parsed.entries.find((e) => e.key === 'task');
  assert.equal(task.line, 1);
  assert.equal(task.value, 'qsgw');
  assert.equal(task.raw, 'task = qsgw');
  // `output_dir` is the third line of the real file.
  const outputDir = parsed.entries.find((e) => e.key === 'output_dir');
  assert.equal(outputDir.line, 3);
});

test('comments, blank lines and stray whitespace are handled', () => {
  const parsed = parseLibrpaIn([
    '# a leading comment',
    '',
    '  task   =   g0w0   # trailing comment',
    'nfreq=12',
    '   ',
    'input_dir = ../dataset  ',
  ].join('\n'));
  // `params` is a prototype-free map so a key like `constructor` cannot collide.
  assert.deepEqual({ ...parsed.params }, { task: 'g0w0', nfreq: '12', input_dir: '../dataset' });
  assert.deepEqual(parsed.warnings, []);
});

test('a malformed line is skipped with a warning, never thrown', () => {
  const parsed = parseLibrpaIn('task = qsgw\nthis line has no equals sign\nnfreq = 6\n');
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.params.task, 'qsgw');
  assert.equal(parsed.params.nfreq, '6');
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /第 2 行/);
});

test('a duplicate key keeps the last value and warns', () => {
  const parsed = parseLibrpaIn('nfreq = 6\nnfreq = 12\n');
  assert.equal(parsed.params.nfreq, '12');
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /nfreq/);
});

test('an empty file parses to empty structures with a warning', () => {
  const parsed = parseLibrpaIn('');
  assert.deepEqual(parsed.entries, []);
  assert.equal(Object.keys(parsed.params).length, 0);
  assert.equal(parsed.warnings.length, 1);
});

// ---------------------------------------------------------- typed access --

test('typed accessors convert booleans and numbers and are case-insensitive', () => {
  const { params } = parseLibrpaIn(fixture('librpa.in'));
  assert.equal(getLibrpaParam(params, 'TASK'), 'qsgw');
  assert.equal(getLibrpaParam(params, 'no_such_key'), undefined);
  assert.equal(getLibrpaFlag(params, 'use_scalapack_gw_wc'), true);
  assert.equal(getLibrpaFlag(params, 'use_pyatb'), false);
  assert.equal(getLibrpaNumber(params, 'nfreq'), 6);
  assert.equal(getLibrpaNumber(params, 'qsgw_max_iter'), 1);
  assert.equal(getLibrpaNumber(params, 'n_params_anacon_resample'), -1);
  assert.equal(getLibrpaNumber(params, 'task'), null, 'a non-numeric value is null');
});

// ------------------------------------------------------------- metadata --

test('LIBRPA_KEYS documents the keys the driver consumes', () => {
  // Every key that appears in the real input must be documented.
  const { params } = parseLibrpaIn(fixture('librpa.in'));
  for (const key of Object.keys(params)) {
    assert.ok(LIBRPA_KEYS[key], `undocumented key in the real input: ${key}`);
  }
  // Spot-check the documented contract fields.
  assert.equal(LIBRPA_KEYS.task.type, 'enum');
  assert.deepEqual(LIBRPA_KEYS.task.values, ['qsgw', 'g0w0', 'rpa', 'exx']);
  assert.equal(LIBRPA_KEYS.nfreq.type, 'number');
  assert.equal(LIBRPA_KEYS.replace_w_head.type, 'bool');
  assert.equal(LIBRPA_KEYS.qsgw_input_contract.type, 'string');
  for (const meta of Object.values(LIBRPA_KEYS)) {
    assert.ok(meta.doc && meta.doc.length > 0, 'every key documents itself');
    assert.ok(meta.group && meta.group.length > 0);
  }
});

test('LIBRPA_KEYS covers every group named in the contract', () => {
  const groups = new Set(Object.values(LIBRPA_KEYS).map((m) => m.group));
  for (const required of ['Task', 'Paths', 'Screening', 'Frequency', 'Dielectric', 'Parallel', 'Symmetry', 'Coulomb', 'QSGW', 'Output']) {
    assert.ok(groups.has(required), `missing group ${required}`);
  }
});

test('summarizeLibrpaParams groups known keys and collects unknown ones', () => {
  const { params } = parseLibrpaIn(fixture('librpa.in'));
  const summary = summarizeLibrpaParams({ ...params, some_future_key: 'x' });
  assert.deepEqual(summary.unknownKeys, ['some_future_key']);
  assert.ok(summary.groups.length > 0);

  const byGroup = Object.fromEntries(summary.groups.map((g) => [g.group, g.items]));
  assert.ok(byGroup.Task.some((i) => i.key === 'task' && i.known));
  assert.ok(byGroup.Paths.some((i) => i.key === 'input_dir'));
  assert.ok(byGroup.QSGW.some((i) => i.key === 'qsgw_max_iter'));
  assert.ok(byGroup.Coulomb.some((i) => i.key === 'version_coul_reader'));
  assert.ok(byGroup.Dielectric.some((i) => i.key === 'option_dielect_func'));

  // An unknown key is still reported, flagged as unknown, under 其他.
  const other = byGroup['其他'].find((i) => i.key === 'some_future_key');
  assert.ok(other);
  assert.equal(other.known, false);
  assert.equal(other.value, 'x');

  // Groups appear in the documented order.
  const order = ['Task', 'Paths', 'Screening', 'Frequency', 'Dielectric', 'Parallel', 'Symmetry', 'Coulomb', 'QSGW', 'Output'];
  const seen = summary.groups.map((g) => g.group).filter((g) => order.includes(g));
  const expected = order.filter((g) => seen.includes(g));
  assert.deepEqual(seen, expected);
});
