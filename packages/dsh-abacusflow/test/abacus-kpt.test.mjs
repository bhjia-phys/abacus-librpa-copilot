/**
 * ABACUS `KPT` parser.
 *
 * The decisive case is line mode: ABACUS interpolates a path from the special points, so a
 * file declaring 5 special points can describe 81 k-points. A parser that reports the
 * special-point count as `nkpts` misreports the run's actual k-mesh, which is exactly the
 * number a researcher checks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseKpt } from '../lib/host/abacus/kpt.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', 'abacus', name), 'utf8');

const close = (a, b, tol = 1e-12) => Math.abs(a - b) <= tol;

// ------------------------------------------------------------ automatic mesh --

test('KPT automatic mesh with Gamma centering', () => {
  const kpt = parseKpt(fixture('KPT'));
  assert.equal(kpt.mode, 'auto');
  assert.equal(kpt.centering, 'Gamma');
  assert.equal(kpt.kType, 0);
  assert.deepEqual(kpt.grid, [4, 4, 4]);
  assert.deepEqual(kpt.shift, [0, 0, 0]);
  assert.equal(kpt.nkpts, 64);
  assert.equal(kpt.points, null);
  assert.equal(kpt.declaredNkpts, null);
  assert.deepEqual(kpt.warnings, []);
});

test('KPT Monkhorst-Pack aliases and half shift', () => {
  for (const name of ['Monkhorst-Pack', 'MP', 'mp']) {
    const kpt = parseKpt(`K_POINTS\n0\n${name}\n2 2 2 1 1 1\n`);
    assert.equal(kpt.centering, 'MP', `alias ${name}`);
    assert.equal(kpt.kType, 1);
    assert.deepEqual(kpt.grid, [2, 2, 2]);
    assert.deepEqual(kpt.shift, [1, 1, 1]);
    assert.equal(kpt.nkpts, 8);
    assert.deepEqual(kpt.warnings, []);
  }
});

test('KPT accepts the KPOINTS and K headers', () => {
  assert.equal(parseKpt('KPOINTS\n0\nGamma\n1 1 1\n').mode, 'auto');
  assert.equal(parseKpt('K\n0\nGamma\n1 1 1\n').mode, 'auto');
  assert.equal(parseKpt('K_POINTS\n0\nGamma\n1 1 1\n').nkpts, 1);
});

test('KPT completes a missing or partial shift with zeros, with a warning', () => {
  const noShift = parseKpt('K_POINTS\n0\nGamma\n2 2 2\n');
  assert.deepEqual(noShift.shift, [0, 0, 0]);
  assert.deepEqual(noShift.warnings, []);

  const partial = parseKpt('K_POINTS\n0\nGamma\n2 2 2 1\n');
  assert.deepEqual(partial.shift, [1, 0, 0]);
  assert.ok(partial.warnings.some((w) => w.includes('shift')));
});

test('KPT tolerates the grid sharing the centering line', () => {
  const inline = parseKpt('K_POINTS\n0\nGamma 3 3 3 0 0 1\n');
  assert.equal(inline.mode, 'auto');
  assert.deepEqual(inline.grid, [3, 3, 3]);
  assert.deepEqual(inline.shift, [0, 0, 1]);
  assert.equal(inline.nkpts, 27);
});

test('KPT warns on a bad centering, a non-positive grid and a bad shift', () => {
  const badCenter = parseKpt('K_POINTS\n0\nNonsense\n2 2 2\n');
  assert.equal(badCenter.centering, 'Gamma');
  assert.ok(badCenter.warnings.some((w) => w.includes('centering')));

  const zeroGrid = parseKpt('K_POINTS\n0\nGamma\n0 2 2\n');
  assert.ok(zeroGrid.warnings.some((w) => w.includes('> 0')));

  const badShift = parseKpt('K_POINTS\n0\nGamma\n2 2 2 2 0 0\n');
  assert.ok(badShift.warnings.some((w) => w.includes('shift')));
});

// -------------------------------------------------------------- explicit list --

test('KPT explicit list records its mode keyword', () => {
  const text = 'K_POINTS\n3\nDirect\n0.0 0.0 0.0 0.5\n0.5 0.0 0.0 0.25\n0.5 0.5 0.0 0.25\n';
  const kpt = parseKpt(text);
  assert.equal(kpt.mode, 'explicit');
  assert.equal(kpt.kMode, 'direct');
  assert.equal(kpt.nkpts, 3);
  assert.equal(kpt.declaredNkpts, 3);
  assert.deepEqual(kpt.points[0], { frac: [0, 0, 0], weight: 0.5 });
  assert.deepEqual(kpt.points[1].frac, [0.5, 0, 0]);
  assert.deepEqual(kpt.warnings, []);
});

test('KPT explicit list supports the Cartesian and single-letter aliases', () => {
  for (const name of ['Cartesian', 'C']) {
    const kpt = parseKpt(`K_POINTS\n1\n${name}\n0.1 0.2 0.3 1.0\n`);
    assert.equal(kpt.kMode, 'cartesian', `alias ${name}`);
  }
  for (const name of ['Direct', 'D']) {
    const kpt = parseKpt(`K_POINTS\n1\n${name}\n0.1 0.2 0.3 1.0\n`);
    assert.equal(kpt.kMode, 'direct', `alias ${name}`);
  }
});

test('KPT explicit list warns when the count and rows disagree', () => {
  const short = parseKpt('K_POINTS\n4\nDirect\n0 0 0 1\n0.5 0 0 1\n');
  assert.equal(short.nkpts, 2);
  assert.equal(short.declaredNkpts, 4);
  assert.ok(short.warnings.some((w) => w.includes('实际读到')));

  const missingWeight = parseKpt('K_POINTS\n1\nDirect\n0 0 0\n');
  assert.equal(missingWeight.points[0].weight, null);
  assert.ok(missingWeight.warnings.some((w) => w.includes('权重')));
});

test('KPT explicit list rejects an unknown mode but keeps parsing as Direct', () => {
  const kpt = parseKpt('K_POINTS\n1\nNonsense\n0 0 0 1\n');
  assert.equal(kpt.kMode, 'direct');
  assert.equal(kpt.nkpts, 1);
  assert.ok(kpt.warnings.some((w) => w.includes('Nonsense')));
});

// ------------------------------------------------------------------ line mode --

test('KPT line mode expands the path instead of reporting special points', () => {
  // The real GaAs file: 5 special points, per-segment counts 20 20 20 20 1.
  // ABACUS generates 20+20+20+20 = 80 interpolated points plus the final special point = 81.
  const kpt = parseKpt(fixture('KPT-lines'));
  assert.equal(kpt.mode, 'explicit');
  assert.equal(kpt.kMode, 'line_direct');
  assert.equal(kpt.declaredNkpts, 5, 'the file declares 5 special points');
  assert.equal(kpt.nkpts, 81, 'but the run had 81 k-points');
  assert.equal(kpt.specialPoints.length, 5);
  assert.equal(kpt.segments.length, 4);
  assert.deepEqual(kpt.segments.map((s) => s.count), [20, 20, 20, 20]);
  // Each segment yields exactly `count` points and excludes its endpoint.
  for (const segment of kpt.segments) assert.equal(segment.points.length, segment.count);
  assert.equal(kpt.points.length, 81);
  // The path starts at the first special point and ends at the last one.
  assert.deepEqual(kpt.points[0].frac, [0.5, 0.5, 0.5]);
  assert.deepEqual(kpt.points.at(-1).frac, [0.0, 0.0, 0.0]);
  assert.deepEqual(kpt.warnings, []);
});

test('KPT line mode interpolation is linear between special points', () => {
  const kpt = parseKpt('K_POINTS\n2\nLine\n0.0 0.0 0.0 4\n0.4 0.0 0.0 1\n');
  assert.equal(kpt.nkpts, 5, '4 points on the segment plus the endpoint');
  const xs = kpt.points.map((p) => p.frac[0]);
  for (let i = 0; i < xs.length; i += 1) assert.ok(close(xs[i], i * 0.1), `x[${i}] = ${xs[i]}`);
  // Line-mode weights are all 1 before normalisation.
  assert.ok(kpt.points.every((p) => p.weight === null));
});

test('KPT line mode accepts the L / Line / Line_Cartesian aliases', () => {
  for (const [name, expected] of [['L', 'line_direct'], ['Line', 'line_direct'],
    ['Line_Direct', 'line_direct'], ['Line_Cartesian', 'line_cartesian']]) {
    const kpt = parseKpt(`K_POINTS\n2\n${name}\n0 0 0 2\n1 0 0 1\n`);
    assert.equal(kpt.kMode, expected, `alias ${name}`);
    assert.equal(kpt.nkpts, 3, `alias ${name} expansion`);
  }
});

test('KPT line mode warns when the final point is not a single point', () => {
  // ABACUS asserts nkl[last] === 1; a file that says otherwise is reported.
  const kpt = parseKpt('K_POINTS\n2\nLine\n0 0 0 2\n1 0 0 5\n');
  assert.ok(kpt.warnings.some((w) => w.includes('最后一个')));
  assert.equal(kpt.nkpts, 3, 'the last segment contributes one point regardless');
});

test('KPT line mode with one special point is reported, not thrown', () => {
  const kpt = parseKpt('K_POINTS\n1\nLine\n0 0 0 1\n');
  assert.equal(kpt.nkpts, 1);
  assert.deepEqual(kpt.segments, []);
  assert.ok(kpt.warnings.some((w) => w.includes('至少 2')));
});

// ---------------------------------------------------------------- malformed --

test('KPT never throws and always explains an empty or broken file', () => {
  const cases = [
    ['', '空'],
    ['K_POINTS\n', 'nkstot'],
    ['K_POINTS\nabc\n', 'nkstot'],
    ['K_POINTS\n-1\nDirect\n', '负'],
    ['K_POINTS\n0\n', 'centering'],
    ['K_POINTS\n0\nGamma\n', 'nk1'],
    ['K_POINTS\n0\nGamma\nabc def\n', 'nk1'],
    ['K_POINTS\n1\n', '坐标类型'],
  ];
  for (const [text, needle] of cases) {
    let kpt;
    assert.doesNotThrow(() => { kpt = parseKpt(text); }, `threw on: ${JSON.stringify(text)}`);
    assert.ok(kpt.warnings.length > 0, `no warning for: ${JSON.stringify(text)}`);
    assert.ok(kpt.warnings.some((w) => w.includes(needle)),
      `expected "${needle}" in: ${kpt.warnings.join(' | ')}`);
    // Every documented field exists even on the failure paths.
    for (const field of ['mode', 'centering', 'kType', 'grid', 'shift', 'kMode', 'points',
      'segments', 'specialPoints', 'declaredNkpts', 'nkpts', 'warnings']) {
      assert.ok(field in kpt, `missing field ${field} for ${JSON.stringify(text)}`);
    }
  }
});

test('KPT warns when nkstot exceeds the ABACUS limit', () => {
  const kpt = parseKpt('K_POINTS\n200001\nDirect\n0 0 0 1\n');
  assert.ok(kpt.warnings.some((w) => w.includes('100000')));
});

test('KPT strips comments and blank lines like ABACUS does', () => {
  const kpt = parseKpt('K_POINTS\n# automatic mesh\n\n0\nGamma   # centering\n2 2 2 0 0 0\n');
  assert.equal(kpt.mode, 'auto');
  assert.deepEqual(kpt.grid, [2, 2, 2]);
  assert.deepEqual(kpt.warnings, []);
});
