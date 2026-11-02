/**
 * ABACUS `KPT` parser.
 *
 * Real grammar (`source_cell/klist.cpp`, `K_Vectors::read_kpoints`, v3.9.0.25). The header
 * may be `K_POINTS`, `KPOINTS` or `K`; the next token is `<nkstot>` and the file branches
 * on it:
 *
 *   nkstot == 0  →  <centering>            Gamma | Monkhorst-Pack | MP | mp
 *                   <nk1> <nk2> <nk3> [s1 s2 s3]
 *
 *   nkstot >  0  →  <mode>                 Cartesian | C | Direct | D
 *                                          Line_Cartesian | Line_Direct | L | Line
 *                   then nkstot records
 *
 * For the explicit list each record is `<kx> <ky> <kz> <weight>`.
 *
 * For a line mode the `nkstot` records are *special points*: `<kx> <ky> <kz> <nkl>`, where
 * `nkl` is how many points to generate on the segment that **starts** at this special
 * point. ABACUS interpolates and the final special point contributes exactly one point
 * (`interpolate_k_between`), so
 *
 *     nkstot_final = Σ_{i<last} nkl[i] + 1
 *
 * which is why the shipped `examples/05_soc/pw_GaAs/KPT-nscf` (5 special points, 20 20 20
 * 20 1) produces 81 k-points, not 5. Reporting only the special points would misreport the
 * run's actual k-mesh, so this module expands the segments itself.
 *
 * Two INPUT keywords change what this file means at run time, and neither is handled here
 * (the scanner merges them): `gamma_only` rewrites the file to a 1×1×1 Gamma mesh, and
 * `kspacing > 0` regenerates the grid from the spacing and rewrites the file too. A KPT
 * read off disk after such a run may therefore not be what the run used — the caller is
 * told this via `kMeshSource` in `input-params.js`.
 *
 * @module abacusflow/host/abacus/kpt
 */
import { toLines, toNum, warn } from '../shared/numbers.js';

const HEADERS = new Set(['K_POINTS', 'KPOINTS', 'K']);

/** `Gamma` and the Monkhorst-Pack spellings ABACUS accepts. */
const CENTERING = new Map([
  ['gamma', { centering: 'Gamma', kType: 0, mp: false }],
  ['monkhorst-pack', { centering: 'MP', kType: 1, mp: true }],
  ['mp', { centering: 'MP', kType: 1, mp: true }],
]);

const MODES = new Map([
  ['cartesian', { kMode: 'cartesian', line: false }],
  ['c', { kMode: 'cartesian', line: false }],
  ['direct', { kMode: 'direct', line: false }],
  ['d', { kMode: 'direct', line: false }],
  ['line_cartesian', { kMode: 'line_cartesian', line: true }],
  ['line_direct', { kMode: 'line_direct', line: true }],
  ['l', { kMode: 'line_direct', line: true }],
  ['line', { kMode: 'line_direct', line: true }],
]);

/** ABACUS refuses more than this many k-points (`read_kpoints`). */
const MAX_KPOINTS = 100000;

/**
 * Parse an ABACUS KPT file.
 *
 * Never throws on content: malformed input yields partial data plus `warnings`.
 *
 * @param {string} text
 * @returns {{
 *   mode:'auto'|'explicit'|null,
 *   centering:'Gamma'|'MP'|null,
 *   kType:number|null,
 *   grid:number[]|null,
 *   shift:number[]|null,
 *   kMode:'cartesian'|'direct'|'line_cartesian'|'line_direct'|null,
 *   points:Array<{ frac:number[], weight:number|null }>|null,
 *   segments:Array<{ from:number[], to:number[], count:number, points:number[][] }>|null,
 *   specialPoints:number[][]|null,
 *   declaredNkpts:number|null,
 *   nkpts:number|null,
 *   warnings:string[]
 * }}
 */
export function parseKpt(text) {
  const warnings = [];
  // Keep the raw lines alongside the comment-stripped ones. The stripped form is what the
  // numeric parsing needs, but a band path carries its high-symmetry label *in* the comment
  // (`0.5 0 0 40 # L`), so throwing the comment away loses the only tick text available.
  const rawLines = toLines(text);
  const lines = [];
  const rawFor = [];
  for (const raw of rawLines) {
    const cleaned = raw.replace(/[#!].*$/, '').trim();
    if (cleaned === '') continue;
    lines.push(cleaned);
    rawFor.push(raw);
  }

  /** Result skeleton, so every early return has the full documented shape. */
  const blank = {
    mode: null,
    centering: null,
    kType: null,
    grid: null,
    shift: null,
    kMode: null,
    points: null,
    segments: null,
    specialPoints: null,
    declaredNkpts: null,
    nkpts: null,
    warnings,
  };

  if (lines.length === 0) {
    warn(warnings, 'KPT 文件为空');
    return blank;
  }

  // ---- (1) header ----------------------------------------------------------
  let cursor = 0;
  const header = lines[0].toUpperCase().replace(/\s+/g, '_');
  if (HEADERS.has(header)) {
    cursor = 1;
  } else {
    warn(warnings, `KPT 第一行不是 K_POINTS（读到「${lines[0]}」），仍按 KPT 解析`);
  }

  if (cursor >= lines.length) {
    warn(warnings, 'KPT 缺少 nkstot 行');
    return blank;
  }

  // ---- (2) nkstot ----------------------------------------------------------
  const nkstot = toNum(lines[cursor].split(/\s+/)[0]);
  cursor += 1;
  if (nkstot === null || !Number.isInteger(nkstot)) {
    warn(warnings, `无法解析 nkstot：「${lines[cursor - 1]}」`);
    return blank;
  }
  if (nkstot > MAX_KPOINTS) {
    warn(warnings, `nkstot = ${nkstot} 超过 ABACUS 上限 ${MAX_KPOINTS}，ABACUS 会拒绝读取`);
  }
  if (nkstot < 0) {
    warn(warnings, `nkstot 为负（${nkstot}），无法解析`);
    return blank;
  }

  // ---- (3a) automatic mesh ------------------------------------------------
  if (nkstot === 0) return parseAutoMesh(lines, cursor, warnings, blank);

  // ---- (3b) explicit list / line mode ------------------------------------
  return parseExplicit(lines, cursor, nkstot, warnings, blank, rawFor);
}

/**
 * `nkstot == 0`: the mesh is described by a centering keyword and a grid triple.
 * The four/five/six-number line is `<nk1> <nk2> <nk3> [s1 s2 s3]`.
 */
function parseAutoMesh(lines, cursor, warnings, blank) {
  if (cursor >= lines.length) {
    warn(warnings, '自动网格模式缺少 centering 行');
    return { ...blank, mode: 'auto' };
  }

  const tokens = lines[cursor].split(/\s+/).filter(Boolean);
  const keyword = tokens[0].toLowerCase();
  cursor += 1;

  let centering = CENTERING.get(keyword);
  let gridTokens = tokens.slice(1);
  if (!centering) {
    warn(warnings, `无法识别的 centering「${tokens[0]}」，按 Gamma 处理`);
    centering = { centering: 'Gamma', kType: 0, mp: false };
  }

  // The grid may sit on the same line as the centering keyword or on the next one.
  if (gridTokens.length < 3) {
    if (cursor >= lines.length) {
      warn(warnings, '自动网格模式缺少 <nk1> <nk2> <nk3> 行');
      return { ...blank, mode: 'auto', centering: centering.centering, kType: centering.kType };
    }
    gridTokens = lines[cursor].split(/\s+/).filter(Boolean);
    cursor += 1;
  }

  const numbers = gridTokens.map(toNum);
  if (numbers.length < 3 || numbers.slice(0, 3).some((v) => v === null)) {
    warn(warnings, '自动网格的 nk1/nk2/nk3 无法解析');
    return { ...blank, mode: 'auto', centering: centering.centering, kType: centering.kType };
  }

  const grid = numbers.slice(0, 3).map((v) => Math.round(v));
  if (grid.some((v) => v <= 0)) {
    warn(warnings, `自动网格的 nk 必须 > 0，读到 ${grid.join(' ')}`);
  }

  // The shift is the number of grid points skipped at the edge: 0 = Gamma-centred,
  // 1 = half-shifted (`koffset` in `read_kpoints`). ABACUS tolerates a missing triple
  // and only warns, so a partially given shift is completed with zeros here.
  let shift;
  const rawShift = numbers.slice(3, 6);
  if (rawShift.length === 0) {
    shift = [0, 0, 0];
  } else if (rawShift.length < 3) {
    warn(warnings, '自动网格的 shift 不足 3 个，其余按 0 处理');
    shift = [...rawShift, 0, 0].slice(0, 3).map((v) => Math.round(v ?? 0));
  } else {
    shift = rawShift.map((v) => Math.round(v));
  }
  if (shift.some((v) => v !== 0 && v !== 1)) {
    warn(warnings, `自动网格的 shift 应为 0/1，读到 ${shift.join(' ')}`);
  }

  return {
    ...blank,
    mode: 'auto',
    centering: centering.centering,
    kType: centering.kType,
    grid,
    shift,
    nkpts: grid[0] * grid[1] * grid[2],
  };
}

/** `nkstot > 0`: either an explicit list or a line path of special points. */
function parseExplicit(lines, cursor, nkstot, warnings, blank, rawFor) {
  if (cursor >= lines.length) {
    warn(warnings, '显式 k 点模式缺少坐标类型行');
    return { ...blank, mode: 'explicit', declaredNkpts: nkstot, nkpts: nkstot };
  }

  const tokens = lines[cursor].split(/\s+/).filter(Boolean);
  const keyword = tokens[0].toLowerCase();
  cursor += 1;

  const modeInfo = MODES.get(keyword);
  if (!modeInfo) {
    warn(warnings, `无法识别的 k 点类型「${tokens[0]}」，按 Direct 处理`);
  }
  const kMode = modeInfo ? modeInfo.kMode : 'direct';
  const isLine = modeInfo ? modeInfo.line : false;

  if (isLine) return parseLineMode(lines, cursor, nkstot, kMode, warnings, blank, rawFor);
  return parseExplicitList(lines, cursor, nkstot, kMode, warnings, blank);
}

/** Explicit list: `nkstot` rows of `<kx> <ky> <kz> <weight>`. */
function parseExplicitList(lines, cursor, nkstot, kMode, warnings, blank) {
  const points = [];
  for (let k = cursor; k < lines.length && points.length < nkstot; k += 1) {
    const values = lines[k].split(/\s+/).filter(Boolean).map(toNum);
    if (values.length < 3 || values.slice(0, 3).some((v) => v === null)) {
      warn(warnings, `第 ${k + 1} 行不是合法 k 点，已跳过`);
      continue;
    }
    if (values.length < 4 || values[3] === null) {
      warn(warnings, `第 ${k + 1} 行缺少 k 点权重`);
    }
    points.push({
      frac: values.slice(0, 3),
      weight: values.length >= 4 && values[3] !== null ? values[3] : null,
    });
  }
  if (points.length !== nkstot) {
    warn(warnings, `声明 ${nkstot} 个 k 点，实际读到 ${points.length} 个`);
  }

  return {
    ...blank,
    mode: 'explicit',
    kMode,
    points,
    nkpts: points.length,
    declaredNkpts: nkstot,
  };
}

/**
 * The high-symmetry point name from a KPT line's trailing comment.
 *
 * ABACUS band paths are written as `0.5 0 0 40 # L`, so the label after `#` is the only
 * source of tick text for a band plot. Real files use both ASCII (`# G`, `# X`) and
 * Unicode Greek (`#Γ`), so this takes everything after the first `#`.
 *
 * @param {string} line
 * @returns {string|null}
 */
function extractPointLabel(line) {
  const hash = line.indexOf('#');
  if (hash < 0) return null;
  const label = line.slice(hash + 1).trim();
  if (label === '') return null;
  // A comment with no letters is not a point name (e.g. `# 1`).
  if (!/[A-Za-z\u0370-\u03ff]/.test(label)) return null;
  return label;
}

/**
 * Line mode: `nkstot` special points, each `<kx> <ky> <kz> <nkl>`.
 *
 * ABACUS walks segments 1..n-1 generating `nkl[i-1]` points from special point `i-1`
 * towards `i` (excluding the endpoint), then appends the final special point once. The
 * expanded list is produced here so `nkpts` is the number of k-points the run really had.
 */
function parseLineMode(lines, cursor, nkstot, kMode, warnings, blank, rawFor) {
  /** @type {Array<{ frac:number[], count:number, label:string|null }>} */
  const specialPoints = [];
  for (let k = cursor; k < lines.length && specialPoints.length < nkstot; k += 1) {
    // `lines[k]` is comment-stripped (numerics); `rawFor[k]` still has the `# L` tail.
    const raw = rawFor[k] ?? lines[k];
    const label = extractPointLabel(raw);
    const values = lines[k].split(/\s+/).filter(Boolean).map(toNum);
    if (values.length < 3 || values.slice(0, 3).some((v) => v === null)) {
      warn(warnings, `第 ${k + 1} 行不是合法 k 点，已跳过`);
      continue;
    }
    let count = values.length >= 4 && values[3] !== null ? Math.round(values[3]) : null;
    if (count === null) {
      warn(warnings, `第 ${k + 1} 行缺少线模式的点数 nkl，按 1 处理`);
      count = 1;
    } else if (count < 0) {
      warn(warnings, `第 ${k + 1} 行的点数 nkl 为负（${count}），按 0 处理`);
      count = 0;
    }
    specialPoints.push({ frac: values.slice(0, 3), count, label });
  }

  if (specialPoints.length === 0) {
    warn(warnings, 'Line 模式没有解析到 k 点');
    return { ...blank, mode: 'explicit', kMode, segments: [], nkpts: 0, declaredNkpts: nkstot };
  }
  if (specialPoints.length < nkstot) {
    warn(warnings, `线模式声明 ${nkstot} 个特殊点，实际读到 ${specialPoints.length} 个`);
  }
  if (specialPoints.length === 1) {
    warn(warnings, '线模式只有 1 个特殊点，ABACUS 的插值要求至少 2 个');
    return {
      ...blank,
      mode: 'explicit',
      kMode,
      segments: [],
      specialPoints: [specialPoints[0].frac],
      points: [{ frac: specialPoints[0].frac, weight: null }],
      nkpts: 1,
      declaredNkpts: nkstot,
    };
  }
  // ABACUS asserts the final special point contributes exactly one k-point.
  if (specialPoints[specialPoints.length - 1].count !== 1) {
    warn(warnings, `线模式最后一个特殊点的点数应为 1，读到 ${specialPoints[specialPoints.length - 1].count}`);
  }

  const segments = [];
  const expanded = [];
  for (let s = 0; s + 1 < specialPoints.length; s += 1) {
    const from = specialPoints[s];
    const to = specialPoints[s + 1];
    const count = from.count;
    const dx = (to.frac[0] - from.frac[0]) / (count || 1);
    const dy = (to.frac[1] - from.frac[1]) / (count || 1);
    const dz = (to.frac[2] - from.frac[2]) / (count || 1);
    const points = [];
    for (let n = 0; n < count; n += 1) {
      points.push([from.frac[0] + n * dx, from.frac[1] + n * dy, from.frac[2] + n * dz]);
    }
    expanded.push(...points);
    // Labels travel with the segments too, so a plot can draw tick marks without joining
    // back to `specialPoints` by index (which breaks once duplicate labels like Γ appear).
    segments.push({
      from: from.frac,
      to: to.frac,
      count,
      points,
      fromLabel: from.label ?? null,
      toLabel: to.label ?? null,
    });
  }
  // The last special point itself.
  expanded.push(specialPoints[specialPoints.length - 1].frac);

  return {
    ...blank,
    mode: 'explicit',
    kMode,
    segments,
    specialPoints: specialPoints.map((p) => p.frac),
    /** High-symmetry point names, parallel to `specialPoints` (null where unlabelled). */
    specialLabels: specialPoints.map((p) => p.label ?? null),
    // Line-mode weights are all 1 before ABACUS normalises them (`interpolate_k_between`).
    points: expanded.map((frac) => ({ frac, weight: null })),
    nkpts: expanded.length,
    declaredNkpts: nkstot,
  };
}

export { HEADERS, CENTERING, MODES, MAX_KPOINTS };
