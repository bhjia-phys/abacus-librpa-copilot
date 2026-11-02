/**
 * `energy_qp` — the LibRPA quasiparticle energy table.
 *
 * Written by `driver/tasks/task_helper.cpp` into the **process working directory**, not
 * into `output_dir`. That asymmetry with `qsgw_*.dat` is real and trips naive viewers, so
 * the caller records the two directories separately.
 *
 * Layout (one header, then a block per k-point):
 *
 *   ```
 *     state     occ_num        e_gs(Ha)        e_qp(Ha)
 *   ---------------------------------------------------------------------------------------------------
 *     K_point    1 :           0.0000          0.0000          0.0000
 *   ---------------------------------------------------------------------------------------------------
 *          1    2.0000   -1.8788617373E+01   -2.0337919716E+01
 *          2    2.0000   -9.2724995039E-01   -1.1155511630E+00
 *   ```
 *
 * For `nspin = 2` a `Spin Up` / `Spin Down` label line precedes each spin's block.
 * Units are **Hartree** — unlike the `*_band_spin_*.dat` files, which are in eV.
 *
 * @module abacusflow/host/librpa/energy-qp
 */
import { toNum, toLines } from '../shared/numbers.js';

/** Hartree -> eV (CODATA 2018). */
export const HARTREE_TO_EV = 27.211386245988;

const RE_KPOINT = /^\s*K_point\s+(\d+)\s*:\s*([-+0-9.eEdD]+)\s+([-+0-9.eEdD]+)\s+([-+0-9.eEdD]+)/i;
const RE_SPIN_LABEL = /^\s*Spin\s+(Up|Down)\s*$/i;
const RE_STATE_ROW = /^\s*(\d+)\s+([-+0-9.eEdD]+)\s+([-+0-9.eEdD]+)\s+([-+0-9.eEdD]+)\s*$/;

/**
 * Parse an `energy_qp` table.
 *
 * @param {string} text
 * @returns {{
 *   rows: Array<{ kpoint:number, k:number[], spin:number|null, spinLabel:string|null,
 *                 state:number, occupation:number, eGsHa:number, eQpHa:number,
 *                 eGsEv:number, eQpEv:number, deltaEv:number }>,
 *   nKpoint:number, nState:number, nSpin:number,
 *   minQpEv:number|null, maxQpEv:number|null,
 *   warnings:string[]
 * }}
 */
export function parseEnergyQp(text) {
  const warnings = [];
  const rows = [];

  let currentK = null;
  let k = [null, null, null];
  let spin = null;
  let spinLabel = null;

  const lines = toLines(text);
  let sawHeader = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (/^\s*-{10,}\s*$/.test(line)) continue;

    if (/state\s+occ_num/i.test(line)) {
      sawHeader = true;
      continue;
    }

    const spinMatch = RE_SPIN_LABEL.exec(line);
    if (spinMatch) {
      spinLabel = spinMatch[1];
      spin = /^up$/i.test(spinLabel) ? 0 : 1;
      continue;
    }

    const kMatch = RE_KPOINT.exec(line);
    if (kMatch) {
      currentK = Number(kMatch[1]);
      k = [toNum(kMatch[2]), toNum(kMatch[3]), toNum(kMatch[4])];
      continue;
    }

    const row = RE_STATE_ROW.exec(line);
    if (row && currentK !== null) {
      const occupation = toNum(row[2]);
      const eGsHa = toNum(row[3]);
      const eQpHa = toNum(row[4]);
      if (occupation === null || eGsHa === null || eQpHa === null) {
        warnings.push(`第 ${i + 1} 行数值无法解析：${line.trim().slice(0, 100)}`);
        continue;
      }
      rows.push({
        kpoint: currentK,
        k,
        spin,
        spinLabel,
        state: Number(row[1]),
        occupation,
        eGsHa,
        eQpHa,
        eGsEv: eGsHa * HARTREE_TO_EV,
        eQpEv: eQpHa * HARTREE_TO_EV,
        deltaEv: (eQpHa - eGsHa) * HARTREE_TO_EV,
      });
      continue;
    }

    warnings.push(`第 ${i + 1} 行无法识别，已跳过：${line.trim().slice(0, 100)}`);
  }

  if (!sawHeader && rows.length > 0) {
    warnings.push('没有找到 `state occ_num e_gs(Ha) e_qp(Ha)` 表头');
  }
  if (rows.length === 0) warnings.push('energy_qp 没有解析到任何状态');

  let minQpEv = null;
  let maxQpEv = null;
  for (const row of rows) {
    if (minQpEv === null || row.eQpEv < minQpEv) minQpEv = row.eQpEv;
    if (maxQpEv === null || row.eQpEv > maxQpEv) maxQpEv = row.eQpEv;
  }

  return {
    rows,
    nKpoint: new Set(rows.map((r) => r.kpoint)).size,
    nState: new Set(rows.map((r) => r.state)).size,
    nSpin: new Set(rows.map((r) => r.spin ?? 0)).size,
    minQpEv,
    maxQpEv,
    warnings,
  };
}

/**
 * Parse a `*_band_spin_<n>.dat` band file (one line per k-point, energies in eV).
 *
 * Written into the process working directory by `task=g0w0`, and into `output_dir` by
 * `task=qsgw_band` — again, the caller decides which directory to look in.
 *
 * Line shape: `ik kx ky kz` then repeating `<occ> <energy_eV>` pairs.
 *
 * @param {string} text
 * @returns {{ rows: Array<{ ik:number, k:number[], states:Array<{ occupation:number, energyEv:number }> }>,
 *             nKpoint:number, nState:number, warnings:string[] }}
 */
export function parseBandSpin(text) {
  const warnings = [];
  const rows = [];

  for (const [index, raw] of toLines(text).entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length < 4) {
      warnings.push(`第 ${index + 1} 行字段不足：${line.slice(0, 80)}`);
      continue;
    }
    const ik = toNum(tokens[0]);
    const k = [toNum(tokens[1]), toNum(tokens[2]), toNum(tokens[3])];
    if (ik === null || k.some((v) => v === null)) {
      warnings.push(`第 ${index + 1} 行 k 点无法解析：${line.slice(0, 80)}`);
      continue;
    }
    const rest = tokens.slice(4).map(toNum);
    if (rest.length % 2 !== 0) {
      warnings.push(`第 ${index + 1} 行的 占据/能量 对不完整`);
    }
    const states = [];
    for (let i = 0; i + 1 < rest.length; i += 2) {
      const occupation = rest[i];
      const energyEv = rest[i + 1];
      if (occupation === null || energyEv === null) continue;
      states.push({ occupation, energyEv });
    }
    rows.push({ ik: Math.trunc(ik), k, states });
  }

  return {
    rows,
    nKpoint: rows.length,
    nState: rows.reduce((best, row) => Math.max(best, row.states.length), 0),
    warnings,
  };
}
