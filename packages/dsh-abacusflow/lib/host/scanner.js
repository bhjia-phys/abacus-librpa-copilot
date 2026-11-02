/**
 * Project discovery for ABACUS and LibRPA calculation directories.
 *
 * The scanner reports observable filesystem facts only. It never decides whether a
 * calculation is scientifically sound or submittable; that judgement belongs to the
 * parsers' status classifier and, above all, to the researcher.
 *
 * Recognition (verified against the live ABACUS checkout, see SPEC.md §1):
 *   - ABACUS task  : directory containing `INPUT` (plus STRU/KPT for completeness)
 *   - LibRPA task  : directory containing `librpa.in`
 *
 * A directory holding both is reported once, as `kind: 'coupled'`, because that is
 * exactly the ABACUS -> LibRPA handoff this plugin exists to make legible.
 */
import { resolve } from 'node:path';
import { listDirAsync, safeStat, joinRel, normalizeRel, pathId, ageSeconds } from './shared/paths.js';
import { toNum } from './shared/numbers.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.vscode', 'dist', '.venv', 'venv',
  '.mypy_cache', '.pytest_cache', '.idea', 'CMakeFiles', '.cache',
]);

/** Output directories ABACUS creates; never descend into them. */
const OUTPUT_DIR_RE = /^OUT\.[^/\\]+$/i;

/**
 * Per-iteration scratch directories produced by a QSGW / PyATB driver.
 *
 * A real Si k-convergence run holds `refresh/pyatb_refresh_iter_0001 … _0009`, each with an
 * INPUT/STRU/KPT and an empty `OUT.*`. They are workflow steps, not results: listing them
 * as tasks buried the two directories that matter (`frozen`, `base_iter1`) under 26 rows of
 * noise in one run. They are reported as `step` and hidden unless the caller asks for them.
 */
const STEP_DIR_RE = /^(pyatb_refresh_iter_|refresh_iter_|iter_|step_)\d+$/i;

/** True when a directory name marks an intermediate workflow step rather than a result. */
export function isStepDir(name) {
  return STEP_DIR_RE.test(String(name ?? ''));
}

const ABACUS_INPUT = 'INPUT';
const ABACUS_STRU = 'STRU';
const ABACUS_KPT = 'KPT';
const LIBRPA_INPUT = 'librpa.in';

/**
 * Extract the OUTPUT-directory suffix from an INPUT file without a full parse.
 * `suffix` defaults to `ABACUS`, which is where ABACUS writes `OUT.ABACUS/`.
 * @param {string|null} text
 * @returns {string}
 */
export function inputSuffix(text) {
  if (!text) return 'ABACUS';
  for (const raw of String(text).split(/\r\n|\n|\r/)) {
    const line = raw.replace(/[#!].*$/, '').trim();
    if (!line) continue;
    const m = /^suffix\s+(.+)$/i.exec(line);
    if (m) {
      const value = m[1].trim().replace(/^["']|["']$/g, '');
      return value || 'ABACUS';
    }
  }
  return 'ABACUS';
}

/** Cheap peek at the first 4 KB of a file (enough for INPUT headers). */
async function peek(p, bytes = 4096) {
  const { readTextCapped } = await import('./shared/paths.js');
  const got = readTextCapped(p, bytes);
  return got ? got.text : null;
}

function entryNames(entries) {
  return new Set((entries ?? []).map((e) => e.name));
}

/**
 * Classify one directory from its entry list.
 * @returns {{ kind:'abacus'|'librpa'|'coupled', hasStru:boolean, hasKpt:boolean,
 *             hasOutput:boolean, suffix:string|null } | null}
 */
function classifyDir(names, suffix) {
  const hasAbacus = names.has(ABACUS_INPUT);
  const hasLibrpa = names.has(LIBRPA_INPUT);
  if (!hasAbacus && !hasLibrpa) return null;
  const hasOutput = suffix ? names.has(`OUT.${suffix}`) : [...names].some((n) => OUTPUT_DIR_RE.test(n));
  return {
    kind: hasAbacus && hasLibrpa ? 'coupled' : hasAbacus ? 'abacus' : 'librpa',
    hasStru: names.has(ABACUS_STRU),
    hasKpt: names.has(ABACUS_KPT),
    hasOutput,
    suffix: suffix || null,
  };
}

/** Files worth showing for a task directory, newest-first. */
function describeFiles(entries) {
  return (entries ?? []).map((e) => ({
    name: e.name,
    size: e.size,
    mtimeMs: e.mtimeMs,
    isDir: e.isDir,
  }));
}

/**
 * Inspect one directory: list it, decide whether it is a task, and return its children.
 *
 * Kept as a single async unit so the caller can run many of them concurrently. On a UNC
 * path (`\\wsl$\...`, a network share) every `stat` costs a round trip, so serialising
 * these is what makes a tree scan feel slow; the work itself is tiny.
 *
 * @returns {Promise<{ location:object, entries:Array, info:object|null }>}
 */
async function inspectDir(location) {
  const entries = await listDirAsync(location.abs);
  if (entries === null) return { location, entries: [], info: null };

  const names = entryNames(entries);
  // Peek at INPUT only when the directory could be an ABACUS task.
  let suffix = null;
  if (names.has(ABACUS_INPUT)) {
    suffix = inputSuffix(await peek(resolve(location.abs, ABACUS_INPUT)));
  }
  return { location, entries, info: classifyDir(names, suffix) };
}

/**
 * Scan a project tree.
 *
 * Breadth-first by level, with each level inspected concurrently. Results are sorted
 * afterwards, so the output does not depend on completion order.
 *
 * @param {string} rootPath absolute project root
 * @param {{ maxDepth?: number, maxTasks?: number, maxDirs?: number, concurrency?: number }} [options]
 * @returns {Promise<{ rootPath:string, tasks:Array, directories:Array, counts:object,
 *                     scannedDirs:number, truncated:boolean, elapsedMs:number, error:string }>}
 */
export async function scanProject(rootPath, options = {}) {
  const started = Date.now();
  const maxDepth = clampInt(options.maxDepth, 1, 20, 4);
  const maxTasks = clampInt(options.maxTasks, 1, 5000, 500);
  const maxDirs = clampInt(options.maxDirs, 1, 200000, 20000);
  const concurrency = clampInt(options.concurrency, 1, 64, 16);
  const includeSteps = options.includeSteps === true;

  const root = resolve(String(rootPath ?? ''));
  const rootStat = safeStat(root);
  if (!rootStat || !rootStat.isDir) {
    return emptyResult(String(rootPath ?? ''), `目录不存在或不可读：${rootPath}`, started);
  }

  const tasks = [];
  const directories = [];
  let scannedDirs = 0;
  let stepCount = 0;
  let truncated = false;

  /** @type {Array<{ abs:string, rel:string, depth:number }>} */
  let level = [{ abs: root, rel: '', depth: 0 }];

  while (level.length > 0) {
    if (scannedDirs >= maxDirs || tasks.length >= maxTasks) {
      truncated = true;
      break;
    }

    // Bound this level by the remaining budget so a huge fan-out cannot overrun.
    const budget = Math.min(level.length, maxDirs - scannedDirs, Math.max(1, maxTasks - tasks.length));
    const slice = level.slice(0, budget);
    if (slice.length < level.length) truncated = true;

    const inspected = await runBounded(slice, concurrency, inspectDir);
    scannedDirs += slice.length;

    /** @type {Array<{ abs:string, rel:string, depth:number }>} */
    const next = [];

    for (const { location, entries, info } of inspected) {
      if (info) {
        const task = buildTask(location, entries, info);
        // Per-iteration scratch dirs are counted but not listed: a real Si k-convergence
        // run would otherwise show 26 `pyatb_refresh_iter_*` rows around the 2 that matter.
        if (task.isStep && !includeSteps) {
          stepCount += 1;
        } else {
          tasks.push(task);
        }
        if (task.isStep && includeSteps) {
          directories.push({
            relPath: location.rel,
            name: location.rel.split('/').pop(),
            taskCount: 1,
          });
        }
      } else if (location.depth > 0) {
        directories.push({
          relPath: location.rel,
          name: location.rel.split('/').pop(),
          taskCount: 0,
        });
      }

      if (location.depth >= maxDepth) continue;
      for (const entry of entries) {
        if (!entry.isDir) continue;
        if (SKIP_DIRS.has(entry.name)) continue;
        if (OUTPUT_DIR_RE.test(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        next.push({
          abs: resolve(location.abs, entry.name),
          rel: joinRel(location.rel, entry.name),
          depth: location.depth + 1,
        });
      }
    }

    level = next;
  }

  tasks.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const counts = { total: tasks.length, abacus: 0, librpa: 0, coupled: 0 };
  for (const t of tasks) {
    if (t.kind === 'coupled') counts.coupled += 1;
    else if (t.kind === 'librpa') counts.librpa += 1;
    else counts.abacus += 1;
  }

  return {
    rootPath: root,
    tasks,
    directories,
    counts,
    scannedDirs,
    /** Per-iteration scratch dirs recognised but hidden; surfaced so the panel can say so. */
    hiddenSteps: stepCount,
    truncated,
    elapsedMs: Date.now() - started,
    error: '',
  };
}

/**
 * Map `items` through `worker` with at most `limit` in flight, preserving order.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item:T) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function runBounded(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Scan a single directory (used when the UI opens one task by path).
 * @returns {Promise<object|null>}
 */
export async function scanSingleDir(dirPath, rootPath = dirPath) {
  const abs = resolve(String(dirPath ?? ''));
  const entries = await listDirAsync(abs);
  if (!entries) return null;
  const names = entryNames(entries);
  let suffix = null;
  if (names.has(ABACUS_INPUT)) {
    suffix = inputSuffix(await peek(resolve(abs, ABACUS_INPUT)));
  }
  const info = classifyDir(names, suffix);
  if (!info) return null;
  const rel = normalizeRel(relativeUnder(rootPath, abs));
  return buildTask({ abs, rel, depth: rel === '' ? 0 : rel.split('/').length }, entries, info);
}

function relativeUnder(rootPath, abs) {
  const root = resolve(String(rootPath ?? ''));
  const target = resolve(String(abs ?? ''));
  const normalRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalTarget = target.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalTarget === normalRoot) return '';
  if (normalTarget.startsWith(`${normalRoot}/`)) return normalTarget.slice(normalRoot.length + 1);
  return normalTarget;
}

/** Assemble the task record shown in the panel and returned by tools. */
function buildTask(location, entries, info) {
  const rel = normalizeRel(location.rel);
  const files = describeFiles(entries);
  const outputDir = info.suffix ? `OUT.${info.suffix}` : findOutputDir(files);
  const outputStat = outputDir ? files.find((f) => f.name === outputDir) : null;

  const newest = files.reduce((acc, f) => Math.max(acc, f.mtimeMs || 0), 0);
  const evidence = [];
  if (info.kind !== 'librpa') {
    evidence.push(`INPUT${info.hasStru ? ' + STRU' : ''}${info.hasKpt ? ' + KPT' : ''}`);
    if (!info.hasStru) evidence.push('缺少 STRU');
    if (!info.hasKpt) evidence.push('无 KPT（可能用 kspacing）');
  }
  if (info.kind !== 'abacus') evidence.push(LIBRPA_INPUT);
  if (outputDir) evidence.push(outputDir);

  // A per-iteration scratch directory is recognised but marked as a step, so the panel can
  // hide it by default while still being able to show it on request.
  const step = isStepDir(rel === '' ? '' : rel.split('/').pop());

  // Band availability, decided from the listing already in hand. The panel uses it to mark
  // rows worth opening on 能带 and to offer channels for a comparison; asking per task later
  // would mean another round trip per row on a UNC path.
  const bandInfo = detectBands(files);

  return {
    id: pathId(info.kind === 'librpa' ? 'librpa' : 'abacus', rel),
    relPath: rel,
    absPath: location.abs,
    name: rel === '' ? location.abs.split(/[\\/]/).filter(Boolean).pop() || location.abs : rel.split('/').pop(),
    kind: info.kind,
    isStep: step,
    depth: location.depth,
    hasStru: info.hasStru,
    hasKpt: info.hasKpt,
    hasBands: bandInfo.hasBands,
    bandKinds: bandInfo.kinds,
    likelyBands: bandInfo.hasBands || bandInfo.mayHaveBandsInOutDir,
    outputDir: outputDir ?? null,
    outputMtimeMs: outputStat ? outputStat.mtimeMs : null,
    mtimeMs: newest,
    ageSeconds: ageSeconds(newest),
    files,
    evidence,
  };
}

/** ABACUS band-file names (flat beside INPUT, or inside OUT.<suffix>). */
const ABACUS_BAND_FILES = new Set(['band.txt', 'bands1.txt', 'bands2.txt']);
/** LibRPA per-iteration band files. */
const LIBRPA_BAND_RE = /^(KS|EXX|QSGW)_band_spin_\d+(_\d+)?\.dat$/i;

/**
 * Which kinds of band data a task directory holds.
 *
 * A task can hold both: `frozen` in the Si runs has an ABACUS stage *and* the QSGW
 * `KS/EXX/QSGW_band_spin_*.dat` — that combination is exactly what the panel wants to plot
 * together, so both kinds are reported instead of stopping at the first match.
 *
 * **ABACUS writes band files inside `OUT.<suffix>/`**, which the top-level listing shows
 * only as a directory. Checking just the top level reported "no bands" for every plain
 * ABACUS band run (NiO `03_bands`, Bi2Se3 `band_full`) — the panel then offered nothing to
 * plot even though the data was right there. So an `OUT.*` present without top-level band
 * files counts as `likely`, and the reader resolves the file itself.
 *
 * @param {Array<{name:string,isDir:boolean}>} files
 * @returns {{ hasBands:boolean, kinds:string[], mayHaveBandsInOutDir:boolean }}
 */
export function detectBands(files) {
  const kinds = new Set();
  for (const file of files ?? []) {
    if (file.isDir) continue;
    if (ABACUS_BAND_FILES.has(file.name)) kinds.add('abacus');
    else if (LIBRPA_BAND_RE.test(file.name)) kinds.add('librpa');
  }
  const hasOutDir = (files ?? []).some((f) => f.isDir && OUTPUT_DIR_RE.test(f.name));
  return {
    hasBands: kinds.size > 0,
    kinds: [...kinds],
    mayHaveBandsInOutDir: hasOutDir && kinds.size === 0,
  };
}

function findOutputDir(files) {
  const hit = files.find((f) => f.isDir && OUTPUT_DIR_RE.test(f.name));
  return hit ? hit.name : null;
}

function clampInt(value, min, max, fallback) {
  const n = toNum(value);
  if (n === null) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function emptyResult(rootPath, error, started) {
  return {
    rootPath,
    tasks: [],
    directories: [],
    counts: { total: 0, abacus: 0, librpa: 0, coupled: 0 },
    scannedDirs: 0,
    truncated: false,
    elapsedMs: Date.now() - started,
    error,
  };
}

export const SCANNER_CONSTANTS = {
  SKIP_DIRS,
  OUTPUT_DIR_RE,
  ABACUS_INPUT,
  ABACUS_STRU,
  ABACUS_KPT,
  LIBRPA_INPUT,
};
