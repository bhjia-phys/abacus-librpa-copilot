/**
 * ABACUS `INPUT` parser and keyword documentation.
 *
 * ABACUS reads `INPUT` as a flat keyword file (`source_io/module_parameter/read_input.cpp`,
 * `ReadInput::read_txt_input`, v3.9.0.25):
 *
 *   1. `filter_nonascii_and_comment` drops everything from `#` to end-of-line;
 *   2. the file must start with the literal `INPUT_PARAMETERS` (case-sensitive in ABACUS,
 *      matched case-insensitively here so a hand-edited file still parses);
 *   3. each following line is `keyword value...`; a bare keyword is a flag;
 *   4. keyword lookup is case-insensitive (`FmtCore::lower(word)`);
 *   5. values run to the end of the line and stop at a token beginning with `#` or `!`
 *      (`read_information(..., "#!")`), so a path containing `/` is safe.
 *
 * The keyword table below is transcribed from `docs/parameters.yaml`, which ABACUS
 * generates with `--generate-parameters-yaml` directly from the `Input_Item` blocks, so the
 * categories, units and defaults here are the program's own, not a guess. Every keyword
 * SPEC.md §1.1 names is covered; a handful of names in that list are **legacy spellings
 * that current ABACUS does not read at all** (verified absent from the whole source tree)
 * and are marked `legacy: true` with the replacement to use instead.
 *
 * @module abacusflow/host/abacus/input-params
 */
import { toLines, toNum, firstNum, warn } from '../shared/numbers.js';

const HEADER = 'INPUT_PARAMETERS';

/**
 * Parse an ABACUS INPUT file.
 *
 * Never throws on content.
 *
 * @param {string} text
 * @returns {{
 *   keywordOrder: string[],
 *   params: Record<string,string>,
 *   entries: Array<{ keyword:string, key:string, values:string[], line:number, raw:string }>,
 *   duplicates: string[],
 *   unknownLines: string[],
 *   headerPresent: boolean,
 *   lineCount: number,
 *   warnings: string[]
 * }}
 */
export function parseAbacusInput(text) {
  const entries = [];
  const params = Object.create(null);
  const keywordOrder = [];
  const duplicateKeys = [];
  const unknownLines = [];
  const warnings = [];

  const lines = toLines(text);
  let headerPresent = false;
  let headerChecked = false;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    // `#` and `!` start a comment; ABACUS truncates at the comment marker, not the line.
    const stripped = raw.replace(/[#!].*$/, '').trim();
    if (stripped === '') continue;

    // (1) header: the first meaningful line must be INPUT_PARAMETERS.
    if (!headerChecked) {
      headerChecked = true;
      if (stripped.toUpperCase() === HEADER) {
        headerPresent = true;
        continue;
      }
      warn(warnings, `第一行不是 ${HEADER}，而是「${stripped.slice(0, 60)}」`);
      // Fall through and treat it as a parameter rather than discarding data.
    } else if (stripped.toUpperCase() === HEADER) {
      // A stray second header: ABACUS would reject it as an unknown keyword.
      warn(warnings, `第 ${i + 1} 行重复出现 ${HEADER}`);
      continue;
    }

    const tokens = stripped.split(/\s+/);
    const keyword = tokens[0];
    const values = tokens.slice(1);
    const key = keyword.toLowerCase();

    if (key in params) duplicateKeys.push(key);
    else keywordOrder.push(keyword);
    params[key] = values.join(' ');
    entries.push({ keyword, key, values, line: i + 1, raw });
  }

  if (!headerPresent) warn(warnings, `缺少 ${HEADER} 头行`);
  if (entries.length === 0) warn(warnings, '没有解析到任何参数');

  const duplicates = [...new Set(duplicateKeys)];
  if (duplicates.length > 0) {
    warn(warnings, `重复关键字（后者生效）：${duplicates.join('、')}`);
  }

  return {
    keywordOrder,
    params,
    entries,
    duplicates,
    unknownLines,
    headerPresent,
    lineCount: lines.length,
    warnings,
  };
}

/** Case-insensitive parameter lookup. @returns {string|undefined} */
export function getParam(params, name) {
  if (!params) return undefined;
  const lower = String(name).toLowerCase();
  if (lower in params) return params[lower];
  for (const key of Object.keys(params)) {
    if (key.toLowerCase() === lower) return params[key];
  }
  return undefined;
}

/**
 * Numeric lookup. For a vector-valued keyword (`kspacing`, `hubbard_u`, ...) the first
 * number is returned, because that is what "the value" means for a scalar question;
 * use {@link getNumberList} when every component matters.
 * @returns {number|null}
 */
export function getNumber(params, name) {
  const value = getParam(params, name);
  if (value === undefined) return null;
  return toNum(value) ?? firstNum(value);
}

/** Every numeric component of a vector-valued keyword. @returns {number[]|null} */
export function getNumberList(params, name) {
  const value = getParam(params, name);
  if (value === undefined || value.trim() === '') return null;
  const numbers = value
    .split(/\s+/)
    .filter(Boolean)
    .map(toNum)
    .filter((v) => v !== null);
  return numbers.length > 0 ? numbers : null;
}

/** Every whitespace-separated token of a keyword. @returns {string[]} */
export function getList(params, name) {
  const value = getParam(params, name);
  if (value === undefined || value.trim() === '') return [];
  return value.split(/\s+/).filter(Boolean);
}

/**
 * Boolean lookup.
 *
 * Contract: a keyword present with no value is a flag, and so is an explicit truthy value.
 * ABACUS's own truthy set is `true, 1, t, yes, y, on, .true.` (`assume_as_boolean`).
 *
 * @returns {boolean|undefined} `undefined` when the keyword is absent, or when it carries
 *   a value that is neither truthy nor falsy — the caller should then show the raw string
 *   rather than inventing a boolean.
 */
export function getFlag(params, name) {
  const value = getParam(params, name);
  if (value === undefined) return undefined;
  if (value.trim() === '') return true;
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 't' || v === 'yes' || v === 'y' || v === 'on' || v === '.true.') {
    return true;
  }
  if (
    v === 'false' || v === '0' || v === 'f' || v === 'no' || v === 'n' ||
    v === 'off' || v === '.false.' || v === 'none' || v === 'null'
  ) {
    return false;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Keyword documentation
// ---------------------------------------------------------------------------

/** Helper so the table below stays readable: `K(category, type, doc[, unit[, values]])`. */
function K(category, type, doc, unit, values, extra) {
  return {
    category,
    type,
    doc,
    ...(unit ? { unit } : {}),
    ...(values ? { values } : {}),
    ...(extra ?? {}),
  };
}

/** Shorthand for the legacy names that current ABACUS no longer reads. */
function legacy(doc, replacement, category = 'Other', type = 'string') {
  return { category, type, doc, legacy: true, replacedBy: replacement };
}

/**
 * Keyword metadata used by the panel and by validation.
 *
 * `category` is one of the fixed panel groups (`System`, `Accuracy`, `Electronic`, ...);
 * ABACUS's own category is kept verbatim in `abacusCategory` so the two can be compared
 * without either being lost.
 *
 * @type {Record<string, {
 *   category:string, type:'string'|'number'|'flag'|'enum', unit?:string,
 *   values?:string[], doc:string, legacy?:boolean, replacedBy?:string,
 *   abacusCategory?:string
 * }>}
 */
export const KEYWORD_INFO = {
  // ---- System --------------------------------------------------------------
  suffix: K('System', 'string',
    '输出子目录名。ABACUS 在工作目录建立 OUT.<suffix>/ 写入全部运行信息；默认 ABACUS。',
    null, null, { abacusCategory: 'System variables' }),
  ntype: K('System', 'number',
    '元素种类数。现在已经不需要设置：ABACUS 从 STRU 的 ATOMIC_SPECIES 自动数出；若同时设置且与 STRU 不符则直接报错退出。',
    null, null, { abacusCategory: 'System variables' }),
  calculation: K('System', 'enum',
    '计算类型。scf 自洽；nscf 非自洽（需已有电荷密度）；relax 固定晶胞的离子弛豫；cell-relax 同时弛豫晶胞；md 分子动力学；get_s/get_wf/get_pchg 只取重叠矩阵/波函数/分带电荷密度（均仅 LCAO）；gen_bessel/gen_opt_abfs 生成 DeePKS 投影子或优化数值原子轨道；test_memory/test_neighbour 只做内存与近邻测试。',
    null, ['scf', 'nscf', 'relax', 'cell-relax', 'md', 'get_s', 'get_wf', 'get_pchg',
      'gen_bessel', 'gen_opt_abfs', 'test_memory', 'test_neighbour'],
    { abacusCategory: 'System variables' }),
  esolver_type: K('System', 'enum',
    '能量求解器。ksdft 是常规 Kohn-Sham DFT；sdft 随机 DFT；ofdft 无轨道 DFT；tddft 实时含时 DFT；lj/dp/nep 经验势；ks-lr/lr 是线性响应 TDDFT。',
    null, ['ksdft', 'sdft', 'ofdft', 'tdofdft', 'tddft', 'lj', 'dp', 'nep', 'ks-lr', 'lr'],
    { abacusCategory: 'System variables' }),
  symmetry: K('System', 'enum',
    '对称性开关。1 自动做对称性分析并用不可约 k 点；0 只考虑时间反演对称（k 与 -k 合并、权重加倍）；-1 完全不做对称性，非共线+SOC 建议用 -1。默认 default 会按计算类型自动取值。',
    null, ['default', '1', '0', '-1'], { abacusCategory: 'System variables' }),
  symmetry_prec: K('Accuracy', 'number',
    '对称性分析的精度（Bohr）。STRU 里的晶格或原子位置不够精确时把这个值放大。',
    'Bohr', null, { abacusCategory: 'System variables' }),
  symmetry_autoclose: K('Electronic', 'flag',
    '对称性分析出错时是否自动关闭对称性继续算（cell-relax 时特别有用）。',
    null, null, { abacusCategory: 'System variables' }),
  kpar: K('System', 'number',
    '把全部 MPI 进程分成 kpar 组，k 点在各组间分配。取值应不超过 k 点数与进程数。',
    null, null, { abacusCategory: 'System variables' }),
  bndpar: K('System', 'number',
    '把进程分成 bndpar 组，能带（目前只对随机轨道）在各组间分配。',
    null, null, { abacusCategory: 'System variables' }),
  diago_proc: K('System', 'number',
    '参与对角化的进程数；0 表示用全部进程。',
    null, null, { abacusCategory: 'System variables' }),
  init_vel: K('Electronic', 'flag',
    '是否从 STRU 读取初速度并据此确定初始温度。md_tfirst 未设或为负时会自动置 1。',
    null, null, { abacusCategory: 'System variables' }),
  cal_force: K('Electronic', 'flag',
    '电子迭代结束后是否计算力。', null, null, { abacusCategory: 'System variables' }),
  cal_stress: K('Electronic', 'flag',
    '电子迭代结束后是否计算应力。', null, null, { abacusCategory: 'System variables' }),
  mem_saver: K('Electronic', 'flag',
    '仅 nscf：是否启用省内存算法（k 点很多时有用）。', null, null, { abacusCategory: 'System variables' }),
  cell_factor: K('System', 'number',
    '构造函数赝势表时的填充因子；cell-relax 时 ABACUS 会自动设为 2.0。',
    null, null, { abacusCategory: 'System variables' }),
  latname: K('Structural', 'enum',
    '布拉维格子类型。设为 user_defined_lattice（或 none）时必须在 STRU 里给 LATTICE_VECTORS；设为其他值时 STRU 中禁止出现 LATTICE_VECTORS，晶胞由 LATTICE_PARAMETERS 决定。',
    null, ['none', 'user_defined_lattice', 'sc', 'fcc', 'bcc', 'hexagonal', 'trigonal',
      'st', 'bct', 'so', 'baco', 'fco', 'bco', 'sm', 'bacm', 'triclinic'],
    { abacusCategory: 'System variables' }),
  device: K('Device', 'enum',
    '计算设备。cpu 走 CPU；gpu 走 CUDA/ROCm，此时 ks_solver 也必须支持 GPU（lcao_in_pw 不支持 GPU）。',
    null, ['cpu', 'gpu'], { abacusCategory: 'System variables' }),
  precision: K('Device', 'enum',
    '浮点精度。仅平面波基组可用 single；NAO 基组不支持单精度。',
    null, ['single', 'double'], { abacusCategory: 'System variables' }),
  init_chg: K('Electronic', 'enum',
    '初始电荷密度来源。atomic 用原子密度叠加；file 先读二进制电荷密度、失败再读 cube；wfc 由波函数与占据算；dm 由实空间密度矩阵算；hr 读 HR；auto 先尝试读文件、失败退回 atomic。',
    null, ['atomic', 'file', 'wfc', 'dm', 'hr', 'auto'], { abacusCategory: 'System variables' }),
  init_wfc: K('Electronic', 'enum',
    '初始波函数来源。atomic 用原子赝波函数（不够则补随机数）；atomic+random 在原子波函数上加小随机数；file 读 wf*.dat（需 out_wfc_pw=2）；random 纯随机；nao / nao+random 用数值原子轨道。',
    null, ['atomic', 'atomic+random', 'file', 'random', 'nao', 'nao+random'],
    { abacusCategory: 'System variables' }),
  chg_extrap: K('Electronic', 'enum',
    'MD / 弛豫过程中每一步之间的电荷外推方式。默认 default 会按计算类型自动选：md 用 second-order，relax/cell-relax 用 first-order，其余 atomic。',
    null, ['default', 'atomic', 'first-order', 'second-order', 'dm'],
    { abacusCategory: 'System variables' }),

  // ---- Input files ---------------------------------------------------------
  pseudo_dir: K('System', 'string',
    '赝势文件所在目录。与 STRU 中 ATOMIC_SPECIES 的赝势文件名拼成完整路径。',
    null, null, { abacusCategory: 'Input files' }),
  orbital_dir: K('System', 'string',
    '数值原子轨道文件所在目录。与 STRU 中 NUMERICAL_ORBITAL 的文件名拼成完整路径。',
    null, null, { abacusCategory: 'Input files' }),
  stru_file: K('System', 'string',
    '结构文件名，默认 STRU。', null, null, { abacusCategory: 'Input files' }),
  kpoint_file: K('System', 'string',
    'k 点文件名，默认 KPT。', null, null, { abacusCategory: 'Input files' }),
  read_file_dir: K('System', 'string',
    '读取重启文件（电荷密度、波函数等）的目录，默认 OUT.<suffix>。',
    null, null, { abacusCategory: 'Input files' }),
  restart_load: K('Electronic', 'flag',
    '是否从上次计算保存的电荷密度续算。', null, null, { abacusCategory: 'Input files' }),

  // ---- Accuracy ------------------------------------------------------------
  ecutwfc: K('Accuracy', 'number',
    '波函数平面波截断能。即使使用数值原子轨道基组也必须设：赝势的局域部分与相关力是平面波展开算的。常用 50–100 Ry。',
    'Ry', null, { abacusCategory: 'Plane wave related variables' }),
  ecutrho: K('Accuracy', 'number',
    '电荷密度与势的截断能。模守恒赝势下建议保持默认 4×ecutwfc；调小会引入噪声，尤其是力与应力。',
    'Ry', null, { abacusCategory: 'Plane wave related variables' }),
  scf_thr: K('Accuracy', 'number',
    'SCF 收敛阈值，即相邻两次迭代电荷密度差。LCAO 一般 1e-6 已足够；单位取决于 scf_thr_type。',
    'Ry（scf_thr_type=1）或无量纲（scf_thr_type=2）', null,
    { abacusCategory: 'Electronic structure' }),
  scf_nmax: K('Accuracy', 'number',
    'SCF 最大电子迭代步数。', null, null, { abacusCategory: 'Electronic structure' }),
  scf_thr_type: K('Accuracy', 'enum',
    'SCF 收敛判据的类型。1 用倒空间电荷密度差；2 用实空间电荷密度差（LCAO 默认）。',
    null, ['1', '2'], { abacusCategory: 'Electronic structure' }),
  scf_ene_thr: K('Accuracy', 'number',
    '总能量收敛阈值；负值表示不启用。', 'eV', null, { abacusCategory: 'Electronic structure' }),
  kspacing: K('Accuracy', 'string',
    'k 点最小间距，单位 1/Bohr，建议小于 0.25。设为 > 0 后 KPT 文件不再必需——ABACUS 会按间距生成网格并**重写** KPT 文件，因此磁盘上的 KPT 内容未必等于实际使用的网格。默认 0 表示读取 KPT。',
    '1/Bohr', null, { abacusCategory: 'System variables', vector: true }),
  pw_diag_thr: K('Accuracy', 'number',
    '平面波求解器（cg/dav/dav_subspace/bpcg）第一步的收敛阈值，之后自动收紧；nscf 建议 ≤ 1e-3。',
    null, null, { abacusCategory: 'Plane wave related variables' }),
  pw_diag_nmax: K('Accuracy', 'number',
    '平面波求解器的最大迭代步数。', null, null,
    { abacusCategory: 'Plane wave related variables' }),
  search_radius: K('Accuracy', 'number',
    'LCAO 寻找近邻原子的搜索半径；-1 表示按轨道与投影子的截断自动决定。',
    'Bohr', null, { abacusCategory: 'Numerical atomic orbitals related variables' }),
  lmaxmax: K('Accuracy', 'number',
    'LCAO 使用的最大角量子数通道；保持默认 2 时不生效，角向通道数从轨道文件读取。',
    null, null, { abacusCategory: 'Numerical atomic orbitals related variables' }),

  // ---- Electronic ----------------------------------------------------------
  basis_type: K('Electronic', 'enum',
    '基组。pw 纯平面波；lcao 数值原子轨道；lcao_in_pw 把局域轨道展开在平面波里。',
    null, ['pw', 'lcao', 'lcao_in_pw'], { abacusCategory: 'Electronic structure' }),
  dft_functional: K('Electronic', 'string',
    '交换关联泛函。不设则用赝势文件自带的泛函；设了就覆盖赝势。短名如 LDA/PBE/PBESOL/SCAN/PBE0/HSE；编译了 LIBXC 时还可用 LIBXC 分量名相加。',
    null, null, { abacusCategory: 'Electronic structure' }),
  nspin: K('Electronic', 'enum',
    '自旋分量数。1 单自旋；2 共线自旋极化（自旋向上/向下）；4 非共线自旋（磁矩可取任意方向，含 SOC 时通常配 noncolin/lspinorb）。',
    null, ['1', '2', '4'], { abacusCategory: 'Electronic structure' }),
  ks_solver: K('Electronic', 'string',
    'Kohn-Sham 方程求解器。平面波：cg/bpcg/dav/dav_subspace；LCAO：lapack/genelpa/scalapack_gvx/elpa/cusolver/cusolvermp。注意 genelpa 不能用于平面波基组。',
    null, null, { abacusCategory: 'Electronic structure' }),
  nbands: K('Electronic', 'number',
    '要计算的 Kohn-Sham 轨道数。建议显式设置；使用展宽时更要留出足够多的空带。',
    null, null, { abacusCategory: 'Electronic structure' }),
  nelec: K('Electronic', 'number',
    '总电子数。0 表示由各元素价电子数求和（中性体系）。', null, null,
    { abacusCategory: 'Electronic structure' }),
  nelec_delta: K('Electronic', 'number',
    '电子数增量：总电子数按 nelec+nelec_delta 计。', null, null,
    { abacusCategory: 'Electronic structure' }),
  nupdown: K('Electronic', 'number',
    '自旋向上与自旋向下电子数之差，非零时启用双费米能级。只能用于 nspin=2。',
    null, null, { abacusCategory: 'Electronic structure' }),
  lspinorb: K('Electronic', 'flag',
    '是否考虑自旋轨道耦合（SOC）。通常与 noncolin=1、nspin=4 一起用，且需要 SOC 赝势。',
    null, null, { abacusCategory: 'Electronic structure' }),
  noncolin: K('Electronic', 'flag',
    '是否允许非共线磁矩，即磁化方向可以指向任意方向而不只限于 z 轴。',
    null, null, { abacusCategory: 'Electronic structure' }),
  gamma_only: K('Electronic', 'flag',
    '仅 LCAO 且只用 Gamma 点时启用快速算法。**注意**：设了它 ABACUS 会把 KPT 文件重写成 1×1×1 Gamma 网格。',
    null, null, { abacusCategory: 'Electronic structure' }),
  fixed_atoms: K('Relaxation', 'flag',
    '是否固定全部原子（把 STRU 里所有原子的 mbl 置 0）。',
    null, null, { abacusCategory: 'System variables' }),

  // ---- Occupational --------------------------------------------------------
  smearing_method: K('Occupational', 'enum',
    '占据数展宽方法。fixed 固定占据（只适用绝缘体）；gauss/gaussian 高斯展宽；mp 与 mp2 是 Methfessel-Paxton（金属推荐）；mv/cold 是 Marzari-Vanderbilt；fd 是费米-狄拉克。',
    null, ['fixed', 'gauss', 'gaussian', 'mp', 'mp2', 'mv', 'cold', 'fd', 'fermi-dirac',
      'marzari-vanderbilt'], { abacusCategory: 'Electronic structure' }),
  smearing_sigma: K('Occupational', 'number',
    '展宽宽度，即展宽能量范围。', 'Ry', null, { abacusCategory: 'Electronic structure' }),
  smearing_sigma_temp: K('Occupational', 'number',
    '按温度给出的展宽宽度（等价于 smearing_sigma，但用温度表示）。',
    'K', null, { abacusCategory: 'Electronic structure' }),
  ocp: K('Occupational', 'flag',
    '是否按 ocp_set 使用用户指定的固定占据。', null, null,
    { abacusCategory: 'RT-TDDFT: Real-Time Time-Dependent Density Functional Theory' }),
  ocp_set: K('Occupational', 'string',
    'ocp=1 时必填：按 k 点、按能带顺序给出占据数，空格分隔，可用 Nx 表示连续 N 个能带取 x。',
    null, null, { abacusCategory: 'RT-TDDFT: Real-Time Time-Dependent Density Functional Theory' }),

  // ---- Mixing --------------------------------------------------------------
  mixing_type: K('Mixing', 'enum',
    '电荷混合方法。plain 简单线性混合；pulay 标准 Pulay；broyden 简化修正 Broyden（通常收敛略快于 Pulay）。',
    null, ['plain', 'pulay', 'broyden'], { abacusCategory: 'Electronic structure' }),
  mixing_beta: K('Mixing', 'number',
    '混合系数：rho_new = rho_old + mixing_beta * drho。调小更稳定但需要更多步。经验值：nspin=1 用 0.8，nspin=2/4 用 0.4；0 表示保持电荷密度不变（配 init_chg=file 续算）。',
    null, null, { abacusCategory: 'Electronic structure' }),
  mixing_beta_mag: K('Mixing', 'number',
    '磁矩密度的混合系数，默认 4×mixing_beta 但不超过 1.6。',
    null, null, { abacusCategory: 'Electronic structure' }),
  mixing_ndim: K('Mixing', 'number',
    'Pulay/Broyden 使用历史多少步的密度来混合。', null, null,
    { abacusCategory: 'Electronic structure' }),
  mixing_gg0: K('Mixing', 'number',
    'Kerker 混合参数（G=0 处的缩放）。', null, null,
    { abacusCategory: 'Electronic structure' }),
  mixing_gg0_min: K('Mixing', 'number',
    'Kerker 系数下限。', null, null, { abacusCategory: 'Electronic structure' }),
  mixing_gg0_mag: K('Mixing', 'number',
    '磁矩密度 Kerker 混合的 G=0 参数。', null, null,
    { abacusCategory: 'Electronic structure' }),
  mixing_restart: K('Mixing', 'number',
    '当相邻两步电荷密度差小于该值时，下一步直接用上一步输出密度重启混合（一次 SCF 只生效一次）。',
    null, null, { abacusCategory: 'Electronic structure' }),
  mixing_angle: K('Mixing', 'number',
    '非共线计算中用于寻找正确磁构型的角度混合参数；目前只实现 1.0。',
    null, null, { abacusCategory: 'Electronic structure' }),
  mixing_tau: K('Mixing', 'flag',
    '是否混合动能密度（meta-GGA 需要）。', null, null,
    { abacusCategory: 'Electronic structure' }),
  mixing_dftu: K('Mixing', 'flag',
    '是否混合 DFT+U 的占据矩阵。', null, null, { abacusCategory: 'Electronic structure' }),

  // ---- Relaxation ----------------------------------------------------------
  relax_method: K('Relaxation', 'string',
    '几何优化算法。cg 共轭梯度（relax_new=1 时唯一可用）；bfgs / lbfgs / cg_bfgs / sd 只在 relax_new=0 时可用；第二个值选 BFGS 变体（1 传统、2 或省略为推荐）。',
    null, null, { abacusCategory: 'Geometry relaxation' }),
  relax_nmax: K('Relaxation', 'number',
    '最大离子步数。scf 默认 1，relax/cell-relax 默认 50；设 0 表示只做初始化后立即停止（快速检查输入正确性）。',
    null, null, { abacusCategory: 'Geometry relaxation' }),
  relax_new: K('Relaxation', 'flag',
    '是否使用 2022 年底引入的新弛豫实现（同时优化离子与晶胞、线搜索）。True 时 relax_method 只能是 cg。',
    null, null, { abacusCategory: 'Geometry relaxation' }),
  relax_scale_force: K('Relaxation', 'number',
    '控制 CG 第一步的大小；大体系宜取小值以免构型崩塌。',
    null, null, { abacusCategory: 'Geometry relaxation' }),
  force_thr: K('Relaxation', 'number',
    '力收敛阈值，与全部原子中最大的力比较。与 force_thr_ev 等价，仅单位不同。LCAO 推荐 0.04 eV/Å。',
    'Ry/Bohr', null, { abacusCategory: 'Geometry relaxation' }),
  force_thr_ev: K('Relaxation', 'number',
    '力收敛阈值（eV/Å），与全部原子中最大的力比较。与 force_thr 等价，仅单位不同。',
    'eV/Angstrom', null, { abacusCategory: 'Geometry relaxation' }),
  force_zero_out: K('Relaxation', 'number',
    '小于该值的力被视为 0。', 'eV/Angstrom', null,
    { abacusCategory: 'Geometry relaxation' }),
  stress_thr: K('Relaxation', 'number',
    '应力收敛阈值，与应力张量中最大的分量比较。',
    'kbar', null, { abacusCategory: 'Geometry relaxation' }),
  press1: K('Relaxation', 'number',
    '第 1 个方向的目标外压；正值表示压应力。', 'kbar', null,
    { abacusCategory: 'Geometry relaxation' }),
  press2: K('Relaxation', 'number',
    '第 2 个方向的目标外压。', 'kbar', null, { abacusCategory: 'Geometry relaxation' }),
  press3: K('Relaxation', 'number',
    '第 3 个方向的目标外压。', 'kbar', null, { abacusCategory: 'Geometry relaxation' }),
  relax_bfgs_w1: K('Relaxation', 'number',
    'BFGS 的 Wolfe 条件参数 c1（充分下降条件）。', null, null,
    { abacusCategory: 'Geometry relaxation' }),
  relax_bfgs_w2: K('Relaxation', 'number',
    'BFGS 的 Wolfe 条件参数 c2（曲率条件）。', null, null,
    { abacusCategory: 'Geometry relaxation' }),
  relax_bfgs_rmax: K('Relaxation', 'number',
    '全部原子总位移的上限。', 'Bohr', null, { abacusCategory: 'Geometry relaxation' }),
  relax_bfgs_rmin: K('Relaxation', 'number',
    '全部原子总位移的下限：低于它且力未收敛则终止计算。',
    'Bohr', null, { abacusCategory: 'Geometry relaxation' }),
  relax_bfgs_init: K('Relaxation', 'number',
    'BFGS 第一步的总位移。', 'Bohr', null, { abacusCategory: 'Geometry relaxation' }),
  relax_cg_thr: K('Relaxation', 'number',
    'relax_method=cg_bfgs 时，最大力降到该值以下就从 CG 切换到 BFGS。',
    'eV/Angstrom', null, { abacusCategory: 'Geometry relaxation' }),
  fixed_axes: K('Relaxation', 'enum',
    'cell-relax 时固定哪些晶胞自由度。None 全部放开；volume 定体积变形状；shape 定形状变体积（只受静水压）；a/b/c/ab/ac/bc 固定相应晶轴。',
    null, ['None', 'volume', 'shape', 'a', 'b', 'c', 'ab', 'ac', 'bc'],
    { abacusCategory: 'Geometry relaxation' }),
  fixed_ibrav: K('Relaxation', 'flag',
    '弛豫时是否保持布拉维格子类型。', null, null,
    { abacusCategory: 'Geometry relaxation' }),

  // ---- MD ------------------------------------------------------------------
  md_type: K('MD', 'enum',
    '分子动力学类型。fire 是基于 MD 的弛豫算法；nve 速度 Verlet；nvt 恒温（见 md_thermostat）；npt Nose-Hoover 控压；langevin 朗之万恒温；msst 多尺度冲击。',
    null, ['fire', 'nve', 'nvt', 'npt', 'langevin', 'msst'],
    { abacusCategory: 'Molecular dynamics' }),
  md_nstep: K('MD', 'number',
    'MD 总步数。rt-tddft 时也用它表示电子演化步数。', null, null,
    { abacusCategory: 'Molecular dynamics' }),
  md_dt: K('MD', 'number',
    'MD 时间步长。设置 td_dt 会反推并改写 md_dt。', 'fs', null,
    { abacusCategory: 'Molecular dynamics' }),
  md_tfirst: K('MD', 'number',
    'MD 初始温度。未设或为负时自动置 init_vel=1，由 STRU 中的速度定初温（STRU 无速度则为 0 K）。',
    'K', null, { abacusCategory: 'Molecular dynamics' }),
  md_tlast: K('MD', 'number',
    'MD 终止温度。未设或为负时取 md_tfirst；与 md_tfirst 不同则温度线性变化。仅 NVT/NPT 使用。',
    'K', null, { abacusCategory: 'Molecular dynamics' }),
  md_nraise: K('MD', 'number',
    '温度调节相关参数：Anderson 恒温器中碰撞频率为 1/md_nraise；Berendsen、rescale_v 也用它。',
    null, null, { abacusCategory: 'Molecular dynamics' }),
  md_thermostat: K('MD', 'enum',
    'NVT 的控温方式。nhc Nose-Hoover 链；anderson 和 berendsen 见 md_nraise；rescaling 速度重标定法一；rescale_v 法二。',
    null, ['nhc', 'anderson', 'berendsen', 'rescaling', 'rescale_v'],
    { abacusCategory: 'Molecular dynamics' }),
  md_tfreq: K('MD', 'number',
    '温度振荡频率，控制恒温器与原子体系的耦合强度。', null, null,
    { abacusCategory: 'Molecular dynamics' }),
  md_tchain: K('MD', 'number',
    'Nose-Hoover 链的恒温器个数。', null, null, { abacusCategory: 'Molecular dynamics' }),
  md_damp: K('MD', 'number',
    'Langevin 方法中加阻尼力的阻尼系数。', 'fs', null,
    { abacusCategory: 'Molecular dynamics' }),
  md_pmode: K('MD', 'enum',
    'NPT 系综的控压模式：iso 各向同性、aniso 各向异性、tri 三斜。',
    null, ['iso', 'aniso', 'tri'], { abacusCategory: 'Molecular dynamics' }),
  init_vel: K('MD', 'flag',
    '是否从 STRU 读取初速度（原子单位）。', null, null,
    { abacusCategory: 'System variables' }),

  // ---- RT-TDDFT ------------------------------------------------------------
  td_dt: K('RT-TDDFT', 'number',
    '电子演化（RT-TDDFT）时间步长。设置它会同时把 md_dt 改写为 td_dt*estep_per_md。',
    'fs', null, { abacusCategory: 'RT-TDDFT: Real-Time Time-Dependent Density Functional Theory' }),
  td_stype: K('RT-TDDFT', 'enum',
    '外加电场的空间类型（规范）。0 长度规范；1 速度规范。',
    null, ['0', '1'], { abacusCategory: 'RT-TDDFT: Real-Time Time-Dependent Density Functional Theory' }),
  td_ttype: K('RT-TDDFT', 'enum',
    '外加电场的时间包络类型。0 高斯；1 梯形；2 三角函数；3 Heaviside。',
    null, ['0', '1', '2', '3'], { abacusCategory: 'RT-TDDFT: Real-Time Time-Dependent Density Functional Theory' }),
  td_vext: K('RT-TDDFT', 'flag',
    '是否外加电场。', null, null,
    { abacusCategory: 'RT-TDDFT: Real-Time Time-Dependent Density Functional Theory' }),
  td_vext_dire: K('RT-TDDFT', 'string',
    '外加电场的方向分量，可同时指定多个（如 `1 2 3`）。', null, null,
    { abacusCategory: 'RT-TDDFT: Real-Time Time-Dependent Density Functional Theory' }),

  // ---- EXX -----------------------------------------------------------------
  exx_fock_alpha: K('EXX', 'number',
    '距离分离杂化泛函中全距 Fock 交换 1/r 的比例。',
    null, null, { abacusCategory: 'Exact Exchange (Common)' }),
  exx_erfc_alpha: K('EXX', 'number',
    '距离分离杂化泛函中短程 Fock 交换 erfc(ωr)/r 的比例。',
    null, null, { abacusCategory: 'Exact Exchange (Common)' }),
  exx_erfc_omega: K('EXX', 'number',
    '短程 Fock 项 erfc(ωr)/r 的距离分离参数 ω。',
    null, null, { abacusCategory: 'Exact Exchange (Common)' }),
  exx_separate_loop: K('EXX', 'flag',
    '是否用两段式自洽：先做若干步 GGA 再进杂化循环；否则直接从杂化循环开始。',
    null, null, { abacusCategory: 'Exact Exchange (Common)' }),
  exx_hybrid_step: K('EXX', 'number',
    '计算 Fock 交换的外层循环最大迭代数。', null, null,
    { abacusCategory: 'Exact Exchange (Common)' }),
  exx_mixing_beta: K('EXX', 'number',
    'exx_separate_loop=1 时外层循环的混合系数。', null, null,
    { abacusCategory: 'Exact Exchange (Common)' }),
  exx_ccp_rmesh_times: K('EXX', 'string',
    '计算库仑势所需的径向网格相对原子轨道网格的倍数；调小可显著加速杂化泛函自洽，但牺牲精度。',
    null, null, { abacusCategory: 'Exact Exchange (LCAO)' }),
  exx_pca_threshold: K('EXX', 'number',
    'EXX 中用于筛除格点 ABF 的主成分分析阈值。', null, null,
    { abacusCategory: 'Exact Exchange (LCAO)' }),
  exx_c_threshold: K('EXX', 'number',
    'EXX 中 C 矩阵的筛选阈值。', null, null, { abacusCategory: 'Exact Exchange (LCAO)' }),
  exx_v_threshold: K('EXX', 'number',
    'EXX 中 V 矩阵的筛选阈值。', null, null, { abacusCategory: 'Exact Exchange (LCAO)' }),
  exx_dm_threshold: K('EXX', 'number',
    'EXX 中密度矩阵的筛选阈值。', null, null, { abacusCategory: 'Exact Exchange (LCAO)' }),
  exx_real_number: K('EXX', 'string',
    'EXX 用实数还是复数运算；默认取决于 gamma_only。', null, null,
    { abacusCategory: 'Exact Exchange (LCAO)' }),
  exx_singularity_correction: K('EXX', 'string',
    '库仑奇点修正方案，默认 default。', null, null,
    { abacusCategory: 'Exact Exchange (LCAO)' }),

  // ---- DFT+U ---------------------------------------------------------------
  dft_plus_u: K('DFT+U', 'flag',
    '是否启用 DFT+U 修正（强关联电子）。', null, null, { abacusCategory: 'DFT+U correction' }),
  orbital_corr: K('DFT+U', 'string',
    '每个原子类型施加 U 的轨道角动量：-1 不修正，1 为 p，2 为 d，3 为 f。按元素顺序给出。',
    null, null, { abacusCategory: 'DFT+U correction', vector: true }),
  hubbard_u: K('DFT+U', 'string',
    '每个原子类型的 Hubbard U 值（eV）。除使用 Yukawa 势外每个元素都要给。',
    'eV', null, { abacusCategory: 'DFT+U correction', vector: true }),
  uramping: K('DFT+U', 'number',
    'U 值逐步加载：SCF 从 U=0 开始，每次重启增加 uramping，直到达到 hubbard_u。> 0.15 eV 才生效。',
    'eV', null, { abacusCategory: 'DFT+U correction' }),
  omc: K('DFT+U', 'number',
    '占据矩阵控制（occupation matrix control）的形式。', null, null,
    { abacusCategory: 'DFT+U correction' }),
  onsite_radius: K('DFT+U', 'number',
    'DFT+U 投影所用单 ζ 数值原子轨道的调整半径。', 'Bohr', null,
    { abacusCategory: 'DFT+U correction' }),
  dft_plus_dmft: K('DFT+U', 'flag',
    '是否做 DFT+DMFT 而非标准 DFT。', null, null, { abacusCategory: 'DFT+U correction' }),

  // ---- vdW -----------------------------------------------------------------
  vdw_method: K('vdW', 'enum',
    '范德华修正方法。none 不加；d2 是 Grimme DFT-D2；d3_0 与 d3_bj 是 DFT-D3 的两种阻尼。',
    null, ['none', 'd2', 'd3_0', 'd3_bj'], { abacusCategory: 'vdW correction' }),
  vdw_s6: K('vdW', 'string',
    'D2/D3 的 s6 缩放因子。不设时按 dft_functional 从内置表取（如 PBE 的 D2 用 0.75）。',
    null, null, { abacusCategory: 'vdW correction' }),
  vdw_s8: K('vdW', 'string',
    'D3(0) / D3(BJ) 的 s8 缩放因子。不设时按 dft_functional 从内置表取。',
    null, null, { abacusCategory: 'vdW correction' }),
  vdw_a1: K('vdW', 'string',
    'D3(0) / D3(BJ) 阻尼函数的 a1 参数。不设时按 dft_functional 从内置表取。',
    null, null, { abacusCategory: 'vdW correction' }),
  vdw_a2: K('vdW', 'string',
    'D3(0) / D3(BJ) 阻尼函数的 a2 参数。不设时按 dft_functional 从内置表取。',
    null, null, { abacusCategory: 'vdW correction' }),
  vdw_d: K('vdW', 'number',
    'DFT-D2 阻尼函数的阻尼速率。', null, null, { abacusCategory: 'vdW correction' }),
  vdw_abc: K('vdW', 'flag',
    'DFT-D3 是否计算三体项。', null, null, { abacusCategory: 'vdW correction' }),
  vdw_cutoff_type: K('vdW', 'enum',
    '周期性结构范德华作用的截断表达方式：radius 用半径，period 用周期数。',
    null, ['radius', 'period'], { abacusCategory: 'vdW correction' }),
  vdw_cutoff_radius: K('vdW', 'number',
    'periodic 结构范德华作用的截断半径。', null, null,
    { abacusCategory: 'vdW correction' }),
  vdw_cutoff_period: K('vdW', 'string',
    'periodic 结构范德华作用的周期数三元组。', null, null,
    { abacusCategory: 'vdW correction' }),

  // ---- DeePKS --------------------------------------------------------------
  deepks_out_labels: K('DeepKS', 'number',
    '是否输出 DeePKS 的标签与描述符（1 训练，2 生产标签）。',
    null, null, { abacusCategory: 'DeePKS' }),
  deepks_scf: K('DeepKS', 'flag',
    'DeePKS 是否做自洽迭代（把 V_delta 加进哈密顿量）。', null, null,
    { abacusCategory: 'DeePKS' }),
  deepks_model: K('DeepKS', 'string',
    '训练好的 traced 神经网络模型文件路径。', null, null, { abacusCategory: 'DeePKS' }),
  deepks_bandgap: K('DeepKS', 'number',
    '是否输出带隙标签（>0 输出）。', null, null, { abacusCategory: 'DeePKS' }),
  bessel_descriptor_lmax: K('DeepKS', 'number',
    'DeePKS 贝塞尔投影子的最大角量子数。', null, null, { abacusCategory: 'DeePKS' }),
  bessel_descriptor_ecut: K('DeepKS', 'number',
    'DeePKS 贝塞尔投影子的截断能。', 'Ry', null, { abacusCategory: 'DeePKS' }),
  bessel_descriptor_rcut: K('DeepKS', 'number',
    'DeePKS 贝塞尔投影子的截断半径。', 'Bohr', null, { abacusCategory: 'DeePKS' }),

  // ---- Output --------------------------------------------------------------
  out_level: K('Output', 'enum',
    '日志详细程度。ie 电子迭代级（默认，打印电子迭代信息）；i 几何优化级（额外打印弛豫信息）；m 分子动力学级（为简洁少打印）；e 只打印电子步。',
    null, ['ie', 'i', 'm', 'e'], { abacusCategory: 'Output information' }),
  out_chg: K('Output', 'string',
    '是否输出实空间电荷密度，可选第二参数控制精度（默认 3）。文件如 SPIN1_CHG.cube。',
    null, null, { abacusCategory: 'Output information', vector: true }),
  out_dos: K('Output', 'number',
    '是否输出态密度。', null, null, { abacusCategory: 'Output information' }),
  out_band: K('Output', 'string',
    '是否输出哈密顿量本征值（eV）：电子迭代期间写日志，计算结束写文件。可选第二参数控制精度（默认 8）。',
    null, null, { abacusCategory: 'Output information', vector: true }),
  out_proj_band: K('Output', 'flag',
    '是否输出投影能带。', null, null, { abacusCategory: 'Output information' }),
  out_stru: K('Output', 'flag',
    '是否每一步离子步都输出结构文件（到 OUT.<suffix> 下的 *_D 目录）。',
    null, null, { abacusCategory: 'Output information' }),
  out_mat_hs: K('Output', 'string',
    '是否按 k 点输出哈密顿量与重叠矩阵的上三角部分，可选第二参数控制精度。',
    null, null, { abacusCategory: 'Output information', vector: true }),
  out_mat_hs2: K('Output', 'flag',
    '是否输出实空间的 H(R) 与 S(R) 矩阵（hrs1_nao.csr / srs1_nao.csr）。',
    null, null, { abacusCategory: 'Output information' }),
  out_mat_xc: K('Output', 'flag',
    '是否在 Kohn-Sham 轨道表象下输出交换关联矩阵。', null, null,
    { abacusCategory: 'Output information' }),
  out_mat_dh: K('Output', 'flag',
    '是否输出哈密顿量对原子位置的导数 dH(R)。', null, null,
    { abacusCategory: 'Output information' }),
  out_mat_t: K('Output', 'flag',
    '是否输出动能矩阵 T(R)。', null, null, { abacusCategory: 'Output information' }),
  out_mat_tk: K('Output', 'string',
    '是否按 k 点输出动能矩阵 T(k) 的上三角部分，可选第二参数控制精度。',
    null, null, { abacusCategory: 'Output information', vector: true }),
  out_mat_r: K('Output', 'flag',
    '是否输出位置矩阵 r(R)（rr.csr）。', null, null,
    { abacusCategory: 'Output information' }),
  out_mat_ds: K('Output', 'flag',
    '是否输出重叠矩阵的导数 dS(R)。', null, null,
    { abacusCategory: 'Output information' }),
  out_mat_l: K('Output', 'string',
    '是否输出角动量算符在局域原子轨道下的期望值（Lx/Ly/Lz）。',
    null, null, { abacusCategory: 'Output information', vector: true }),
  out_wfc_lcao: K('Output', 'number',
    '是否输出 LCAO 波函数系数。0 不输出；1 文本；2 二进制。',
    null, null, { abacusCategory: 'Output information' }),
  out_elf: K('Output', 'string',
    '是否输出实空间电子局域函数（ELF），可选第二参数控制精度（默认 3）。',
    null, null, { abacusCategory: 'Output information', vector: true }),
  out_mul: K('Output', 'flag',
    '是否输出 Mulliken 布居分析到 mulliken.txt。', null, null,
    { abacusCategory: 'Output information' }),
  out_pot: K('Output', 'string',
    '输出实空间势的种类（1 总局域势，2 静电梯度等），可选第二参数控制精度。',
    null, null, { abacusCategory: 'Output information', vector: true }),
  out_app_flag: K('Output', 'flag',
    'MD / 弛豫过程中输出矩阵（r(R)、H(R)、S(R)、T(R)、dH(R)、wfc）时是追加还是覆盖。',
    null, null, { abacusCategory: 'Output information' }),
  out_freq_ion: K('Output', 'number',
    '每多少个离子步输出一次电荷密度、局域势、H/S 矩阵、密度矩阵、Mulliken 分析等。',
    null, null, { abacusCategory: 'Output information' }),
  out_freq_elec: K('Output', 'number',
    '每多少个电子步输出一次电荷密度与波函数；收敛或达到 scf_nmax 时总会输出。',
    null, null, { abacusCategory: 'Output information' }),
  out_freq_td: K('Output', 'number',
    'RT-TDDFT 中每多少个电子演化步输出一次；要与离子步同步则设为 estep_per_md。',
    null, null, { abacusCategory: 'Output information' }),
  out_alllog: K('Output', 'flag',
    '是否让每个 MPI rank 各写一份 running_<type>_<rank>.log。',
    null, null, { abacusCategory: 'Output information' }),
  out_ndigits: K('Output', 'number',
    '输出数据的小数位数（电荷密度、H 矩阵、S 矩阵等）。', null, null,
    { abacusCategory: 'Output information' }),
  out_dmk: K('Output', 'string',
    '是否按 k 点输出密度矩阵 DM(k)，可选第二参数控制精度。',
    null, null, { abacusCategory: 'Output information', vector: true }),
  out_dmr: K('Output', 'string',
    '是否输出相对晶格矢量 R 的密度矩阵 DM(R)，可选第二参数控制精度。',
    null, null, { abacusCategory: 'Output information', vector: true }),
  out_wfc_pw: K('Output', 'number',
    '是否输出平面波波函数系数。0 不输出；1 文本；2 二进制（可用 init_wfc=file 读回）。',
    null, null, { abacusCategory: 'Output information' }),
  out_ldos: K('Output', 'string',
    '是否输出局域态密度，可选第二参数控制精度（默认 3）。',
    null, null, { abacusCategory: 'Output information', vector: true }),
  out_element_info: K('Output', 'flag',
    '是否把每个元素的赝势与轨道信息输出到 OUT.<element_label>。', null, null,
    { abacusCategory: 'Output information' }),
  out_eband_terms: K('Output', 'flag',
    '是否分别输出能带能量的各项（动能、赝势、Hartree、交换关联）。', null, null,
    { abacusCategory: 'Output information' }),
  out_dipole: K('Output', 'flag',
    '是否输出电偶极矩。', null, null,
    { abacusCategory: 'RT-TDDFT: Real-Time Time-Dependent Density Functional Theory' }),
  out_current: K('Output', 'number',
    '是否输出电流：0 不输出，1 输出。', null, null,
    { abacusCategory: 'RT-TDDFT: Real-Time Time-Dependent Density Functional Theory' }),
  out_vecpot: K('Output', 'flag',
    '是否输出 TDDFT 的矢量势（原子单位）。', null, null,
    { abacusCategory: 'RT-TDDFT: Real-Time Time-Dependent Density Functional Theory' }),
  out_spillage: K('Output', 'number',
    '是否输出截断球贝塞尔函数与平面波、以及彼此之间的重叠积分（Nao 轨道生成流程用）；取 2 才输出。',
    null, null, { abacusCategory: 'Output information' }),
  dos_edelta_ev: K('Postprocess', 'number',
    '态密度输出的能量步长。', 'eV', null, { abacusCategory: 'Density of states' }),
  dos_sigma: K('Postprocess', 'number',
    '态密度的高斯展宽宽度。', 'eV', null, { abacusCategory: 'Density of states' }),
  dos_emin_ev: K('Postprocess', 'number',
    '态密度输出的能量下限。', 'eV', null, { abacusCategory: 'Density of states' }),
  dos_emax_ev: K('Postprocess', 'number',
    '态密度输出的能量上限。', 'eV', null, { abacusCategory: 'Density of states' }),
  dos_scale: K('Postprocess', 'number',
    '态密度的纵轴缩放。', null, null, { abacusCategory: 'Output information' }),

  // ---- Postprocess ---------------------------------------------------------
  berry_phase: K('Postprocess', 'flag',
    '是否计算 Berry 相位（即自发极化）。', null, null,
    { abacusCategory: 'Berry phase and wannier90 interface' }),
  gdir: K('Postprocess', 'number',
    'Berry 相位算极化时取哪一个晶格矢量方向（1/2/3 对应 a/b/c）。',
    null, null, { abacusCategory: 'Berry phase and wannier90 interface' }),
  towannier90: K('Postprocess', 'flag',
    '是否生成 Wannier90 所需文件。', null, null,
    { abacusCategory: 'Berry phase and wannier90 interface' }),
  wannier_method: K('Postprocess', 'number',
    '生成 .mmn / .amn 文件的实现方式（仅 LCAO）。', null, null,
    { abacusCategory: 'Berry phase and wannier90 interface' }),
  cal_cond: K('Postprocess', 'flag',
    '是否计算电子电导率。', null, null, { abacusCategory: 'Electronic conductivities' }),
  cond_smear: K('Postprocess', 'number',
    '电导率计算所用的展宽方法。', null, null,
    { abacusCategory: 'Electronic conductivities' }),
  cond_fwhm: K('Postprocess', 'number',
    '电导率计算的半高全宽。', null, null, { abacusCategory: 'Electronic conductivities' }),
  sc_mag_switch: K('Electronic', 'flag',
    '是否启用自旋约束 DFT（把每个原子的磁矩约束到指定值）。',
    null, null, { abacusCategory: 'Spin-Constrained DFT' }),
  nche_sto: K('Electronic', 'number',
    '随机 DFT 的 Chebyshev 展开阶数。', null, null,
    { abacusCategory: 'Electronic structure (SDFT)' }),

  // ---- Legacy names SPEC.md §1.1 lists, absent from current ABACUS ----------
  nbnd: legacy(
    '旧版能带数关键字。当前 ABACUS 参数表里没有 nbnd（源码中只作为内部变量名出现在报错信息里），写了会被当作未知关键字并**中止运行**。改用 nbands。',
    'nbands', 'Electronic', 'number',
  ),
  hubbard_alpha: legacy(
    '旧版 DFT+U 线性响应参数 α。当前 ABACUS 没有这个关键字；U 值直接由 hubbard_u 给出，或用 uramping 逐步加载。',
    'hubbard_u / uramping', 'DFT+U', 'number',
  ),
  exx_hybrid_alpha: legacy(
    '旧版精确交换比例。当前 ABACUS 拆成了 exx_fock_alpha（全距 1/r 的比例）与 exx_erfc_alpha（短程 erfc(ωr)/r 的比例）。',
    'exx_fock_alpha / exx_erfc_alpha', 'EXX', 'number',
  ),
  exx_mpi_processor: legacy(
    '旧版 EXX 专用 MPI 处理器选择。当前 ABACUS 没有这个关键字；并行由 kpar/bndpar 等统一控制。',
    'kpar / bndpar', 'EXX', 'string',
  ),
  press_thr: legacy(
    '旧版压强收敛阈值。当前 ABACUS 用 stress_thr（kbar）比较应力张量最大分量；目标外压用 press1/press2/press3。',
    'stress_thr', 'Relaxation', 'number',
  ),
  tddft: legacy(
    '不是一个 INPUT 关键字。实时含时 DFT 由 calculation=md 配合 esolver_type=tddft 开启，步数用 md_nstep、步长用 td_dt。',
    'esolver_type=tddft + calculation=md', 'RT-TDDFT', 'flag',
  ),
  td_nstep: legacy(
    '旧版 RT-TDDFT 步数关键字。当前 ABACUS 没有它；电子演化步数用 md_nstep。',
    'md_nstep', 'RT-TDDFT', 'number',
  ),
  out_interval: legacy(
    '旧版输出间隔关键字。当前 ABACUS 用 out_freq_ion（离子步间隔）与 out_freq_elec（电子步间隔）。源码里只剩一个同名的内部布尔量，不参与 INPUT 解析。',
    'out_freq_ion / out_freq_elec', 'Output', 'number',
  ),
  out_bandgap: legacy(
    '旧版带隙输出开关。当前 ABACUS 参数表里没有这个 INPUT 关键字（只在内部参数结构里留了一个开关），写了会被判为未知关键字。',
    '（无直接替代；看 running log 的 E_gap(k)）', 'Output', 'flag',
  ),
  out_zmatrix: legacy(
    '旧版 Z 矩阵输出开关。当前 ABACUS 已移除该关键字。',
    '（无替代）', 'Output', 'flag',
  ),
};

/** Canonical category order for the panel. */
const CATEGORY_ORDER = [
  'System', 'Accuracy', 'Electronic', 'Occupational', 'Mixing', 'Structural',
  'Relaxation', 'MD', 'RT-TDDFT', 'EXX', 'DFT+U', 'vdW', 'DeepKS', 'Output',
  'Device', 'Postprocess', 'Other',
];

/** Case-insensitive KEYWORD_INFO lookup. @returns {object|undefined} */
export function keywordInfo(name) {
  const exact = KEYWORD_INFO[name];
  if (exact) return exact;
  const lower = String(name ?? '').toLowerCase();
  if (KEYWORD_INFO[lower]) return KEYWORD_INFO[lower];
  for (const candidate of Object.keys(KEYWORD_INFO)) {
    if (candidate.toLowerCase() === lower) return KEYWORD_INFO[candidate];
  }
  return undefined;
}

/** True when `value` is one of an enum keyword's documented values. */
function enumOk(meta, value) {
  if (!meta || meta.type !== 'enum' || !meta.values || value === '') return undefined;
  return meta.values.some((v) => String(v).toLowerCase() === String(value).trim().toLowerCase());
}

/**
 * Group the parsed parameters for display, flagging unknown keys.
 *
 * @param {Record<string,string>} params
 * @returns {{
 *   groups: Array<{ category:string, items:Array<{
 *     key:string, value:string, known:boolean, unit?:string, doc?:string,
 *     enumOk?:boolean, legacy?:boolean, replacedBy?:string }> }>,
 *   unknownKeys: string[]
 * }}
 */
export function summarizeParams(params) {
  const groups = new Map();
  const unknownKeys = [];

  const keys = Object.keys(params ?? {});
  for (const key of keys) {
    const meta = keywordInfo(key);
    if (!meta) unknownKeys.push(key);
    const category = meta ? meta.category : 'Other';
    if (!groups.has(category)) groups.set(category, []);
    const value = params[key];
    const ok = enumOk(meta, value);
    groups.get(category).push({
      key,
      value,
      known: Boolean(meta),
      ...(meta?.unit ? { unit: meta.unit } : {}),
      ...(meta?.doc ? { doc: meta.doc } : {}),
      ...(ok === undefined ? {} : { enumOk: ok }),
      ...(meta?.legacy ? { legacy: true } : {}),
      ...(meta?.replacedBy ? { replacedBy: meta.replacedBy } : {}),
    });
  }

  const ordered = [...groups.entries()]
    .map(([category, items]) => ({ category, items }))
    .sort((a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a.category);
      const bi = CATEGORY_ORDER.indexOf(b.category);
      return (ai < 0 ? CATEGORY_ORDER.length : ai) - (bi < 0 ? CATEGORY_ORDER.length : bi);
    });

  return { groups: ordered, unknownKeys };
}

/**
 * Where the effective k-mesh actually comes from.
 *
 * `klist.cpp` `read_kpoints` shows the precedence: `gamma_only` and `kspacing > 0` both
 * make ABACUS **rewrite** the KPT file before reading it, so a KPT file found on disk is
 * only authoritative when neither is set. `kspacing` is a 1-or-3 value vector, so the first
 * component is the one that gates the branch.
 *
 * @returns {{ source:'KPT'|'kspacing'|'gamma_only', kspacing:number|null, note:string }}
 */
export function kMeshSource(params) {
  if (getFlag(params, 'gamma_only') === true) {
    return {
      source: 'gamma_only',
      kspacing: null,
      note: 'gamma_only 已设置：ABACUS 会把 KPT 重写为 Gamma 1×1×1，磁盘上的 KPT 不再代表实际网格。',
    };
  }
  const kspacing = getNumber(params, 'kspacing');
  if (kspacing !== null && kspacing > 0) {
    return {
      source: 'kspacing',
      kspacing,
      note: `kspacing=${kspacing} > 0：ABACUS 按间距生成网格并重写 KPT，磁盘上的 KPT 内容不代表实际网格。`,
    };
  }
  return { source: 'KPT', kspacing: null, note: '使用 KPT 文件给出的 k 网格。' };
}

export { CATEGORY_ORDER };
