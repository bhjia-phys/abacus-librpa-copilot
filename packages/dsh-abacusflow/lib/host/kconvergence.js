/**
 * k-point convergence comparison.
 *
 * A convergence study is *not* one task: it is several runs of the same system that differ
 * only in the k mesh (k444 vs k666 vs k888). Looking at them one at a time cannot answer
 * the question, so this module aligns several band sets onto a common k path and reports
 * the quantities a convergence decision actually uses.
 *
 * The Si runs in this repository are the motivating case: `si-qsgw-k444-headwing-kconv-*`
 * and `si-qsgw-k666-headwing-kconv-*` hold the same 201-point path (length 4.6324) and the
 * same 44 bands, so they can be compared point-by-point rather than only by eye.
 *
 * ## What it refuses to do
 *
 * It will not interpolate or resample to force a match. If two runs have different k paths
 * or different band counts, that is a real mismatch and it is reported as such; silently
 * aligning them would fabricate a comparison. The caller gets a per-run extent block and a
 * warning instead.
 *
 * @module abacusflow/host/kconvergence
 */
import { readBands } from './bands.js';

/** Two k-path samples are the same point within this distance (Cartesian, 1/Bohr). */
const KPATH_TOLERANCE = 1e-5;

/**
 * Describe one run's band set in the terms a convergence check needs.
 *
 * "Band edges" are taken from the *occupation-weighted* ordering LibRPA writes: for each
 * k-point the highest occupied and lowest empty state. When occupations are absent (ABACUS
 * `band.txt` has none) the edge is reported as `null` rather than guessed from an index,
 * because guessing would produce a confident-looking gap that is not a gap.
 *
 * @param {object} channel one entry from `readBands(...).librpa` or `.abacus`
 * @returns {object}
 */
export function describeChannel(channel) {
  const energies = channel.energies ?? [];
  const occupations = channel.occupations ?? null;
  const edges = bandEdges(energies, occupations);

  return {
    label: channel.label ?? channel.file,
    kind: channel.kind ?? 'ABACUS',
    spin: channel.spin ?? 1,
    iter: channel.iter ?? null,
    nKpoint: channel.nKpoint ?? energies.length,
    nBand: channel.nBand ?? (energies[0] ? energies[0].length : 0),
    kpathLength: (channel.kpath ?? []).length > 0 ? channel.kpath[channel.kpath.length - 1] : null,
    minEnergyEv: channel.minEnergyEv ?? null,
    maxEnergyEv: channel.maxEnergyEv ?? null,
    vbmEv: edges.vbm,
    cbmEv: edges.cbm,
    gapEv: edges.gap,
    meanVbmEv: edges.meanVbm,
    meanCbmEv: edges.meanCbm,
    /** k-points whose lowest empty state sat below the highest occupied one. */
    invertedKpoints: edges.inverted,
    usableKpoints: edges.usableKpoints,
    occupationScale: edges.occupationScale,
  };
}

/**
 * Locate the band edges from occupations.
 *
 * Two things make the naive "global max of occupied / global min of empty" wrong:
 *
 *  1. **Each k-point has its own HOMO**, and the gap is `min_k(LUMO_k) - max_k(HOMO_k)`.
 *     Taking a global min over every empty state instead lets a single pathological state
 *     dominate — which is exactly what the real Si EXX files do: they contain an empty
 *     state at -45.5 eV, far below the 4.5 eV HOMO, and a global-min gap reads -50 eV.
 *  2. **Occupations are scaled by the k-point count** (0 or 2 here, not 0 or 1), so the
 *     threshold must be relative, not `> 0.5` on a fixed scale.
 *
 * A per-k LUMO that sits *below* that k's HOMO is an unconverged or mislabelled state; it
 * is excluded from the gap and counted, so the caller can say the file is suspect instead
 * of publishing a negative gap.
 *
 * @param {number[][]} energies `[ik][iband]`
 * @param {number[][]|null} occupations `[ik][iband]`, same shape
 * @returns {{ vbm:number|null, cbm:number|null, gap:number|null,
 *             meanVbm:number|null, meanCbm:number|null,
 *             inverted:number, usableKpoints:number, occupationScale:number|null }}
 */
export function bandEdges(energies, occupations) {
  const empty = {
    vbm: null,
    cbm: null,
    gap: null,
    meanVbm: null,
    meanCbm: null,
    inverted: 0,
    usableKpoints: 0,
    occupationScale: null,
  };
  if (!occupations || energies.length === 0) return empty;

  // Occupations may be per-k normalised (0/1) or scaled by nk (0/2, 0/4 …). Derive the
  // scale from the data so the same threshold works for both.
  let maxOcc = 0;
  for (const row of occupations) {
    for (const value of row) {
      if (Number.isFinite(value) && value > maxOcc) maxOcc = value;
    }
  }
  if (maxOcc <= 0) return empty;
  const threshold = maxOcc * 0.5;

  const homos = [];
  const lumos = [];
  let inverted = 0;

  for (let ik = 0; ik < energies.length; ik += 1) {
    const eig = energies[ik] ?? [];
    const occ = occupations[ik] ?? [];
    let homo = null;
    let lumo = null;
    for (let ib = 0; ib < eig.length; ib += 1) {
      const energy = eig[ib];
      const occupation = occ[ib];
      if (!Number.isFinite(energy) || !Number.isFinite(occupation)) continue;
      if (occupation > threshold) {
        if (homo === null || energy > homo) homo = energy;
      } else {
        if (lumo === null || energy < lumo) lumo = energy;
      }
    }
    // A k-point whose lowest empty state sits below its highest occupied state cannot
    // contribute a gap: both of its edges are excluded from the extrema, not just counted.
    // Keeping them in was the bug that produced a -50 eV "gap" from one bad state.
    if (homo !== null && lumo !== null && lumo < homo) {
      inverted += 1;
      continue;
    }
    if (homo !== null) homos.push(homo);
    if (lumo !== null) lumos.push(lumo);
  }

  const usableKpoints = energies.length - inverted;

  return {
    vbm: homos.length > 0 ? Math.max(...homos) : null,
    cbm: lumos.length > 0 ? Math.min(...lumos) : null,
    gap: homos.length > 0 && lumos.length > 0 ? Math.min(...lumos) - Math.max(...homos) : null,
    meanVbm: homos.length > 0 ? mean(homos) : null,
    meanCbm: lumos.length > 0 ? mean(lumos) : null,
    inverted,
    usableKpoints,
    occupationScale: maxOcc,
  };
}

function mean(values) {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/**
 * Check whether two channels share an identical k path.
 *
 * A convergence comparison is only point-by-point meaningful if the paths agree. If they
 * do not, the caller should compare scalars (gap, edges) instead of curves.
 *
 * @returns {{ identical:boolean, reason:string }}
 */
export function compareKPaths(a, b) {
  const ka = a.kpath ?? [];
  const kb = b.kpath ?? [];
  if (ka.length === 0 || kb.length === 0) {
    return { identical: false, reason: '其中一个任务没有 k 路径数据' };
  }
  if (ka.length !== kb.length) {
    return { identical: false, reason: `k 点数不同（${ka.length} vs ${kb.length}）` };
  }
  for (let i = 0; i < ka.length; i += 1) {
    if (Math.abs(ka[i] - kb[i]) > KPATH_TOLERANCE) {
      return { identical: false, reason: `第 ${i + 1} 个 k 点的路径长度不同` };
    }
  }
  return { identical: true, reason: '' };
}

/**
 * Build a k-point convergence comparison across several runs.
 *
 * @param {Array<{ label:string, absPath:string, outDir?:string|null, librpaOutDir?:string|null }>} runs
 * @param {{ kind?:string, spin?:number, iteration?:number|null }} [options]
 * @returns {object}
 */
export function compareRuns(runs, options = {}) {
  const kind = options.kind ?? 'QSGW';
  const spin = options.spin ?? 1;
  const notes = [];
  const warnings = [];

  /** @type {Array<{ label:string, channel:object, summary:object }>} */
  const entries = [];

  for (const run of runs) {
    const bands = readBands(run.absPath, {
      outDir: run.outDir ?? null,
      librpaOutDir: run.librpaOutDir ?? null,
      lrpaIteration: options.iteration ?? null,
    });
    for (const w of bands.warnings) warnings.push(`${run.label}：${w}`);

    const wanted = bands.librpa.filter((c) => c.kind === kind && c.spin === spin);
    const channel = wanted[0];
    if (!channel) {
      notes.push(`${run.label}：没有 ${kind} spin ${spin} 能带文件`);
      continue;
    }
    // `readBands` keeps the occupation columns; without them the band edge cannot be
    // located, and an index-based guess would produce a confident wrong gap.
    const occupations = channel.occupations ?? null;
    if (!occupations) {
      notes.push(`${run.label}：没有占据数，只能报告能量范围，不报告能隙`);
    }
    entries.push({
      label: run.label,
      channel: { ...channel, occupations },
      summary: describeChannel({ ...channel, occupations, label: run.label }),
    });
  }

  // Reference = the first entry; every later one is compared to it.
  const reference = entries[0] ?? null;
  let pathCheck = null;
  if (entries.length >= 2) {
    pathCheck = compareKPaths(entries[0].channel, entries[1].channel);
    if (!pathCheck.identical) {
      warnings.push(
        `k 路径不一致（${pathCheck.reason}）：只能比较标量（能隙、带边），不能逐点比较曲线。`,
      );
    }
  }

  const rows = entries.map((entry) => ({
    label: entry.label,
    nKpoint: entry.summary.nKpoint,
    nBand: entry.summary.nBand,
    iter: entry.summary.iter,
    gapEv: entry.summary.gapEv,
    vbmEv: entry.summary.vbmEv,
    cbmEv: entry.summary.cbmEv,
    meanVbmEv: entry.summary.meanVbmEv,
    meanCbmEv: entry.summary.meanCbmEv,
    invertedKpoints: entry.summary.invertedKpoints,
    usableKpoints: entry.summary.usableKpoints,
    minEnergyEv: entry.summary.minEnergyEv,
    maxEnergyEv: entry.summary.maxEnergyEv,
    deltaGapVsReferenceEv:
      reference && entry !== reference && entry.summary.gapEv !== null && reference.summary.gapEv !== null
        ? entry.summary.gapEv - reference.summary.gapEv
        : null,
    deltaMeanVbmVsReferenceEv:
      reference && entry !== reference && entry.summary.meanVbmEv !== null && reference.summary.meanVbmEv !== null
        ? entry.summary.meanVbmEv - reference.summary.meanVbmEv
        : null,
  }));

  // A file with inverted k-points is suspect; say so rather than publish its gap.
  for (const entry of entries) {
    if (entry.summary.invertedKpoints > 0) {
      warnings.push(
        `${entry.label}：有 ${entry.summary.invertedKpoints}/${entry.summary.nKpoint} 个 k 点的最低空态` +
          `低于最高占据态（未收敛或标记有误），这些点已从能隙中排除。`,
      );
    }
  }

  return {
    kind,
    spin,
    iteration: options.iteration ?? null,
    kPathIdentical: pathCheck ? pathCheck.identical : null,
    kPathReason: pathCheck ? pathCheck.reason : '',
    runs: entries.map((entry) => ({
      label: entry.label,
      kpath: entry.channel.kpath,
      energies: entry.channel.energies,
      nBand: entry.channel.nBand,
      nKpoint: entry.channel.nKpoint,
    })),
    rows,
    notes,
    warnings,
    error: '',
  };
}

export { KPATH_TOLERANCE };
