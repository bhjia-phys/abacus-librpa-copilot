/**
 * Band-structure parsing and assembly.
 *
 * The three irregularities pinned here were all observed in this repository's own runs:
 * a `band.txt` that holds two appended k-paths, spin channels split into separate files,
 * and LibRPA's per-iteration band triples.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseAbacusBands, pickMainBlock, readBandFiles } from '../lib/host/abacus/bands.js';
import { parseLibrpaBand, parseBandFileName, groupBandIterations } from '../lib/host/librpa/bands.js';
import { readBands, cumulativePathLength } from '../lib/host/bands.js';
import { physicsPath } from '../scripts/lib/local-data.mjs';

/** `<ik> <kpath> <E1..En>` — the real ABACUS line shape. */
const abacusLine = (ik, kpath, energies) => `${ik} ${kpath.toFixed(8)} ${energies.map((e) => e.toFixed(8)).join(' ')}`;

/** `<ik> <kx> <ky> <kz>` then `<occ> <E>` pairs — the real LibRPA line shape. */
const librpaLine = (ik, k, energies) =>
  `${ik} ${k.map((v) => v.toFixed(7)).join(' ')} ` +
  energies.map((e) => `1.00000 ${e.toFixed(5)}`).join(' ');

// ------------------------------------------------------------- ABACUS ------

test('an ABACUS band file yields one block with the right shape', () => {
  const text = [
    abacusLine(1, 0, [-5, 1, 4]),
    abacusLine(2, 0.5, [-4.8, 1.2, 4.3]),
    abacusLine(3, 1.0, [-4.5, 1.5, 4.8]),
  ].join('\n');
  const parsed = parseAbacusBands(text, { fileName: 'band.txt' });
  assert.equal(parsed.nBlock, 1);
  assert.equal(parsed.nBand, 3);
  const block = parsed.blocks[0];
  assert.equal(block.nKpoint, 3);
  assert.deepEqual(block.kpath, [0, 0.5, 1.0]);
  assert.deepEqual(block.energies[1], [-4.8, 1.2, 4.3]);
  assert.equal(block.minEnergyEv, -5);
  assert.equal(block.maxEnergyEv, 4.8);
  assert.equal(block.kPathMonotone, true);
  assert.deepEqual(parsed.warnings, []);
});

test('an appended band file is split into blocks instead of drawn as one path', () => {
  // The real Bi2Se3 case: an earlier 3-point run followed by the current 4-point path.
  const earlier = [abacusLine(1, 0, [0, 1]), abacusLine(2, 1, [0.1, 1.1]), abacusLine(3, 2, [0.2, 1.2])];
  const current = [
    abacusLine(1, 0, [0, 1]),
    abacusLine(2, 0.5, [0.3, 1.3]),
    abacusLine(3, 1.0, [0.6, 1.6]),
    abacusLine(4, 1.5, [0.9, 1.9]),
  ];
  const parsed = parseAbacusBands([...earlier, ...current].join('\n'));
  assert.equal(parsed.nBlock, 2);
  assert.equal(parsed.blocks[0].nKpoint, 3);
  assert.equal(parsed.blocks[1].nKpoint, 4);
  // The longer block is the one worth plotting.
  assert.equal(pickMainBlock(parsed).nKpoint, 4);
  // And the situation is reported rather than silently smoothed over.
  assert.ok(parsed.warnings.some((w) => w.includes('2 个独立的 k 路径块')));
});

test('a band file with ragged row widths is flagged, not silently truncated', () => {
  const text = [
    abacusLine(1, 0, [0, 1, 2]),
    abacusLine(2, 0.5, [0, 1]),
  ].join('\n');
  const parsed = parseAbacusBands(text);
  assert.equal(parsed.nBlock, 1);
  assert.ok(parsed.warnings.some((w) => w.includes('能带数不一致')));
});

test('unparseable band lines are skipped and reported', () => {
  const text = ['garbage line here', abacusLine(1, 0, [0, 1]), ''].join('\n');
  const parsed = parseAbacusBands(text);
  assert.equal(parsed.blocks[0].nKpoint, 1);
  assert.ok(parsed.warnings.some((w) => w.includes('无法解析')));
});

test('an empty band file reports empty rather than throwing', () => {
  const parsed = parseAbacusBands('');
  assert.equal(parsed.nBlock, 0);
  assert.deepEqual(parsed.blocks, []);
  assert.ok(parsed.warnings.length > 0);
});

test('readBandFiles picks up both spin channels and notes missing files', () => {
  const files = {
    'bands1.txt': [abacusLine(1, 0, [0, 1]), abacusLine(2, 1, [0.1, 1.1])].join('\n'),
    'bands2.txt': [abacusLine(1, 0, [0, 2]), abacusLine(2, 1, [0.2, 2.2])].join('\n'),
  };
  const { channels, warnings } = readBandFiles((name) => files[name] ?? null, ['bands1.txt', 'bands2.txt']);
  assert.equal(channels.length, 2);
  assert.equal(channels[0].spin, 1);
  assert.equal(channels[1].spin, 2);
  assert.deepEqual(warnings, []);

  const none = readBandFiles(() => null, ['band.txt']);
  assert.equal(none.channels.length, 0);
  assert.ok(none.warnings.some((w) => w.includes('没有找到能带文件')));
});

// ------------------------------------------------------------- LibRPA ------

test('a LibRPA band file name yields kind, spin and iteration', () => {
  assert.deepEqual(parseBandFileName('QSGW_band_spin_1_12.dat'), { kind: 'QSGW', spin: 1, iter: 12 });
  assert.deepEqual(parseBandFileName('KS_band_spin_2.dat'), { kind: 'KS', spin: 2, iter: null });
  assert.equal(parseBandFileName('random.txt'), null);
});

test('a LibRPA band file yields per-k states', () => {
  const text = [
    librpaLine(1, [0, 0, 0], [-5, 1]),
    librpaLine(2, [0.5, 0, 0], [-4.5, 1.5]),
  ].join('\n');
  const parsed = parseLibrpaBand(text, { fileName: 'QSGW_band_spin_1_3.dat' });
  assert.equal(parsed.kind, 'QSGW');
  assert.equal(parsed.spin, 1);
  assert.equal(parsed.iter, 3);
  assert.equal(parsed.nKpoint, 2);
  assert.equal(parsed.nState, 2);
  assert.deepEqual(parsed.rows[0].k, [0, 0, 0]);
  assert.deepEqual(parsed.rows[1].energiesEv, [-4.5, 1.5]);
  assert.equal(parsed.minEnergyEv, -5);
  assert.equal(parsed.maxEnergyEv, 1.5);
});

test('groupBandIterations sorts each series and keeps kinds apart', () => {
  const entries = [
    { fileName: 'QSGW_band_spin_1_10.dat', parsed: { kind: 'QSGW', spin: 1, iter: 10, rows: [1], nKpoint: 4, nState: 2, minEnergyEv: 0, maxEnergyEv: 1 } },
    { fileName: 'QSGW_band_spin_1_2.dat', parsed: { kind: 'QSGW', spin: 1, iter: 2, rows: [1], nKpoint: 4, nState: 2, minEnergyEv: 0, maxEnergyEv: 1 } },
    { fileName: 'KS_band_spin_1_2.dat', parsed: { kind: 'KS', spin: 1, iter: 2, rows: [1], nKpoint: 4, nState: 2, minEnergyEv: 0, maxEnergyEv: 1 } },
  ];
  const { series } = groupBandIterations(entries);
  assert.equal(series.length, 2);
  const qsgw = series.find((s) => s.kind === 'QSGW');
  assert.deepEqual(qsgw.iterations.map((i) => i.iter), [2, 10]);
});

test('cumulativePathLength turns Cartesian k into distance along the path', () => {
  const path = cumulativePathLength([
    [0, 0, 0],
    [0.5, 0, 0],
    [1.0, 0, 0],
  ]);
  assert.deepEqual(path, [0, 0.5, 1.0]);
});

// ----------------------------------------------------------- assembly ------

function makeTask(files) {
  const root = mkdtempSync(join(tmpdir(), 'abacusflow-bands-'));
  const task = join(root, 'task');
  mkdirSync(task, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const full = join(task, name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return { root, task };
}

test('readBands finds ABACUS bands inside OUT.<suffix>', () => {
  const { task } = makeTask({
    'OUT.t/band.txt': [abacusLine(1, 0, [0, 1]), abacusLine(2, 1, [0.1, 1.1])].join('\n'),
  });
  try {
    const bands = readBands(task, { outDir: 'OUT.t' });
    assert.equal(bands.error, '');
    assert.equal(bands.abacus.length, 1);
    assert.equal(bands.abacus[0].file, 'band.txt');
    assert.equal(bands.abacus[0].nKpoint, 2);
    assert.equal(bands.abacus[0].nBand, 2);
    assert.deepEqual(bands.abacus[0].kpath, [0, 1]);
    assert.equal(bands.librpa.length, 0);
  } finally {
    rmSync(join(task, '..'), { recursive: true, force: true });
  }
});

test('readBands selects the requested LibRPA iteration and reports availability', () => {
  const line = (e) => [librpaLine(1, [0, 0, 0], [e]), librpaLine(2, [1, 0, 0], [e + 0.5])].join('\n');
  const { task } = makeTask({
    'librpa.in': 'task = qsgw\noutput_dir = ./librpa.d/\n',
    'librpa.d/QSGW_band_spin_1_2.dat': line(0),
    'librpa.d/QSGW_band_spin_1_9.dat': line(-1),
  });
  try {
    const latest = readBands(task, { librpaOutDir: 'librpa.d' });
    assert.equal(latest.librpa.length, 1);
    assert.equal(latest.librpa[0].iter, 9, 'newest iteration by default');

    const exact = readBands(task, { librpaOutDir: 'librpa.d', lrpaIteration: 2 });
    assert.equal(exact.librpa[0].iter, 2);
    assert.equal(exact.librpa[0].minEnergyEv, 0);

    const missing = readBands(task, { librpaOutDir: 'librpa.d', lrpaIteration: 99 });
    assert.equal(missing.librpa[0].iter, 9, 'falls back to the newest');
    assert.ok(missing.notes.some((n) => n.includes('没有第 99 次迭代')));

    assert.equal(latest.availability.length, 1);
    assert.deepEqual(latest.availability[0].iterations, [2, 9]);
  } finally {
    rmSync(join(task, '..'), { recursive: true, force: true });
  }
});

test('readBands reports a task with no band data instead of throwing', () => {
  const { task } = makeTask({ 'INPUT': 'INPUT_PARAMETERS\n' });
  try {
    const bands = readBands(task, {});
    assert.equal(bands.error, '');
    assert.equal(bands.abacus.length, 0);
    assert.equal(bands.librpa.length, 0);
    assert.ok(bands.warnings.some((w) => w.includes('没有能带数据')));
  } finally {
    rmSync(join(task, '..'), { recursive: true, force: true });
  }
});

// -------------------------------------------------- real NiO / Bi2Se3 ------

const NIO_ROOT = physicsPath('topics', 'gw', 'nio_calculation');
const BIO_BANDS = physicsPath('topics', 'gw', 'efficiency', 'soc-magnetic', 'results', 'Bi2Se3-r2', 'band_full');

test('real NiO band output parses with both spin channels', { skip: !existsSync(NIO_ROOT) }, () => {
  const task = join(NIO_ROOT, 'share', 'NiO-AFM-II-ABACUS-G0W0-QSGW-check-20261014', 'abacus', 'bands');
  const bands = readBands(task, { outDir: 'OUT.nio_afm_frozen_line' });
  assert.equal(bands.error, '');
  assert.equal(bands.abacus.length, 2, 'bands1.txt and bands2.txt');
  assert.deepEqual(bands.abacus.map((c) => c.spin), [1, 2]);
  for (const channel of bands.abacus) {
    assert.equal(channel.nKpoint, 364);
    assert.equal(channel.nBand, 80);
    assert.equal(channel.nBlock, 1);
  }
});

test('real NiO QSGW band iterations are grouped', { skip: !existsSync(NIO_ROOT) }, () => {
  const task = join(NIO_ROOT, 'share', 'NiO-AFM-II-ABACUS-G0W0-QSGW-check-20261014', 'librpa', 'qsgw');
  const bands = readBands(task, { lrpaIteration: 12 });
  assert.equal(bands.error, '');
  assert.equal(bands.librpa.length, 6, 'KS/EXX/QSGW x 2 spins');
  for (const channel of bands.librpa) {
    assert.equal(channel.iter, 12);
    assert.equal(channel.nKpoint, 364);
    assert.equal(channel.nBand, 80);
  }
  const kinds = new Set(bands.librpa.map((c) => c.kind));
  assert.deepEqual([...kinds].sort(), ['EXX', 'KS', 'QSGW']);
  // Every series should advertise all 12 iterations.
  for (const a of bands.availability) assert.equal(a.fileCount, 12);
});

test('real Bi2Se3 band.txt holds two appended k-path blocks', { skip: !existsSync(BIO_BANDS) }, () => {
  const bands = readBands(BIO_BANDS, { outDir: 'OUT.soc' });
  assert.equal(bands.error, '');
  assert.equal(bands.abacus.length, 1);
  const channel = bands.abacus[0];
  assert.equal(channel.nBlock, 2, 'an earlier run was appended to this file');
  assert.equal(channel.nKpoint, 364, 'the longer block is selected for plotting');
  assert.equal(channel.nBand, 220);
  assert.ok(bands.warnings.some((w) => w.includes('2 个独立的 k 路径块')));
});
