/**
 * `librpa.in` — the LibRPA driver input file.
 *
 * Format (verified on a real QSGW run and against `LibRPA/driver/inputfile.cpp` +
 * `LibRPA/src/api/options.cpp`): one `key = value` per line, `#` starts a comment,
 * values are bare strings (`qsgw`, `../dataset`, `1e-06`, `true`) — no quoting, no
 * multi-line values, no sections.
 *
 * `LIBRPA_KEYS` documents the keys the driver actually consumes, grouped the way the
 * panel renders them (CONTRACT.md §7).
 *
 * @module abacusflow/host/librpa/input
 */
import { toNum, toLines } from '../shared/numbers.js';

/**
 * Parse a `librpa.in` file.
 *
 * Malformed lines never throw: they are skipped and described in `warnings`.
 *
 * @param {string} text
 * @returns {{
 *   entries: Array<{ key:string, value:string, raw:string, line:number }>,
 *   params: Record<string,string>,
 *   duplicates: string[],
 *   warnings: string[]
 * }}
 */
export function parseLibrpaIn(text) {
  const entries = [];
  const params = Object.create(null);
  const duplicates = [];
  const warnings = [];

  const lines = toLines(text);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    // `#` starts a comment anywhere in the line; LibRPA never quotes values, so a `#`
    // inside a path cannot be distinguished and is treated as a comment (as the C++
    // reader does).
    const stripped = raw.replace(/#.*$/, '').trim();
    if (stripped === '') continue;

    const eq = stripped.indexOf('=');
    if (eq < 0) {
      warnings.push(`第 ${i + 1} 行不是 key = value，已跳过：${stripped.slice(0, 120)}`);
      continue;
    }
    const key = stripped.slice(0, eq).trim();
    if (key === '') {
      warnings.push(`第 ${i + 1} 行缺少键名，已跳过：${stripped.slice(0, 120)}`);
      continue;
    }
    const value = stripped.slice(eq + 1).trim();
    // Last occurrence wins, matching the C++ reader which simply overwrites.
    if (key in params) {
      if (!duplicates.includes(key)) duplicates.push(key);
      if (params[key] !== value) {
        warnings.push(`键 ${key} 重复出现（第 ${i + 1} 行），后出现的值生效`);
      }
    }
    params[key] = value;
    entries.push({ key, value, raw, line: i + 1 });
  }

  if (entries.length === 0) warnings.push('没有解析到任何 key = value 行');

  return { entries, params, duplicates, warnings };
}

/** Case-insensitive lookup. @returns {string|undefined} */
export function getLibrpaParam(params, name) {
  if (!params) return undefined;
  if (name in params) return params[name];
  const lower = String(name).toLowerCase();
  for (const key of Object.keys(params)) {
    if (key.toLowerCase() === lower) return params[key];
  }
  return undefined;
}

/**
 * Boolean lookup.
 *
 * LibRPA's reader (`driver/input_parser.cpp:100-105`) accepts the Fortran spellings as
 * well as the English ones: `true|t|.t.` and `false|f|.f.`. A bare `1`/`0` is also
 * accepted here because some hand-written inputs use it.
 *
 * @returns {boolean|undefined} undefined when the key is absent or the value is not a boolean
 */
export function getLibrpaFlag(params, name) {
  const value = getLibrpaParam(params, name);
  if (value === undefined) return undefined;
  const v = String(value).trim().toLowerCase();
  if (v === 'true' || v === 't' || v === '.t.' || v === '1' || v === 'on' || v === 'yes') return true;
  if (v === 'false' || v === 'f' || v === '.f.' || v === '0' || v === 'off' || v === 'no') return false;
  return undefined;
}

/** Numeric lookup. @returns {number|null} */
export function getLibrpaNumber(params, name) {
  const value = getLibrpaParam(params, name);
  return value === undefined ? null : toNum(value);
}

/**
 * Documentation for the driver keys.
 *
 * `group` is one of the CONTRACT.md §7 groups: Task, Paths, Screening, Frequency,
 * Dielectric, Parallel, Symmetry, Coulomb, QSGW, Output.
 *
 * @type {Record<string, { type:'string'|'number'|'bool'|'enum', values?:string[],
 *                         group:string, doc:string }>}
 */
export const LIBRPA_KEYS = {
  // ---- Task ------------------------------------------------------------------
  task: {
    type: 'enum',
    values: ['qsgw', 'g0w0', 'rpa', 'exx'],
    group: 'Task',
    doc: '要执行的计算：qsgw 准粒子自洽、g0w0 单次、rpa 相关能、exx 交换。',
  },
  output_level: {
    type: 'enum',
    values: ['silent', 'critical', 'warn', 'info', 'verbose', 'debug'],
    group: 'Task',
    doc: '日志详细程度；常规运行用 info。',
  },
  constants_choice: {
    type: 'enum',
    values: ['vasp', 'aims', 'quantum_espresso', 'abacus'],
    group: 'Task',
    doc: '物理常数与单位约定来源，必须与产生 dataset 的 DFT 代码一致。',
  },
  version_coul_reader: {
    type: 'number',
    group: 'Coulomb',
    doc: 'Coulomb 矩阵读入器版本；不同版本的 ABACUS 导出格式不同。',
  },
  version_lri_reader: {
    type: 'number',
    group: 'Task',
    doc: 'RI 系数读入器版本，-1 表示自动判断。',
  },
  use_pyatb: { type: 'bool', group: 'Task', doc: '是否调用 pyatb 做能带插值。' },
  debug: { type: 'bool', group: 'Task', doc: '调试输出开关。' },

  // ---- Paths -----------------------------------------------------------------
  input_dir: { type: 'string', group: 'Paths', doc: 'ABACUS 导出的 dataset 目录。' },
  output_dir: { type: 'string', group: 'Paths', doc: '输出目录，默认 "./"，实际常写 ./librpa.d/。' },
  restart_from_dir: {
    type: 'string',
    group: 'Paths',
    doc: '读取已算好的自能/W 的目录；空表示从头算。',
  },
  prefix_lri_coeff: { type: 'string', group: 'Paths', doc: 'RI 三中心系数文件前缀（默认 Cs_data）。' },
  prefix_lri_coeff_shrink: { type: 'string', group: 'Paths', doc: '收缩辅助基的 RI 系数前缀。' },
  prefix_shrink_sinvS: { type: 'string', group: 'Paths', doc: '收缩映射 sinvS 前缀。' },
  prefix_coul_full: { type: 'string', group: 'Paths', doc: '全 Coulomb 矩阵文件前缀（coulomb_full_iq）。' },
  prefix_coul_cut: { type: 'string', group: 'Paths', doc: '截断 Coulomb 矩阵文件前缀（coulomb_cut_iq）。' },
  prefix_eigvecs_scf: { type: 'string', group: 'Paths', doc: 'KS 本征矢文件前缀（KS_eigenvector）。' },
  fn_stru: { type: 'string', group: 'Paths', doc: '结构文件名（默认 stru_out）。' },
  fn_bz_sampling: { type: 'string', group: 'Paths', doc: 'k 点文件名（默认 bz_sampling_out）。' },
  fn_basis: { type: 'string', group: 'Paths', doc: '基组元数据文件名（默认 basis_out）。' },
  fn_basis_wfc: { type: 'string', group: 'Paths', doc: '波函数基文件名（默认 basis_wfc_out）。' },
  fn_basis_aux: { type: 'string', group: 'Paths', doc: '辅助基文件名（默认 basis_aux_out）。' },
  fn_basis_aux_shrink: { type: 'string', group: 'Paths', doc: '收缩辅助基文件名（basis_aux_shrink_out）。' },
  fn_eigocc_scf: { type: 'string', group: 'Paths', doc: '本征值/占据文件名（默认 band_out）。' },
  fn_dielfunc: { type: 'string', group: 'Paths', doc: '介电函数文件名（默认 dielecfunc_out）。' },
  fn_vxc_scf: { type: 'string', group: 'Paths', doc: 'Vxc 矩阵文件名前缀（vxc_out）。' },
  fn_band_kpath_info: { type: 'string', group: 'Paths', doc: '能带路径信息文件名（band_kpath_info）。' },

  // ---- Screening -------------------------------------------------------------
  option_dielect_func: {
    type: 'number',
    group: 'Dielectric',
    doc: '介电函数处理方式：0 不使用外部数据，3 拟合，4 插值。',
  },
  replace_w_head: { type: 'bool', group: 'Dielectric', doc: '是否用外部介电函数替换 W 的 head。' },
  use_fullcoul_eps: { type: 'bool', group: 'Dielectric', doc: '介电函数用全 Coulomb 还是截断 Coulomb。' },
  use_shrink_abfs: { type: 'bool', group: 'Screening', doc: '是否使用收缩辅助基（ABFS）。' },
  use_shrink_chi: { type: 'bool', group: 'Screening', doc: '是否对 chi 做收缩。' },
  n_bands_chi0: { type: 'number', group: 'Screening', doc: '构建 chi0 使用的能带数，-1 表示全部。' },
  n_bands_sigc: { type: 'number', group: 'Screening', doc: '构建 sigc 使用的能带数，-1 表示全部。' },
  sf_gf_omega_shift: { type: 'number', group: 'Screening', doc: '格林函数谱函数展宽（Ha）。' },
  sf_sigc_omega_shift: { type: 'number', group: 'Screening', doc: '自能谱函数展宽（Ha）。' },

  // ---- Frequency -------------------------------------------------------------
  nfreq: { type: 'number', group: 'Frequency', doc: '虚频网格点数。' },
  tfgrid_type: {
    type: 'enum',
    values: ['minimax', 'pade', 'same', 'unset'],
    group: 'Frequency',
    doc: '虚频网格类型；minimax 用 Minimax 拟合网格。',
  },
  tfgrids_type: {
    type: 'enum',
    values: ['minimax', 'pade', 'same', 'unset'],
    group: 'Frequency',
    doc: '虚频网格类型（librpa.out 中写作 tfgrids_type）。',
  },
  n_params_anacon: { type: 'number', group: 'Frequency', doc: '解析延拓拟合参数个数。' },
  n_params_anacon_resample: {
    type: 'number',
    group: 'Frequency',
    doc: '延拓重采样参数数，-1 表示不重采样。',
  },
  anacon_nfreq: { type: 'number', group: 'Frequency', doc: '延拓使用的频点数，-1 表示跟随 nfreq。' },
  minimax_emin: { type: 'number', group: 'Frequency', doc: 'Minimax 网格能量下界，-1 表示自动。' },
  minimax_emax: { type: 'number', group: 'Frequency', doc: 'Minimax 网格能量上界，-1 表示自动。' },
  minimax_regulation: { type: 'number', group: 'Frequency', doc: 'Minimax 网格规范化开关。' },

  // ---- Parallel --------------------------------------------------------------
  parallel_routing: {
    type: 'enum',
    values: ['auto', 'atom_pair', 'libri'],
    group: 'Parallel',
    doc: 'MPI 并行路由；libri 走 LibRI 的分块并行。',
  },
  use_kpara_scf_eigvec: { type: 'bool', group: 'Parallel', doc: 'SCF 本征矢是否按 k 并行存储。' },
  use_scalapack_gw_wc: { type: 'bool', group: 'Parallel', doc: 'Wc 是否用 ScaLAPACK 并行。' },
  use_scalapack_ecrpa: { type: 'bool', group: 'Parallel', doc: 'ecRPA 是否用 ScaLAPACK。' },
  use_cholesky_gw_wc: { type: 'bool', group: 'Parallel', doc: 'Wc 是否用 Cholesky 分解。' },
  libri_chi0_collect_max_bytes: {
    type: 'number',
    group: 'Parallel',
    doc: 'LibRI 收集 chi0 的最大字节数，0 表示不限制。',
  },

  // ---- Symmetry --------------------------------------------------------------
  use_symmetry_exx: { type: 'bool', group: 'Symmetry', doc: 'EXX 是否使用对称性约化。' },
  use_symmetry_gw: { type: 'bool', group: 'Symmetry', doc: 'GW 是否使用对称性约化。' },
  use_symmetry_rpa: { type: 'bool', group: 'Symmetry', doc: 'RPA 是否使用对称性约化。' },

  // ---- Coulomb ---------------------------------------------------------------
  vq_threshold: { type: 'number', group: 'Coulomb', doc: 'Coulomb 矩阵元素截断阈值，0 表示不截断。' },
  sqrt_coulomb_threshold: { type: 'number', group: 'Coulomb', doc: 'sqrt(Coulomb) 稀疏化阈值。' },
  use_fullcoul_wc: { type: 'bool', group: 'Coulomb', doc: 'Wc 用全 Coulomb。' },
  use_fullcoul_exx: { type: 'bool', group: 'Coulomb', doc: 'EXX 用全 Coulomb。' },
  cs_R_threshold: { type: 'number', group: 'Coulomb', doc: 'RI 系数空间截断阈值。' },
  gf_R_threshold: { type: 'number', group: 'Coulomb', doc: '格林函数空间截断阈值。' },
  rpa_headwing_mode: {
    type: 'enum',
    values: ['qavg', 'full', 'none'],
    group: 'Coulomb',
    doc: 'RPA head/wing 的处理方式。',
  },

  // ---- QSGW ------------------------------------------------------------------
  qsgw_input_contract: {
    type: 'string',
    group: 'QSGW',
    doc: '输入契约文件路径，用于校验 dataset 与代际约定（决定输出列的含义）。',
  },
  qsgw_mixer: {
    type: 'enum',
    values: ['none', 'linear', 'broyden'],
    group: 'QSGW',
    doc: 'QSGW 自洽混合器；none 表示只做固定次数更新。',
  },
  qsgw_mixing_beta: { type: 'number', group: 'QSGW', doc: 'QSGW 混合系数。' },
  qsgw_min_iter: { type: 'number', group: 'QSGW', doc: 'QSGW 最少迭代次数。' },
  qsgw_max_iter: { type: 'number', group: 'QSGW', doc: 'QSGW 最多迭代次数。' },
  qsgw_convergence_tolerance_ev: { type: 'number', group: 'QSGW', doc: 'QSGW 收敛判据（eV）。' },
  qsgw_band0_cut_mode: { type: 'number', group: 'QSGW', doc: '第 0 条能带处截断 Coulomb 的使用模式。' },
  qsgw_band0_cut_shift_ha: { type: 'number', group: 'QSGW', doc: 'band0 截断的能量偏移（Ha）。' },
  qsgw_band0_unoccupied_keep: { type: 'number', group: 'QSGW', doc: 'band0 保留的未占据能带数。' },
  qsgw_write_iteration_matrices: {
    type: 'bool',
    group: 'QSGW',
    doc: '是否写出每次迭代的矩阵（qsgw_matrices.dat，文件很大）。',
  },
  qsgw_update_hartree: { type: 'bool', group: 'QSGW', doc: '是否更新 Hartree 项。' },
  qsgw_hartree_coulomb: { type: 'string', group: 'QSGW', doc: 'Hartree 项使用 full 还是 cut Coulomb。' },
  qsgw_hartree_normalization: { type: 'string', group: 'QSGW', doc: 'Hartree 项的归一化方式。' },

  // ---- Output ----------------------------------------------------------------
  output_energy_qp: { type: 'bool', group: 'Output', doc: '是否输出准粒子能量文件。' },
  output_gw_spec_func: { type: 'bool', group: 'Output', doc: '是否输出 GW 谱函数。' },
  read_sigc_mat_rf: { type: 'bool', group: 'Output', doc: '是否读入 (R,f) 形式的自能矩阵。' },
  output_wc_rf: { type: 'bool', group: 'Output', doc: '是否输出 (R,f) 形式的 Wc。' },
  output_wc_rf_atom_pair: { type: 'bool', group: 'Output', doc: '是否按原子对输出 Wc。' },
  i_state_low: { type: 'number', group: 'Output', doc: '输出能带区间下界（0 基）。' },
  i_state_high: { type: 'number', group: 'Output', doc: '输出能带区间上界。' },
};

/** Display order of the groups. */
const GROUP_ORDER = [
  'Task',
  'Paths',
  'Screening',
  'Frequency',
  'Dielectric',
  'Parallel',
  'Symmetry',
  'Coulomb',
  'QSGW',
  'Output',
];

/** Fallback group for keys with no metadata. */
const OTHER_GROUP = '其他';

function lookupKey(key) {
  if (Object.prototype.hasOwnProperty.call(LIBRPA_KEYS, key)) return LIBRPA_KEYS[key];
  const lower = key.toLowerCase();
  for (const candidate of Object.keys(LIBRPA_KEYS)) {
    if (candidate.toLowerCase() === lower) return LIBRPA_KEYS[candidate];
  }
  return null;
}

/**
 * Group parsed params for display.
 *
 * Groups appear in `GROUP_ORDER`; unknown keys are collected in `其他` **and** listed in
 * `unknownKeys` so the UI can flag them without losing their values.
 *
 * @param {Record<string,string>} params
 * @returns {{ groups: Array<{ group:string, items:Array<{
 *   key:string, value:string, known:boolean, doc?:string }> }>, unknownKeys:string[] }}
 */
export function summarizeLibrpaParams(params) {
  const buckets = new Map();
  const unknownKeys = [];

  for (const key of Object.keys(params ?? {})) {
    const meta = lookupKey(key);
    if (!meta) unknownKeys.push(key);
    const groupName = meta ? meta.group : OTHER_GROUP;
    if (!buckets.has(groupName)) buckets.set(groupName, []);
    buckets.get(groupName).push({
      key,
      value: params[key],
      known: Boolean(meta),
      ...(meta ? { doc: meta.doc } : {}),
    });
  }

  const rank = (group) => {
    const index = GROUP_ORDER.indexOf(group);
    return index < 0 ? GROUP_ORDER.length : index;
  };

  const groups = [...buckets.entries()]
    .map(([group, items]) => ({ group, items }))
    .sort((a, b) => rank(a.group) - rank(b.group) || a.group.localeCompare(b.group));

  return { groups, unknownKeys };
}
