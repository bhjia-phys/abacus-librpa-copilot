/**
 * k-point convergence studies: several QSGW runs that differ only in the response mesh.
 *
 * Two shapes of evidence exist in this repository, and they answer different questions:
 *
 *  1. **A live run tree** — `runs/<material>/k444`, `k555`, … each with its own
 *     `librpa.d/qsgw_iterations.dat`. This is the raw trajectory: gap and ΔE per update,
 *     per mesh. It shows whether the *self-consistency* converged at that mesh.
 *
 *  2. **An analysis snapshot** — `snapshot.json` + `comparison.json` written by the
 *     researcher's own campaign scripts, holding every case's `native_rows` and a
 *     per-mesh gap comparison. When the runs themselves have been cleaned up, this is the
 *     only surviving record, so the panel must read it rather than demand the raw tree.
 *
 * In both shapes the interesting object is a **mesh x iteration surface**, not a single
 * curve. That is why this is its own module with its own view: one run's convergence is
 * not a k-convergence answer.
 *
 * ## What it refuses to declare
 *
 * It never says a mesh is "converged". Whether 14 meV between k777 and k888 is acceptable
 * depends on the quantity and the tolerance, which are the researcher's to set. The module
 * reports the adjacent-mesh differences and leaves the verdict out.
 *
 * @module abacusflow/host/kstudy
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { listDir, readTextCapped, safeStat } from './shared/paths.js';
import { parseQsgwIterations } from './librpa/output.js';

/** `k444` / `k666` directory names encode the mesh. */
const MESH_DIR_RE = /^k(\d)\1\1$/i;

/**
 * Parse a mesh label from a directory name.
 * @returns {number|null} the mesh size (4 for k444), or null
 */
export function meshFromName(name) {
  const m = MESH_DIR_RE.exec(String(name ?? ''));
  if (m) return Number(m[1]);
  const any = /^k(\d)(\d)(\d)$/i.exec(String(name ?? ''));
  if (!any) return null;
  return Number(any[1]);
}

/**
 * Read one run's QSGW trajectory from its `qsgw_iterations.dat`.
 *
 * @param {string} taskAbs task directory (the one holding `librpa.d` or `librpa.in`)
 * @param {string} [outDir] LibRPA output dir name, default `librpa.d`
 * @returns {{ iterations:Array, convergedIter:number|null, file:string|null } | null}
 */
export function readTrajectory(taskAbs, outDir = 'librpa.d') {
  const candidates = [
    join(taskAbs, outDir, 'qsgw_iterations.dat'),
    join(taskAbs, 'qsgw_iterations.dat'),
  ];
  for (const path of candidates) {
    if (!safeStat(path)) continue;
    const raw = readTextCapped(path, 4 * 1024 * 1024);
    if (!raw) continue;
    const parsed = parseQsgwIterations(raw.text);
    return {
      iterations: parsed.rows.map((row) => ({
        iter: row.iter,
        gapEv: typeof row.gap_eV === 'number' ? row.gap_eV : null,
        maxDeltaEv: typeof row.max_delta_eV === 'number' ? row.max_delta_eV : null,
        residualMaxHa: typeof row.residual_max_Ha === 'number' ? row.residual_max_Ha : null,
        converged: row.converged === 1 || row.converged === '1' || row.converged === true,
      })),
      convergedIter: parsed.convergedIter,
      file: path,
    };
  }
  return null;
}

/**
 * Build a study from directory names: `<root>/<material>/k<mesh>`.
 *
 * @param {string} root directory holding per-material subdirectories
 * @returns {{ materials:Array<{ material:string, meshes:Array }>, warnings:string[], error:string }}
 */
export function studyFromTree(root) {
  const warnings = [];
  const abs = resolve(root);
  if (!safeStat(abs)) {
    return { materials: [], warnings, error: `目录不存在：${root}` };
  }

  const materials = [];
  for (const materialEntry of listDir(abs, { withStats: false }) ?? []) {
    if (!materialEntry.isDir) continue;
    const materialAbs = join(abs, materialEntry.name);
    const meshes = [];
    for (const meshEntry of listDir(materialAbs, { withStats: false }) ?? []) {
      if (!meshEntry.isDir) continue;
      const mesh = meshFromName(meshEntry.name);
      if (mesh === null) continue;
      const meshAbs = join(materialAbs, meshEntry.name);
      const trajectory = readTrajectory(meshAbs);
      if (!trajectory) {
        warnings.push(`${materialEntry.name}/${meshEntry.name}：没有 qsgw_iterations.dat`);
        continue;
      }
      meshes.push({
        mesh,
        dir: meshEntry.name,
        relPath: `${materialEntry.name}/${meshEntry.name}`,
        iterations: trajectory.iterations,
        convergedIter: trajectory.convergedIter,
      });
    }
    if (meshes.length === 0) continue;
    meshes.sort((a, b) => a.mesh - b.mesh);
    materials.push({ material: materialEntry.name, meshes });
  }

  if (materials.length === 0) {
    warnings.push('没有找到 <材料>/k<网格> 形式的目录（例如 Si/k444）');
  }
  return { materials, warnings, error: '' };
}

/**
 * Read a campaign analysis snapshot (`snapshot.json`, optionally `comparison.json`).
 *
 * These are produced by the researcher's own scripts when a campaign finishes; they hold
 * the per-iteration trajectories and the per-mesh gap comparison. Reading them means the
 * panel still answers a k-convergence question after the raw run tree has been removed.
 *
 * @param {string} snapshotPath
 * @returns {{ materials:Array, comparison:object|null, observedUtc:string|null,
 *             limitation:string|null, warnings:string[], error:string }}
 */
export function studyFromSnapshot(snapshotPath) {
  const warnings = [];
  const abs = resolve(snapshotPath);
  if (!safeStat(abs)) return { materials: [], comparison: null, observedUtc: null, limitation: null, warnings, error: `文件不存在：${snapshotPath}` };

  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (error) {
    return { materials: [], comparison: null, observedUtc: null, limitation: null, warnings, error: `snapshot 解析失败：${error.message}` };
  }

  const byMaterial = new Map();
  for (const item of snapshot.cases ?? []) {
    const material = item.material ?? 'unknown';
    if (!byMaterial.has(material)) byMaterial.set(material, []);
    byMaterial.get(material).push({
      mesh: item.n,
      dir: `k${String(item.n).repeat(3)}`,
      relPath: item.run ?? null,
      complete: item.complete === true,
      convergedIter: null,
      iterations: (item.native_rows ?? []).map((row) => ({
        iter: row.iteration,
        gapEv: typeof row.gap_eV === 'number' ? row.gap_eV : null,
        maxDeltaEv: typeof row.max_delta_eV === 'number' ? row.max_delta_eV : null,
        residualMaxHa: typeof row.residual_max_Ha === 'number' ? row.residual_max_Ha : null,
        converged: row.native_converged === true,
      })),
    });
  }

  const materials = [...byMaterial.entries()]
    .map(([material, meshes]) => ({ material, meshes: meshes.sort((a, b) => a.mesh - b.mesh) }))
    .sort((a, b) => a.material.localeCompare(b.material));

  // `comparison.json` sits next to the snapshot and carries the derived per-mesh gaps.
  const comparisonPath = join(dirname(abs), 'comparison.json');
  let comparison = null;
  if (safeStat(comparisonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(comparisonPath, 'utf8'));
      comparison = {
        observedUtc: parsed.observed_utc ?? null,
        comparisonIteration: parsed.comparison_iteration ?? null,
        limitation: parsed.limitation ?? null,
        rows: (parsed.rows ?? []).map((row) => ({
          material: row.material,
          mesh: row.n,
          completedUpdates: row.completed_updates ?? null,
          gridGapEv: typeof row.grid_gap_eV === 'number' ? row.grid_gap_eV : null,
          pathGapEv: typeof row.path_gap_eV === 'number' ? row.path_gap_eV : null,
          gammaGapEv: typeof row.Gamma_gap_eV === 'number' ? row.Gamma_gap_eV : null,
          lastGapStepEv: typeof row.grid_last_gap_step_eV === 'number' ? row.grid_last_gap_step_eV : null,
        })),
      };
    } catch (error) {
      warnings.push(`comparison.json 解析失败：${error.message}`);
    }
  }

  return {
    materials,
    comparison,
    observedUtc: snapshot.observed_utc ?? null,
    limitation: comparison?.limitation ?? null,
    warnings,
    error: '',
  };
}

/**
 * Adjacent-mesh differences: the quantity a convergence decision actually uses.
 *
 * Reported per material between consecutive meshes, using the last gap of each mesh.
 * A negative `deltaGapEv` means the finer mesh lowered the gap.
 *
 * @param {Array<{ material:string, meshes:Array }>} materials
 * @returns {Array<{ material:string, coarser:number, finer:number, coarseGapEv:number|null,
 *                   fineGapEv:number|null, deltaGapEv:number|null }>}
 */
export function adjacentMeshDeltas(materials) {
  const out = [];
  for (const { material, meshes } of materials) {
    const withGap = meshes
      .map((m) => ({
        mesh: m.mesh,
        gap: lastFinite(m.iterations.map((i) => i.gapEv)),
      }))
      .filter((m) => m.gap !== null);
    for (let i = 1; i < withGap.length; i += 1) {
      const coarse = withGap[i - 1];
      const fine = withGap[i];
      out.push({
        material,
        coarser: coarse.mesh,
        finer: fine.mesh,
        coarseGapEv: coarse.gap,
        fineGapEv: fine.gap,
        deltaGapEv: fine.gap - coarse.gap,
      });
    }
  }
  return out;
}

function lastFinite(values) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = values[i];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Assemble a full k-convergence study view from whatever evidence a directory holds.
 *
 * Prefers a live run tree (`<material>/k<mesh>`); falls back to an analysis snapshot so a
 * cleaned-up campaign is still answerable.
 *
 * @param {string} target directory or snapshot file
 * @returns {object}
 */
export function buildKStudy(target) {
  const abs = resolve(target);
  const isFile = safeStat(abs)?.isDir === false;

  if (isFile) {
    const study = studyFromSnapshot(abs);
    return {
      source: 'snapshot',
      observedUtc: study.observedUtc,
      limitation: study.limitation,
      materials: study.materials,
      comparison: study.comparison,
      deltas: adjacentMeshDeltas(study.materials),
      warnings: study.warnings,
      error: study.error,
    };
  }

  const tree = studyFromTree(abs);
  // A tree error means the path itself is unusable; fall through to the snapshot probe
  // and finally report `none`, rather than returning a "tree" that holds only an error.
  if (!tree.error && tree.materials.length > 0) {
    return {
      source: 'tree',
      observedUtc: null,
      limitation: null,
      materials: tree.materials,
      comparison: null,
      deltas: adjacentMeshDeltas(tree.materials),
      warnings: tree.warnings,
      error: '',
    };
  }

  // A study directory often holds its own analysis next to the runs.
  for (const candidate of ['snapshot.json', join('analysis', 'snapshot.json')]) {
    const path = join(abs, candidate);
    if (safeStat(path)) {
      const study = studyFromSnapshot(path);
      return {
        source: 'snapshot',
        observedUtc: study.observedUtc,
        limitation: study.limitation,
        materials: study.materials,
        comparison: study.comparison,
        deltas: adjacentMeshDeltas(study.materials),
        warnings: [...tree.warnings, ...study.warnings],
        error: study.error,
      };
    }
  }

  return {
    source: 'none',
    observedUtc: null,
    limitation: null,
    materials: [],
    comparison: null,
    deltas: [],
    warnings: [
      ...(tree.error ? [tree.error] : tree.warnings),
      '也没有找到 snapshot.json（分析快照）',
    ],
    error: '',
  };
}

export { MESH_DIR_RE, basename, existsSync };
