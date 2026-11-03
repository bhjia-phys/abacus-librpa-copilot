/**
 * dsh-abacusflow host plugin.
 *
 * Two responsibilities, mirroring VASPFlow's split:
 *
 *  1. HTTP routes under /abacusflow/api/* — the data service the browser panel reads.
 *     POST-free: every route is a GET so the panel can poll cheaply.
 *       GET /abacusflow/api/ping
 *       GET /abacusflow/api/scan?rootPath=&maxDepth=
 *       GET /abacusflow/api/task-bundle?id=
 *       GET /abacusflow/api/file?id=&name=
 *       GET /abacusflow/api/bands?id=&only=&iter=     (two-step: only=inventory, then a channel)
 *       GET /abacusflow/api/kcompare?ids=a,b&kind=QSGW&spin=1   (k-mesh series, scalars only)
 *       GET /abacusflow/api/research-context?id=     (nearest research.md, read-only)
 *
 *  2. Agent tools (abacus_* / librpa_*) registered on the host `tools` registry:
 *       abacus_scan, abacus_inspect, abacus_convergence, abacus_structure,
 *       abacus_inputs, librpa_inspect
 *
 * Both read through the same TaskStore / task-bundle code, so the panel and the model
 * see identical numbers. Nothing here decides whether a calculation is scientifically
 * correct; the tools report observable facts and keep the uncertainty explicit.
 *
 * Dependency note: a profile-installed bundle is linked into the profile's
 * node_modules, and Node resolves imports from the *real* directory, so a bare
 * specifier such as '@deepseek-ai/schemastery' would not resolve from here. This
 * module therefore imports nothing but node: builtins and its own relative files,
 * and validates `config` by hand instead of exporting a schema.
 *
 * @module abacusflow
 */
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanProject, scanSingleDir } from './host/scanner.js';
import { TaskStore } from './host/task-store.js';
import { buildTaskBundle, probeTaskStatus } from './host/task-bundle.js';
import { diagnoseStage } from './host/diagnose.js';
import { readBands, compactBands } from './host/bands.js';
import { listRemoteTasks, pullRemoteRun } from './host/remote.js';
import { buildKStudy } from './host/kstudy.js';
import { compareRuns } from './host/kconvergence.js';
import { findResearchContext } from './host/research-context.js';
import { withLocalConfig } from './host/local-config.js';
import { loadLibrary, matchTask, summarizeRecord, speciesCountsFromStru } from './host/library.js';
import { fetchAsset, listAssets, publishedBandChannel } from './host/library-assets.js';
import { readTextCapped, normalizeRel, statFilesParallel, safeStat } from './host/shared/paths.js';
import { struToScene } from './host/abacus/stru-scene.js';
import { parseStru, applyLatname } from './host/abacus/stru.js';
import { parseAbacusInput, summarizeParams } from './host/abacus/input-params.js';

export const name = 'abacusflow';
export const inject = ['tools', 'webServer'];

/** Coerce the row's `config` object, ignoring wrong types instead of throwing. */
function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const intOr = (value, fallback, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
  };
  return {
    defaultScanRoot: typeof source.defaultScanRoot === 'string' ? source.defaultScanRoot : '',
    maxDepth: intOr(source.maxDepth, 4, 1, 20),
    maxTasks: intOr(source.maxTasks, 500, 1, 5000),
    // Where a pulled remote run is written. Empty means "next to defaultScanRoot/from-remote".
    remoteLocalRoot: typeof source.remoteLocalRoot === 'string' ? source.remoteLocalRoot : '',
    // SSH alias (from ~/.ssh/config) offered in the panel's remote tab.
    remoteHost: typeof source.remoteHost === 'string' ? source.remoteHost : '',
    // Checkout of https://github.com/AroundPeking/LibRPA-database, used by the library tab.
    libraryRoot: typeof source.libraryRoot === 'string' ? source.libraryRoot : '',
    // Where fetched database figures/band curves are cached. Empty = beside libraryRoot.
    libraryAssetCacheDir: typeof source.libraryAssetCacheDir === 'string' ? source.libraryAssetCacheDir : '',
  };
}

const API_PREFIX = '/abacusflow/api';

/**
 * What this host serves beyond the first release, announced by `/ping`. The panel compares it
 * with what it needs (`HOST_FEATURES_NEEDED` in lib/client.js) and says so when the host is
 * behind, instead of failing on a missing field or route.
 *   asset-kind     `/library/assets` items carry kind/quantity/stem, and audits come apart
 *   diagnose       `/diagnose`
 *   library-band   `/library/band`
 */
const HOST_FEATURES = Object.freeze(['asset-kind', 'diagnose', 'library-band']);

/** Session workspace cwd for a tool call, matching dsh-tool-fs.sessionCwd. */
function workspaceOf(exec) {
  return exec?.agent?.session?.header?.cwd || process.cwd();
}

/** Resolve a root path argument against the session workspace. */
function resolveRoot(exec, rootPath) {
  const raw = String(rootPath ?? '').trim();
  if (!raw) return workspaceOf(exec);
  return resolve(raw);
}

/** Trim long text for a tool render. */
function clip(text, limit = 12000) {
  const s = String(text ?? '');
  return s.length <= limit ? s : `${s.slice(0, limit)}\n…（已截断 ${s.length - limit} 字符）`;
}

function textResult(text) {
  return [{ type: 'text', text: clip(text) }];
}

// ---------------------------------------------------------------------------
// shared read helpers
// ---------------------------------------------------------------------------

/**
 * Ensure a scan of `rootPath` exists, reusing the cache when fresh.
 * @returns {Promise<object>} scan result, or one with `error` set
 */
async function ensureScan(ctx, rootPath, options = {}) {
  const ttl = options.force ? 0 : (options.ttlMs ?? 45_000);
  const cached = ttl > 0 ? ctx.store.getScan(rootPath, ttl) : null;
  if (cached) return cached;
  const scan = await scanProject(rootPath, {
    maxDepth: options.maxDepth ?? ctx.config.maxDepth,
    maxTasks: ctx.config.maxTasks,
  });
  if (!scan.error) ctx.store.putScan(rootPath, scan);
  return scan;
}

/** Find one task inside a scan by relative path (tolerant of case and separators). */
function findTask(scan, relPath) {
  const want = normalizeRel(relPath);
  const tasks = scan.tasks ?? [];
  return (
    tasks.find((t) => t.relPath === want) ??
    tasks.find((t) => t.relPath.toLowerCase() === want.toLowerCase()) ??
    tasks.find((t) => t.relPath.endsWith(`/${want}`)) ??
    null
  );
}

/** Build (or read from cache) the bundle for a task. */
function bundleFor(ctx, task) {
  const stamp = TaskStore.stampFor(task);
  const cached = ctx.store.getBundle(task.id, stamp);
  if (cached) return cached;
  const bundle = buildTaskBundle(task, { includeScene: true });
  return ctx.store.putBundle(task.id, stamp, bundle);
}

/**
 * Status only, cached separately from the bundle.
 *
 * The tree needs a status for every task on every scan; the detail panes need the full
 * bundle for exactly one task. Keeping them apart is what makes a first scan fast.
 */
function statusFor(task) {
  const cached = statusCache.get(task.id);
  const stamp = TaskStore.stampFor(task);
  if (cached && cached.stamp === stamp && Date.now() - cached.at < 20_000) return cached.status;
  const status = probeTaskStatus(task);
  statusCache.set(task.id, { at: Date.now(), stamp, status });
  return status;
}

/** @type {Map<string, { at:number, stamp:string, status:object }>} */
const statusCache = new Map();

/**
 * Band-structure data for one task, with its own short cache.
 *
 * Band files are large (a real QSGW run has 72 files at ~870 KiB each) and the panel
 * re-requests them whenever the user changes the energy window, so this must not re-read
 * from disk on every keystroke. The key includes the LibRPA iteration because that is the
 * one parameter that changes which file is read.
 *
 * @param {object} ctx the tool context (needs `store`)
 * @param {object} task scanner task
 * @param {{ lrpaIteration?: number|null }} [options]
 */
function bandsFor(ctx, task, options = {}) {
  const stamp = `${TaskStore.stampFor(task)}#${options.lrpaIteration ?? 'latest'}`;
  const cached = bandsCache.get(task.id);
  if (cached && cached.stamp === stamp && Date.now() - cached.at < 60_000) return cached.data;

  // The bundle knows the resolved ABACUS `OUT.<suffix>` and LibRPA `output_dir` names, so
  // read it first rather than guessing those directory names here.
  const bundle = bundleFor(ctx, task);
  const data = readBands(task.absPath, {
    outDir: bundle.abacus?.outputDir ?? task.outputDir ?? null,
    librpaOutDir: bundle.librpa?.outputDir ?? null,
    lrpaIteration: options.lrpaIteration ?? null,
  });
  if (bandsCache.size > 12) bandsCache.clear();
  bandsCache.set(task.id, { at: Date.now(), stamp, data });
  return data;
}

/** @type {Map<string, { at:number, stamp:string, data:object }>} */
const bandsCache = new Map();

// ---------------------------------------------------------------------------
// renderers (Chinese, compact; the panel carries the visual detail)
// ---------------------------------------------------------------------------

function renderScan(value) {
  if (value.error) return textResult(`扫描失败：${value.error}`);
  const lines = [];
  lines.push(`扫描 ${value.rootPath}：${value.counts.total} 个任务（ABACUS ${value.counts.abacus}，LibRPA ${value.counts.librpa}，两者同目录 ${value.counts.coupled}），检查 ${value.scannedDirs} 个目录，用时 ${value.elapsedMs} ms。`);
  if (value.truncated) lines.push('注意：达到深度或数量上限，结果被截断。');
  const byStatus = {};
  for (const t of value.tasks) {
    const label = t.status?.label ?? '未判定';
    byStatus[label] = (byStatus[label] ?? 0) + 1;
  }
  lines.push(`状态统计：${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join('，') || '无'}`);
  for (const t of value.tasks.slice(0, 60)) {
    lines.push(`- ${t.relPath || '.'} [${kindLabel(t.kind)}] ${t.status?.label ?? '未判定'}${t.outputDir ? ` (${t.outputDir})` : ''}`);
  }
  if (value.tasks.length > 60) lines.push(`… 另有 ${value.tasks.length - 60} 个任务`);
  return textResult(lines.join('\n'));
}

function kindLabel(kind) {
  if (kind === 'coupled') return 'ABACUS+LibRPA';
  if (kind === 'librpa') return 'LibRPA';
  return 'ABACUS';
}

function renderConvergence(value) {
  if (value.error) return textResult(`读取收敛数据失败：${value.error}`);
  const lines = [];
  for (const row of value.results) {
    if (row.error) {
      lines.push(`${row.rel_path}：${row.error}`);
      continue;
    }
    const it = row.iterations ?? [];
    if (it.length === 0) {
      lines.push(`${row.rel_path}：没有 SCF 迭代记录（日志为 ${row.log_file ?? '缺失'}）`);
      continue;
    }
    const last = it[it.length - 1];
    lines.push(`${row.rel_path}：${row.ionic_steps} 个离子步，${it.length} 条 SCF 记录；末次 E_KohnSham = ${fmt(last.eKohnShamEv)}，E_Fermi = ${fmt(last.eFermiEv)}，gap = ${fmt(last.gapEv)}，Δρ = ${fmt(last.rhoDeviation)}`);
    lines.push(`  SCF 收敛：${row.scf_converged === null ? '无结论' : row.scf_converged ? '是' : '否'}；运行结束：${row.finished ? '是' : '否/未完成'}`);
    lines.push(`  能量序列（eV）：${row.energy_ev.slice(-8).map((v) => v.toFixed(6)).join(' → ')}`);
  }
  return textResult(lines.join('\n'));
}

function fmt(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(6) : '—';
}

function renderStructure(value) {
  if (value.error) return textResult(`读取结构失败：${value.error}`);
  return textResult(
    value.results
      .map((row) => (row.error
        ? `${row.rel_path}：${row.error}`
        : `${row.rel_path}：${row.formula}，${row.natom} 个原子，体积 ${typeof row.volume === 'number' ? row.volume.toFixed(3) : '—'} Å³，${row.bonds} 条成键`))
      .join('\n'),
  );
}

/** One stage's diagnosis as text: the verdict first, then the evidence it rests on. */
function renderDiagnosis(value) {
  if (value.error) return textResult(`诊断失败：${value.error}`);
  const d = value.diagnosis;
  const lines = [`【${d.stage.relPath || '.'}】${kindLabel(d.stage.kind)} · 结论：${d.verdict.text}`];
  if (d.lines.length) {
    lines.push('关键日志行：');
    for (const l of d.lines) lines.push(`  ${l.file}${l.line ? ` 第 ${l.line} 行` : ''}（${l.why}）：${l.text}`);
  }
  if (d.checks.length) {
    lines.push('输入要求 vs 输出：');
    for (const c of d.checks) lines.push(`  ${c.ok === true ? '✓' : c.ok === false ? '✗' : '?'} ${c.asked} → ${c.found}${c.note ? `（${c.note}）` : ''}`);
  }
  if (d.missing.length) {
    lines.push('缺少的文件：');
    for (const m of d.missing) lines.push(`  ${m.name}：${m.why}${m.need === 'required' ? '（必需）' : ''}`);
  }
  for (const n of d.notes) lines.push(`注：${n}`);
  return textResult(lines.join('\n'));
}

function renderInspect(value) {
  if (value.error) return textResult(`查看任务失败：${value.error}`);
  const lines = [];
  for (const row of value.results) {
    if (row.error) {
      lines.push(`${row.rel_path}：${row.error}`);
      continue;
    }
    lines.push(`【${row.rel_path || '.'}】${kindLabel(row.kind)} · ${row.status.label}`);
    lines.push(`  判据：${row.status.reason}`);
    if (row.status.evidence?.length) lines.push(`  证据：${row.status.evidence.join('；')}`);
    if (row.abacus) {
      lines.push(`  计算类型：${row.abacus.calculation ?? '未知'}；基组：${row.abacus.basisType ?? '未知'}；输出目录：${row.abacus.outputDir ?? '缺失'}`);
      if (row.abacus.stru) {
        const s = row.abacus.stru;
        // `abacus_inspect` returns species as plain labels; `task-bundle` returns objects.
        const labels = Array.isArray(s.species)
          ? s.species.map((x) => (typeof x === 'string' ? x : x.label)).join('/')
          : '—';
        const unit = s.latticeConstantUnit ?? 'Bohr';
        lines.push(`  结构：${labels}，${s.natom ?? 0} 个原子，晶格常数 ${fmt(s.latticeConstant)} ${unit}`);
      }
      if (row.abacus.kpt) {
        const k = row.abacus.kpt;
        lines.push(`  k 点：${k.mode === 'auto' ? `${k.centering ?? ''} ${(k.grid ?? []).join('×')} 网格` : `${k.nkpts ?? (k.points ?? []).length} 个显式点`}`);
      }
      if (row.abacus.log) {
        const lg = row.abacus.log;
        // `abacus_inspect` builds a summary object, so `iterations` is a count here.
        const recordCount = Array.isArray(lg.iterations) ? lg.iterations.length : (lg.iterations ?? '—');
        lines.push(`  日志：${row.abacus.logFile ?? '—'}，SCF 记录 ${recordCount} 条，SCF 收敛 ${lg.scfConverged === null ? '无结论' : lg.scfConverged ? '是' : '否'}，结束标记 ${lg.finished ? '有' : '无'}`);
        if (typeof lg.maxForce === 'number') lines.push(`  末次最大受力：${lg.maxForce.toFixed(6)} eV/Å`);
        if (Array.isArray(lg.errors) && lg.errors.length) {
          lines.push(`  错误签名：${lg.errors.map((e) => e.code).join('，')}`);
        }
      }
      if (row.abacus.warnings?.length) lines.push(`  warning.log 条目：${row.abacus.warnings.length} 条（前 3：${row.abacus.warnings.slice(0, 3).join(' | ')}）`);
    }
    if (row.librpa) {
      const l = row.librpa;
      lines.push(`  LibRPA 任务：${l.task ?? '未知'}；输出目录：${l.outputDir}`);
      if (l.log) {
        lines.push(`  LibRPA 版本：${l.log.build['Source code Git hash'] ?? '未知'}（build ${l.log.build['Build type'] ?? '未知'}），LibRI ${l.log.build['Use LibRI'] ?? '未知'}`);
        lines.push(`  结束标记：${l.log.finished ? 'libRPA finished successfully' : '未出现'}`);
      }
      if (l.qsgw?.iterations?.rows?.length) {
        const rows = l.qsgw.iterations.rows;
        const tail = rows[rows.length - 1];
        lines.push(`  QSGW 迭代 ${rows.length} 次；末次 gap ${fmt(tail.gap_eV)} eV，ΔE ${fmt(tail.max_delta_eV)} eV`);
      }
      if (l.qsgw?.eigenvalues?.rows?.length) {
        const e = l.qsgw.eigenvalues;
        lines.push(`  QSGW 本征值：${e.nIter} 次迭代 × ${e.nKpoint} k 点 × ${e.nBand} 条能带，能量范围 ${fmt(e.minEnergyEv)} – ${fmt(e.maxEnergyEv)} eV`);
      }
    }
    if (row.notes?.length) lines.push(`  备注：${row.notes.join('；')}`);
  }
  return textResult(lines.join('\n'));
}

function renderInputs(value) {
  if (value.error) return textResult(`读取输入失败：${value.error}`);
  const out = [];
  for (const row of value.results) {
    if (row.error) {
      out.push(`${row.rel_path}：${row.error}`);
      continue;
    }
    out.push(`【${row.rel_path || '.'}】${row.profile} · 已知关键字 ${row.known_count}/${row.total_count}`);
    for (const group of row.groups) {
      out.push(`  ${group.category}：${group.items.map((i) => `${i.key}=${i.value || '(flag)'}`).join('，')}`);
    }
    if (row.unknownKeys.length) out.push(`  未收录关键字：${row.unknownKeys.join('，')}`);
  }
  return textResult(out.join('\n'));
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

/**
 * @param {object} ctx Cordis context (tools + webServer injected)
 * @param {object} [rawConfig] the row's `config` from cordis.patch.yml
 */
export function apply(ctx, rawConfig) {
  // Machine-specific paths come from the git-ignored local-config.json for any key the
  // published patch leaves out (lib/host/local-config.js).
  const cfg = normalizeConfig(withLocalConfig(rawConfig));
  const store = new TaskStore();
  const toolCtx = { store, config: cfg };
  ctx.effect(() => () => store.clear(), 'abacusflow: store');

  /**
   * The LibRPA database index, loaded once per process.
   *
   * Only the metadata is read here (122 records, ~3.1 MB). Figures and band curves are fetched
   * from the upstream dataset on demand — see `libraryCacheDir`.
   */
  let libraryCache = null;
  const getLibrary = () => {
    if (libraryCache) return libraryCache;
    libraryCache = loadLibrary(cfg.libraryRoot);
    return libraryCache;
  };

  /**
   * Where fetched database assets are cached.
   *
   * Beside the metadata index when configured, else under the OS temp dir. The objects are
   * content-addressed by URL (which pins a commit), so they never go stale.
   */
  const libraryCacheDir = () => {
    const base = cfg.libraryAssetCacheDir || cfg.libraryRoot;
    if (!base) return join(tmpdir(), 'abacusflow-library-assets');
    return join(base, '.asset-cache');
  };

  const route = (path, handler) => {
    try {
      ctx.effect(() =>
        ctx.webServer.register({
          kind: 'exact',
          path,
          handler: async (req, res) => {
            const send = (status, value) => {
              res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify(value));
            };
            try {
              await handler(req, res, send);
            } catch (error) {
              send(500, { error: error && error.message ? error.message : String(error) });
            }
          },
        }),
      );
    } catch (error) {
      console.error('[abacusflow] route registration failed:', path, error);
    }
  };

  route(`${API_PREFIX}/ping`, async (req, res, send) => {
    // `features` lets the panel tell when the host is older than itself: DSH hot-reloads the
    // client bundle, but this half keeps running until DSH is fully restarted.
    send(200, { ok: true, version: '0.1.0', features: HOST_FEATURES, defaultScanRoot: cfg.defaultScanRoot });
  });

  route(`${API_PREFIX}/scan`, async (req, res, send) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const rootPath = url.searchParams.get('rootPath') || cfg.defaultScanRoot;
    if (!rootPath) return send(400, { error: '缺少 rootPath' });
    const maxDepth = url.searchParams.get('maxDepth');
    const scan = await ensureScan(toolCtx, resolve(rootPath), {
      maxDepth: maxDepth === null ? cfg.maxDepth : Number(maxDepth),
      force: url.searchParams.get('force') === '1',
    });
    if (scan.error) return send(200, { ...scan, tasks: [], directories: [] });
    // Attach status per task so the tree can colour rows without N round trips. This uses
    // the cheap probe (log tail only), not a full bundle: the list must stay fast on a
    // network path, and the detail panes still get the full parse on selection.
    const tasks = scan.tasks.map((task) => ({ ...task, status: statusFor(task) }));
    send(200, { ...scan, tasks });
  });

  route(`${API_PREFIX}/task-bundle`, async (req, res, send) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const id = url.searchParams.get('id');
    if (!id) return send(400, { error: '缺少 id' });
    const task = store.taskById(id);
    if (!task) return send(404, { error: '任务不在已扫描结果中，请先扫描' });
    send(200, bundleFor(toolCtx, task));
  });

  // Why a stage is in its state (host/diagnose.js): the decisive log lines with line numbers,
  // what the input asked for against what the output holds, absent files, a one-line verdict.
  // On demand for one stage; the same function backs the `abacus_diagnose` tool.
  route(`${API_PREFIX}/diagnose`, async (req, res, send) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const id = url.searchParams.get('id');
    if (!id) return send(400, { error: '缺少 id' });
    const task = store.taskById(id);
    if (!task) return send(404, { error: '任务不在已扫描结果中，请先扫描' });
    send(200, diagnoseStage(task, bundleFor(toolCtx, task)));
  });

  route(`${API_PREFIX}/remote/list`, async (req, res, send) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const host = url.searchParams.get('host') || cfg.remoteHost;
    const remoteRun = url.searchParams.get('run');
    if (!host || !remoteRun) return send(400, { error: '缺少 host 或 run' });
    // One SSH connection returns every task of the run; no mount and no per-entry trip.
    send(200, await listRemoteTasks(host, remoteRun));
  });

  route(`${API_PREFIX}/remote/pull`, async (req, res, send) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const host = url.searchParams.get('host') || cfg.remoteHost;
    const remoteRun = url.searchParams.get('run');
    const localRoot = url.searchParams.get('localRoot') || cfg.remoteLocalRoot;
    if (!host || !remoteRun) return send(400, { error: '缺少 host 或 run' });
    if (!localRoot) return send(400, { error: '缺少 localRoot（在插件配置里设 remoteLocalRoot，或作为参数传入）' });
    send(200, await pullRemoteRun({ host, remoteRun, localRoot }));
  });

  route(`${API_PREFIX}/file-size`, async (req, res, send) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const id = url.searchParams.get('id');
    if (!id) return send(400, { error: '缺少 id' });
    const task = store.taskById(id);
    if (!task) return send(404, { error: '任务不在已扫描结果中，请先扫描' });
    // Sizes are fetched only when the file browser asks: statting every entry of a task
    // directory during a scan is what made scanning slow on a network path.
    const stats = await statFilesParallel(task.absPath, 16);
    if (!stats) return send(404, { error: '无法读取目录' });
    const sizes = Object.create(null);
    for (const [name, value] of stats) sizes[name] = value;
    send(200, { id, sizes });
  });

  route(`${API_PREFIX}/library/search`, async (req, res, send) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const query = (url.searchParams.get('q') || '').trim();
    const library = getLibrary();
    if (!library.ok) return send(200, { ok: false, error: library.error, records: [], total: 0, formulas: [] });

    if (!query) {
      // No query: return the catalogue as summaries so the tab can list what exists.
      const all = library.records.map(summarizeRecord);
      return send(200, { ok: true, error: '', records: all.slice(0, 500), total: all.length, formulas: library.formulas });
    }

    const q = query.toLowerCase();
    const hits = library.records
      .filter((record) => {
        const hay = [record.id, record.material, record.formula, record.dimension, record.record_type]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (hay.includes(q)) return true;
        // Also match on an element symbol, so "Bi" finds Bi2Se3.
        return (record.species ?? []).some((s) => String(s.element ?? '').toLowerCase() === q);
      })
      .map(summarizeRecord);
    send(200, { ok: true, error: '', records: hits, total: hits.length, formulas: library.formulas });
  });

  route(`${API_PREFIX}/library/match`, async (req, res, send) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const id = url.searchParams.get('id');
    if (!id) return send(400, { error: '缺少 id' });
    const task = store.taskById(id);
    if (!task) return send(404, { error: '任务不存在' });

    const library = getLibrary();
    if (!library.ok) return send(200, { ok: false, error: library.error, matches: [], tried: [], exact: false });

    // The task's own STRU supplies the composition. Reading it here keeps the browser from
    // parsing STRU just to ask the database a question.
    let speciesCounts = null;
    try {
      const struPath = resolve(task.absPath, 'STRU');
      if (safeStat(struPath)) {
        const raw = readTextCapped(struPath, 8 * 1024 * 1024);
        if (raw) speciesCounts = speciesCountsFromStru(parseStru(raw.text));
      }
    } catch {
      // No STRU: the directory name still yields a candidate.
    }

    const result = matchTask({ speciesCounts, relPath: task.relPath, name: task.name }, library);
    send(200, { ok: true, error: '', ...result });
  });

  // ---- library assets: figures and band data, served on demand --------------------
  //
  // The database keeps its bulk data on Hugging Face and only 3.1 MB of metadata in Git, so
  // the panel lists what a record offers and fetches one object when the user opens it. Bytes
  // are proxied through this host rather than hot-linked, so the browser is not subject to the
  // mirror's CORS policy, the disk cache is shared, and a record cannot point the browser at
  // an arbitrary host.
  route(`${API_PREFIX}/library/assets`, async (req, res, send) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const id = url.searchParams.get('id');
    if (!id) return send(400, { error: '缺少 id' });
    const library = getLibrary();
    if (!library.ok) return send(200, { ok: false, error: library.error, figures: [], audits: [], bandData: [] });
    const record = library.records.find((r) => r.id === id);
    if (!record) return send(404, { error: `数据库里没有记录 ${id}` });
    const groups = listAssets(record);
    send(200, {
      ok: true,
      error: '',
      id: record.id,
      material: record.material,
      formula: record.formula,
      figures: groups.figures,
      audits: groups.audits,
      bandData: groups.bandData,
      counts: {
        figures: groups.figures.length,
        audits: groups.audits.length,
        bandData: groups.bandData.length,
        inputs: groups.inputs.length,
        results: groups.results.length,
        logs: groups.logs.length,
      },
    });
  });

  route(`${API_PREFIX}/library/asset`, async (req, res, send) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const target = url.searchParams.get('url');
    if (!target) return send(400, { error: '缺少 url' });
    const fetched = await fetchAsset({ cacheDir: libraryCacheDir(), url: target });
    if (!fetched.ok) return send(502, { error: fetched.error, url: target });
    // Binary response: `send` is JSON-only, so write the bytes directly.
    const contentType = fetched.contentType || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': String(fetched.bytes.length),
      'cache-control': 'public, max-age=86400',
      'x-abacusflow-cached': fetched.cached ? '1' : '0',
      // The type above is the one the panel relies on (an SVG <img> needs image/svg+xml);
      // the browser must not second-guess it.
      'x-content-type-options': 'nosniff',
      // These bytes come from a dataset, and this route shares DSH's origin. An <img> never
      // runs an SVG's scripts, but opening the URL directly would; the sandbox keeps a
      // document served from here script-free and in its own origin. (Not applied to PDFs:
      // Chrome's viewer refuses to render inside a sandboxed document.)
      ...(/^(image\/svg\+xml|application\/json|text\/)/.test(contentType)
        ? { 'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox" }
        : {}),
    });
    res.end(fetched.bytes);
  });

  // One published band table as a channel (host/library-assets.js `publishedBandChannel`):
  // parsed and measured exactly like a local LibRPA band file, so the panel's ordinary
  // alignment check decides whether it may share an axis with a local curve. Only a URL the
  // record itself lists as band data is fetched.
  route(`${API_PREFIX}/library/band`, async (req, res, send) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const id = url.searchParams.get('id');
    const target = url.searchParams.get('url');
    if (!id || !target) return send(400, { error: '缺少 id 或 url' });
    const library = getLibrary();
    if (!library.ok) return send(200, { ok: false, error: library.error });
    const record = library.records.find((r) => r.id === id);
    if (!record) return send(404, { error: `数据库里没有记录 ${id}` });
    const item = listAssets(record).bandData.find((b) => b.url && b.url === target);
    if (!item) return send(404, { error: '这条记录没有列出这个能带文件' });
    const fetched = await fetchAsset({ cacheDir: libraryCacheDir(), url: item.url });
    if (!fetched.ok) return send(502, { error: fetched.error });
    send(200, { recordId: record.id, label: item.label, ...publishedBandChannel(fetched.bytes.toString('utf8'), item) });
  });

  route(`${API_PREFIX}/kstudy`, async (req, res, send) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const path = url.searchParams.get('path');
    if (!path) return send(400, { error: '缺少 path' });
    // Reads either a live `<material>/k<mesh>` tree or the campaign's analysis snapshot.
    send(200, buildKStudy(path));
  });

  // Several scanned runs that differ only in k mesh, compared by host/kconvergence.js:
  // occupation-based band edges per run and the k-path identity check. Scalars only — the
  // panel draws the curves from /bands, so the band arrays are not sent twice.
  route(`${API_PREFIX}/kcompare`, async (req, res, send) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const ids = (url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length < 1 || ids.length > 12) return send(400, { error: '需要 1–12 个任务 id' });
    const tasks = ids.map((id) => store.taskById(id));
    const missing = ids.filter((_, i) => !tasks[i]);
    if (missing.length > 0) return send(404, { error: `任务不在已扫描结果中：${missing.join('、')}` });
    const spin = Number(url.searchParams.get('spin') ?? 1);
    const iter = url.searchParams.get('iter');
    const runs = tasks.map((task) => {
      const bundle = bundleFor(toolCtx, task);
      return {
        label: task.relPath,
        absPath: task.absPath,
        outDir: bundle.abacus?.outputDir ?? task.outputDir ?? null,
        librpaOutDir: bundle.librpa?.outputDir ?? null,
      };
    });
    const result = compareRuns(runs, {
      kind: url.searchParams.get('kind') || 'QSGW',
      spin: Number.isFinite(spin) ? spin : 1,
      iteration: iter === null || iter === '' ? null : Number(iter),
    });
    send(200, { ...result, runs: result.runs.map((r) => ({ label: r.label, nKpoint: r.nKpoint, nBand: r.nBand })) });
  });

  // The nearest research.md above a task: the only AITP link the panel can verify, because
  // AITP exposes agent tools, not a service. A few stats up the tree; read-only.
  route(`${API_PREFIX}/research-context`, async (req, res, send) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const id = url.searchParams.get('id');
    if (!id) return send(400, { error: '缺少 id' });
    const task = store.taskById(id);
    if (!task) return send(404, { error: '任务不在已扫描结果中，请先扫描' });
    send(200, findResearchContext(task.absPath));
  });

  route(`${API_PREFIX}/bands`, async (req, res, send) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const id = url.searchParams.get('id');
    if (!id) return send(400, { error: '缺少 id' });
    const task = store.taskById(id);
    if (!task) return send(404, { error: '任务不在已扫描结果中，请先扫描' });
    const iter = url.searchParams.get('iter');
    // Optional `only` filter keeps the transfer small: a full QSGW task has six 364x80
    // channels and a plot rarely needs them all at once.
    //   only=<kind>:<spin>[,<kind>:<spin>...]   just those LibRPA channels
    //   only=abacus                              the ABACUS channels
    //   only=inventory                           metadata only, no band arrays
    const only = url.searchParams.get('only');
    const allow = only ? new Set(only.split(',').map((s) => s.trim()).filter(Boolean)) : null;
    const inventoryMode = Boolean(allow && allow.has('inventory'));
    const bands = bandsFor(toolCtx, task, { lrpaIteration: iter === null ? null : Number(iter) });

    let selected = bands;
    if (allow && !inventoryMode) {
      selected = {
        ...bands,
        abacus: allow.has('abacus') ? bands.abacus : [],
        librpa: bands.librpa.filter((c) => allow.has(`${c.kind}:${c.spin}`) || allow.has(c.kind)),
      };
    }

    // The browser payload is rounded to 3 decimals: a band plot cannot resolve finer, and
    // the full-precision numbers stay available to the agent tools.
    const payload = compactBands(selected);
    if (inventoryMode) {
      // Keep every channel's identity and extent so the panel can list checkboxes, but
      // drop the band arrays — they are the entire payload size.
      for (const channel of [...payload.abacus, ...payload.librpa]) {
        channel.energies = [];
        channel.kpath = [];
      }
    }
    send(200, payload);
  });

  route(`${API_PREFIX}/file`, async (req, res, send) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const id = url.searchParams.get('id');
    const fileName = url.searchParams.get('name');
    if (!id || !fileName) return send(400, { error: '缺少 id 或 name' });
    const task = store.taskById(id);
    if (!task) return send(404, { error: '任务不在已扫描结果中，请先扫描' });
    if (/[\\/]\.\.|[\\/]/.test(fileName)) return send(400, { error: 'name 必须是任务目录内的文件名' });
    const base = resolve(task.absPath, fileName);
    const got = readTextCapped(base, 1024 * 1024);
    if (!got) return send(404, { error: `无法读取 ${fileName}` });
    send(200, { name: fileName, text: got.text, truncated: got.truncated });
  });

  // ---------------------------------------------------------------- tools ---

  const registerTool = (definition) => {
    try {
      return ctx.effect(() => ctx.tools.register(definition));
    } catch (error) {
      console.error('[abacusflow] tool registration failed:', definition.name, error);
      return undefined;
    }
  };

  registerTool({
    name: 'abacus_scan',
    description:
      '扫描项目根目录，识别 ABACUS 任务（含 INPUT）与 LibRPA 任务（含 librpa.in），返回每个任务的相对路径、类型、输出目录与运行状态。只需要概览时调用一次即可。',
    parameters: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: '项目根目录绝对路径；省略则用当前会话工作目录。' },
        maxDepth: { type: 'number', description: '向下扫描的层数，默认 4，范围 1–20。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          rootPath: { type: 'string' },
          tasks: { type: 'array', items: { type: 'object', additionalProperties: true } },
          directories: { type: 'array', items: { type: 'object', additionalProperties: true } },
          counts: { type: 'object', additionalProperties: true },
          scannedDirs: { type: 'number' },
          truncated: { type: 'boolean' },
          elapsedMs: { type: 'number' },
          error: { type: 'string', required: true },
        },
        additionalProperties: true,
      },
      render: (_args, value) => renderScan(value),
    },
    async execute(args, exec) {
      const rootPath = resolveRoot(exec, args.rootPath);
      const scan = await ensureScan(toolCtx, rootPath, { maxDepth: args.maxDepth, force: true });
      if (scan.error) return { ...scan, tasks: [], directories: [] };
      const tasks = scan.tasks.map((task) => ({ ...task, status: statusFor(task) }));
      // Re-cache with statuses so the panel route reuses this work.
      store.putScan(rootPath, { ...scan, tasks });
      return { ...scan, tasks };
    },
  });

  registerTool({
    name: 'abacus_inspect',
    description:
      '一次查看 1–20 个任务的计算状态与关键证据：ABACUS 的计算类型、基组、结构摘要、k 点、日志收敛与错误签名；LibRPA 的版本哈希、结束标记与 QSGW 迭代概况。它不重新校验输入合法性，也不判断科学正确性。',
    parameters: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: '项目根目录绝对路径；省略则用当前会话工作目录。' },
        relPaths: { type: 'array', items: { type: 'string' }, description: '1–20 个相对于 rootPath 的任务目录。' },
      },
      required: ['relPaths'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          rootPath: { type: 'string' },
          results: { type: 'array', items: { type: 'object', additionalProperties: true } },
          error: { type: 'string', required: true },
        },
        additionalProperties: true,
      },
      render: (_args, value) => renderInspect(value),
    },
    async execute(args, exec) {
      const rootPath = resolveRoot(exec, args.rootPath);
      const relPaths = Array.isArray(args.relPaths) ? args.relPaths : [];
      if (relPaths.length < 1 || relPaths.length > 20) {
        return { rootPath, results: [], error: '请提供 1–20 个任务目录' };
      }
      const scan = await ensureScan(toolCtx, rootPath);
      if (scan.error) return { rootPath, results: [], error: scan.error };
      const results = relPaths.map((relPath) => {
        const task = findTask(scan, relPath);
        if (!task) return { rel_path: relPath, error: '目录不是已识别的 ABACUS 或 LibRPA 任务' };
        const bundle = bundleFor(toolCtx, task);
        return {
          rel_path: task.relPath,
          kind: task.kind,
          status: bundle.status,
          abacus: bundle.abacus
            ? {
                calculation: bundle.abacus.calculation,
                basisType: bundle.abacus.basisType,
                outputDir: bundle.abacus.outputDir,
                logFile: bundle.abacus.logFile,
                stru: bundle.abacus.stru
                  ? {
                      natom: bundle.abacus.stru.natom,
                      species: bundle.abacus.stru.species.map((s) => s.label),
                      latticeConstant: bundle.abacus.stru.latticeConstant,
                      latticeConstantUnit: bundle.abacus.stru.latticeConstantUnit,
                    }
                  : null,
                kpt: bundle.abacus.kpt,
                log: bundle.abacus.log
                  ? {
                      iterations: bundle.abacus.log.iterations.length,
                      scfConverged: bundle.abacus.log.scfConverged,
                      finished: bundle.abacus.log.finished,
                      maxForce: bundle.abacus.log.maxForce,
                      errors: bundle.abacus.log.errors,
                    }
                  : null,
                warnings: bundle.abacus.warnings,
                versions: bundle.abacus.versions,
              }
            : null,
          librpa: bundle.librpa
            ? {
                task: bundle.librpa.task,
                outputDir: bundle.librpa.outputDir,
                log: bundle.librpa.log
                  ? { build: bundle.librpa.log.build, finished: bundle.librpa.log.finished, errors: bundle.librpa.log.errors }
                  : null,
                qsgw: bundle.librpa.qsgw
                  ? {
                      iterations: bundle.librpa.qsgw.iterations
                        ? { count: bundle.librpa.qsgw.iterations.rows.length, convergedIter: bundle.librpa.qsgw.iterations.convergedIter }
                        : null,
                      eigenvalues: bundle.librpa.qsgw.eigenvalues
                        ? {
                            nIter: bundle.librpa.qsgw.eigenvalues.nIter,
                            nKpoint: bundle.librpa.qsgw.eigenvalues.nKpoint,
                            nBand: bundle.librpa.qsgw.eigenvalues.nBand,
                            minEnergyEv: bundle.librpa.qsgw.eigenvalues.minEnergyEv,
                            maxEnergyEv: bundle.librpa.qsgw.eigenvalues.maxEnergyEv,
                          }
                        : null,
                    }
                  : null,
              }
            : null,
          files: bundle.files.map((f) => f.name),
          notes: bundle.notes,
          error: '',
        };
      });
      return { rootPath, results, error: '' };
    },
  });

  registerTool({
    name: 'abacus_diagnose',
    description:
      '诊断一个 ABACUS 或 LibRPA 阶段为什么处于当前状态：引用决定性的日志行（文件与行号）、对照输入要求与实际输出、列出缺少的文件，并给出一句结论。只读；本地文件可能是从集群拉回的子集，缺失的输出会如实标注为“没有产出或没有拉回”。',
    parameters: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: '项目根目录绝对路径；省略则用当前会话工作目录。' },
        relPath: { type: 'string', description: '相对于 rootPath 的任务目录。' },
      },
      required: ['relPath'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          rootPath: { type: 'string' },
          diagnosis: { type: 'object', additionalProperties: true },
          error: { type: 'string', required: true },
        },
        additionalProperties: true,
      },
      render: (_args, value) => renderDiagnosis(value),
    },
    async execute(args, exec) {
      const rootPath = resolveRoot(exec, args.rootPath);
      const scan = await ensureScan(toolCtx, rootPath);
      if (scan.error) return { rootPath, diagnosis: null, error: scan.error };
      const task = findTask(scan, String(args.relPath ?? ''));
      if (!task) return { rootPath, diagnosis: null, error: `${args.relPath} 不是已识别的 ABACUS 或 LibRPA 任务` };
      return { rootPath, diagnosis: diagnoseStage(task, bundleFor(toolCtx, task)), error: '' };
    },
  });

  registerTool({
    name: 'abacus_convergence',
    description:
      '读取 1–12 个 ABACUS 任务的 SCF 收敛序列：每个离子步内各电子步的 Kohn-Sham 能量（eV）、Fermi 能、能隙与电荷密度残差。面板会在对话中画出曲线。',
    parameters: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: '项目根目录绝对路径；省略则用当前会话工作目录。' },
        relPaths: { type: 'array', items: { type: 'string' }, description: '1–12 个相对于 rootPath 的 ABACUS 任务目录。' },
      },
      required: ['relPaths'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          rootPath: { type: 'string' },
          results: { type: 'array', items: { type: 'object', additionalProperties: true } },
          error: { type: 'string', required: true },
        },
        additionalProperties: true,
      },
      render: (_args, value) => renderConvergence(value),
    },
    async execute(args, exec) {
      const rootPath = resolveRoot(exec, args.rootPath);
      const relPaths = Array.isArray(args.relPaths) ? args.relPaths : [];
      if (relPaths.length < 1 || relPaths.length > 12) {
        return { rootPath, results: [], error: '请提供 1–12 个任务目录' };
      }
      const scan = await ensureScan(toolCtx, rootPath);
      if (scan.error) return { rootPath, results: [], error: scan.error };
      const results = relPaths.map((relPath) => {
        const task = findTask(scan, relPath);
        if (!task) return { rel_path: relPath, error: '目录不是已识别的任务' };
        const bundle = bundleFor(toolCtx, task);
        const log = bundle.abacus?.log;
        if (!log) return { rel_path: task.relPath, error: `没有可解析的 ABACUS 日志（输出目录 ${bundle.abacus?.outputDir ?? '缺失'}）` };
        const iterations = log.iterations ?? [];
        const ionicSteps = new Set(iterations.map((i) => i.ionicStep)).size;
        return {
          rel_path: task.relPath,
          log_file: bundle.abacus.logFile,
          ionic_steps: ionicSteps,
          iterations,
          energy_ev: iterations.map((i) => i.eKohnShamEv).filter((v) => v !== null),
          rho_deviation: iterations.map((i) => i.rhoDeviation).filter((v) => v !== null),
          scf_converged: log.scfConverged,
          finished: log.finished,
          errors: log.errors,
          error: '',
        };
      });
      return { rootPath, results, error: '' };
    },
  });

  registerTool({
    name: 'abacus_structure',
    description:
      '读取 1–12 个任务目录里的 ABACUS STRU 文件，返回晶胞、原子、成键与分子式；面板会在对话中显示可旋转的 3D 结构。',
    parameters: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: '项目根目录绝对路径；省略则用当前会话工作目录。' },
        relPaths: { type: 'array', items: { type: 'string' }, description: '1–12 个相对目录，每个目录需含 STRU。' },
      },
      required: ['relPaths'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          rootPath: { type: 'string' },
          results: { type: 'array', items: { type: 'object', additionalProperties: true } },
          error: { type: 'string', required: true },
        },
        additionalProperties: true,
      },
      render: (_args, value) => renderStructure(value),
    },
    async execute(args, exec) {
      const rootPath = resolveRoot(exec, args.rootPath);
      const relPaths = Array.isArray(args.relPaths) ? args.relPaths : [];
      if (relPaths.length < 1 || relPaths.length > 12) {
        return { rootPath, results: [], error: '请提供 1–12 个目录' };
      }
      const results = relPaths.map((relPath) => {
        const abs = resolve(rootPath, normalizeRel(relPath));
        const raw = readTextCapped(resolve(abs, 'STRU'), 8 * 1024 * 1024);
        if (!raw) return { rel_path: relPath, error: '目录内没有可读的 STRU' };
        try {
          const stru = parseStru(raw.text);
          // A STRU under `latname` carries no LATTICE_VECTORS; rebuild the cell from the
          // task's INPUT so the volume and cell edges are not silently lost.
          const inputRaw = readTextCapped(resolve(abs, 'INPUT'), 4 * 1024 * 1024);
          if (inputRaw) {
            const latname = parseAbacusInput(inputRaw.text).params.latname;
            if (latname) applyLatname(stru, latname);
          }
          const scene = struToScene(stru, { includeConnectivity: true, bondAlgorithm: 'crystal-nn' });
          return {
            rel_path: relPath,
            formula: scene.formula,
            natom: scene.natom,
            volume: scene.volume,
            bonds: scene.bonds.length,
            cell: scene.cell,
            atoms: scene.atoms,
            scene,
            error: '',
          };
        } catch (error) {
          return { rel_path: relPath, error: `STRU 解析失败：${error && error.message ? error.message : String(error)}` };
        }
      });
      return { rootPath, results, error: '' };
    },
  });

  registerTool({
    name: 'abacus_inputs',
    description:
      '读取并归类 1–20 个任务的 ABACUS INPUT 参数（按 系统/精度/电子/占据/混合/结构/输出 等分组），列出未收录的关键字。它只报告文件内容，不判断参数是否合理。',
    parameters: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: '项目根目录绝对路径；省略则用当前会话工作目录。' },
        relPaths: { type: 'array', items: { type: 'string' }, description: '1–20 个相对目录。' },
      },
      required: ['relPaths'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          rootPath: { type: 'string' },
          results: { type: 'array', items: { type: 'object', additionalProperties: true } },
          error: { type: 'string', required: true },
        },
        additionalProperties: true,
      },
      render: (_args, value) => renderInputs(value),
    },
    async execute(args, exec) {
      const rootPath = resolveRoot(exec, args.rootPath);
      const relPaths = Array.isArray(args.relPaths) ? args.relPaths : [];
      if (relPaths.length < 1 || relPaths.length > 20) {
        return { rootPath, results: [], error: '请提供 1–20 个目录' };
      }
      const results = relPaths.map((relPath) => {
        const abs = resolve(rootPath, normalizeRel(relPath));
        const raw = readTextCapped(resolve(abs, 'INPUT'), 4 * 1024 * 1024);
        if (!raw) return { rel_path: relPath, error: '目录内没有可读的 INPUT' };
        try {
          const parsed = parseAbacusInput(raw.text);
          const summary = summarizeParams(parsed.params);
          const total = Object.keys(parsed.params).length;
          const known = total - summary.unknownKeys.length;
          return {
            rel_path: relPath,
            profile: parsed.params.calculation ?? '未知计算类型',
            groups: summary.groups,
            unknownKeys: summary.unknownKeys,
            known_count: known,
            total_count: total,
            duplicates: parsed.duplicates,
            warnings: parsed.warnings,
            error: '',
          };
        } catch (error) {
          return { rel_path: relPath, error: `INPUT 解析失败：${error && error.message ? error.message : String(error)}` };
        }
      });
      return { rootPath, results, error: '' };
    },
  });

  registerTool({
    name: 'abacus_bands',
    description:
      '读取 1–8 个任务的能带数据：ABACUS 的 band.txt / bands1.txt / bands2.txt（含多次计算追加导致的多块文件），以及目录里已有的 LibRPA KS/EXX/QSGW 能带。返回能带数、k 点数、能量范围与可选迭代；面板会用可调能量窗口画出能带。',
    parameters: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: '项目根目录绝对路径；省略则用当前会话工作目录。' },
        relPaths: { type: 'array', items: { type: 'string' }, description: '1–8 个相对目录。' },
        iteration: { type: 'number', description: 'LibRPA 迭代号；省略则取每个能带系列的最新一次。' },
      },
      required: ['relPaths'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          rootPath: { type: 'string' },
          results: { type: 'array', items: { type: 'object', additionalProperties: true } },
          error: { type: 'string', required: true },
        },
        additionalProperties: true,
      },
      render: (_args, value) => {
        if (value.error) return textResult(`读取能带失败：${value.error}`);
        return textResult(
          value.results
            .map((row) => {
              if (row.error) return `${row.rel_path}：${row.error}`;
              const lines = [`【${row.rel_path || '.'}】`];
              if (row.abacus.length === 0 && row.librpa.length === 0) {
                lines.push('  没有能带数据');
              }
              for (const c of row.abacus) {
                lines.push(
                  `  ABACUS ${c.file}：spin ${c.spin}，${c.nKpoint} k 点 × ${c.nBand} 条能带，` +
                    `能量 ${fmt(c.minEnergyEv)} – ${fmt(c.maxEnergyEv)} eV` +
                    (c.nBlock > 1 ? `（文件含 ${c.nBlock} 个 k 路径块，显示最长的一块）` : ''),
                );
              }
              for (const c of row.librpa) {
                lines.push(
                  `  LibRPA ${c.kind} spin ${c.spin} iter ${c.iter ?? '—'}：${c.nKpoint} k 点 × ${c.nBand} 条能带，` +
                    `能量 ${fmt(c.minEnergyEv)} – ${fmt(c.maxEnergyEv)} eV`,
                );
              }
              if (row.availability.length > 0) {
                lines.push(`  可用的 LibRPA 能带系列：${row.availability.map((a) => `${a.key}（${a.fileCount} 次迭代）`).join('，')}`);
              }
              if (row.warnings.length > 0) lines.push(`  注意：${row.warnings.join('；')}`);
              return lines.join('\n');
            })
            .join('\n\n'),
        );
      },
    },
    async execute(args, exec) {
      const rootPath = resolveRoot(exec, args.rootPath);
      const relPaths = Array.isArray(args.relPaths) ? args.relPaths : [];
      if (relPaths.length < 1 || relPaths.length > 8) {
        return { rootPath, results: [], error: '请提供 1–8 个目录' };
      }
      const scan = await ensureScan(toolCtx, rootPath);
      if (scan.error) return { rootPath, results: [], error: scan.error };

      const results = relPaths.map((relPath) => {
        const task = findTask(scan, relPath);
        if (!task) return { rel_path: relPath, error: '目录不是已识别的任务' };
        const bands = bandsFor(toolCtx, task, { lrpaIteration: args.iteration ?? null });
        return {
          rel_path: task.relPath,
          abacus: bands.abacus.map((c) => ({
            file: c.file,
            spin: c.spin,
            nKpoint: c.nKpoint,
            nBand: c.nBand,
            nBlock: c.nBlock,
            minEnergyEv: c.minEnergyEv,
            maxEnergyEv: c.maxEnergyEv,
          })),
          librpa: bands.librpa.map((c) => ({
            file: c.file,
            kind: c.kind,
            spin: c.spin,
            iter: c.iter,
            nKpoint: c.nKpoint,
            nBand: c.nBand,
            minEnergyEv: c.minEnergyEv,
            maxEnergyEv: c.maxEnergyEv,
          })),
          availability: bands.availability,
          warnings: bands.warnings,
          error: '',
        };
      });
      return { rootPath, results, error: '' };
    },
  });

  registerTool({
    name: 'librpa_bands',
    description:
      '读取 1–8 个 LibRPA 任务的 QSGW 能带随迭代的演化：KS / EXX / QSGW 三类、每个自旋、每一代迭代的 k 点数、能带数与能量范围。用于判断准粒子能带是否收敛。',
    parameters: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: '项目根目录绝对路径；省略则用当前会话工作目录。' },
        relPaths: { type: 'array', items: { type: 'string' }, description: '1–8 个含 librpa.in 的相对目录。' },
      },
      required: ['relPaths'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          rootPath: { type: 'string' },
          results: { type: 'array', items: { type: 'object', additionalProperties: true } },
          error: { type: 'string', required: true },
        },
        additionalProperties: true,
      },
      render: (_args, value) => {
        if (value.error) return textResult(`读取 LibRPA 能带失败：${value.error}`);
        return textResult(
          value.results
            .map((row) => {
              if (row.error) return `${row.rel_path}：${row.error}`;
              const lines = [`【${row.rel_path || '.'}】`];
              if (row.series.length === 0) lines.push('  没有 LibRPA 能带文件');
              for (const s of row.series) {
                lines.push(
                  `  ${s.kind} spin ${s.spin}：${s.iterations.length} 次迭代（${s.iterations.join(', ')}）`,
                );
              }
              // Only report an energy extent when a file was actually read; otherwise say so
              // rather than printing an em dash pair that looks like a failed parse.
              if (row.loaded.length > 0) {
                lines.push('  已读取的能带（默认每个系列取最新一次迭代）：');
                for (const c of row.loaded) {
                  lines.push(
                    `    ${c.kind} spin ${c.spin} iter ${c.iter ?? '—'}：${c.nKpoint} k 点 × ${c.nBand} 条能带，` +
                      `能量 ${fmt(c.minEnergyEv)} – ${fmt(c.maxEnergyEv)} eV`,
                  );
                }
              }
              if (row.qsgw) {
                lines.push(
                  `  QSGW 收敛：${row.qsgw.iterations} 次迭代，max_delta ${fmt(row.qsgw.lastDeltaEv)} eV（末次），` +
                    `收敛 ${row.qsgw.convergedIter === null ? '否' : `于第 ${row.qsgw.convergedIter} 次`}`,
                );
              }
              if (row.warnings.length > 0) lines.push(`  注意：${row.warnings.join('；')}`);
              return lines.join('\n');
            })
            .join('\n\n'),
        );
      },
    },
    async execute(args, exec) {
      const rootPath = resolveRoot(exec, args.rootPath);
      const relPaths = Array.isArray(args.relPaths) ? args.relPaths : [];
      if (relPaths.length < 1 || relPaths.length > 8) {
        return { rootPath, results: [], error: '请提供 1–8 个目录' };
      }
      const scan = await ensureScan(toolCtx, rootPath);
      if (scan.error) return { rootPath, results: [], error: scan.error };

      const results = relPaths.map((relPath) => {
        const task = findTask(scan, relPath);
        if (!task) return { rel_path: relPath, error: '目录不是已识别的任务' };
        const bundle = bundleFor(toolCtx, task);
        if (!bundle.librpa) return { rel_path: task.relPath, error: '该目录没有 librpa.in' };
        const bands = bandsFor(toolCtx, task, { lrpaIteration: null });
        const rows = bundle.librpa.qsgw?.iterations?.rows ?? [];
        return {
          rel_path: task.relPath,
          series: bands.availability.map((a) => ({
            kind: a.kind,
            spin: a.spin,
            iterations: a.iterations,
          })),
          loaded: bands.librpa.map((c) => ({
            kind: c.kind,
            spin: c.spin,
            iter: c.iter,
            nKpoint: c.nKpoint,
            nBand: c.nBand,
            minEnergyEv: c.minEnergyEv,
            maxEnergyEv: c.maxEnergyEv,
          })),
          qsgw: rows.length
            ? {
                iterations: rows.length,
                lastDeltaEv: rows[rows.length - 1].max_delta_eV,
                convergedIter: bundle.librpa.qsgw.iterations.convergedIter,
              }
            : null,
          warnings: bands.warnings,
          error: '',
        };
      });
      return { rootPath, results, error: '' };
    },
  });

  registerTool({
    name: 'abacus_kstudy',
    description:
      '查看 k 点收敛性研究：一组只差响应网格的 QSGW 计算（<材料>/k444、k555…），给出每个网格的迭代轨迹（能隙与 ΔE 随更新次数）和相邻网格的能隙差。可读活的 run 目录树，也可读活动分析脚本产出的 snapshot.json。它不判定"是否收敛"——那取决于你选的数量与容差。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'k 收敛研究目录（含 <材料>/k<网格>），或 snapshot.json 的路径。',
        },
        material: { type: 'string', description: '只看某个材料，例如 Si；省略则全部。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          observedUtc: { type: 'string' },
          limitation: { type: 'string' },
          materials: { type: 'array', items: { type: 'object', additionalProperties: true } },
          deltas: { type: 'array', items: { type: 'object', additionalProperties: true } },
          warnings: { type: 'array', items: { type: 'string' } },
          error: { type: 'string', required: true },
        },
        additionalProperties: true,
      },
      render: (_args, value) => {
        if (value.error) return textResult(`读取 k 收敛研究失败：${value.error}`);
        const lines = [];
        lines.push(`来源：${value.source === 'snapshot' ? '分析快照' : value.source === 'tree' ? '运行目录树' : '无'}` +
          (value.observedUtc ? `，观测于 ${value.observedUtc}` : ''));
        const materials = value.material
          ? value.materials.filter((m) => m.material === value.material)
          : value.materials;
        for (const m of materials) {
          lines.push(`\n【${m.material}】${m.meshes.length} 个网格`);
          for (const mesh of m.meshes) {
            const last = mesh.iterations[mesh.iterations.length - 1];
            lines.push(
              `  k${String(mesh.mesh).repeat(3)}：${mesh.iterations.length} 次迭代，` +
                `末次能隙 ${fmt(mesh.gapEv ?? last.gapEv)} eV` +
                (mesh.complete === false ? '（未完成）' : ''),
            );
          }
        }
        const deltas = value.material ? value.deltas.filter((d) => d.material === value.material) : value.deltas;
        if (deltas.length > 0) {
          lines.push('\n相邻网格能隙差：');
          for (const d of deltas) {
            lines.push(
              `  ${d.material} k${String(d.coarser).repeat(3)}→k${String(d.finer).repeat(3)}：` +
                `${fmt(d.deltaGapEv * 1000)} meV`,
            );
          }
        }
        if (value.limitation) lines.push(`\n限制：${value.limitation}`);
        if (value.warnings.length) lines.push(`\n注意：${value.warnings.join('；')}`);
        return textResult(lines.join('\n'));
      },
    },
    async execute(args) {
      const study = buildKStudy(args.path);
      return {
        source: study.source,
        observedUtc: study.observedUtc,
        limitation: study.limitation,
        material: args.material ?? null,
        materials: study.materials,
        deltas: study.deltas,
        warnings: study.warnings,
        error: study.error,
      };
    },
  });

  registerTool({
    name: 'abacus_remote_list',
    description:
      '用一次 SSH 连接列出远程超算上一个 run 目录里的全部 ABACUS / LibRPA 任务（任务路径、含哪些输入文件、有哪些 OUT.* 输出目录）。不要挂载远端目录——在这个网络上每次 SSH 连接约 11 秒，挂载会把每个目录项变成一次往返。',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string', description: '~/.ssh/config 里的主机别名，例如 dongfang；省略则用插件配置的 remoteHost。' },
        run: { type: 'string', description: '远端 run 目录绝对路径，例如 /data/home/user/ai-runs/foo。' },
      },
      required: ['run'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          run: { type: 'string' },
          tasks: { type: 'array', items: { type: 'object', additionalProperties: true } },
          elapsedMs: { type: 'number' },
          error: { type: 'string', required: true },
        },
        additionalProperties: true,
      },
      render: (_args, value) => {
        if (value.error) return textResult(`远程列目录失败：${value.error}`);
        const lines = [`${value.run}：${value.tasks.length} 个任务（一次连接，用时 ${value.elapsedMs} ms）`];
        for (const t of value.tasks) {
          lines.push(
            `- ${t.relPath} [${kindLabel(t.kind)}] 输入：${t.markers.join('+')}` +
              (t.outputDirs.length ? ` 输出：${t.outputDirs.join(',')}` : ' （无 OUT.* 输出）'),
          );
        }
        lines.push('');
        lines.push('要把这些画出来，用 abacus_remote_pull 拉到本地再看；拉的只是绘图需要的文件。');
        return textResult(lines.join('\n'));
      },
    },
    async execute(args) {
      const host = args.host || cfg.remoteHost;
      if (!host) return { run: args.run, tasks: [], elapsedMs: 0, error: '没有指定 host，插件配置里也没有 remoteHost' };
      return listRemoteTasks(host, args.run);
    },
  });

  registerTool({
    name: 'abacus_remote_pull',
    description:
      '把一个远程 run 里"绘图需要的文件"拉到本地目录（远端打成 tar 再下载，实测一个 37 GB 的 run 只需 2 MiB）。拉完后用本地路径调用 abacus_bands / abacus_convergence 即可看能带与收敛。',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string', description: '~/.ssh/config 主机别名；省略用插件配置的 remoteHost。' },
        run: { type: 'string', description: '远端 run 目录绝对路径。' },
        localRoot: { type: 'string', description: '本地落地目录；省略用插件配置的 remoteLocalRoot。' },
        withEigenvalues: { type: 'boolean', description: '是否一并拉取 qsgw_eigenvalues.dat（通常几十 MB，画图不需要）。' },
      },
      required: ['run'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          localPath: { type: 'string' },
          message: { type: 'string' },
          error: { type: 'string', required: true },
        },
        additionalProperties: true,
      },
      render: (_args, value) => {
        if (!value.ok) return textResult(`远程拉取失败：${value.error}`);
        return textResult(`${value.message}\n把 ${value.localPath} 作为 rootPath 传给 abacus_scan 就能看了。`);
      },
    },
    async execute(args) {
      const host = args.host || cfg.remoteHost;
      if (!host) return { ok: false, localPath: null, message: '', error: '没有指定 host，插件配置里也没有 remoteHost' };
      const localRoot = args.localRoot || cfg.remoteLocalRoot;
      if (!localRoot) return { ok: false, localPath: null, message: '', error: '没有指定 localRoot，插件配置里也没有 remoteLocalRoot' };
      return pullRemoteRun({ host, remoteRun: args.run, localRoot, withEigenvalues: args.withEigenvalues === true });
    },
  });

  registerTool({
    name: 'librpa_inspect',
    description:
      '查看 1–20 个 LibRPA 任务的输入、构建版本与 QSGW 输出：librpa.in 参数分组、编译哈希与库信息、QSGW 迭代表（能隙、ΔE、收敛标记）与本征值范围。',
    parameters: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: '项目根目录绝对路径；省略则用当前会话工作目录。' },
        relPaths: { type: 'array', items: { type: 'string' }, description: '1–20 个相对目录，每个目录需含 librpa.in。' },
        includeIterations: { type: 'boolean', description: '是否包含完整 QSGW 迭代表（默认 true）。' },
      },
      required: ['relPaths'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          rootPath: { type: 'string' },
          results: { type: 'array', items: { type: 'object', additionalProperties: true } },
          error: { type: 'string', required: true },
        },
        additionalProperties: true,
      },
      render: (_args, value) => {
        if (value.error) return textResult(`查看 LibRPA 失败：${value.error}`);
        return textResult(
          value.results
            .map((row) => {
              if (row.error) return `${row.rel_path}：${row.error}`;
              const lines = [`【${row.rel_path || '.'}】task=${row.task ?? '未知'} · ${row.status?.label ?? '未判定'}`];
              if (row.build && Object.keys(row.build).length) {
                lines.push(`  构建：${Object.entries(row.build).map(([k, v]) => `${k}=${v}`).join('，')}`);
              }
              if (row.params) {
                lines.push(`  输入参数：${row.params.map((p) => `${p.key}=${p.value}`).join('，')}`);
              }
              if (row.iterations?.length) {
                lines.push(`  QSGW 迭代：`);
                for (const it of row.iterations) {
                  lines.push(`    iter ${it.iter}：gap ${fmt(it.gap_eV)} eV，ΔE ${fmt(it.max_delta_eV)} eV，残差 ${fmt(it.residual_l2_Ha)} Ha，converged=${it.converged}`);
                }
              }
              if (row.eigenvalues) {
                lines.push(`  本征值：${row.eigenvalues.nIter} 次 × ${row.eigenvalues.nKpoint} k × ${row.eigenvalues.nBand} 带，范围 ${fmt(row.eigenvalues.minEnergyEv)} – ${fmt(row.eigenvalues.maxEnergyEv)} eV`);
              }
              return lines.join('\n');
            })
            .join('\n\n'),
        );
      },
    },
    async execute(args, exec) {
      const rootPath = resolveRoot(exec, args.rootPath);
      const relPaths = Array.isArray(args.relPaths) ? args.relPaths : [];
      if (relPaths.length < 1 || relPaths.length > 20) {
        return { rootPath, results: [], error: '请提供 1–20 个目录' };
      }
      const scan = await ensureScan(toolCtx, rootPath);
      if (scan.error) return { rootPath, results: [], error: scan.error };
      const includeIterations = args.includeIterations !== false;
      const results = relPaths.map((relPath) => {
        const task = findTask(scan, relPath);
        if (!task) return { rel_path: relPath, error: '目录不是已识别的任务' };
        const bundle = bundleFor(toolCtx, task);
        if (!bundle.librpa) return { rel_path: task.relPath, error: '该目录没有 librpa.in' };
        const l = bundle.librpa;
        return {
          rel_path: task.relPath,
          task: l.task,
          status: l.status,
          outputDir: l.outputDir,
          build: l.log?.build ?? {},
          params: (l.paramsSummary?.groups ?? []).flatMap((g) => g.items.map((i) => ({ key: i.key, value: i.value, known: i.known }))),
          iterations: includeIterations ? (l.qsgw?.iterations?.rows ?? []) : [],
          eigenvalues: l.qsgw?.eigenvalues
            ? {
                nIter: l.qsgw.eigenvalues.nIter,
                nKpoint: l.qsgw.eigenvalues.nKpoint,
                nBand: l.qsgw.eigenvalues.nBand,
                minEnergyEv: l.qsgw.eigenvalues.minEnergyEv,
                maxEnergyEv: l.qsgw.eigenvalues.maxEnergyEv,
              }
            : null,
          perRankLogs: l.files?.perRankLogs ?? [],
          exitcode: l.files?.exitcode ?? null,
          error: '',
        };
      });
      return { rootPath, results, error: '' };
    },
  });

  // Extra ergonomic route: let the panel ask for one directory directly.
  route(`${API_PREFIX}/open`, async (req, res, send) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const rootPath = url.searchParams.get('rootPath') || cfg.defaultScanRoot;
    const relPath = url.searchParams.get('relPath') || '';
    if (!rootPath) return send(400, { error: '缺少 rootPath' });
    const task = await scanSingleDir(resolve(rootPath, normalizeRel(relPath)), rootPath);
    if (!task) return send(404, { error: '该目录不是 ABACUS 或 LibRPA 任务' });
    send(200, bundleFor(toolCtx, task));
  });
}
