/**
 * LibRPA output parsers.
 *
 * Four artifacts carry everything the panel needs (SPEC.md §2.3):
 *
 *   librpa.out                     main log — MPI shape, **build provenance**, resolved
 *                                  driver parameters, timing table, terminator
 *   librpa.d/qsgw_iterations.dat   one row per QSGW iteration (header-keyed columns)
 *   librpa.d/qsgw_eigenvalues.dat  long-format eigenvalues, one row per band
 *   librpa.d/qsgw_matrices.dat     huge matrix dumps — never parsed, only stat'ed by
 *                                  the caller (12 MB for a 2-atom Si cell)
 *
 * The build provenance block is the version-identification mechanism: a LibRPA number is
 * only interpretable together with the git hash, build type and library switches that
 * produced it. `Source code Git hash` is therefore always extracted.
 *
 * @module abacusflow/host/librpa/output
 */
import { toNum, toLines } from '../shared/numbers.js';

/** Retained error signatures cap. */
const MAX_ERRORS = 64;

/** Default column order of `qsgw_eigenvalues.dat`, used when the header line is absent. */
const EIGENVALUE_COLUMNS = ['iter', 'channel', 'spin', 'kpoint', 'kx', 'ky', 'kz', 'band', 'energy_eV'];

/** Default column order of `qsgw_iterations.dat`, used when the header line is absent. */
const ITERATION_COLUMNS = [
  'iter',
  'max_delta_eV',
  'residual_l2_Ha',
  'residual_max_Ha',
  'efermi_eV',
  'gap_eV',
  'electron_count',
  'requested_mode',
  'applied_mode',
  'beta',
  'fallback',
  'rcond',
  'coefficient_l1',
  'coefficient_count',
  'converged',
  'coefficients',
  'fallback_reason',
];

/** Identifiers that only ever appear in a column-header comment line. */
const COLUMN_MARKERS = new Set([
  'iter', 'channel', 'spin', 'kpoint', 'band', 'energy_eV', 'gap_eV', 'converged',
  'kx', 'ky', 'kz', 'max_delta_eV', 'efermi_eV', 'components', 'real_value',
]);

const RE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Read the leading `# ...` preamble shared by the `.dat` files.
 *
 * Two kinds of comment line occur:
 *   - `# key value ...`       header metadata (values may contain spaces),
 *   - `# a b c d ...`         the column names, all bare identifiers.
 *
 * @param {string[]} lines
 * @returns {{ header: Record<string,string>, headerLines: string[],
 *             columns: string[]|null, dataStart: number }}
 */
function readPreamble(lines) {
  const header = Object.create(null);
  const headerLines = [];
  let columns = null;
  let dataStart = lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === '') {
      dataStart = i + 1;
      continue;
    }
    if (!trimmed.startsWith('#')) {
      dataStart = i;
      break;
    }
    headerLines.push(trimmed);
    const body = trimmed.replace(/^#\s*/, '').trim();
    if (body === '') continue;

    const tokens = body.split(/\s+/);
    const looksLikeColumns =
      tokens.length > 2 &&
      tokens.every((t) => RE_IDENTIFIER.test(t)) &&
      tokens.some((t) => COLUMN_MARKERS.has(t));
    if (looksLikeColumns) {
      columns = tokens;
      continue;
    }
    const space = body.search(/\s/);
    if (space < 0) header[body] = '';
    else header[body.slice(0, space)] = body.slice(space + 1).trim();
  }

  return { header, headerLines, columns, dataStart };
}

/**
 * Yield the tokenised data lines starting at `start`, skipping blanks and comments.
 * @returns {string[][]}
 */
function tokenRows(lines, start) {
  const rows = [];
  for (let i = start; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    rows.push(trimmed.split(/\s+/));
  }
  return rows;
}

/** Numbers where parseable, the original string otherwise (`none`, `fallback`, ...). */
function coerceCell(token) {
  const n = toNum(token);
  return n === null ? token : n;
}

/** `converged` may be 0/1, true/false, yes/no. */
function isConvergedCell(value) {
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'true' || v === 'yes' || v === '1' || v === 'converged';
  }
  return false;
}

/**
 * Parse `qsgw_eigenvalues.dat`.
 *
 * Layout (verified on a real QSGW run):
 * ```
 * # qsgw_contract_version 6
 * ...
 * # iter channel spin kpoint kx ky kz band energy_eV
 * 0 0 0 0 0.0000e+00 0.0000e+00 0.0000e+00 0 -1.79077515426670539e+03
 * ```
 *
 * @param {string} text
 * @returns {{
 *   header: Record<string,string>, headerLines: string[], columns: string[],
 *   rows: Array<{ iter:number, channel:number, spin:number, kpoint:number,
 *                 k:number[], band:number, energyEv:number }>,
 *   nIter:number, nBand:number, nKpoint:number, nSpin:number,
 *   minEnergyEv:number|null, maxEnergyEv:number|null, warnings:string[]
 * }}
 */
export function parseQsgwEigenvalues(text) {
  const warnings = [];
  const lines = toLines(text);
  const { header, headerLines, columns, dataStart } = readPreamble(lines);

  const cols = columns ?? EIGENVALUE_COLUMNS;
  // Column positions are resolved by name so a reordered/extended header still works.
  const idx = (name, fallback) => {
    const found = cols.indexOf(name);
    return found >= 0 ? found : fallback;
  };
  const iIter = idx('iter', 0);
  const iChannel = idx('channel', 1);
  const iSpin = idx('spin', 2);
  const iKpoint = idx('kpoint', 3);
  const iKx = idx('kx', 4);
  const iKy = idx('ky', 5);
  const iKz = idx('kz', 6);
  const iBand = idx('band', 7);
  const iEnergy = idx('energy_eV', cols.length - 1);

  const rows = [];
  let skipped = 0;
  for (const tokens of tokenRows(lines, dataStart)) {
    const take = (position) => (position < tokens.length ? toNum(tokens[position]) : null);
    const iter = take(iIter);
    const channel = take(iChannel);
    const spin = take(iSpin);
    const kpoint = take(iKpoint);
    const kx = take(iKx);
    const ky = take(iKy);
    const kz = take(iKz);
    const band = take(iBand);
    const energyEv = take(iEnergy);
    if (
      iter === null || channel === null || spin === null || kpoint === null ||
      kx === null || ky === null || kz === null || band === null || energyEv === null
    ) {
      skipped += 1;
      continue;
    }
    rows.push({
      iter: Math.trunc(iter),
      channel: Math.trunc(channel),
      spin: Math.trunc(spin),
      kpoint: Math.trunc(kpoint),
      k: [kx, ky, kz],
      band: Math.trunc(band),
      energyEv,
    });
  }

  if (skipped > 0) warnings.push(`${skipped} 行无法解析，已跳过`);
  if (rows.length === 0) warnings.push('qsgw_eigenvalues.dat 中没有数据行');

  const iters = new Set();
  const bands = new Set();
  const kpoints = new Set();
  const spins = new Set();
  let minEnergyEv = null;
  let maxEnergyEv = null;
  for (const row of rows) {
    iters.add(row.iter);
    bands.add(row.band);
    kpoints.add(row.kpoint);
    spins.add(row.spin);
    if (minEnergyEv === null || row.energyEv < minEnergyEv) minEnergyEv = row.energyEv;
    if (maxEnergyEv === null || row.energyEv > maxEnergyEv) maxEnergyEv = row.energyEv;
  }

  return {
    header,
    headerLines,
    columns: cols,
    rows,
    nIter: iters.size,
    nBand: bands.size,
    nKpoint: kpoints.size,
    nSpin: spins.size,
    minEnergyEv,
    maxEnergyEv,
    warnings,
  };
}

/**
 * Parse `qsgw_iterations.dat`.
 *
 * The header line names every column, and that column set has grown between LibRPA
 * versions (the real run has 17 columns ending in `coefficients fallback_reason`), so
 * rows are keyed by header name rather than by position. Cells become numbers wherever
 * they parse and stay strings otherwise (`none`, a fallback label, ...).
 *
 * @param {string} text
 * @returns {{
 *   header: Record<string,string>,
 *   columns: string[],
 *   rows: Array<Record<string, number|string|null>>,
 *   convergedIter: number|null,
 *   warnings: string[]
 * }}
 */
export function parseQsgwIterations(text) {
  const warnings = [];
  const lines = toLines(text);
  const { header, columns, dataStart } = readPreamble(lines);
  const cols = columns ?? ITERATION_COLUMNS;

  const rows = [];
  let skipped = 0;
  for (const tokens of tokenRows(lines, dataStart)) {
    // Trailing columns may be omitted by an older writer; missing cells become null.
    if (tokens.length > cols.length) {
      skipped += 1;
      continue;
    }
    const row = Object.create(null);
    for (let i = 0; i < cols.length; i += 1) {
      row[cols[i]] = i < tokens.length ? coerceCell(tokens[i]) : null;
    }
    if (typeof row.iter !== 'number') {
      skipped += 1;
      continue;
    }
    rows.push(row);
  }

  if (skipped > 0) warnings.push(`${skipped} 行无法解析，已跳过`);
  if (rows.length === 0) warnings.push('qsgw_iterations.dat 中没有数据行');

  let convergedIter = null;
  for (const row of rows) {
    if (isConvergedCell(row.converged)) {
      convergedIter = typeof row.iter === 'number' ? row.iter : null;
      break;
    }
  }

  return {
    header,
    columns: cols,
    rows,
    convergedIter,
    warnings,
  };
}

/** Error signatures worth reporting from a LibRPA log. */
const LIBRPA_SIGNATURES = [
  { code: 'ABORT', re: /\bAbort\(|\bMPI_Abort|Segmentation fault|forrtl:\s*(?:severe|error)/i, message: '进程异常终止' },
  { code: 'RUNTIME_ERROR', re: /terminate called after throwing|LIBRPA_RUNTIME_ERROR|std::runtime_error/i, message: '运行时错误' },
  { code: 'FAILED', re: /^Error:\s*libRPA failed/i, message: 'LibRPA 报错退出（Error: libRPA failed）' },
  { code: 'ERROR_LINE', re: /^\|?\s*(?:Error|ERROR)\b/, message: '日志含报错行' },
];

/**
 * Parse `librpa.out`.
 *
 * Structure of a real successful run:
 * ```
 * Initialized LibRPA global environment at [2026-07-24 03:23:27.967]
 * Total number of tasks    :     1
 * Total number of nodes    :     1
 * Maximal number of threads:   1
 * LibRPA CMake build info:
 * | Build type               : Debug
 * | Source code Git hash     : 1027891ffe...
 * ===== Begin driver parameters  =====
 * task = qsgw
 * ===== End driver parameters    =====
 * ...
 * Entry                        #calls   CPU time (s)   Wall time (s)
 * Total for driver                  1        4.8426        4.8626
 * ...
 * libRPA finished successfully
 * ```
 *
 * @param {string} text
 * @returns {{
 *   mpi: { tasks:number|null, nodes:number|null, threads:number|null },
 *   build: Record<string,string>,
 *   driverParams: Record<string,string>,
 *   finished: boolean,
 *   timings: Array<{ name:string, calls:number, seconds:number, cumSeconds:number }>,
 *   errors: Array<{ code:string, message:string, evidence:string }>,
 *   startTime: string|null,
 *   endTime: string|null,
 *   qsgwProgress: Array<{ iteration:number, maxDeltaEv:number|null, gapEv:number|null,
 *                         mixer:string|null, converged:boolean, line:string }>,
 *   qsgwVerdict: { converged:boolean, message:string } | null,
 *   warnings: string[]
 * }}
 */
export function parseLibrpaLog(text) {
  const warnings = [];
  const build = Object.create(null);
  const driverParams = Object.create(null);
  const timings = [];
  const errors = [];

  const mpi = { tasks: null, nodes: null, threads: null };
  const qsgwProgress = [];
  let qsgwVerdict = null;
  let finished = false;
  let startTime = null;
  let endTime = null;
  let inBuild = false;
  let inDriver = false;
  let inTiming = false;

  const pushError = (code, message, evidence) => {
    if (errors.length >= MAX_ERRORS) return;
    const line = String(evidence ?? '').trim().slice(0, 300);
    if (errors.some((e) => e.code === code && e.evidence === line)) return;
    errors.push({ code, message, evidence: line });
  };

  const lines = toLines(text);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') continue;

    // ---- terminator (the literal last line of a successful run) ------------------
    if (trimmed === 'libRPA finished successfully') {
      finished = true;
      inTiming = false;
      continue;
    }

    // ---- start / end time --------------------------------------------------------
    if (startTime === null) {
      const t = /^Initialized LibRPA global environment at \[([^\]]+)\]/.exec(trimmed);
      if (t) {
        startTime = t[1].trim();
        continue;
      }
    }
    {
      const t = /^Finalizing LibRPA global environment at \[([^\]]+)\]/.exec(trimmed);
      if (t) {
        endTime = t[1].trim();
        continue;
      }
    }

    // ---- QSGW progress -----------------------------------------------------------
    //   `QSGW iteration 1: max_delta= 9.18152786e+01 eV gap= 7.21148065 eV mixer=none`
    //   `QSGW iteration 2: ... , converged`
    if (/^QSGW iteration\s+\d+/i.test(trimmed)) {
      const it = /^QSGW iteration\s+(\d+)\s*:\s*(.*)$/i.exec(trimmed);
      if (it) {
        const body = it[2];
        const dE = /max_delta\s*=\s*([-+0-9.eEdD]+)/i.exec(body);
        const gap = /gap\s*=\s*([-+0-9.eEdD]+)/i.exec(body);
        const mixer = /mixer\s*=\s*(\S+)/i.exec(body);
        qsgwProgress.push({
          iteration: Number(it[1]),
          maxDeltaEv: dE ? toNum(dE[1]) : null,
          gapEv: gap ? toNum(gap[1]) : null,
          mixer: mixer ? mixer[1].replace(/,$/, '') : null,
          converged: /,\s*converged\b|\bconverged\s*$/i.test(body),
          line: trimmed,
        });
      }
      continue;
    }
    if (/^QSGW reached qsgw_max_iter/i.test(trimmed)) {
      qsgwVerdict = { converged: false, message: trimmed };
      continue;
    }
    {
      const m = /^QSGW completed iterations\s*:\s*(\d+)/i.exec(trimmed);
      if (m) {
        if (qsgwVerdict === null && Number(m[1]) > 0) {
          qsgwVerdict = { converged: true, message: trimmed };
        }
        continue;
      }
    }

    // ---- MPI shape ---------------------------------------------------------------
    let m = /^Total number of tasks\s*:\s*(\d+)/i.exec(trimmed);
    if (m) {
      mpi.tasks = Number(m[1]);
      continue;
    }
    m = /^Total number of nodes\s*:\s*(\d+)/i.exec(trimmed);
    if (m) {
      mpi.nodes = Number(m[1]);
      continue;
    }
    m = /^Maximal number of threads\s*:\s*(\d+)/i.exec(trimmed);
    if (m) {
      mpi.threads = Number(m[1]);
      continue;
    }

    // ---- build provenance --------------------------------------------------------
    if (/^LibRPA CMake build info:?/i.test(trimmed)) {
      inBuild = true;
      continue;
    }
    if (inBuild) {
      if (!trimmed.startsWith('|')) {
        inBuild = false;
      } else {
        const body = trimmed.slice(1);
        const colon = body.indexOf(':');
        if (colon > 0) {
          const key = body.slice(0, colon).trim();
          // The value may legitimately be empty (`Fortran compiler flags   :`).
          const value = body.slice(colon + 1).trim();
          if (key) build[key] = value;
        }
        continue;
      }
    }

    // ---- driver parameter block --------------------------------------------------
    if (/^=+\s*Begin driver parameters/i.test(trimmed)) {
      inDriver = true;
      continue;
    }
    if (/^=+\s*End driver parameters/i.test(trimmed)) {
      inDriver = false;
      continue;
    }
    if (inDriver) {
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        if (key) driverParams[key] = value;
      }
      continue;
    }

    // ---- timing table ------------------------------------------------------------
    //   `Entry                        #calls   CPU time (s)   Wall time (s)`
    //   `CLASS_NAME NAME TIME/s CALLS AVG/s PER/%` (older/other builds)
    if (/^Entry\b.*#calls/i.test(trimmed) || /^CLASS_NAME\s+NAME/i.test(trimmed)) {
      inTiming = true;
      continue;
    }
    if (inTiming) {
      if (/^\s*-{5,}\s*$/.test(line)) continue;
      // `name  calls  cpuSeconds  wallSeconds`; names may contain spaces and digits.
      const row = /^\s*(\S.*?)\s+(\d+)\s+([\d.]+(?:[eE][-+]?\d+)?)\s+([\d.]+(?:[eE][-+]?\d+)?)\s*$/.exec(line);
      if (row) {
        const calls = toNum(row[2]);
        const cpu = toNum(row[3]);
        const wall = toNum(row[4]);
        if (calls !== null && cpu !== null && wall !== null) {
          timings.push({
            name: row[1].trim(),
            calls: Math.trunc(calls),
            seconds: cpu,
            cumSeconds: wall,
          });
          continue;
        }
      }
      inTiming = false;
      // fall through: the line may still carry an error signature
    }

    // ---- error signatures --------------------------------------------------------
    for (const sig of LIBRPA_SIGNATURES) {
      if (sig.re.test(trimmed)) {
        pushError(sig.code, sig.message, trimmed);
        break;
      }
    }
  }

  if (!finished) {
    const tail = lines.length > 0
      ? lines.slice(-1)[0].trim().slice(0, 200)
      : '';
    pushError(
      'UNFINISHED',
      '日志没有 `libRPA finished successfully` 结束标记，任务可能仍在运行或被中断',
      tail,
    );
  }

  const hardErrors = errors.filter((e) => e.code !== 'UNFINISHED');
  if (hardErrors.length === 0 && !finished) {
    warnings.push('日志没有结束标记');
  }
  if (Object.keys(build).length === 0) {
    warnings.push('没有解析到 LibRPA 构建信息块（CMake build info）');
  } else if (!build['Source code Git hash']) {
    warnings.push('构建信息块缺少 Source code Git hash，无法确定代码版本');
  }
  if (Object.keys(driverParams).length === 0) {
    warnings.push('没有解析到 driver parameters 块');
  }

  return {
    mpi,
    build,
    driverParams,
    finished,
    timings,
    errors,
    startTime,
    endTime,
    qsgwProgress,
    qsgwVerdict,
    warnings,
  };
}

/** Status labels, Chinese (CONTRACT.md §8). */
const STATUS_LABELS = Object.freeze({
  NO_OUTPUT: '未开始',
  RUNNING: '运行中',
  FINISHED: '已完成',
  // Results exist but no `librpa.out` was retained. Saying "运行中" here would be a lie, and
  // saying "已完成" would hide that the log is missing; the distinction is worth a code.
  FINISHED_NO_LOG: '已完成（无日志）',
  ERROR: '出错',
});

/**
 * Decide a LibRPA task's status.
 *
 * Rules: no `librpa.out` and no QSGW output → `NO_OUTPUT`; an error signature, or a
 * non-zero `librpa.exitcode` together with no terminator → `ERROR`; the
 * `libRPA finished successfully` terminator → `FINISHED`; otherwise `RUNNING` (a missing
 * terminator cannot distinguish "still running" from "killed", so the mtime goes into
 * `evidence` instead of changing the code).
 *
 * A non-zero exit code alone is *not* an error: this machine's real successful QSGW run
 * leaves `librpa.exitcode = 2` while its log ends with the success terminator, so the
 * terminator outranks the exit code.
 *
 * @param {{ hasOutput:boolean, logText:string|null, exitcode:number|null,
 *           mtimeAgeSeconds:number|null }} input
 * @returns {{ code:'NO_OUTPUT'|'RUNNING'|'FINISHED'|'ERROR', label:string,
 *             reason:string, evidence:string[] }}
 */
export function classifyLibrpaRun(input) {
  const source = input && typeof input === 'object' ? input : {};
  const hasOutput = source.hasOutput === true;
  const logText = typeof source.logText === 'string' ? source.logText : null;
  const exitcode =
    typeof source.exitcode === 'number' && Number.isFinite(source.exitcode) ? source.exitcode : null;
  const age =
    typeof source.mtimeAgeSeconds === 'number' && Number.isFinite(source.mtimeAgeSeconds)
      ? source.mtimeAgeSeconds
      : null;

  if (!hasOutput) {
    return {
      code: 'NO_OUTPUT',
      label: STATUS_LABELS.NO_OUTPUT,
      reason: '没有 librpa.out，也没有 QSGW 输出文件',
      evidence: [],
    };
  }

  if (logText === null || logText.trim() === '') {
    // A missing log has two different causes, and conflating them misleads the reader:
    //   - `logMissing`: results exist but no `librpa.out` was kept (scheduler redirect,
    //     cleaned directory, older driver). The honest verdict is "finished, log not
    //     retained", not "running".
    //   - otherwise: output exists but the main log is unreadable — genuinely inconclusive.
    if (source.logMissing === true) {
      const completed = Array.isArray(source.completedOutputs) ? source.completedOutputs : [];
      return {
        code: 'FINISHED_NO_LOG',
        label: STATUS_LABELS.FINISHED_NO_LOG,
        reason: '有计算产物，但没有保存 librpa.out 主日志',
        evidence: [...completed, '缺少 librpa.out（结果文件存在，说明运行已产出）'],
      };
    }
    return {
      code: 'RUNNING',
      label: STATUS_LABELS.RUNNING,
      reason: '有输出文件，但缺少可读的 librpa.out 主日志',
      evidence: ['存在输出文件', '缺少 librpa.out'],
    };
  }

  const parsed = parseLibrpaLog(logText);
  const evidence = [];
  if (parsed.mpi.tasks !== null) {
    evidence.push(`MPI 任务数 ${parsed.mpi.tasks}，节点 ${parsed.mpi.nodes ?? '?'}，线程 ${parsed.mpi.threads ?? '?'}`);
  }
  const hash = parsed.build['Source code Git hash'];
  if (hash) evidence.push(`Source code Git hash = ${hash}`);
  const buildType = parsed.build['Build type'];
  if (buildType) evidence.push(`Build type = ${buildType}`);
  if (Object.keys(parsed.driverParams).length > 0) {
    evidence.push(`driver parameters ${Object.keys(parsed.driverParams).length} 项`);
  }

  const hardErrors = parsed.errors.filter((e) => e.code !== 'UNFINISHED');
  if (hardErrors.length > 0) {
    for (const err of hardErrors.slice(0, 4)) evidence.push(`${err.code}：${err.evidence}`);
    if (exitcode !== null) evidence.push(`librpa.exitcode = ${exitcode}`);
    return {
      code: 'ERROR',
      label: STATUS_LABELS.ERROR,
      reason: `日志出现错误签名（${hardErrors.map((e) => e.code).join('、')}）`,
      evidence,
    };
  }

  if (parsed.finished) {
    evidence.push('出现 libRPA finished successfully');
    if (exitcode !== null && exitcode !== 0) {
      evidence.push(`librpa.exitcode = ${exitcode}（与成功标记不一致，需人工确认）`);
    }
    return {
      code: 'FINISHED',
      label: STATUS_LABELS.FINISHED,
      reason: '日志以 `libRPA finished successfully` 结束',
      evidence,
    };
  }

  if (exitcode !== null && exitcode !== 0) {
    evidence.push(`librpa.exitcode = ${exitcode}`);
    if (age !== null) evidence.push(`日志已 ${(age / 60).toFixed(1)} 分钟未更新`);
    return {
      code: 'ERROR',
      label: STATUS_LABELS.ERROR,
      reason: `没有成功结束标记，且 librpa.exitcode = ${exitcode}（非零）`,
      evidence,
    };
  }

  evidence.push('没有 `libRPA finished successfully` 结束标记');
  if (age === null) evidence.push('无法读取日志修改时间');
  else evidence.push(`日志 ${Math.max(0, Math.round(age))} 秒前更新`);
  return {
    code: 'RUNNING',
    label: STATUS_LABELS.RUNNING,
    reason: '日志没有结束标记；无法区分“仍在运行”与“已被终止”，需要核对调度器状态',
    evidence,
  };
}
