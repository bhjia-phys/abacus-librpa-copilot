/**
 * Assemble the band-structure data a plot needs, from either DFT or GW output.
 *
 * Two producers are supported, and a task may have both:
 *
 *   ABACUS   `band.txt` / `bands1.txt` / `bands2.txt`   -> DFT (and EXX) bands
 *   LibRPA   `{KS,EXX,QSGW}_band_spin_<s>_<iter>.dat`   -> GW / QSGW bands per iteration
 *
 * Everything returned is already in eV and relative to a stated reference, because the
 * two producers use different energy zeros:
 *
 *   - ABACUS `band.txt` energies are absolute (the writer passes `eshift = 0`);
 *   - LibRPA band files are in eV but on LibRPA's internal zero.
 *
 * So this module never *assumes* a common zero. It reports the raw extent and lets the
 * caller shift by an explicitly supplied reference (`zero`), which the panel exposes as a
 * control. A plot that silently aligned two different zeros would be worse than no plot.
 *
 * @module abacusflow/host/bands
 */
import { resolve } from 'node:path';
import { listDir, readTextCapped, safeStat } from './shared/paths.js';
import { parseAbacusBands, pickMainBlock } from './abacus/bands.js';
import { parseKpt } from './abacus/kpt.js';
import { parseLibrpaBand, parseBandFileName, groupBandIterations } from './librpa/bands.js';

/** Cap: these files are ~870 KiB each on a real QSGW run, and there can be dozens. */
const MAX_BAND_FILES = 40;
const MAX_BAND_BYTES = 64 * 1024 * 1024;

/** ABACUS band-file names, in the order a spin-polarised run writes them. */
const ABACUS_BAND_NAMES = ['band.txt', 'bands1.txt', 'bands2.txt'];

/**
 * Read the band data of a task directory.
 *
 * @param {string} taskAbs absolute task directory
 * @param {{ outDir?: string|null, librpaOutDir?: string|null, lrpaIteration?: number|null }} [options]
 *   `outDir` is the ABACUS `OUT.<suffix>` name; `librpaOutDir` is LibRPA's `output_dir`.
 * @returns {object}
 */
export function readBands(taskAbs, options = {}) {
  const notes = [];
  const warnings = [];

  const outDirName = options.outDir ?? null;
  const outDirAbs = outDirName ? resolve(taskAbs, outDirName) : null;

  // High-symmetry ticks for the x axis. Read once per task: the KPT that defined the path
  // is what names Γ/Z/F, and it applies to every band channel of that task.
  const kTicks = readKTicks(taskAbs);

  // ---- ABACUS ------------------------------------------------------------
  const abacusChannels = [];
  for (const name of ABACUS_BAND_NAMES) {
    const candidates = [];
    if (outDirAbs) candidates.push(resolve(outDirAbs, name));
    candidates.push(resolve(taskAbs, name));
    const found = candidates.find((p) => safeStat(p));
    if (!found) continue;

    const raw = readTextCapped(found, MAX_BAND_BYTES);
    if (!raw) {
      notes.push(`无法读取 ${name}`);
      continue;
    }
    const parsed = parseAbacusBands(raw.text, { fileName: name });
    for (const w of parsed.warnings) warnings.push(`${name}：${w}`);
    const main = pickMainBlock(parsed);
    const spinMatch = /^bands(\d)\.txt$/i.exec(name);
    abacusChannels.push({
      source: 'abacus',
      file: name,
      spin: spinMatch ? Number(spinMatch[1]) : 1,
      nBlock: parsed.nBlock,
      nBand: parsed.nBand,
      // Only the plotted block is sent to the browser; the others are described.
      nKpoint: main ? main.nKpoint : 0,
      kpath: main ? main.kpath : [],
      // Tick labels for the x axis: Γ/Z/F/… positioned along the same path length.
      kTicks: main ? placeTicks(kTicks, main.kpath) : [],
      energies: main ? main.energies : [],
      minEnergyEv: main ? main.minEnergyEv : null,
      maxEnergyEv: main ? main.maxEnergyEv : null,
      blocks: parsed.blocks.map((b) => ({
        index: b.index,
        nKpoint: b.nKpoint,
        nBand: b.nBand,
        kpathRange: b.kpathRange,
        minEnergyEv: b.minEnergyEv,
        maxEnergyEv: b.maxEnergyEv,
      })),
      truncated: raw.truncated,
    });
  }

  // ---- LibRPA ------------------------------------------------------------
  const librpaOutRel = options.librpaOutDir ?? null;
  const librpaOutAbs = librpaOutRel ? resolve(taskAbs, librpaOutRel) : resolve(taskAbs, 'librpa.d');

  const librpaFiles = [];
  const seenDirs = new Set();
  for (const dir of [librpaOutAbs, taskAbs]) {
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    const entries = listDir(dir);
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.isDir) continue;
      if (!/^(KS|EXX|QSGW)_band_spin_\d+(_\d+)?\.dat$/i.test(entry.name)) continue;
      librpaFiles.push({ dir, name: entry.name, size: entry.size });
    }
  }

  // Prefer the requested iteration; otherwise the newest available one per (kind, spin).
  // Reading all 72 files of a 12-iteration run would mean ~61 MB on a network path.
  const bySeries = new Map();
  for (const file of librpaFiles) {
    const meta = parseBandFileName(file.name);
    if (!meta) continue;
    const key = `${meta.kind}:${meta.spin}`;
    if (!bySeries.has(key)) bySeries.set(key, []);
    bySeries.get(key).push({ ...file, meta });
  }

  const wantedIter = options.lrpaIteration ?? null;
  const librpaChannels = [];
  const availability = [];

  for (const [key, files] of bySeries) {
    files.sort((a, b) => (a.meta.iter ?? 0) - (b.meta.iter ?? 0));
    availability.push({
      key,
      kind: files[0].meta.kind,
      spin: files[0].meta.spin,
      iterations: files.map((f) => f.meta.iter).filter((v) => v !== null),
      fileCount: files.length,
    });

    let chosen = files[files.length - 1];
    if (wantedIter !== null) {
      const exact = files.find((f) => f.meta.iter === wantedIter);
      if (exact) chosen = exact;
      else notes.push(`${key}：没有第 ${wantedIter} 次迭代，改用第 ${chosen.meta.iter} 次`);
    }
    if (files.length > MAX_BAND_FILES) {
      notes.push(`${key}：共 ${files.length} 个能带文件，只读取所选的 1 个`);
    }

    const raw = readTextCapped(resolve(chosen.dir, chosen.name), MAX_BAND_BYTES);
    if (!raw) {
      notes.push(`无法读取 ${chosen.name}`);
      continue;
    }
    const parsed = parseLibrpaBand(raw.text, { fileName: chosen.name });
    for (const w of parsed.warnings) warnings.push(`${chosen.name}：${w}`);
    if (parsed.rows.length === 0) continue;

    // LibRPA gives k as Cartesian coordinates, not a path length; build the cumulative
    // segment length so the axis means the same thing as in the ABACUS plot.
    const kpath = cumulativePathLength(parsed.rows.map((r) => r.k));

    librpaChannels.push({
      source: 'librpa',
      file: chosen.name,
      kind: parsed.kind,
      spin: parsed.spin,
      iter: parsed.iter,
      nKpoint: parsed.nKpoint,
      nBand: parsed.nState,
      kpath,
      // LibRPA walks the same high-symmetry path, so the KPT ticks apply here too. If the
      // k counts differ the tick indices are dropped by `placeTicks` rather than clamped.
      kTicks: placeTicks(kTicks, kpath),
      kCartesian: parsed.rows.map((r) => r.k),
      energies: parsed.rows.map((r) => r.energiesEv),
      // Occupations locate the band edges for a k-convergence comparison; the plot
      // ignores them and `compactBands` strips them from the browser payload.
      occupations: parsed.rows.map((r) => r.occupations),
      minEnergyEv: parsed.minEnergyEv,
      maxEnergyEv: parsed.maxEnergyEv,
      truncated: raw.truncated,
    });
  }

  if (abacusChannels.length === 0 && librpaChannels.length === 0) {
    warnings.push('这个任务没有能带数据（没有 band.txt / bands*.txt，也没有 *_band_spin_*.dat）');
  }

  return {
    abacus: abacusChannels,
    librpa: librpaChannels,
    availability,
    notes,
    warnings,
    error: '',
  };
}

/**
 * Shrink a band payload to what the plot actually draws.
 *
 * A real QSGW task carries six channels x 364 k-points x 80 bands as full float64 decimal
 * strings, which is ~1.6 MiB of JSON. The chart needs the k-path and the energies and
 * nothing else, and two decimals of an eV is finer than any band plot resolves, so the
 * wire form rounds to that. This is a *transport* concern only: the parser keeps full
 * precision, and the agent tools report the unrounded extents.
 *
 * @param {object} bands result of `readBands`
 * @param {{ digits?: number }} [options]
 */
export function compactBands(bands, options = {}) {
  const digits = options.digits ?? 3;
  const factor = 10 ** digits;
  const round = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * factor) / factor : null);

  const round2d = (energies) =>
    Array.isArray(energies)
      ? energies.map((row) => (Array.isArray(row) ? row.map(round) : []))
      : [];

  return {
    abacus: (bands.abacus ?? []).map((c) => ({
      source: c.source,
      file: c.file,
      spin: c.spin,
      nBlock: c.nBlock,
      nBand: c.nBand,
      nKpoint: c.nKpoint,
      kpath: (c.kpath ?? []).map(round),
      // High-symmetry ticks travel with every channel payload above the inventory level;
      // dropping them here silently removed the axis labels from the plot.
      kTicks: (c.kTicks ?? []).map((t) => ({ label: t.label, index: t.index, position: round(t.position) })),
      energies: round2d(c.energies),
      minEnergyEv: round(c.minEnergyEv),
      maxEnergyEv: round(c.maxEnergyEv),
      blocks: c.blocks,
    })),
    librpa: (bands.librpa ?? []).map((c) => ({
      source: c.source,
      file: c.file,
      kind: c.kind,
      spin: c.spin,
      iter: c.iter,
      nBand: c.nBand,
      nKpoint: c.nKpoint,
      kpath: (c.kpath ?? []).map(round),
      kTicks: (c.kTicks ?? []).map((t) => ({ label: t.label, index: t.index, position: round(t.position) })),
      energies: round2d(c.energies),
      minEnergyEv: round(c.minEnergyEv),
      maxEnergyEv: round(c.maxEnergyEv),
    })),
    availability: bands.availability ?? [],
    notes: bands.notes ?? [],
    warnings: bands.warnings ?? [],
    error: bands.error ?? '',
  };
}

/**
 * Cumulative Cartesian path length through the k-points, starting at 0.
 *
 * LibRPA stores Cartesian k, so without this the x-axis would be a raw coordinate rather
 * than a distance along the path — which makes segment labels meaningless.
 */
export function cumulativePathLength(kPoints) {
  const out = [];
  let total = 0;
  for (let i = 0; i < kPoints.length; i += 1) {
    if (i === 0) {
      out.push(0);
      continue;
    }
    const a = kPoints[i - 1];
    const b = kPoints[i];
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    out.push(total);
  }
  return out;
}

/**
 * Cheap existence check: does this task have any band file at all?
 *
 * The scanner sees one directory level, so a plain ABACUS band run
 * (`OUT.<suffix>/band.txt`) looks band-less there. This resolves that without parsing
 * anything: it stats a handful of candidate paths and lists the LibRPA directory.
 *
 * @param {string} taskAbs
 * @param {{ outDir?: string|null, librpaOutDir?: string|null }} [options]
 * @returns {{ abacus:string[], librpa:string[] }}
 */
export function probeBandFiles(taskAbs, options = {}) {
  const outDirAbs = options.outDir ? resolve(taskAbs, options.outDir) : null;
  const librpaOutAbs = options.librpaOutDir
    ? resolve(taskAbs, options.librpaOutDir)
    : resolve(taskAbs, 'librpa.d');

  const abacus = [];
  for (const name of ABACUS_BAND_NAMES) {
    const candidates = [];
    if (outDirAbs) candidates.push(resolve(outDirAbs, name));
    candidates.push(resolve(taskAbs, name));
    if (candidates.some((p) => safeStat(p))) abacus.push(name);
  }

  const librpa = [];
  const seen = new Set();
  for (const dir of [librpaOutAbs, taskAbs]) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const entry of listDir(dir) ?? []) {
      if (entry.isDir) continue;
      if (/^(KS|EXX|QSGW)_band_spin_\d+(_\d+)?\.dat$/i.test(entry.name)) librpa.push(entry.name);
    }
  }

  return { abacus, librpa };
}

/**
 * High-symmetry tick positions for a band plot's x axis.
 *
 * A band plot is drawn against cumulative k-path length, so the labels need a *position*,
 * not just a name. ABACUS's `KPT` in `Line` mode states each special point together with how
 * many points the following segment has, which is exactly enough to compute where in the
 * expanded path each label falls.
 *
 * Returns an empty list rather than guessing when there is no line-mode KPT: a band run over
 * a uniform mesh has no high-symmetry path, and inventing ticks would be worse than none.
 *
 * @param {string} taskAbs
 * @param {{ kpathLength?: number[] }} [hint] optional already-computed path, to match length
 * @returns {Array<{ label:string, index:number, position:number|null }>}
 */
export function readKTicks(taskAbs, hint) {
  // `KPT` sits beside `INPUT`; a run may also keep the expanded copy in OUT.*. Prefer the
  // task directory because that is the file a person edits.
  const candidates = [resolve(taskAbs, 'KPT')];
  const outDirs = listDir(taskAbs, { withStats: false }) ?? [];
  for (const entry of outDirs) {
    if (entry.isDir && /^OUT\./i.test(entry.name)) candidates.push(resolve(taskAbs, entry.name, 'KPT'));
  }

  for (const path of candidates) {
    if (!safeStat(path)) continue;
    const raw = readTextCapped(path, 1024 * 1024);
    if (!raw) continue;
    const parsed = parseKpt(raw.text);
    const labels = parsed.specialLabels ?? [];
    if (labels.every((label) => label === null || label === undefined)) continue;

    // Cumulative index of each special point in the expanded path: ABACUS emits
    // `nkl[i-1]` points from point i-1 (excluding the endpoint), then the last point once.
    const ticks = [];
    let index = 0;
    const counts = (parsed.segments ?? []).map((segment) => segment.count);
    for (let i = 0; i < labels.length; i += 1) {
      const label = labels[i];
      if (label) {
        ticks.push({
          label,
          index,
          // The axis position is filled by the caller, which owns the kpath array.
          position: null,
        });
      }
      // Advance by this point's segment length (the last point has no following segment).
      index += i < counts.length ? counts[i] : 1;
    }
    // The final special point is appended once after the last segment.
    if (labels.length > 0 && labels[labels.length - 1]) {
      // Already pushed above with the advanced index; nothing more to add.
    }
    return ticks;
  }
  return [];
}

/**
 * Resolve tick positions against a concrete kpath array.
 *
 * `index` from the KPT expansion may exceed the band file's k count when the file was
 * truncated or re-exported; those ticks are dropped rather than clamped to the right edge,
 * which would put a label on the wrong point.
 */
export function placeTicks(ticks, kpathLength) {
  if (!Array.isArray(ticks) || ticks.length === 0) return [];
  const n = kpathLength?.length ?? 0;
  if (n === 0) return [];
  return ticks
    .filter((tick) => tick.index >= 0 && tick.index < n)
    .map((tick) => ({ label: tick.label, index: tick.index, position: kpathLength[tick.index] }));
}

export { ABACUS_BAND_NAMES, MAX_BAND_FILES };
