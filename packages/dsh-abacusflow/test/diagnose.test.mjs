/**
 * Per-stage diagnosis (lib/host/diagnose.js): "why is this stage in this state?"
 *
 * Every case is a real temp directory read through the real scanner and bundle, built from
 * the repository's ABACUS/LibRPA fixtures or from the shapes of the real runs this was
 * developed against (2026-11-02): a Slurm-cancelled Bi2Se3 QSGW run whose librpa.out just
 * stops, the NiO QSGW run that kept no librpa.out, ABACUS stages pulled back without their
 * charge densities. The diagnosis must quote the decisive line with its file and line
 * number, compare what the input asked for with what is there, and never call "not here"
 * "not produced".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanProject } from '../lib/host/scanner.js';
import { buildTaskBundle } from '../lib/host/task-bundle.js';
import { diagnoseStage } from '../lib/host/diagnose.js';

const FIX = new URL('./fixtures/', import.meta.url);
const fixture = (rel) => new URL(rel, FIX);

/** Scan `root`, find `relPath`, and diagnose it through the real bundle. */
async function diagnose(root, relPath) {
  const scan = await scanProject(root, { maxDepth: 4 });
  const task = scan.tasks.find((t) => t.relPath === relPath);
  assert.ok(task, `task ${relPath} scanned; got ${scan.tasks.map((t) => t.relPath).join(', ')}`);
  return diagnoseStage(task, buildTaskBundle(task, { includeScene: false }));
}

/** An ABACUS stage from the fixtures, with INPUT lines appended and a chosen log. */
function abacusStage(root, rel, { input = [], log = null, files = {} } = {}) {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'INPUT'), `${readFileSync(fixture('abacus/INPUT'), 'utf8')}\n${input.join('\n')}\n`);
  copyFileSync(fixture('abacus/STRU'), join(dir, 'STRU'));
  copyFileSync(fixture('abacus/KPT'), join(dir, 'KPT'));
  if (log) {
    mkdirSync(join(dir, 'OUT.si2'), { recursive: true });
    copyFileSync(fixture(`abacus/${log}`), join(dir, 'OUT.si2', 'running_scf.log'));
  }
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

function withTemp(fn) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'abacusflow-diagnose-'));
    try {
      await fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

// ------------------------------------------------------------------ ABACUS ---

test('an unconverged SCF: the verdict line, its file and line, and scf_nmax against the log', withTemp(async (root) => {
  abacusStage(root, 'scf', { input: ['calculation scf', 'scf_nmax 50'], log: 'running_scf.unconverged.log' });
  const d = await diagnose(root, 'scf');
  assert.equal(d.verdict.tone, 'warn');
  assert.match(d.verdict.text, /电子步没有收敛：用满 scf_nmax = 50 步/);
  assert.match(d.verdict.text, /scf_thr = 1\.00e-6/);
  const verdictLine = d.lines.find((l) => l.kind === 'verdict');
  assert.deepEqual([verdictLine.file, verdictLine.line, verdictLine.text], ['OUT.si2/running_scf.log', 15, '!!SCF IS NOT CONVERGED!!']);
  assert.ok(d.lines.some((l) => l.kind === 'end' && l.line === 17), 'the terminator is quoted too');
  const scf = d.checks.find((c) => c.asked.includes('scf_nmax'));
  assert.equal(scf.ok, false);
  assert.match(scf.found, /^50 步/);
  assert.equal(scf.note, '用满了 scf_nmax 仍未收敛');
}));

test('an output INPUT asked for and that is not here is "not here", never "not produced"', withTemp(async (root) => {
  abacusStage(root, 'scf', { log: 'running_scf.unconverged.log' });
  const d = await diagnose(root, 'scf');
  const chg = d.checks.find((c) => c.asked.startsWith('out_chg'));
  assert.equal(chg.found, '本地没有');
  assert.equal(chg.ok, null, 'unknown, not failed');
  assert.match(chg.note, /没有产出，或没有拉回本地/);
}));

test('ABACUS\'s own abort (WARNING_QUIT) decides the verdict, with its message', withTemp(async (root) => {
  abacusStage(root, 'scf', { log: 'running_scf.notice.log' });
  const d = await diagnose(root, 'scf');
  assert.equal(d.verdict.tone, 'err');
  assert.match(d.verdict.text, /WARNING_QUIT.*running_scf\.log 第 8 行/);
  const fatal = d.lines.find((l) => l.kind === 'fatal');
  assert.match(fatal.text, /Can't find pseudopotential file: missing\.UPF/);
}));

test('a log that stops without a terminator quotes its last line', withTemp(async (root) => {
  abacusStage(root, 'relax', { log: 'running_scf.crashed.log' });
  const d = await diagnose(root, 'relax');
  const last = d.lines.find((l) => l.kind === 'last');
  assert.deepEqual([last.file, last.line], ['OUT.si2/running_scf.log', 12]);
  assert.match(d.verdict.text, /第 12 行/);
}));

test('a scheduler time limit in slurm-*.out is the cause, though the log just stops', withTemp(async (root) => {
  abacusStage(root, 'relax', {
    log: 'running_scf.crashed.log',
    files: { 'slurm-3704890.out': 'starting abacus\nslurmstepd: error: *** JOB 3704890 ON c21001 CANCELLED AT 2026-10-19T16:27:44 DUE TO TIME LIMIT ***\n' },
  });
  const d = await diagnose(root, 'relax');
  assert.equal(d.verdict.tone, 'err');
  assert.match(d.verdict.text, /运行被终止.*slurm-3704890\.out 第 2 行/);
}));

test('no output directory: not run, or not pulled back — and nothing else is claimed', withTemp(async (root) => {
  abacusStage(root, 'tzdp');
  const d = await diagnose(root, 'tzdp');
  assert.equal(d.verdict.tone, 'info');
  assert.match(d.verdict.text, /没有输出目录 OUT\.si2：这个阶段没有运行，或输出没有拉回本地/);
  assert.ok(d.missing.some((m) => m.name === 'OUT.si2/'));
  assert.equal(d.lines.length, 0);
}));

test('nbands and nspin are checked against the band files actually present', withTemp(async (root) => {
  // ABACUS layout: `<ik> <k-path length> <E_1> … <E_nband>`; 3 bands here, and only spin 1.
  const dir = abacusStage(root, 'bands', { input: ['nbands 4', 'nspin 2', 'out_band 1'], log: 'running_scf.log' });
  writeFileSync(join(dir, 'OUT.si2', 'bands1.txt'), '1 0.0000 -5.1 2.2 3.3\n2 0.1000 -5.0 2.3 3.4\n');
  const d = await diagnose(root, 'bands');
  const nbands = d.checks.find((c) => c.asked.startsWith('nbands'));
  assert.equal(nbands.ok, false);
  assert.match(nbands.found, /bands1\.txt 2 k × 3 带/);
  const spins = d.checks.find((c) => c.asked.startsWith('nspin = 2'));
  assert.equal(spins.ok, null, 'a missing spin file is "not here", not "not produced"');
  assert.match(spins.note, /没有自旋 2 的能带文件/);
}));

test('a missing KPT is required unless INPUT replaces it with kspacing', withTemp(async (root) => {
  const dir = abacusStage(root, 'a');
  rmSync(join(dir, 'KPT'));
  assert.ok((await diagnose(root, 'a')).missing.some((m) => m.name === 'KPT' && m.need === 'required'));
  const dir2 = abacusStage(root, 'b', { input: ['kspacing 0.1'] });
  rmSync(join(dir2, 'KPT'));
  assert.ok(!(await diagnose(root, 'b')).missing.some((m) => m.name === 'KPT'));
}));

// ------------------------------------------------------------------ LibRPA ---

const ITER = '# iter max_delta_eV residual_l2_Ha residual_max_Ha efermi_eV gap_eV electron_count beta converged';
const row = (iter, delta) => `${iter} ${delta.toExponential(6)} 0 0 15.78 2.28 48 1 0`;

test('a Slurm-cancelled LibRPA run: librpa.err decides, the log\'s last line is quoted', withTemp(async (root) => {
  const dir = join(root, 'run');
  mkdirSync(join(dir, 'librpa.d'), { recursive: true });
  writeFileSync(join(dir, 'librpa.in'), ['task = qsgw', 'output_dir = librpa.d', 'qsgw_max_iter = 5'].join('\n'));
  writeFileSync(join(dir, 'librpa.out'), [
    'Initialized LibRPA global environment at [2026-10-19 07:00:00.000]',
    'QSGW iteration 1: max_delta= 5.49505816e+01 eV gap= 0.00000000 eV mixer=none',
    'Task   25. libRI G0W0, spin 0, bra 1, ket 1, time grid    -0.832247.',
  ].join('\n'));
  // Every MPI step of a cancelled job prints the same banner, as in the real run.
  writeFileSync(join(dir, 'librpa.err'), ['c21001', 'c21057', 'c21064', 'c21072']
    .map((node, i) => `slurmstepd-${node}: error: *** STEP 3704890.${i} ON ${node} CANCELLED AT 2026-10-19T16:27:44 ***`).join('\n'));
  const d = await diagnose(root, 'run');
  assert.equal(d.verdict.tone, 'err');
  assert.match(d.verdict.text, /运行被终止：作业被调度器取消（CANCELLED）（librpa\.err 第 1 行）/);
  assert.ok(d.lines.some((l) => l.file === 'librpa.out' && l.line === 3 && l.kind === 'last'));
  assert.ok(d.lines.some((l) => l.file === 'librpa.out' && l.line === 2 && /QSGW/.test(l.why)));
  const banners = d.lines.filter((l) => l.file === 'librpa.err');
  assert.equal(banners.length, 1, 'one quote for four identical banners');
  assert.match(banners[0].why, /另有 3 行同类/);
  assert.match(d.notes[0], /状态仍是「运行中」.*librpa\.err 第 1 行/, 'the running status beside the verdict is explained');
}));

test('results without librpa.out: an unconverged QSGW table is named, the missing log listed', withTemp(async (root) => {
  const dir = join(root, 'qsgw');
  mkdirSync(join(dir, 'librpa.d'), { recursive: true });
  writeFileSync(join(dir, 'librpa.in'), ['task = qsgw', 'output_dir = librpa.d', 'qsgw_max_iter = 1', 'qsgw_convergence_tolerance_ev = 1e-4',
    'input_dir = /data/home/cluster-user/ai-runs/x/producer/DZP/librpa/input'].join('\n'));
  writeFileSync(join(dir, 'librpa.d', 'qsgw_iterations.dat'), [ITER, row(0, 0), row(1, 14.344975)].join('\n'));
  const d = await diagnose(root, 'qsgw');
  assert.equal(d.verdict.tone, 'warn');
  assert.match(d.verdict.text, /QSGW 迭代（第 0–1 次）没有达到收敛判据：末次 max ΔE = 14\.34 eV/);
  const check = d.checks.find((c) => c.asked.startsWith('task = qsgw'));
  assert.equal(check.ok, false);
  assert.equal(check.note, '用满 qsgw_max_iter 仍未收敛');
  assert.ok(d.missing.some((m) => m.name === 'librpa.out'));
  assert.ok(d.notes.some((n) => /集群上的路径/.test(n)), 'a cluster input_dir is said to be uncheckable, not missing');
}));

test('a local input_dir is checked against every fn_* and prefix_* librpa.in names', withTemp(async (root) => {
  const input = join(root, 'producer', 'export');
  mkdirSync(input, { recursive: true });
  writeFileSync(join(input, 'band_out'), '');
  writeFileSync(join(input, 'KS_eigenvector_0.dat'), '');
  const dir = join(root, 'consumer');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'librpa.in'), ['task = g0w0', 'input_dir = ../producer/export', 'fn_eigocc_scf = band_out',
    'fn_stru = stru_out', 'prefix_eigvecs_scf = KS_eigenvector', 'prefix_lri_coeff = v1_Cs_data_'].join('\n'));
  writeFileSync(join(dir, 'librpa.out'), 'libRPA finished successfully\n');
  const d = await diagnose(root, 'consumer');
  const names = d.missing.map((m) => m.name);
  assert.ok(names.includes('../producer/export/stru_out'), names.join(' | '));
  assert.ok(names.includes('../producer/export/v1_Cs_data_*'));
  assert.ok(!names.some((n) => /band_out|KS_eigenvector/.test(n)), 'present inputs are not listed');
  assert.equal(d.verdict.tone, 'ok');
}));
