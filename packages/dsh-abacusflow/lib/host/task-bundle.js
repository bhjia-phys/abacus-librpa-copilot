/**
 * Assemble everything known about one task in a single object.
 *
 * This is the single read path shared by the HTTP routes and the agent tools, so the
 * panel and the model can never disagree about a number.
 *
 * Every parser is called defensively: one broken file must not degrade the rest of the
 * bundle. Failures are reported per section in `notes`.
 */
import { resolve } from 'node:path';
import { statSync, openSync, readSync, closeSync } from 'node:fs';
import { listDir, readTextCapped, readAllText, safeStat, ageSeconds, joinRel } from './shared/paths.js';
import { parseAbacusInput, summarizeParams, getParam, kMeshSource } from './abacus/input-params.js';
import { parseStru, cellVolume, applyLatname } from './abacus/stru.js';
import { struToScene } from './abacus/stru-scene.js';
import { parseKpt } from './abacus/kpt.js';
import { parseInputInfo } from './abacus/input-info.js';
import { parseScfLog, classifyAbacusRun } from './abacus/log.js';
import { parseLibrpaIn, summarizeLibrpaParams } from './librpa/input.js';
import { parseLibrpaLog, parseQsgwEigenvalues, parseQsgwIterations, classifyLibrpaRun } from './librpa/output.js';
import { parseEnergyQp, parseBandSpin } from './librpa/energy-qp.js';

/** Candidate main-log names, in the order ABACUS would use. */
const LOG_CANDIDATES = [
  'running_scf.log',
  'running_relax.log',
  'running_cell-relax.log',
  'running_md.log',
  'running_nscf.log',
  'running_tddft.log',
  'running_dftu.log',
  'running_sdft.log',
];

/** Maximum bytes we will read from a single text file. */
const MAX_TEXT_BYTES = 24 * 1024 * 1024;

function guard(fn, fallback, notes, label) {
  try {
    return fn();
  } catch (error) {
    notes.push(`${label} 解析失败：${error && error.message ? error.message : String(error)}`);
    return fallback;
  }
}

/**
 * Cheap status probe for the task LIST: read only what classification needs.
 *
 * Building a full bundle parses every input file, the structure and the whole log, which
 * on a network/UNC path is dominated by round trips — doing that for every task just to
 * colour a row in the tree made a 17-task scan take 20+ seconds. The list only needs the
 * status, so this reads the tail of the main log and nothing else.
 *
 * The full bundle is still what the detail panes and the agent tools use, so the two can
 * never disagree about the *status*: both go through the same classifier.
 *
 * @param {object} task scanner task
 * @returns {{ code:string, label:string, reason:string, evidence:string[] }}
 */
export function probeTaskStatus(task) {
  try {
    if (task.kind === 'abacus' || task.kind === 'coupled') {
      const base = task.absPath;
      const suffix = task.outputDir ? task.outputDir.replace(/^OUT\./, '') : 'ABACUS';
      const outDir = resolve(base, `OUT.${suffix}`);
      if (!safeStat(outDir)) {
        return { code: 'NO_OUTPUT', label: '未开始', reason: `没有 OUT.${suffix} 输出目录`, evidence: [] };
      }
      const logName = LOG_CANDIDATES.find((name) => safeStat(resolve(outDir, name)));
      if (!logName) {
        return {
          code: 'NO_OUTPUT',
          label: '未开始',
          reason: `输出目录内没有可读的主日志`,
          evidence: [`OUT.${suffix}`],
        };
      }
      const logPath = resolve(outDir, logName);
      // Classification needs the verdicts, the terminator and any fatal banner. Those can
      // sit anywhere, but a finished run's terminator is at the end and an abort banner is
      // near the end; reading a bounded window keeps the list fast without guessing.
      const head = readTextCapped(logPath, 256 * 1024);
      const tail = readTail(logPath, 512 * 1024);
      const text = `${head ? head.text : ''}\n${tail}`;
      const stat = safeStat(logPath);
      return classifyAbacusRun({
        hasOutputDir: true,
        logText: text,
        logFileName: logName,
        mtimeAgeSeconds: ageSeconds(stat ? stat.mtimeMs : null),
      });
    }

    if (task.kind === 'librpa') {
      const base = task.absPath;
      const logPath = resolve(base, 'librpa.out');
      const stat = safeStat(logPath);
      if (!stat) {
        return { code: 'NO_OUTPUT', label: '未开始', reason: '没有 librpa.out', evidence: [] };
      }
      const tail = readTail(logPath, 512 * 1024);
      const exitRaw = readTextCapped(resolve(base, 'librpa.exitcode'), 4096);
      const exitcode = exitRaw ? Number(exitRaw.text.trim()) : null;
      return classifyLibrpaRun({
        hasOutput: true,
        logText: tail,
        exitcode: Number.isFinite(exitcode) ? exitcode : null,
        mtimeAgeSeconds: ageSeconds(stat.mtimeMs),
      });
    }
  } catch (error) {
    return {
      code: 'UNKNOWN',
      label: '未知',
      reason: `状态探测失败：${error && error.message ? error.message : String(error)}`,
      evidence: [],
    };
  }
  return { code: 'NO_OUTPUT', label: '未开始', reason: '无法识别的任务类型', evidence: [] };
}

/** Read the last `bytes` of a file as text, or '' when unreadable. */
function readTail(path, bytes) {
  try {
    const st = statSync(path);
    const start = Math.max(0, st.size - bytes);
    const length = st.size - start;
    if (length <= 0) return '';
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, start);
      return buffer.toString('utf8', 0, read);
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Build the full bundle for a task record produced by the scanner.
 *
 * @param {object} task scanner task
 * @param {{ includeScene?: boolean, fileLimit?: number }} [options]
 * @returns {object}
 */
export function buildTaskBundle(task, options = {}) {
  const includeScene = options.includeScene !== false;
  const notes = [];
  // Names and entry types come from the directory enumeration only. File sizes are NOT
  // collected here: a task directory can hold thousands of files and each `stat` is a
  // network round trip on a UNC path (one real `OUT.*` folder here has 1473 files, which
  // cost 30 s to stat individually). `size` stays `null` — meaning "not asked for", which
  // the file browser resolves on demand through `/file-size`.
  const files = listDir(task.absPath) ?? [];
  const fileList = files.map((f) => ({
    name: f.name,
    size: f.size,
    mtimeMs: f.mtimeMs,
    isDir: f.isDir,
  }));

  const bundle = {
    task: {
      id: task.id,
      relPath: task.relPath,
      absPath: task.absPath,
      name: task.name,
      kind: task.kind,
      outputDir: task.outputDir,
      mtimeMs: task.mtimeMs,
      evidence: task.evidence ?? [],
    },
    abacus: null,
    librpa: null,
    files: fileList,
    structureScene: null,
    status: null,
    notes,
    error: '',
  };

  if (task.kind === 'abacus' || task.kind === 'coupled') {
    bundle.abacus = guard(() => readAbacus(task, notes), null, notes, 'ABACUS');
  }
  if (task.kind === 'librpa' || task.kind === 'coupled') {
    bundle.librpa = guard(() => readLibrpa(task, notes), null, notes, 'LibRPA');
  }

  // Status preference: an ABACUS run status if there is an ABACUS half, else LibRPA.
  bundle.status = bundle.abacus?.status ?? bundle.librpa?.status ?? {
    code: 'NO_OUTPUT',
    label: '未开始',
    reason: '没有找到可解析的输出文件',
    evidence: [],
  };

  if (includeScene && bundle.abacus?.stru) {
    bundle.structureScene = guard(
      () => struToScene(bundle.abacus.stru, { includeConnectivity: true, bondAlgorithm: 'crystal-nn' }),
      null,
      notes,
      '结构场景',
    );
  }

  return bundle;
}

/** Read the ABACUS half of a task. */
function readAbacus(task, notes) {
  const base = task.absPath;

  const inputRaw = readTextCapped(resolve(base, 'INPUT'), MAX_TEXT_BYTES);
  const input = parseAbacusInput(inputRaw?.text ?? '');
  const suffix = effectiveSuffix(input, task.outputDir);
  const outDir = resolve(base, `OUT.${suffix}`);
  const outDirStat = safeStat(outDir);

  const struRaw = readTextCapped(resolve(base, 'STRU'), MAX_TEXT_BYTES);
  let stru = struRaw ? parseStru(struRaw.text) : null;
  if (!struRaw) notes.push('缺少 STRU，无法解析结构');
  // A STRU with `latname` in INPUT carries no LATTICE_VECTORS; rebuild the cell now that
  // INPUT is parsed, otherwise the structure panel would silently lose the lattice.
  if (stru) {
    const latname = getParam(input.params, 'latname');
    if (latname) applyLatname(stru, latname);
  }

  const kptRaw = readTextCapped(resolve(base, 'KPT'), 1024 * 1024);
  const kpt = kptRaw ? parseKpt(kptRaw.text) : null;

  const infoRaw = readTextCapped(resolve(outDir, 'INPUT.info'), MAX_TEXT_BYTES);
  const inputInfo = infoRaw ? parseInputInfo(infoRaw.text) : null;

  const logName = LOG_CANDIDATES.find((name) => safeStat(resolve(outDir, name)));
  const logRaw = logName ? readTextCapped(resolve(outDir, logName), MAX_TEXT_BYTES) : null;
  const log = logRaw ? parseScfLog(logRaw.text) : null;

  const warningRaw = readTextCapped(resolve(outDir, 'warning.log'), 2 * 1024 * 1024);
  const logStat = logName ? safeStat(resolve(outDir, logName)) : null;

  const status = classifyAbacusRun({
    hasOutputDir: Boolean(outDirStat),
    logText: logRaw ? logRaw.text : null,
    logFileName: logName ?? null,
    mtimeAgeSeconds: ageSeconds(logStat ? logStat.mtimeMs : null),
  });

  // A run that converged electronically but whose log is truncated is still not finished.
  const kMesh = kMeshSource(input.params);
  const latticeConstant = stru ? stru.latticeConstant : null;

  return {
    suffix,
    outputDir: outDirStat ? `OUT.${suffix}` : null,
    calculation: input.params.calculation ?? log?.calculation ?? null,
    basisType: input.params.basis_type ?? inputInfo?.params.basis_type ?? null,
    input,
    paramsSummary: guard(() => summarizeParams(input.params), { groups: [], unknownKeys: [] }, notes, 'INPUT 参数'),
    effectiveParams: inputInfo?.params ?? null,
    kpt,
    kspacing: kMesh.kspacing,
    kMeshSource: kMesh,
    latname: getParam(input.params, 'latname') ?? null,
    stru,
    cellVolumeAngstrom3: stru ? cellVolume(stru) : null,
    latticeConstant,
    log,
    logFile: logName ?? null,
    logTruncated: Boolean(logRaw?.truncated),
    warnings: warningRaw ? warningRaw.text.split(/\r\n|\n|\r/).filter((l) => l.trim()).slice(0, 200) : [],
    status,
    versions: extractAbacusVersion(logRaw?.text ?? inputRaw?.text ?? ''),
  };
}

function effectiveSuffix(input, scanOutputDir) {
  const fromInput = input?.params?.suffix;
  if (fromInput) return fromInput;
  if (scanOutputDir) {
    const m = /^OUT\.(.+)$/.exec(scanOutputDir);
    if (m) return m[1];
  }
  return 'ABACUS';
}

/** Pull `ABACUS v3.9.0.25` / `Commit: dd4216653` out of the log or INPUT banner. */
function extractAbacusVersion(text) {
  if (!text) return null;
  const v = /ABACUS\s+v([0-9][^\s]*)/.exec(text);
  const c = /Commit:\s*([0-9a-f]{7,40})/i.exec(text);
  if (!v && !c) return null;
  return { version: v ? v[1] : null, commit: c ? c[1] : null };
}

/** Read the LibRPA half of a task. */
function readLibrpa(task, notes) {
  const base = task.absPath;
  const inputRaw = readTextCapped(resolve(base, 'librpa.in'), 1024 * 1024);
  if (!inputRaw) {
    notes.push('缺少 librpa.in');
    return null;
  }
  const input = parseLibrpaIn(inputRaw.text);

  const outDirRel = input.params.output_dir ? input.params.output_dir.replace(/^\.\//, '').replace(/\/+$/, '') : '';
  const outDirAbs = resolve(base, outDirRel || '.');

  const logNames = ['librpa.out'];
  const extraLogs = (listDir(base) ?? [])
    .filter((f) => !f.isDir && /^librpa_para_nprocs_\d+_myid_\d+\.out$/.test(f.name))
    .map((f) => f.name)
    .slice(0, 8);
  const logName = logNames.find((n) => safeStat(resolve(base, n))) ?? null;
  const logRaw = logName ? readTextCapped(resolve(base, logName), MAX_TEXT_BYTES) : null;
  const log = logRaw ? parseLibrpaLog(logRaw.text) : null;

  const errRaw = readTextCapped(resolve(base, 'librpa.err'), 1024 * 1024);
  const exitRaw = readTextCapped(resolve(base, 'librpa.exitcode'), 4096);
  const exitcode = exitRaw ? Number(exitRaw.text.trim()) : null;
  const logStat = logName ? safeStat(resolve(base, logName)) : null;

  const eigPath = resolve(outDirAbs, 'qsgw_eigenvalues.dat');
  const iterPath = resolve(outDirAbs, 'qsgw_iterations.dat');
  const eigRaw = safeStat(eigPath) ? readTextCapped(eigPath, MAX_TEXT_BYTES) : null;
  const iterRaw = safeStat(iterPath) ? readTextCapped(iterPath, 4 * 1024 * 1024) : null;

  const eigenvalues = eigRaw ? guard(() => parseQsgwEigenvalues(eigRaw.text), null, notes, 'qsgw_eigenvalues') : null;
  const iterations = iterRaw ? guard(() => parseQsgwIterations(iterRaw.text), null, notes, 'qsgw_iterations') : null;

  const matricesStat = safeStat(resolve(outDirAbs, 'qsgw_matrices.dat'));

  // LibRPA writes to two different places, and this asymmetry is real: the driver's own
  // products (`energy_qp`, `KS/EXX/GW_band_spin_*.dat`) land in the process working
  // directory, while everything from the library (`qsgw_*.dat`, Sigma_c, W_c) lands in
  // `output_dir`. Read both and say which is which.
  const energyQpRaw = safeStat(resolve(base, 'energy_qp')) ? readTextCapped(resolve(base, 'energy_qp'), MAX_TEXT_BYTES) : null;
  const energyQp = energyQpRaw ? guard(() => parseEnergyQp(energyQpRaw.text), null, notes, 'energy_qp') : null;

  // LibRPA writes its band files next to the run *or* into `output_dir`, depending on the
  // driver version and how it was launched. Both are real: the NiO QSGW run keeps all six
  // `*_band_spin_*.dat` in `librpa.d/`, while the Si runs keep them in the task directory.
  // Scanning only `base` reported zero band files for the first case.
  const bandDirs = [base, outDirAbs].filter((dir, index, all) => all.indexOf(dir) === index);
  const bandFiles = [];
  for (const dir of bandDirs) {
    for (const f of listDir(dir) ?? []) {
      if (f.isDir) continue;
      // `QSGW` must be listed explicitly: it does not start with `GW`, so a `GW|EXX|KS`
      // alternation silently skipped every QSGW band file — the very files a QSGW run is
      // read for. `band()` is how ABACUS/LibRPA may name the same series elsewhere.
      if (!/^(QSGW|GW|EXX|KS)_band_spin_\d+(_\d+)?\.dat$/i.test(f.name)) continue;
      if (!bandFiles.includes(f.name)) bandFiles.push(f.name);
    }
  }
  const bandEnergies = {};
  for (const name of bandFiles.slice(0, 6)) {
    // The file may live in either directory; find the one that has it.
    const path = [outDirAbs, base].map((dir) => resolve(dir, name)).find((p) => safeStat(p));
    if (!path) continue;
    const raw = readTextCapped(path, MAX_TEXT_BYTES);
    if (!raw) continue;
    const parsed = guard(() => parseBandSpin(raw.text), null, notes, name);
    if (parsed) bandEnergies[name] = { nKpoint: parsed.nKpoint, nState: parsed.nState };
  }

  // What counts as "this run produced something".
  //
  // `librpa.out` is the driver's stdout; a run that was launched through a scheduler often
  // has it redirected elsewhere, and some workflows never keep it at all. `qsgw_iterations.dat`
  // and the band files are written by the run itself and are the strongest evidence it
  // produced results. NiO's QSGW run has all of them but no `librpa.out`, so judging on the
  // log alone reported "not started" for a finished calculation — and the agent tools
  // inherited that verdict.
  const hasQsgwIterations = Boolean(iterations) && (iterations.rows?.length ?? 0) > 0;
  const status = classifyLibrpaRun({
    hasOutput:
      Boolean(logName) ||
      Boolean(eigenvalues) ||
      Boolean(energyQp) ||
      hasQsgwIterations ||
      bandFiles.length > 0,
    logText: logRaw ? logRaw.text : null,
    // Without a log there is nothing to read, but that does not mean the run is still going.
    // Tell the classifier whether a log file simply was not kept, so it can report a
    // finished-but-undocumented run instead of calling it "running".
    logMissing: !logName,
    completedOutputs: [
      hasQsgwIterations ? `qsgw_iterations.dat ${iterations.rows.length} 行` : null,
      eigenvalues ? 'qsgw_eigenvalues.dat' : null,
      energyQp ? 'energy_qp' : null,
      bandFiles.length > 0 ? `${bandFiles.length} 个能带文件` : null,
    ].filter(Boolean),
    exitcode: Number.isFinite(exitcode) ? exitcode : null,
    mtimeAgeSeconds: ageSeconds(logStat ? logStat.mtimeMs : null),
  });

  return {
    input,
    paramsSummary: guard(() => summarizeLibrpaParams(input.params), { groups: [], unknownKeys: [] }, notes, 'librpa.in 参数'),
    task: input.params.task ?? null,
    outputDir: outDirRel || '.',
    logFile: logName,
    log,
    files: {
      perRankLogs: extraLogs,
      err: errRaw ? errRaw.text.slice(0, 4000) : null,
      exitcode: Number.isFinite(exitcode) ? exitcode : null,
      bandFiles,
    },
    energyQp,
    bandEnergies,
    qsgw: {
      eigenvalues,
      iterations,
      hasMatrices: Boolean(matricesStat),
      matricesBytes: matricesStat ? matricesStat.size : 0,
    },
    status,
  };
}

export { LOG_CANDIDATES, MAX_TEXT_BYTES, joinRel };
