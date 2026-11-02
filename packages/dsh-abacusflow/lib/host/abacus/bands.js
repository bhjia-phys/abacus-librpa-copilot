/**
 * ABACUS band files: `band.txt`, `bands1.txt`, `bands2.txt`.
 *
 * Layout (`write_bands.cpp:119-127`): one line per k-point,
 *
 *   `<ik+1> <k-path length> <E_1> <E_2> ... <E_nband>`
 *
 * with energies already in eV. The band index and the path length are the first two
 * columns; everything after is one energy per band.
 *
 * Two real-world irregularities, both observed in this repository's own runs and both
 * fatal to a naive reader:
 *
 *  1. **A file can hold more than one block.** `out_app_flag` (and a restarted run) make
 *     ABACUS append rather than overwrite, so `band.txt` may contain an earlier run's
 *     64-point path followed by the current 364-point path. The k index then restarts at
 *     1 partway down the file. Concatenating the blocks would draw a line shooting back
 *     to k=0 mid-plot, so blocks are detected and kept apart, and the caller chooses one.
 *
 *  2. **Spin channels are separate files** (`bands1.txt` / `bands2.txt`) for `nspin = 2`,
 *     while `band.txt` is single-channel. Reading only `band.txt` on a spin-polarised run
 *     silently shows half the data.
 *
 * @module abacusflow/host/abacus/bands
 */
import { toNum, toLines } from '../shared/numbers.js';

/** A run with more blocks than this is not a band file we should guess about. */
const MAX_BLOCKS = 64;

/**
 * Parse an ABACUS band file into one or more contiguous blocks.
 *
 * @param {string} text
 * @param {{ fileName?: string }} [options]
 * @returns {{
 *   blocks: Array<{
 *     index: number,
 *     nKpoint: number,
 *     nBand: number,
 *     kpath: number[],
 *     energies: number[][],     // [ik][iband] in eV
 *     minEnergyEv: number|null,
 *     maxEnergyEv: number|null,
 *     kpathRange: [number, number]
 *   }>,
 *   nBlock: number,
 *   nBand: number,
 *   fileName: string|null,
 *   warnings: string[]
 * }}
 */
export function parseAbacusBands(text, options = {}) {
  const warnings = [];
  const fileName = options.fileName ?? null;
  const lines = toLines(text);

  /** @type {Array<{ ik:number, kpath:number, energies:number[] }>} */
  const rows = [];
  let skipped = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const tokens = trimmed.split(/\s+/);
    if (tokens.length < 4) {
      skipped += 1;
      continue;
    }
    const ik = toNum(tokens[0]);
    const kpath = toNum(tokens[1]);
    if (ik === null || kpath === null) {
      skipped += 1;
      continue;
    }
    const energies = [];
    let bad = false;
    for (let c = 2; c < tokens.length; c += 1) {
      const value = toNum(tokens[c]);
      if (value === null) {
        bad = true;
        break;
      }
      energies.push(value);
    }
    if (bad || energies.length === 0) {
      skipped += 1;
      continue;
    }
    rows.push({ ik, kpath, energies });
  }

  if (skipped > 0) warnings.push(`${skipped} 行无法解析，已跳过`);
  if (rows.length === 0) {
    warnings.push('没有解析到任何能带数据行');
    return { blocks: [], nBlock: 0, nBand: 0, fileName, warnings };
  }

  // ---- split into blocks wherever the k index does not increment by exactly 1 ----
  const blockStarts = [0];
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].ik !== rows[i - 1].ik + 1) blockStarts.push(i);
    if (blockStarts.length > MAX_BLOCKS) break;
  }

  const blocks = [];
  for (let b = 0; b < blockStarts.length; b += 1) {
    const from = blockStarts[b];
    const to = b + 1 < blockStarts.length ? blockStarts[b + 1] : rows.length;
    const slice = rows.slice(from, to);
    if (slice.length === 0) continue;

    const nBand = slice[0].energies.length;
    // A block whose rows disagree on width is kept but flagged: it means the file is
    // inconsistent, not that we should silently drop bands.
    const widths = new Set(slice.map((r) => r.energies.length));
    if (widths.size > 1) {
      warnings.push(`第 ${b + 1} 个块的能带数不一致：${[...widths].join(', ')}`);
    }

    let min = Infinity;
    let max = -Infinity;
    for (const row of slice) {
      for (const value of row.energies) {
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }

    const kpath = slice.map((r) => r.kpath);
    let monotone = true;
    for (let i = 1; i < kpath.length; i += 1) {
      if (kpath[i] < kpath[i - 1] - 1e-12) { monotone = false; break; }
    }
    if (!monotone) warnings.push(`第 ${b + 1} 个块的 k 路径长度不是单调递增`);

    blocks.push({
      index: b,
      nKpoint: slice.length,
      nBand,
      kpath,
      energies: slice.map((r) => r.energies),
      minEnergyEv: Number.isFinite(min) ? min : null,
      maxEnergyEv: Number.isFinite(max) ? max : null,
      kpathRange: [kpath[0], kpath[kpath.length - 1]],
      kPathMonotone: monotone,
    });
  }

  if (blocks.length > 1) {
    // Not an error: it is the documented consequence of `out_app_flag`, but the user must
    // know the plot is showing one block rather than all of them.
    warnings.push(
      `文件包含 ${blocks.length} 个独立的 k 路径块（k 索引重新从 1 开始），` +
        `通常是多次计算追加到同一文件所致；默认显示最长的那一块。`,
    );
  }

  return {
    blocks,
    nBlock: blocks.length,
    nBand: blocks.length > 0 ? blocks[0].nBand : 0,
    fileName,
    warnings,
  };
}

/** Pick the block worth plotting: the one with the most k-points, else the last. */
export function pickMainBlock(parsed) {
  if (!parsed || parsed.blocks.length === 0) return null;
  let best = parsed.blocks[0];
  for (const block of parsed.blocks) {
    if (block.nKpoint > best.nKpoint) best = block;
  }
  return best;
}

/**
 * Locate the band files of one ABACUS task directory and parse them.
 *
 * `nspin = 2` writes `bands1.txt` + `bands2.txt`; otherwise `band.txt`. Both spellings
 * are checked so a directory that changed spin setting still loads.
 *
 * @param {(name:string) => string|null} readFile  reads a file by name, or returns null
 * @param {string[]} names  candidate file names
 * @returns {{ channels: Array<{ name:string, spin:number|null, parsed:object }>, warnings:string[] }}
 */
export function readBandFiles(readFile, names) {
  const channels = [];
  const warnings = [];

  const spinOf = (name) => {
    const m = /^bands(\d)\.txt$/i.exec(name);
    return m ? Number(m[1]) : null;
  };

  for (const name of names) {
    const text = readFile(name);
    if (text === null) continue;
    const parsed = parseAbacusBands(text, { fileName: name });
    channels.push({ name, spin: spinOf(name), parsed });
    for (const w of parsed.warnings) warnings.push(`${name}：${w}`);
  }

  if (channels.length === 0) warnings.push('没有找到能带文件（band.txt / bands1.txt / bands2.txt）');
  return { channels, warnings };
}
