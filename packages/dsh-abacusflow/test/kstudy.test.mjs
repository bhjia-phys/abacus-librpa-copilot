/**
 * k-point convergence studies.
 *
 * The motivating data is the researcher's Si campaign: five Gamma-centred meshes
 * (k444…k888), eight QSGW updates each, retained only as an analysis snapshot. These tests
 * pin both evidence shapes (live tree, snapshot) and the numbers the panel shows for Si.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { physicsPath } from '../scripts/lib/local-data.mjs';

import {
  meshFromName,
  readTrajectory,
  studyFromTree,
  studyFromSnapshot,
  adjacentMeshDeltas,
  buildKStudy,
} from '../lib/host/kstudy.js';

/** A `qsgw_iterations.dat` with the real column layout. */
const ITER_HEADER =
  '# iter max_delta_eV residual_l2_Ha residual_max_Ha efermi_eV gap_eV electron_count beta converged';
function iterRow(iter, gap, delta, residual) {
  return [
    iter,
    delta.toExponential(15),
    (residual * 10).toExponential(15),
    residual.toExponential(15),
    '5.0e+00',
    gap.toExponential(15),
    '8.0e+00',
    '1.0',
    '0',
  ].join(' ');
}

// ------------------------------------------------------------- helpers -----

test('meshFromName reads k444-style names only', () => {
  assert.equal(meshFromName('k444'), 4);
  assert.equal(meshFromName('k888'), 8);
  assert.equal(meshFromName('K666'), 6);
  // A non-cubic name still yields its first digit: campaigns are Gamma-centred cubes here.
  assert.equal(meshFromName('k468'), 4);
  assert.equal(meshFromName('frozen'), null);
  assert.equal(meshFromName('k44'), null);
});

test('readTrajectory parses the QSGW table into an iteration list', () => {
  const root = mkdtempSync(join(tmpdir(), 'abacusflow-traj-'));
  try {
    mkdirSync(join(root, 'librpa.d'), { recursive: true });
    writeFileSync(
      join(root, 'librpa.d', 'qsgw_iterations.dat'),
      [ITER_HEADER, iterRow(0, 0.7094, 0, 0), iterRow(1, 1.3979, 2.0, 0.0445), iterRow(2, 1.5224, 0.5333, 0.0196)].join('\n'),
    );
    const traj = readTrajectory(root);
    assert.ok(traj);
    assert.equal(traj.iterations.length, 3);
    assert.equal(traj.iterations[0].iter, 0);
    assert.ok(Math.abs(traj.iterations[2].gapEv - 1.5224) < 1e-9);
    assert.ok(Math.abs(traj.iterations[1].maxDeltaEv - 2.0) < 1e-9);
    assert.equal(traj.convergedIter, null, 'no row is marked converged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readTrajectory returns null when a run has no iteration table', () => {
  const root = mkdtempSync(join(tmpdir(), 'abacusflow-traj-'));
  try {
    assert.equal(readTrajectory(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- tree -----

test('studyFromTree groups meshes by material and sorts them', () => {
  const root = mkdtempSync(join(tmpdir(), 'abacusflow-kstudy-'));
  try {
    for (const [material, mesh, gap] of [['Si', 'k666', 1.5], ['Si', 'k444', 1.6], ['Si', 'k555', 1.4], ['BN', 'k444', 6.9]]) {
      const dir = join(root, material, mesh, 'librpa.d');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'qsgw_iterations.dat'), [ITER_HEADER, iterRow(0, gap, 0, 0), iterRow(1, gap, 0.1, 0.01)].join('\n'));
    }
    const study = studyFromTree(root);
    assert.equal(study.error, '');
    assert.equal(study.materials.length, 2);
    const si = study.materials.find((m) => m.material === 'Si');
    assert.deepEqual(si.meshes.map((m) => m.mesh), [4, 5, 6], 'sorted ascending');
    const bn = study.materials.find((m) => m.material === 'BN');
    assert.equal(bn.meshes.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('studyFromTree reports a directory with no mesh subdirectories', () => {
  const root = mkdtempSync(join(tmpdir(), 'abacusflow-kstudy-'));
  try {
    mkdirSync(join(root, 'Si', 'frozen'), { recursive: true });
    const study = studyFromTree(root);
    assert.equal(study.materials.length, 0);
    assert.ok(study.warnings.some((w) => w.includes('k<网格>')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ snapshot -----

const SNAPSHOT = {
  observed_utc: '2026-10-18T06:45:01.723429+00:00',
  cases: [
    {
      material: 'Si',
      n: 4,
      run: '/runs/Si/k444',
      complete: true,
      native_rows: [
        { iteration: 0, gap_eV: 0.7094, max_delta_eV: 0, residual_max_Ha: 0, native_converged: false },
        { iteration: 8, gap_eV: 1.650284, max_delta_eV: 0.0015, residual_max_Ha: 5.52e-5, native_converged: false },
      ],
    },
    {
      material: 'Si',
      n: 8,
      run: '/runs/Si/k888',
      complete: true,
      native_rows: [
        { iteration: 0, gap_eV: 0.72, max_delta_eV: 0, residual_max_Ha: 0, native_converged: false },
        { iteration: 8, gap_eV: 1.424808, max_delta_eV: 0.0012, residual_max_Ha: 4e-5, native_converged: false },
      ],
    },
  ],
};

test('studyFromSnapshot reads cases and pairs adjacent meshes', () => {
  const root = mkdtempSync(join(tmpdir(), 'abacusflow-snap-'));
  try {
    const file = join(root, 'snapshot.json');
    writeFileSync(file, JSON.stringify(SNAPSHOT));
    const study = studyFromSnapshot(file);
    assert.equal(study.error, '');
    assert.equal(study.observedUtc, '2026-10-18T06:45:01.723429+00:00');
    assert.equal(study.materials.length, 1);
    const si = study.materials[0];
    assert.equal(si.material, 'Si');
    assert.deepEqual(si.meshes.map((m) => m.mesh), [4, 8]);

    const deltas = adjacentMeshDeltas(study.materials);
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].coarser, 4);
    assert.equal(deltas[0].finer, 8);
    assert.ok(Math.abs(deltas[0].deltaGapEv - (1.424808 - 1.650284)) < 1e-9);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('studyFromSnapshot also picks up comparison.json next to it', () => {
  const root = mkdtempSync(join(tmpdir(), 'abacusflow-snap-'));
  try {
    writeFileSync(join(root, 'snapshot.json'), JSON.stringify(SNAPSHOT));
    writeFileSync(
      join(root, 'comparison.json'),
      JSON.stringify({
        observed_utc: '2026-10-18T06:45:01.723429+00:00',
        comparison_iteration: 8,
        limitation: 'Fixed-budget sensitivity only',
        rows: [
          { material: 'Si', n: 4, completed_updates: 8, grid_gap_eV: 1.6503, path_gap_eV: 1.4704, Gamma_gap_eV: 2.9, grid_last_gap_step_eV: 0.0015 },
        ],
      }),
    );
    const study = studyFromSnapshot(join(root, 'snapshot.json'));
    assert.ok(study.comparison);
    assert.equal(study.comparison.comparisonIteration, 8);
    assert.equal(study.comparison.rows.length, 1);
    assert.ok(Math.abs(study.comparison.rows[0].gridGapEv - 1.6503) < 1e-9);
    assert.ok(study.comparison.limitation.includes('Fixed-budget'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed snapshot reports an error instead of throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'abacusflow-snap-'));
  try {
    const file = join(root, 'snapshot.json');
    writeFileSync(file, '{not json');
    const study = studyFromSnapshot(file);
    assert.ok(study.error.includes('解析失败'));
    assert.deepEqual(study.materials, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ dispatch -----

test('buildKStudy prefers a live tree and falls back to a snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'abacusflow-dispatch-'));
  try {
    // Tree present.
    const meshDir = join(root, 'Si', 'k444', 'librpa.d');
    mkdirSync(meshDir, { recursive: true });
    writeFileSync(join(meshDir, 'qsgw_iterations.dat'), [ITER_HEADER, iterRow(0, 1.6, 0, 0)].join('\n'));
    const fromTree = buildKStudy(root);
    assert.equal(fromTree.source, 'tree');
    assert.equal(fromTree.materials.length, 1);

    // No tree, but an analysis snapshot beside it.
    const bare = mkdtempSync(join(tmpdir(), 'abacusflow-dispatch2-'));
    try {
      writeFileSync(join(bare, 'snapshot.json'), JSON.stringify(SNAPSHOT));
      const fromSnap = buildKStudy(bare);
      assert.equal(fromSnap.source, 'snapshot');
      assert.equal(fromSnap.materials[0].material, 'Si');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildKStudy on a nonexistent path reports it', () => {
  const study = buildKStudy(join(tmpdir(), 'abacusflow-does-not-exist-xyz'));
  assert.equal(study.source, 'none');
  assert.ok(study.warnings.some((w) => w.includes('不存在') || w.includes('snapshot')));
});

// --------------------------------------------------------- real campaign ---

const REAL_SNAPSHOT = physicsPath('topics', 'gw', 'workspace', 'qsgw', 'k-convergence-master-20261012', 'analysis', 'kmesh-convergence-20261018', 'snapshot.json');

test('the real Si campaign yields five meshes and a shrinking final difference', { skip: !existsSync(REAL_SNAPSHOT) }, () => {
  const study = buildKStudy(REAL_SNAPSHOT);
  assert.equal(study.error, '');
  assert.equal(study.source, 'snapshot');

  const si = study.materials.find((m) => m.material === 'Si');
  assert.ok(si, 'Si present in the campaign');
  assert.deepEqual(si.meshes.map((m) => m.mesh), [4, 5, 6, 7, 8]);
  for (const mesh of si.meshes) {
    assert.equal(mesh.iterations.length, 9, 'iteration 0 through 8');
    assert.equal(mesh.complete, true, 'Si completed every mesh');
  }

  // The recorded gaps, to 1 meV, from the researcher's own analysis.
  const lastGaps = si.meshes.map((m) => m.iterations[m.iterations.length - 1].gapEv);
  const expected = [1.6503, 1.4521, 1.5625, 1.3987, 1.4248];
  for (let i = 0; i < expected.length; i += 1) {
    assert.ok(Math.abs(lastGaps[i] - expected[i]) < 1e-3, `k${si.meshes[i].mesh}: ${lastGaps[i]} vs ${expected[i]}`);
  }

  const deltas = study.deltas.filter((d) => d.material === 'Si');
  assert.equal(deltas.length, 4);
  // The gap does NOT decrease monotonically with mesh refinement — this is the finding the
  // view must not hide behind a smoothed curve.
  assert.ok(deltas[0].deltaGapEv < 0, 'k444 -> k555 lowers the gap');
  assert.ok(deltas[1].deltaGapEv > 0, 'k555 -> k666 raises it again');
  assert.ok(deltas[3].deltaGapEv > 0, 'k777 -> k888 raises it slightly');
  // And the last step is much smaller than the first, which is what "approaching" looks like.
  assert.ok(Math.abs(deltas[3].deltaGapEv) < Math.abs(deltas[0].deltaGapEv) / 3);
});

test('the real campaign records its own limitation', { skip: !existsSync(REAL_SNAPSHOT) }, () => {
  const study = buildKStudy(REAL_SNAPSHOT);
  assert.ok(study.limitation, 'a limitation is recorded');
  assert.ok(
    String(study.limitation).toLowerCase().includes('fixed-budget'),
    `limitation text: ${study.limitation}`,
  );
  // comparison.json does sit beside the snapshot in this campaign, with one row per case
  // (BN, MgO, Si x five meshes = 15) and the recorded comparison iteration.
  assert.ok(study.comparison, 'comparison.json is picked up');
  assert.equal(study.comparison.rows.length, 15);
  assert.equal(study.comparison.comparisonIteration, 8);
  const siRows = study.comparison.rows.filter((row) => row.material === 'Si');
  assert.equal(siRows.length, 5, 'one comparison row per Si mesh');
});
