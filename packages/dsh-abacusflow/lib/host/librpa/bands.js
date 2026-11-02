/**
 * LibRPA band files: `{KS,EXX,QSGW}_band_spin_<spin>_<iter>.dat`.
 *
 * Layout (`driver/tasks/qsgw.cpp:1185-1196`, `src/qsgw/band_output.cpp:150-161`): one line
 * per k-point,
 *
 *   `<ik> <kx> <ky> <kz>` then repeating `<occupation> <energy_eV>` pairs
 *
 * Energies are in eV (converted with `HA2EV` at write time), and the occupation is scaled
 * by the number of k-points, so an occupied state can read `1.00000` or `2.00000`
 * depending on the run.
 *
 * The `<iter>` suffix is why these files matter: a QSGW run writes one triple per
 * iteration, so plotting `QSGW_band_spin_1_<iter>.dat` across iterations shows the
 * quasiparticle bands converging — a different question from the SCF convergence trace.
 *
 * @module abacusflow/host/librpa/bands
 */
import { toNum, toLines } from '../shared/numbers.js';

/** `QSGW_band_spin_1_12.dat` -> { kind, spin, iter }. */
export function parseBandFileName(name) {
  const m = /^(KS|EXX|QSGW)_band_spin_(\d+)(?:_(\d+))?\.dat$/i.exec(String(name ?? ''));
  if (!m) return null;
  return {
    kind: m[1].toUpperCase(),
    spin: Number(m[2]),
    iter: m[3] === undefined ? null : Number(m[3]),
  };
}

/**
 * Parse one LibRPA band file.
 *
 * @param {string} text
 * @param {{ fileName?: string }} [options]
 * @returns {{
 *   kind: string|null, spin: number|null, iter: number|null,
 *   rows: Array<{ ik:number, k:number[], occupations:number[], energiesEv:number[] }>,
 *   nKpoint: number, nState: number,
 *   minEnergyEv: number|null, maxEnergyEv: number|null,
 *   warnings: string[]
 * }}
 */
export function parseLibrpaBand(text, options = {}) {
  const warnings = [];
  const meta = options.fileName ? parseBandFileName(options.fileName) : null;
  const rows = [];
  let skipped = 0;

  const lines = toLines(text);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const tokens = trimmed.split(/\s+/);
    if (tokens.length < 6) {
      skipped += 1;
      continue;
    }
    const ik = toNum(tokens[0]);
    const k = [toNum(tokens[1]), toNum(tokens[2]), toNum(tokens[3])];
    if (ik === null || k.some((v) => v === null)) {
      skipped += 1;
      continue;
    }

    const occupations = [];
    const energiesEv = [];
    for (let c = 4; c + 1 < tokens.length; c += 2) {
      const occ = toNum(tokens[c]);
      const energy = toNum(tokens[c + 1]);
      if (occ === null || energy === null) {
        skipped += 1;
        break;
      }
      occupations.push(occ);
      energiesEv.push(energy);
    }
    if (energiesEv.length === 0) continue;
    rows.push({ ik: Math.trunc(ik), k, occupations, energiesEv });
  }

  if (skipped > 0) warnings.push(`${skipped} 行无法解析，已跳过`);
  if (rows.length === 0) {
    warnings.push('没有解析到任何能带数据行');
    return {
      kind: meta?.kind ?? null,
      spin: meta?.spin ?? null,
      iter: meta?.iter ?? null,
      rows: [],
      nKpoint: 0,
      nState: 0,
      minEnergyEv: null,
      maxEnergyEv: null,
      warnings,
    };
  }

  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    for (const value of row.energiesEv) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }

  const widths = new Set(rows.map((r) => r.energiesEv.length));
  if (widths.size > 1) warnings.push(`不同 k 点的态数不一致：${[...widths].join(', ')}`);

  return {
    kind: meta?.kind ?? null,
    spin: meta?.spin ?? null,
    iter: meta?.iter ?? null,
    rows,
    nKpoint: rows.length,
    nState: rows[0].energiesEv.length,
    minEnergyEv: Number.isFinite(min) ? min : null,
    maxEnergyEv: Number.isFinite(max) ? max : null,
    warnings,
  };
}

/**
 * Group several parsed LibRPA band files into an iteration series.
 *
 * Returns one entry per (kind, spin) with the iterations sorted ascending, which is what
 * the panel plots and what a convergence question is actually about.
 *
 * @param {Array<{ fileName:string, parsed:object }>} entries
 * @returns {{ series: Array<{ kind:string, spin:number,
 *                            iterations: Array<{ iter:number, nKpoint:number, nState:number,
 *                                                minEnergyEv:number|null, maxEnergyEv:number|null }> }>,
 *             warnings:string[] }}
 */
export function groupBandIterations(entries) {
  const warnings = [];
  /** @type {Map<string, { kind:string, spin:number, iterations:Array }>} */
  const groups = new Map();

  for (const { fileName, parsed } of entries) {
    if (!parsed || parsed.rows.length === 0) continue;
    const kind = parsed.kind;
    const spin = parsed.spin;
    if (!kind || spin === null) {
      warnings.push(`${fileName}：文件名里没有 <KIND>_band_spin_<s>_<iter> 结构`);
      continue;
    }
    const key = `${kind}:${spin}`;
    if (!groups.has(key)) groups.set(key, { kind, spin, iterations: [] });
    groups.get(key).iterations.push({
      iter: parsed.iter,
      nKpoint: parsed.nKpoint,
      nState: parsed.nState,
      minEnergyEv: parsed.minEnergyEv,
      maxEnergyEv: parsed.maxEnergyEv,
    });
  }

  for (const group of groups.values()) {
    // Files without an `<iter>` suffix sort last but stay usable.
    group.iterations.sort((a, b) => (a.iter ?? Infinity) - (b.iter ?? Infinity));
  }

  return { series: [...groups.values()], warnings };
}
