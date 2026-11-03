/**
 * Why is this stage in the state it is? The evidence for one stage, gathered for a reader.
 *
 * The classifiers (abacus/log.js, librpa/output.js) decide a status from the log; this module
 * shows the reader *why*, in four parts the panel renders as they are:
 *
 *   - `lines`    the decisive log lines, quoted, each with its file and 1-based line number:
 *                a fatal signature, the convergence verdict, the terminator — or, when there
 *                is no terminator, the last line the program wrote;
 *   - `checks`   what the input asked for against what the output contains (SCF steps and
 *                threshold, QSGW iterations and tolerance, `out_*` flags and their files);
 *   - `missing`  files a stage of this kind needs or normally leaves, that are not here;
 *   - `verdict`  one line that follows from the above, and nothing else.
 *
 * Patterns come from the classifiers themselves (`ABACUS_LOG_MARKERS`,
 * `LIBRPA_LOG_SIGNATURES`), so the diagnosis cannot disagree with a status about what a
 * line means. Everything is read on demand for one stage; none of this is on the scan path.
 *
 * Absence is reported as absence. Many local copies are partial pulls from a cluster, so a
 * file that INPUT asked for and that is not here is "not here — not produced, or not pulled
 * back", never "not produced".
 *
 * @module abacusflow/host/diagnose
 */
import { isAbsolute, resolve } from 'node:path';
import { listDir, readTextCapped, safeStat, ageSeconds } from './shared/paths.js';
import { readBands } from './bands.js';
import { ABACUS_LOG_MARKERS } from './abacus/log.js';
import { LIBRPA_LOG_SIGNATURES } from './librpa/output.js';
import { getParam } from './abacus/input-params.js';
import { infoParam } from './abacus/input-info.js';
import { getLibrpaParam, getLibrpaNumber } from './librpa/input.js';

const MAX_LOG_BYTES = 24 * 1024 * 1024;
const MAX_SIDE_BYTES = 4 * 1024 * 1024;
const MAX_FATAL_LINES = 3;
const STALE_SECONDS = 6 * 3600;

/** Scheduler and wrapper output kept next to a run: where a killed job says why. */
const JOB_OUTPUT = /^(slurm-\d+\.out|.+\.o\d+|.+\.e\d+|job\.(out|err|log)|nohup\.out|stdout|stderr|run\.(out|err|log)|abacus\.(out|err|log))$/i;

/**
 * What a batch scheduler writes when it ends a job. These lines land in stderr files
 * (`librpa.err`, `slurm-*.out`), never in the program's own log, which simply stops — so
 * the classifiers see "no terminator" and cannot tell "still running" from "killed". Here
 * the line itself is the evidence. Most specific first.
 */
const SCHEDULER_SIGNATURES = [
  { code: 'TIME_LIMIT', re: /DUE TO TIME LIMIT|time limit exceeded/i, message: '作业触及时限，被调度器终止' },
  { code: 'OOM_KILL', re: /oom-kill|out of memory|OOM Killer/i, message: '内存不足，被系统终止（OOM）' },
  { code: 'PREEMPTED', re: /DUE TO PREEMPTION|PREEMPTED/i, message: '作业被抢占' },
  { code: 'CANCELLED', re: /\bCANCELLED AT\b/i, message: '作业被调度器取消（CANCELLED）' },
  { code: 'NODE_FAIL', re: /DUE TO NODE FAILURE|NODE_FAIL/i, message: '计算节点故障' },
];

/** Calculations whose own SCF loop must converge; for nscf the "SCF" is one step by design. */
const CONVERGING = /^(scf|relax|cell-relax|md)$/i;

/**
 * `out_*` flags whose products have recognisable names. Names changed between ABACUS
 * versions, so each pattern accepts the spellings seen in v3.x outputs (`bands1.txt` and
 * `BANDS_1.dat`, `SPIN1_CHG.cube` and `chgs1.cube`, …).
 */
const OUTPUT_FLAGS = [
  { key: 'out_band', what: '能带本征值', files: /^(bands?_?\d*\.(txt|dat)|BANDS_\d+\.dat|eigs?\d*\.txt)$/i },
  { key: 'out_chg', what: '电荷密度', files: /(^|_)CHG.*\.cube$|^chgs?\d*(_ini)?\.cube$/i },
  { key: 'out_wfc_lcao', what: 'LCAO 波函数', files: /^(WFC_NAO|LOWF|wfs?\d*k?\d*_?nao)|wf.*nao/i },
  { key: 'out_mul', what: 'Mulliken 布居', files: /mulliken/i },
  { key: 'out_mat_hs2', what: 'H(R)/S(R) 稀疏矩阵', files: /(HR|SR|hrs|srs).*\.csr$/i },
  { key: 'out_mat_r', what: 'r(R) 矩阵', files: /(^rr|data-rR).*\.csr$/i },
  { key: 'out_dos', what: '态密度', files: /DOS|^dos/i },
];

const CHARGE_FILES = OUTPUT_FLAGS.find((flag) => flag.key === 'out_chg').files;
const BAND_FILES = OUTPUT_FLAGS.find((flag) => flag.key === 'out_band').files;

/** Files `rpa 1` exports for LibRPA, wherever the run writes them. */
const LIBRPA_EXPORT = /^(band_out|stru_out|bz_sampling_out|basis_(out|wfc_out|aux_out)|KS_eigenvector|(v\d+_)?Cs_data|(v\d+_)?coulomb_)/;

/**
 * Diagnose one stage.
 *
 * @param {object} task scanner task (`absPath`, `kind`, `relPath`, `mtimeMs`, …)
 * @param {object} bundle `buildTaskBundle(task)` for the same task
 * @returns {{
 *   ok: boolean, stage: object, status: object|null,
 *   verdict: { tone: 'ok'|'warn'|'err'|'info', text: string },
 *   lines: Array<{ file: string, line: number|null, text: string, why: string, kind: string }>,
 *   checks: Array<{ asked: string, found: string, ok: boolean|null, note?: string }>,
 *   missing: Array<{ name: string, why: string, need: 'required'|'expected' }>,
 *   notes: string[]
 * }}
 */
export function diagnoseStage(task, bundle) {
  const out = {
    ok: true,
    stage: { id: task.id, relPath: task.relPath, absPath: task.absPath, kind: task.kind },
    status: bundle && bundle.status ? bundle.status : null,
    verdict: { tone: 'info', text: '' },
    lines: [],
    checks: [],
    missing: [],
    notes: [],
  };
  const verdicts = [];
  // A coupled stage runs both programs in one folder; each half's verdict says which it is.
  const half = (name, verdict) => (task.kind === 'coupled' && verdict ? { ...verdict, text: `${name}：${verdict.text}` } : verdict);
  if (task.kind === 'abacus' || task.kind === 'coupled') verdicts.push(half('ABACUS', diagnoseAbacus(task, bundle, out)));
  if (task.kind === 'librpa' || task.kind === 'coupled') verdicts.push(half('LibRPA', diagnoseLibrpa(task, bundle, out)));
  scanJobOutputs(task.absPath, out);
  // The worst half decides; within a tone, the first (ABACUS before LibRPA, as in the pipeline).
  const rank = { err: 0, warn: 1, info: 2, ok: 3 };
  const decided = verdicts.filter(Boolean).sort((a, b) => rank[a.tone] - rank[b.tone])[0];
  out.verdict = decided || { tone: 'info', text: '不是可识别的 ABACUS 或 LibRPA 阶段' };
  // A scheduler ending the job is the cause whatever the program's own log says (it just
  // stops), so that line decides — unless the run had already finished cleanly.
  const ended = out.lines.find((l) => l.kind === 'fatal' && l.scheduler);
  const jobFatal = ended || out.lines.find((l) => l.kind === 'fatal' && l.source === 'job');
  if (jobFatal && out.verdict.tone !== 'ok' && !out.verdict.text.startsWith('运行被终止')) {
    out.verdict = { tone: 'err', text: `运行被终止：${jobFatal.why.replace(/；另有.*$/, '')}（${jobFatal.file} 第 ${jobFatal.line} 行）` };
    // The status beside it still says "running": it is decided from the program's log alone,
    // which simply stops. Say so, rather than leave two answers side by side.
    if (out.status && out.status.code === 'RUNNING') {
      out.notes.unshift(`列表里的状态仍是「运行中」：状态只按程序日志判定，而日志没有结束标记；终止记录在 ${jobFatal.file} 第 ${jobFatal.line} 行`);
    }
  }
  return out;
}

// ------------------------------------------------------------------ ABACUS ---

function diagnoseAbacus(task, bundle, out) {
  const base = task.absPath;
  const abacus = bundle ? bundle.abacus : null;
  const params = abacus && abacus.input ? abacus.input.params : {};
  const effective = abacus ? abacus.effectiveParams : null;
  // INPUT.info holds every value the run used, defaults included; INPUT only what was set.
  const asked = (name) => {
    const fromInput = getParam(params, name);
    if (fromInput !== undefined) return { value: String(fromInput).trim(), from: 'INPUT' };
    const fromInfo = infoParam(effective, name);
    if (fromInfo !== undefined) return { value: String(fromInfo).trim(), from: 'INPUT.info（默认值）' };
    return null;
  };
  const num = (value) => {
    const n = Number(String(value ?? '').trim().split(/\s+/)[0].replace(/[dD]/, 'e'));
    return Number.isFinite(n) ? n : null;
  };

  // ---- the files every ABACUS stage starts from
  if (!safeStat(resolve(base, 'INPUT'))) out.missing.push({ name: 'INPUT', why: 'ABACUS 的参数文件', need: 'required' });
  if (!safeStat(resolve(base, 'STRU'))) out.missing.push({ name: 'STRU', why: '结构文件', need: 'required' });
  const kspacing = asked('kspacing');
  const gammaOnly = asked('gamma_only');
  if (!safeStat(resolve(base, 'KPT')) && !(kspacing && num(kspacing.value) > 0) && !(gammaOnly && num(gammaOnly.value) === 1)) {
    out.missing.push({ name: 'KPT', why: 'k 点文件（INPUT 没有用 kspacing 或 gamma_only 代替它）', need: 'required' });
  }
  const statusCode = (abacus && abacus.status ? abacus.status : bundle && bundle.status || {}).code;
  // A finished run had its pseudopotentials on the machine it ran on; absent here they only
  // matter for a rerun. For a stage that never produced output they may be the cause.
  checkSpeciesFiles(base, abacus, asked, out, statusCode === 'FINISHED' || statusCode === 'FINISHED_UNCONVERGED');

  const suffix = abacus ? abacus.suffix : 'ABACUS';
  const outName = `OUT.${suffix}`;
  const outDir = resolve(base, outName);
  const outFiles = listDir(outDir);
  if (!outFiles) {
    out.missing.push({ name: `${outName}/`, why: '输出目录：没有运行，或输出没有拉回本地', need: 'expected' });
    return { tone: 'info', text: `没有输出目录 ${outName}：这个阶段没有运行，或输出没有拉回本地` };
  }
  const names = outFiles.filter((f) => !f.isDir).map((f) => f.name);
  const logFile = abacus && abacus.logFile;
  const calcAsked = asked('calculation');
  if (!logFile) {
    out.missing.push({ name: `${outName}/running_${calcAsked ? calcAsked.value : 'scf'}.log`, why: '主日志', need: 'required' });
  }

  // ---- decisive lines of the main log
  const logPath = logFile ? resolve(outDir, logFile) : null;
  const logRel = logFile ? `${outName}/${logFile}` : null;
  let terminated = false;
  let lastLine = null;
  if (logPath) {
    const raw = readTextCapped(logPath, MAX_LOG_BYTES);
    if (raw) {
      const scanned = scanAbacusLog(raw.text, logRel);
      out.lines.push(...scanned.lines);
      terminated = scanned.terminated;
      lastLine = scanned.lastLine;
      if (raw.truncated) out.notes.push(`${logRel} 超过 ${Math.round(MAX_LOG_BYTES / 1048576)} MB，只读了开头部分，行号仍然准确`);
    }
  }
  // warning.log carries ABACUS's routine notices (AUTO_SET NBANDS, a missing optional block)
  // next to real complaints, so its lines are quoted only for a run that did not end cleanly.
  const warningLog = readTextCapped(resolve(outDir, 'warning.log'), MAX_SIDE_BYTES);
  if (warningLog) {
    const all = numberedLines(warningLog.text).filter((l) => l.text.trim());
    const loud = all.filter((l) => /error|fatal|abort|quit|nots+converged|cannot|can't open|fail/i.test(l.text) && !/can't find: .* block/i.test(l.text));
    if (statusCode === 'FINISHED') {
      if (all.length) out.notes.push(`${outName}/warning.log 有 ${all.length} 行${loud.length ? `，其中 ${loud.length} 行像报错（第 ${loud[0].line} 行：${clip(loud[0].text.trim())}）；运行仍正常结束` : '，都是例行提示'}`);
    } else {
      for (const l of (loud.length ? loud : all).slice(0, 3)) out.lines.push({ file: `${outName}/warning.log`, line: l.line, text: clip(l.text.trim()), why: 'ABACUS 警告', kind: 'warning', source: 'abacus' });
    }
  }

  // ---- what INPUT asked for, against what the output holds
  const log = abacus ? abacus.log : null;
  if (calcAsked && log && log.calculation && log.calculation.toLowerCase() !== calcAsked.value.toLowerCase()) {
    out.checks.push({ asked: `calculation = ${calcAsked.value}`, found: `日志里是 ${log.calculation}`, ok: false, note: 'INPUT 与日志对不上：输出目录可能属于另一次运行' });
  }
  let scf = null;
  // ABACUS's default calculation is scf.
  const calcName = (calcAsked && calcAsked.value) || (log && log.calculation) || 'scf';
  if (log && log.iterations && log.iterations.length > 0 && CONVERGING.test(calcName)) {
    const lastIonic = log.iterations[log.iterations.length - 1].ionicStep;
    const steps = log.iterations.filter((it) => it.ionicStep === lastIonic);
    const drho = [...steps].reverse().find((it) => it.rhoDeviation !== null);
    const nmax = asked('scf_nmax');
    const thr = asked('scf_thr');
    // The step number the log printed, not the count of records: a log may skip records.
    const lastStep = steps[steps.length - 1];
    scf = {
      steps: lastStep && Number.isFinite(lastStep.scfIter) ? lastStep.scfIter : steps.length,
      nmax: nmax ? num(nmax.value) : null,
      thr: thr ? num(thr.value) : null,
      drho: drho ? drho.rhoDeviation : null,
      converged: log.scfConverged === true && !log.scfNotConverged,
      ionic: new Set(log.iterations.map((it) => it.ionicStep)).size,
    };
    out.checks.push({
      asked: [nmax ? `scf_nmax = ${nmax.value}` : null, thr ? `scf_thr = ${thr.value}` : null].filter(Boolean).join(' · ') || 'SCF（INPUT 没有写 scf_nmax / scf_thr）',
      found: `${scf.ionic > 1 ? `第 ${lastIonic} 个离子步：` : ''}${scf.steps} 步${scf.drho !== null ? `，末次 drho = ${fmtSci(scf.drho)}` : ''}`,
      ok: log.scfNotConverged ? false : log.scfConverged === true ? true : null,
      note: log.scfNotConverged
        ? scf.nmax !== null && scf.steps >= scf.nmax ? '用满了 scf_nmax 仍未收敛' : '没有收敛'
        : log.scfConverged === true ? '收敛' : '日志没有收敛结论',
    });
  }
  for (const flag of OUTPUT_FLAGS) {
    const value = asked(flag.key);
    if (!value || value.from !== 'INPUT' || !(num(value.value) >= 1)) continue;
    const hits = names.filter((n) => flag.files.test(n));
    out.checks.push({
      asked: `${flag.key} = ${value.value}`,
      found: hits.length ? `${hits.slice(0, 3).join('、')}${hits.length > 3 ? ` 等 ${hits.length} 个` : ''}` : '本地没有',
      ok: hits.length ? true : null,
      note: hits.length ? flag.what : `${flag.what}：没有产出，或没有拉回本地`,
    });
  }
  // The band count INPUT asked for, and the spins nspin implies, against the band files.
  if (names.some((n) => BAND_FILES.test(n))) {
    const channels = readBands(base, { outDir: outName }).abacus || [];
    const nbands = asked('nbands');
    if (channels.length && nbands && num(nbands.value) !== null) {
      const want = num(nbands.value);
      const match = channels.every((c) => c.nBand === want);
      out.checks.push({
        asked: `nbands = ${nbands.value}${nbands.from === 'INPUT' ? '' : `（${nbands.from}）`}`,
        found: channels.map((c) => `${c.file} ${c.nKpoint} k × ${c.nBand} 带`).join('、'),
        ok: match,
        note: match ? '能带文件的带数与 nbands 一致' : '能带文件的带数与 nbands 不同',
      });
    }
    const nspin = asked('nspin');
    if (channels.length && nspin && num(nspin.value) === 2) {
      const spins = [...new Set(channels.map((c) => c.spin))].sort();
      const absent = [1, 2].filter((s) => !spins.includes(s));
      out.checks.push({
        asked: 'nspin = 2（两个自旋）',
        found: `能带文件覆盖自旋 ${spins.join('、')}`,
        ok: absent.length === 0 ? true : null,
        note: absent.length === 0 ? '两个自旋的能带都在' : `没有自旋 ${absent.join('、')} 的能带文件：没有产出，或没有拉回本地`,
      });
    }
  }
  const rpa = asked('rpa');
  if (rpa && rpa.from === 'INPUT' && num(rpa.value) === 1) {
    const exported = [...(listDir(base) ?? []), ...outFiles].filter((f) => LIBRPA_EXPORT.test(f.name));
    out.checks.push({
      asked: 'rpa = 1（为 LibRPA 导出）',
      found: exported.length ? `${exported.length} 个导出文件，如 ${exported.slice(0, 2).map((f) => f.name).join('、')}` : '本地没有导出文件',
      ok: exported.length ? true : null,
      note: exported.length ? 'LibRPA 输入' : '下游 LibRPA 读它们；看下游 librpa.in 的 input_dir 指向哪里',
    });
  }
  const initChg = asked('init_chg');
  if (initChg && initChg.from === 'INPUT' && initChg.value.toLowerCase() === 'file') {
    const dirName = (asked('read_file_dir') || { value: `${outName}/` }).value;
    const dir = resolve(base, dirName);
    const files = listDir(dir);
    const charge = (files ?? []).filter((f) => CHARGE_FILES.test(f.name));
    out.checks.push({
      asked: `init_chg = file（从 ${dirName} 读电荷密度）`,
      found: !files ? `${dirName} 本地不存在` : charge.length ? charge.slice(0, 2).map((f) => f.name).join('、') : '那里没有电荷密度文件',
      ok: charge.length ? true : null,
      note: charge.length ? '起点电荷' : 'nscf 从 scf 的电荷出发；运行时它必须在那里（本地缺失可能只是没拉回）',
    });
  }

  // ---- the verdict
  const status = abacus && abacus.status ? abacus.status : bundle && bundle.status;
  const code = status ? status.code : null;
  const fatal = out.lines.find((l) => l.kind === 'fatal' && l.source === 'abacus');
  if (code === 'ERROR' || fatal) {
    return { tone: 'err', text: fatal ? `进程异常终止：${fatal.why}（${fatal.file} 第 ${fatal.line} 行）` : `进程异常终止：${status.reason}` };
  }
  if (code === 'FINISHED_UNCONVERGED') {
    if (log && log.ionicConvergedScfNot) return { tone: 'warn', text: '离子步收敛了，但最后的电子步没有收敛：结构可能可用，能量与力不可信' };
    const parts = [];
    if (scf && scf.nmax !== null) parts.push(scf.steps >= scf.nmax ? `用满 scf_nmax = ${scf.nmax} 步` : `${scf.steps} 步后停止（scf_nmax = ${scf.nmax}）`);
    if (scf && scf.drho !== null) parts.push(`末次 drho = ${fmtSci(scf.drho)}${scf.thr !== null ? ` > scf_thr = ${fmtSci(scf.thr)}` : ''}`);
    return { tone: 'warn', text: `电子步没有收敛${parts.length ? `：${parts.join('，')}` : ''}` };
  }
  if (code === 'RUNNING') {
    const stat = logPath ? safeStat(logPath) : null;
    const age = ageSeconds(stat ? stat.mtimeMs : null);
    const where = lastLine ? `（末行：${lastLine.file} 第 ${lastLine.line} 行）` : '';
    if (age !== null && age > STALE_SECONDS) {
      return { tone: 'warn', text: `日志 ${fmtAge(age)}没有更新，也没有结束标记：多半已被中断${where}` };
    }
    return { tone: 'info', text: `还没有结束标记，日志 ${age === null ? '修改时间未知' : `${fmtAge(age)}前`}更新：可能仍在运行${where}` };
  }
  if (code === 'NO_OUTPUT') return { tone: 'info', text: status.reason || '没有可读的主日志' };
  if (code === 'FINISHED' || terminated) {
    const absent = out.checks.filter((c) => c.ok === null && c.asked.startsWith('out_')).length;
    const converged = scf && scf.converged ? '，电子步收敛' : '';
    if (absent > 0) return { tone: 'ok', text: `正常结束${converged}；INPUT 要求的 ${absent} 类输出本地没有（没有产出，或没有拉回）` };
    return { tone: 'ok', text: `正常结束${converged}` };
  }
  return { tone: 'info', text: status ? status.reason : '还没有读取状态' };
}

/** Quote the lines the ABACUS classifier decides on. */
function scanAbacusLog(text, file) {
  const M = ABACUS_LOG_MARKERS;
  const lines = [];
  const last = {};
  let fatalCount = 0;
  let lastLine = null;
  const all = numberedLines(text);
  for (let i = 0; i < all.length; i += 1) {
    const { line, text: raw } = all[i];
    const t = raw.trim();
    if (!t) continue;
    lastLine = { file, line, text: clip(t) };
    if (M.notice.test(raw) && fatalCount < MAX_FATAL_LINES) {
      // WARNING_QUIT: the message follows the !NOTICE! banner.
      const message = all.slice(i + 1, i + 8).map((l) => l.text.trim()).filter((s) => s && !/^[-=]{5,}$/.test(s) && s !== 'NOTICE').slice(0, 2);
      lines.push({ file, line, text: clip([t, ...message].join(' | ')), why: 'ABACUS 主动中止（WARNING_QUIT）', kind: 'fatal', source: 'abacus' });
      fatalCount += 1;
      continue;
    }
    const sig = fatalCount < MAX_FATAL_LINES ? M.fatal.find((s) => s.re.test(t)) : null;
    if (sig) {
      lines.push({ file, line, text: clip(t), why: sig.message, kind: 'fatal', source: 'abacus' });
      fatalCount += 1;
      continue;
    }
    if (M.relaxConvergedScfNot.test(t)) last.relax = { file, line, text: clip(t), why: '离子步收敛但电子步未收敛', kind: 'verdict', source: 'abacus' };
    else if (M.scfNotConverged.test(raw)) last.scf = { file, line, text: clip(t), why: '电子步未收敛', kind: 'verdict', source: 'abacus' };
    else if (M.scfConverged.test(raw)) last.scf = { file, line, text: clip(t), why: '电子步收敛', kind: 'verdict', source: 'abacus' };
    else if (M.exxNotConverged.test(t)) last.exx = { file, line, text: clip(t), why: 'EXX 自洽未收敛', kind: 'verdict', source: 'abacus' };
    else if (M.totalTime.test(t)) last.end = { file, line, text: clip(t), why: '正常结束标记', kind: 'end', source: 'abacus' };
  }
  for (const key of ['scf', 'relax', 'exx', 'end']) if (last[key]) lines.push(last[key]);
  if (!last.end && lastLine) lines.push({ ...lastLine, why: '日志末行：没有结束标记', kind: 'last', source: 'abacus' });
  return { lines, terminated: Boolean(last.end), lastLine };
}

/** Pseudopotential and orbital files named in STRU, resolved the way ABACUS does. */
function checkSpeciesFiles(base, abacus, asked, out, ran) {
  const species = abacus && abacus.stru && Array.isArray(abacus.stru.species) ? abacus.stru.species : [];
  if (species.length === 0) return;
  const groups = [
    { dirKey: 'pseudo_dir', what: '赝势', files: species.map((s) => s.pp).filter(Boolean) },
    { dirKey: 'orbital_dir', what: '数值原子轨道', files: species.flatMap((s) => s.orbitals || []).filter(Boolean) },
  ];
  for (const group of groups) {
    if (group.files.length === 0) continue;
    const dirValue = asked(group.dirKey);
    const dirName = dirValue ? dirValue.value : './';
    const dir = resolve(base, dirName);
    if (!safeStat(dir)) {
      out.notes.push(`${group.dirKey} = ${dirName} 在本地不存在，无法核对${group.what}文件（${group.files.join('、')}）`);
      continue;
    }
    const absent = group.files.filter((name) => !safeStat(resolve(dir, name)));
    if (absent.length === 0) continue;
    if (ran) {
      out.notes.push(`STRU 引用的${group.what}文件本地不在（${absent.join('、')}）：运行时它们在计算机器上，只影响在本地重跑`);
      continue;
    }
    for (const name of absent) out.missing.push({ name: `${dirName.replace(/\/?$/, '/')}${name}`, why: `STRU 引用的${group.what}`, need: 'required' });
  }
}

// ------------------------------------------------------------------ LibRPA ---

function diagnoseLibrpa(task, bundle, out) {
  const base = task.absPath;
  const librpa = bundle ? bundle.librpa : null;
  if (!librpa) {
    out.missing.push({ name: 'librpa.in', why: 'LibRPA 的参数文件', need: 'required' });
    return { tone: 'err', text: '没有 librpa.in：不知道这个阶段要算什么' };
  }
  const params = librpa.input ? librpa.input.params : {};
  const taskName = String(getLibrpaParam(params, 'task') ?? '').toLowerCase() || null;
  const outRel = librpa.outputDir || '.';
  const outDir = resolve(base, outRel);
  const outListing = listDir(outDir);
  if (outRel !== '.' && !outListing) out.missing.push({ name: `${outRel}/`, why: 'output_dir：结果写在这里', need: 'expected' });

  // ---- decisive lines
  let lastLine = null;
  let terminated = false;
  if (librpa.logFile) {
    const raw = readTextCapped(resolve(base, librpa.logFile), MAX_LOG_BYTES);
    if (raw) {
      const scanned = scanLibrpaLog(raw.text, librpa.logFile);
      out.lines.push(...scanned.lines);
      lastLine = scanned.lastLine;
      terminated = scanned.terminated;
    }
  } else {
    out.missing.push({ name: 'librpa.out', why: '主日志（stdout）；没有它就无法确认正常结束', need: 'expected' });
  }
  const errText = readTextCapped(resolve(base, 'librpa.err'), MAX_SIDE_BYTES);
  if (errText) {
    // One quote per kind of line: every MPI step of a cancelled job prints the same banner.
    const seen = new Map();
    for (const l of numberedLines(errText.text).filter((x) => x.text.trim())) {
      const t = l.text.trim();
      const ended = SCHEDULER_SIGNATURES.find((sig) => sig.re.test(t));
      const sig = ended || LIBRPA_LOG_SIGNATURES.find((x) => x.re.test(t));
      const key = sig ? sig.code : `stderr:${l.line}`;
      if (seen.has(key)) {
        seen.get(key).repeats += 1;
        continue;
      }
      if (seen.size >= 4) break;
      const entry = { file: 'librpa.err', line: l.line, text: clip(t), why: sig ? sig.message : '标准错误输出', kind: sig ? 'fatal' : 'stderr', source: 'librpa', repeats: 0, ...(ended ? { scheduler: true } : {}) };
      seen.set(key, entry);
      out.lines.push(entry);
    }
    for (const entry of seen.values()) {
      if (entry.repeats > 0) entry.why = `${entry.why}；另有 ${entry.repeats} 行同类`;
      delete entry.repeats;
    }
  }
  const exitcode = librpa.files ? librpa.files.exitcode : null;
  if (exitcode !== null && exitcode !== undefined) {
    out.lines.push({ file: 'librpa.exitcode', line: 1, text: String(exitcode), why: exitcode === 0 ? '退出码 0' : terminated ? '退出码非零，但日志有成功结束标记（以标记为准）' : '退出码非零', kind: exitcode === 0 || terminated ? 'end' : 'fatal', source: 'librpa' });
  }

  // ---- what librpa.in asked for, against what is there
  // The iteration table is the record; without it (not pulled back) the log's own
  // `QSGW iteration n: max_delta= …` lines say the same thing.
  const table = librpa.qsgw && librpa.qsgw.iterations ? librpa.qsgw.iterations.rows || [] : [];
  const progress = librpa.log && Array.isArray(librpa.log.qsgwProgress) ? librpa.log.qsgwProgress : [];
  const fromLog = table.length === 0 && progress.length > 0;
  const rows = fromLog ? progress.map((p) => ({ iter: p.iteration, max_delta_eV: p.maxDeltaEv, converged: p.converged })) : table;
  const convergedIter = fromLog
    ? (progress.find((p) => p.converged) || {}).iteration ?? null
    : librpa.qsgw && librpa.qsgw.iterations ? librpa.qsgw.iterations.convergedIter ?? null : null;
  const span = rows.length ? `第 ${rows[0].iter}–${rows[rows.length - 1].iter} 次` : '';
  if (taskName === 'qsgw') {
    const maxIter = getLibrpaNumber(params, 'qsgw_max_iter');
    const tol = getLibrpaNumber(params, 'qsgw_convergence_tolerance_ev');
    const last = rows.length ? rows[rows.length - 1] : null;
    out.checks.push({
      asked: [`task = qsgw`, maxIter !== null ? `qsgw_max_iter = ${maxIter}` : null, tol !== null ? `收敛判据 ${tol} eV` : null].filter(Boolean).join(' · '),
      found: rows.length
        ? `${fromLog ? `${librpa.logFile} 的迭代行` : `${outRel}/qsgw_iterations.dat`}：${span}${last && typeof last.max_delta_eV === 'number' ? `，末次 max ΔE = ${fmtSci(last.max_delta_eV)} eV` : ''}`
        : '没有 qsgw_iterations.dat，日志里也没有迭代行',
      ok: convergedIter !== null ? true : rows.length ? false : null,
      note: convergedIter !== null ? `第 ${convergedIter} 次迭代收敛` : rows.length ? (maxIter !== null && last && last.iter >= maxIter ? '用满 qsgw_max_iter 仍未收敛' : '没有一行达到判据') : '迭代表不在本地',
    });
    if (!table.length) out.missing.push({ name: `${outRel}/qsgw_iterations.dat`, why: 'QSGW 每次迭代的能隙与 max ΔE', need: 'expected' });
  } else if (taskName) {
    out.checks.push({ asked: `task = ${taskName}`, found: librpa.logFile ? `${librpa.logFile} 在` : '没有主日志', ok: librpa.logFile ? true : null, note: '结果写在主日志里' });
  }
  const bandInfo = getLibrpaParam(params, 'fn_band_kpath_info');
  if (bandInfo) {
    const bandFiles = librpa.files ? librpa.files.bandFiles || [] : [];
    out.checks.push({
      asked: `fn_band_kpath_info = ${bandInfo}（输出能带）`,
      found: bandFiles.length ? describeLibrpaBandFiles(bandFiles, librpa.bandEnergies) : '本地没有能带文件',
      ok: bandFiles.length ? true : null,
      note: bandFiles.length ? 'KS / EXX / QSGW 能带' : '没有产出，或没有拉回本地',
    });
  }
  const inputDir = getLibrpaParam(params, 'input_dir');
  if (inputDir) {
    const posixAbsolute = /^\//.test(inputDir) && process.platform === 'win32';
    const dir = posixAbsolute ? null : isAbsolute(inputDir) ? inputDir : resolve(base, inputDir);
    const listing = dir ? listDir(dir) : null;
    if (!listing) {
      out.notes.push(posixAbsolute
        ? `input_dir = ${inputDir} 是集群上的路径，本地无法核对它的 fn_* / prefix_* 输入文件`
        : `input_dir = ${inputDir} 在本地不存在，无法核对 LibRPA 的输入文件`);
    } else {
      const present = new Set(listing.map((f) => f.name));
      for (const [key, value] of Object.entries(params)) {
        if (!/^fn_/.test(key) || key === 'fn_band_kpath_info' || !value) continue;
        if (!present.has(String(value))) out.missing.push({ name: `${inputDir.replace(/\/?$/, '/')}${value}`, why: `librpa.in 的 ${key}`, need: 'required' });
      }
      for (const [key, value] of Object.entries(params)) {
        if (!/^prefix_/.test(key) || !value || String(value).includes('/')) continue;
        if (![...present].some((name) => name.startsWith(String(value)))) out.missing.push({ name: `${inputDir.replace(/\/?$/, '/')}${value}*`, why: `librpa.in 的 ${key}`, need: 'required' });
      }
    }
  }

  // ---- the verdict
  const status = librpa.status || (bundle && bundle.status);
  const code = status ? status.code : null;
  const fatal = out.lines.find((l) => l.kind === 'fatal' && l.source === 'librpa');
  if (code === 'ERROR' || (fatal && !terminated)) {
    return { tone: 'err', text: fatal ? `LibRPA 异常退出：${fatal.why}（${fatal.file} 第 ${fatal.line} 行）` : `LibRPA 异常退出：${status.reason}` };
  }
  if (taskName === 'qsgw' && rows.length && convergedIter === null && (code === 'FINISHED' || code === 'FINISHED_NO_LOG')) {
    const last = rows[rows.length - 1];
    return { tone: 'warn', text: `QSGW 迭代（${span}）没有达到收敛判据${last && typeof last.max_delta_eV === 'number' ? `：末次 max ΔE = ${fmtSci(last.max_delta_eV)} eV` : ''}` };
  }
  if (code === 'FINISHED_NO_LOG') {
    return { tone: 'warn', text: `有结果文件，但没有 librpa.out：无法确认正常结束${convergedIter !== null ? `（迭代表第 ${convergedIter} 次收敛）` : ''}` };
  }
  if (code === 'RUNNING') {
    const stat = librpa.logFile ? safeStat(resolve(base, librpa.logFile)) : null;
    const age = ageSeconds(stat ? stat.mtimeMs : null);
    const where = lastLine ? `（末行：${lastLine.file} 第 ${lastLine.line} 行）` : '';
    if (age !== null && age > STALE_SECONDS) return { tone: 'warn', text: `日志 ${fmtAge(age)}没有更新，也没有成功结束标记：多半已被中断${where}` };
    return { tone: 'info', text: `还没有成功结束标记：可能仍在运行${where}` };
  }
  if (code === 'NO_OUTPUT') return { tone: 'info', text: '没有 librpa.out，也没有结果文件：这个阶段没有运行，或输出没有拉回本地' };
  if (code === 'FINISHED') return { tone: 'ok', text: `正常结束${convergedIter !== null ? `，QSGW 第 ${convergedIter} 次迭代收敛` : ''}` };
  return { tone: 'info', text: status ? status.reason : '还没有读取状态' };
}

/** Quote the lines the LibRPA classifier decides on, plus the QSGW progress it reports. */
function scanLibrpaLog(text, file) {
  const lines = [];
  let fatalCount = 0;
  let lastLine = null;
  let end = null;
  let lastIter = null;
  let convergedIter = null;
  for (const { line, text: raw } of numberedLines(text)) {
    const t = raw.trim();
    if (!t) continue;
    lastLine = { file, line, text: clip(t) };
    if (t === 'libRPA finished successfully') {
      end = { file, line, text: t, why: '成功结束标记', kind: 'end', source: 'librpa' };
      continue;
    }
    if (/^QSGW iteration\s+\d+/i.test(t)) {
      lastIter = { file, line, text: clip(t), why: 'QSGW 最后一次迭代', kind: 'verdict', source: 'librpa' };
      if (!convergedIter && /,\s*converged\b|\bconverged\s*$/i.test(t)) convergedIter = { file, line, text: clip(t), why: 'QSGW 收敛', kind: 'verdict', source: 'librpa' };
      continue;
    }
    const sig = fatalCount < MAX_FATAL_LINES ? LIBRPA_LOG_SIGNATURES.find((s) => s.re.test(t)) : null;
    if (sig) {
      lines.push({ file, line, text: clip(t), why: sig.message, kind: 'fatal', source: 'librpa' });
      fatalCount += 1;
    }
  }
  if (convergedIter) lines.push(convergedIter);
  if (lastIter && (!convergedIter || lastIter.line !== convergedIter.line)) lines.push(lastIter);
  if (end) lines.push(end);
  else if (lastLine) lines.push({ ...lastLine, why: '日志末行：没有成功结束标记', kind: 'last', source: 'librpa' });
  return { lines, terminated: Boolean(end), lastLine };
}

// -------------------------------------------------------------- job output ---

/** Scheduler / wrapper output next to the run: a time limit or an OOM kill shows here. */
function scanJobOutputs(base, out) {
  const entries = (listDir(base) ?? []).filter((f) => !f.isDir && JOB_OUTPUT.test(f.name) && f.name !== 'librpa.out');
  const signatures = [...ABACUS_LOG_MARKERS.fatal, ...LIBRPA_LOG_SIGNATURES];
  for (const entry of entries.slice(0, 6)) {
    const raw = readTextCapped(resolve(base, entry.name), MAX_SIDE_BYTES);
    if (!raw) continue;
    let found = 0;
    for (const { line, text } of numberedLines(raw.text)) {
      const t = text.trim();
      const sig = t ? signatures.find((s) => s.re.test(t)) : null;
      if (!sig) continue;
      out.lines.push({ file: entry.name, line, text: clip(t), why: sig.message, kind: 'fatal', source: 'job' });
      found += 1;
      if (found >= 2) break;
    }
  }
}

// ----------------------------------------------------------------- helpers ---

/** "6 个能带文件：KS、EXX、QSGW × 自旋 1、2，364 k × 80 态" from the names and the bundle's sizes. */
function describeLibrpaBandFiles(names, sizes) {
  const kinds = [...new Set(names.map((n) => (/^(QSGW|GW|EXX|KS)_/i.exec(n) || [])[1]).filter(Boolean))];
  const spins = [...new Set(names.map((n) => Number((/_spin_(\d+)/i.exec(n) || [])[1])).filter(Number.isFinite))].sort();
  const size = Object.values(sizes || {})[0];
  return `${names.length} 个能带文件：${kinds.join('、')}${spins.length ? ` × 自旋 ${spins.join('、')}` : ''}${size ? `，${size.nKpoint} k × ${size.nState} 态` : ''}`;
}

function numberedLines(text) {
  return String(text).split(/\r\n|\n|\r/).map((value, index) => ({ line: index + 1, text: value }));
}

function clip(text) {
  const t = String(text);
  return t.length > 240 ? `${t.slice(0, 240)}…` : t;
}

function fmtSci(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
  return Math.abs(value) >= 1e-3 && Math.abs(value) < 1e4 ? String(+value.toPrecision(4)) : value.toExponential(2);
}

function fmtAge(seconds) {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} 分钟`;
  if (seconds < 86400 * 2) return `${(seconds / 3600).toFixed(1)} 小时`;
  return `${Math.round(seconds / 86400)} 天`;
}
