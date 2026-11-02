/**
 * Behaviour of the panel's pure logic: run grouping, stage states, lineage, k-mesh series,
 * band alignment, gap provenance and the messages handed to the agent.
 *
 * `lib/client.js` is one pre-bundled script for the DSH module loader, so it cannot be
 * imported. Its non-React logic lives between `@pure-begin` and `@pure-end`; this file
 * evaluates exactly that region in a fresh context. Anything the panel *claims* — a state,
 * a lineage edge, an alignment, the file a number came from — is decided there, so these
 * tests check outcomes rather than source text.
 *
 * Fixtures mirror the real data the panel was redesigned against (2026-11-02):
 * NiO (producer/DZP + producer/TZDP → qsgw), Bi2Se3 (producer/work → consumer-one-update-r1),
 * Si (k444 / k666 runs of coupled stages).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const begin = source.indexOf('/* @pure-begin');
const end = source.indexOf('/* @pure-end */');
assert.ok(begin > 0 && end > begin, 'pure region markers found');
const region = source.slice(begin, end);

const EXPORTS = [
  'groupRuns', 'lanesOf', 'rootIsRun', 'stageState', 'lineageOf', 'meshToken', 'detectSeries',
  'samePath', 'eigenIdentity', 'alignChannel', 'defaultWindow', 'ticksFor', 'rankBandSources',
  'buildBandChannels', 'bandStyle', 'gapLedger', 'collapseLedger', 'buildAskContext', 'tailPath', 'handoffIntents',
  'buildHandoffMessage', 'natCompare', 'ENERGY_ZERO_NOTE', 'abacusFermi', 'librpaFermi', 'fmtMeV',
  'mainViewSessionId', 'describeSessionLink', 'describeRemoteError', 'submissionStep', 'submissionLabel', 'postToSession',
  'groupFigures', 'jsonOutline', 'fmtBytes', 'buildDiagnosisMessage', 'DIAGNOSIS_GLYPH',
  'methodFamily', 'recordSpinFacts', 'localCompareFacts', 'compareWithRecord', 'gapComparison', 'baseName',
];
// Wrapped in a function and run in this context, so arrays and objects share this realm's
// prototypes (deepStrictEqual compares them) and nothing leaks into the global scope.
const P = vm.runInThisContext(`(function () {\n${region}\nreturn { ${EXPORTS.join(', ')} };\n})()`, {
  filename: 'client.js#pure',
});

// The pure region must stay free of React, the DOM and storage, or it could not run here.
test('the pure region does not touch React, the DOM or storage', () => {
  for (const banned of ['React.', 'useState', 'useEffect', 'document.', 'window.', 'localStorage', 'fetch(', ' h(']) {
    assert.ok(!region.includes(banned), `pure region uses ${banned}`);
  }
});

const ROOT = '\\\\wsl$\\Ubuntu\\home\\user\\runs\\from-cluster';
let serial = 0;
function task(relPath, kind, extra = {}) {
  serial += 1;
  return {
    id: `t${serial}`,
    relPath,
    absPath: `${ROOT}\\${relPath.replace(/\//g, '\\')}`,
    name: relPath.split('/').pop(),
    kind,
    status: extra.status || { code: 'FINISHED', label: '已完成', reason: '', evidence: [] },
    hasStru: kind !== 'librpa',
    hasBands: false,
    ageSeconds: extra.ageSeconds ?? null,
    outputDir: extra.outputDir ?? null,
  };
}
const NO_OUTPUT = { code: 'NO_OUTPUT', label: '未开始', reason: '没有 OUT 目录', evidence: [] };

const sampleTasks = [
  task('nio-matched-dzp-k666-20261016-r1/qsgw', 'librpa', { status: NO_OUTPUT }),
  task('nio-matched-dzp-k666-20261016-r1/producer/DZP/03_bands', 'abacus'),
  task('nio-matched-dzp-k666-20261016-r1/producer/TZDP/01_scf', 'abacus', { status: NO_OUTPUT }),
  task('nio-matched-dzp-k666-20261016-r1/producer/DZP/01_scf', 'abacus'),
  task('nio-matched-dzp-k666-20261016-r1/producer/DZP/02_export', 'abacus'),
  task('bi2se3-soc-abacus-reexport-20261025-r1/consumer-one-update-r1/run', 'librpa'),
  task('bi2se3-soc-abacus-reexport-20261025-r1/producer/work/band_full', 'abacus'),
  task('si-qsgw-k666-headwing-kconv-20260517-203305/frozen', 'coupled'),
  task('si-qsgw-k444-headwing-kconv-20260517-203305/frozen', 'coupled'),
  task('si-qsgw-k666-headwing-kconv-20260517-203305/keep_sweep/keep_10_refresh', 'coupled'),
  task('si-qsgw-k666-headwing-kconv-20260517-203305/keep_sweep/keep_6_refresh', 'coupled'),
];
const runs = P.groupRuns(sampleTasks, ROOT);
const nio = runs.find((r) => r.key.startsWith('nio-'));
const stageOf = (run, rel) => run.stages.find((s) => s.rel === rel);

// ---------------------------------------------------------------- runs ---

test('a collection root groups tasks into dated runs, in natural order', () => {
  assert.deepEqual(runs.map((r) => r.name), [
    'bi2se3-soc-abacus-reexport-20261025-r1',
    'nio-matched-dzp-k666-20261016-r1',
    'si-qsgw-k444-headwing-kconv-20260517-203305',
    'si-qsgw-k666-headwing-kconv-20260517-203305',
  ]);
  assert.equal(nio.absPath, `${ROOT}\\nio-matched-dzp-k666-20261016-r1`);
});

test('stages run producer → consumer, branches in order, steps in natural order', () => {
  assert.deepEqual(nio.stages.map((s) => s.rel), [
    'producer/DZP/01_scf',
    'producer/DZP/02_export',
    'producer/DZP/03_bands',
    'producer/TZDP/01_scf',
    'qsgw',
  ]);
  assert.deepEqual(nio.counts, { producer: 4, coupled: 0, consumer: 1 });
  const lanes = P.lanesOf(nio);
  assert.deepEqual(lanes.map((l) => l.role), ['producer', 'consumer']);
  assert.deepEqual(lanes[0].branches.map((b) => b.name), ['producer/DZP', 'producer/TZDP']);
  const si = runs.find((r) => r.key.startsWith('si-qsgw-k666'));
  // keep_6 sorts before keep_10 (natural order, not lexical).
  assert.deepEqual(si.stages.map((s) => s.rel), ['frozen', 'keep_sweep/keep_6_refresh', 'keep_sweep/keep_10_refresh']);
});

test('a scan root that is itself a run becomes one run named after the folder', () => {
  const inside = [task('producer/DZP/01_scf', 'abacus'), task('qsgw', 'librpa')];
  const one = P.groupRuns(inside, 'D:\\runs\\nio-matched-dzp-k666-20261016-r1');
  assert.equal(one.length, 1);
  assert.equal(one[0].key, '.');
  assert.equal(one[0].name, 'nio-matched-dzp-k666-20261016-r1');
  assert.equal(P.rootIsRun(inside), true);
  assert.equal(P.rootIsRun(sampleTasks), false, 'dated run folders mean a collection');
});

// -------------------------------------------------------------- states ---

const qsgwBundle = (rows, convergedIter, status) => ({
  status,
  librpa: { task: 'qsgw', outputDir: 'librpa.d', qsgw: { iterations: { rows, convergedIter, columns: [] } } },
});
const ROWS = [
  { iter: 0, max_delta_eV: 0, gap_eV: 0.91988, efermi_eV: 15.7799 },
  { iter: 1, max_delta_eV: 14.345, gap_eV: 2.28854, efermi_eV: 16.5547 },
];

test('no log but QSGW output on disk reads as "evidence mismatch", not "no output"', () => {
  const t = task('x/qsgw', 'librpa', { status: NO_OUTPUT });
  assert.equal(P.stageState(t, null).code, 'none', 'before the bundle loads, the scan status stands');
  const state = P.stageState(t, qsgwBundle(ROWS, null, NO_OUTPUT));
  assert.equal(state.code, 'partial');
  assert.equal(state.label, '证据不全');
  assert.match(state.detail, /2 行/);
});

test('a finished QSGW run that never met its threshold is unconverged, not done', () => {
  const finished = { code: 'FINISHED', label: '已完成', reason: 'libRPA finished successfully' };
  const state = P.stageState(task('x/q', 'librpa'), qsgwBundle(ROWS, null, finished));
  assert.equal(state.code, 'unconv');
  assert.match(state.detail, /14\.3/);
  assert.equal(P.stageState(task('x/q', 'librpa'), qsgwBundle(ROWS, 1, finished)).label, '已收敛');
});

test('"converged" is only claimed where a verdict exists', () => {
  const finished = { code: 'FINISHED', label: '已完成', reason: '' };
  const scf = { status: finished, abacus: { calculation: 'scf', log: { scfConverged: true, iterations: [{}, {}] } } };
  const nscf = { status: finished, abacus: { calculation: 'nscf', log: { scfConverged: true, iterations: [{}] } } };
  assert.equal(P.stageState(task('a', 'abacus'), scf).label, '已收敛');
  assert.equal(P.stageState(task('b', 'abacus'), nscf).label, '已完成');
});

// FINISHED_NO_LOG is the host's verdict for results without a retained librpa.out (UI.md §11a).
// stageState used to drop it into its generic "未判定" branch, which hid both facts.
test('a run with results but no log reads as finished-without-log, unless its table never converged', () => {
  const noLog = { code: 'FINISHED_NO_LOG', label: '已完成（无日志）', reason: '有计算产物，但没有保存 librpa.out 主日志' };
  const bare = P.stageState(task('x/qsgw', 'librpa', { status: noLog }), null);
  assert.equal(bare.code, 'partial');
  assert.equal(bare.label, '已完成（无日志）');
  assert.match(bare.detail, /没有保存 librpa\.out/);
  const converged = P.stageState(task('x/qsgw', 'librpa'), qsgwBundle(ROWS, 1, noLog));
  assert.equal(converged.code, 'partial', 'a converged table does not replace the missing log');
  assert.match(converged.detail, /第 1 次迭代达到收敛判据/);
  const never = P.stageState(task('x/qsgw', 'librpa'), qsgwBundle(ROWS, null, noLog));
  assert.equal(never.code, 'unconv');
  assert.match(never.detail, /没有 librpa\.out/);
});

test('error, unconverged SCF and stale running map to their own states', () => {
  const t = (status, extra) => task('s', 'abacus', { status, ...extra });
  assert.equal(P.stageState(t({ code: 'ERROR', reason: 'SEGFAULT' }), null).code, 'err');
  assert.equal(P.stageState(t({ code: 'FINISHED_UNCONVERGED', reason: '' }), null).code, 'unconv');
  const stale = P.stageState(t({ code: 'RUNNING', reason: '' }, { ageSeconds: 3 * 86400 }), null);
  assert.equal(stale.code, 'run');
  assert.match(stale.detail, /3 天无更新/);
});

// ------------------------------------------------------------- lineage ---

const librpaIn = (inputDir) => ({ status: NO_OUTPUT, librpa: { input: { params: inputDir === null ? {} : { input_dir: inputDir } } } });

test('a cluster input_dir is mapped into the producer branch it names', () => {
  const link = P.lineageOf(stageOf(nio, 'qsgw'), librpaIn('/data/home/cluster-user/ai-runs/nio-matched-dzp-k666-20261016-r1/producer/DZP/librpa/input'), nio);
  assert.equal(link.kind, 'input_dir');
  assert.equal(link.branch, 'producer/DZP', 'DZP, not TZDP');
  assert.equal(link.runRel, 'producer/DZP/librpa/input');
});

test('an input_dir that does not land on a producer is reported as unresolved', () => {
  const bi = runs.find((r) => r.key.startsWith('bi2se3'));
  const stage = stageOf(bi, 'consumer-one-update-r1/run');
  const link = P.lineageOf(stage, librpaIn('/data/home/x/bi2se3-soc-abacus-reexport-20261025-r1/consumer-one-update-r1/input'), bi);
  assert.equal(link.kind, 'unresolved');
  assert.match(link.text, /本地没有对应的产出阶段/);
});

test('relative input_dir resolves from the stage; no producers means nothing is claimed', () => {
  const tasks = [task('opt5/validation/soc-option5', 'librpa')];
  const run = P.groupRuns(tasks, ROOT)[0];
  const link = P.lineageOf(run.stages[0], librpaIn('../soc-dataset'), run);
  assert.equal(link.kind, 'none');
  assert.equal(link.runRel, 'validation/soc-dataset');
});

test('without input_dir the edge is a labelled layout guess; coupled stages read their own folder', () => {
  const guess = P.lineageOf(stageOf(nio, 'qsgw'), librpaIn(null), nio);
  assert.equal(guess.kind, 'layout');
  assert.equal(guess.branch, null, 'two producer branches: the guess does not pick one');
  assert.match(guess.text, /推断/);
  const si = runs.find((r) => r.key.startsWith('si-qsgw-k444'));
  assert.equal(P.lineageOf(si.stages[0], null, si).kind, 'same_dir');
  assert.equal(P.lineageOf(stageOf(nio, 'qsgw'), null, nio), null, 'nothing is said before the bundle loads');
});

// -------------------------------------------------------------- series ---

test('runs that differ only by k mesh form a series, ordered coarse to fine', () => {
  const series = P.detectSeries(runs);
  assert.equal(series.length, 1, 'NiO k666 alone is not a series');
  assert.equal(series[0].key, 'si-qsgw-k*-headwing-kconv-20260517-203305');
  assert.deepEqual(series[0].members.map((m) => m.label), ['k444', 'k666']);
  assert.equal(P.meshToken('si-qsgw-kconv-x'), null, 'kconv is not a mesh token');
  assert.deepEqual(P.meshToken('mgo-6x6x6-r1').mesh, [6, 6, 6]);
});

// -------------------------------------------------------------- bands ---

const channel = (kpath, energies, extra = {}) => ({ kpath, energies, nBand: energies[0].length, ...extra });
const abacusPath = [0, 0.2, 0.32, 0.4];
const librpaPath = [0, 0.6, 1.1, 1.5]; // same points, another length convention
const E = [[-1, 2], [-0.8, 2.2], [-0.7, 2.5], [-0.9, 2.1]];

test('identical k paths overlay as they are', () => {
  assert.equal(P.alignChannel(channel(abacusPath, E), channel(abacusPath.slice(), E)).mode, 'same');
});

test('different length conventions align by index only with KS proof', () => {
  const ref = channel(abacusPath, E);
  const ks = channel(librpaPath, E.map((row) => row.map((v) => v + 0.0004)));
  const proof = P.eigenIdentity(ref, ks);
  assert.ok(proof.maxAbs < 0.001);
  assert.equal(proof.count, 8);
  const qsgw = channel(librpaPath, E.map((row) => row.map((v) => v * 1.3)));
  assert.equal(P.alignChannel(ref, qsgw, proof).mode, 'index');
  assert.equal(P.alignChannel(ref, qsgw, null).mode, 'none', 'no proof, no overlay');
  const bad = P.eigenIdentity(ref, channel(librpaPath, E.map((row) => row.map((v) => v + 0.5))));
  assert.equal(P.alignChannel(ref, qsgw, bad).mode, 'none', 'a failed proof is a refusal');
});

test('different point counts are never overlaid, and the reason says why', () => {
  const result = P.alignChannel(channel(abacusPath, E), channel([0, 1, 2], E.slice(0, 3)));
  assert.equal(result.mode, 'none');
  assert.match(result.reason, /4 vs 3/);
});

test('the default window centres on a Fermi level from a file', () => {
  const w = P.defaultWindow({ min: -88.4, max: 270.6 }, 15.388, 6);
  assert.ok(w.centred);
  assert.ok(Math.abs(w.lo - 9.388) < 1e-9 && Math.abs(w.hi - 21.388) < 1e-9);
  const none = P.defaultWindow({ min: -5, max: 40 }, null, 6);
  assert.equal(none.centred, false);
  assert.deepEqual([none.lo, none.hi], [-5, 10]);
  assert.equal(P.abacusFermi({ abacus: { log: { iterations: [{ eFermiEv: 15.1 }, { eFermiEv: 15.388 }] } } }), 15.388);
  assert.deepEqual(P.librpaFermi(qsgwBundle(ROWS, null), 1), { energy: 16.5547, iter: 1 });
});

test('channel keys separate tasks and iterations, so the basket never collapses two curves', () => {
  const payload = (iter) => ({ librpa: [{ kind: 'QSGW', spin: 1, iter, file: `QSGW_band_spin_1_${iter}.dat`, kpath: [], energies: [] }] });
  const a = P.buildBandChannels(payload(5), 'k444/frozen')[0];
  const b = P.buildBandChannels(payload(10), 'k444/frozen')[0];
  const c = P.buildBandChannels(payload(10), 'k666/frozen')[0];
  assert.equal(new Set([a.key, b.key, c.key]).size, 3);
  assert.equal(c.source, 'librpa');
  assert.notEqual(P.bandStyle({ source: 'abacus', spin: 1 }).dash, P.bandStyle({ source: 'librpa', kind: 'KS', spin: 1 }).dash, 'producers differ in line shape, not only colour');
});

test('band sources prefer the producer branch the consumer read, and skip stages without output', () => {
  const bundles = {
    [stageOf(nio, 'producer/DZP/03_bands').id]: { abacus: { kpt: { mode: 'explicit', kMode: 'line_direct', nkpts: 364 } } },
    [stageOf(nio, 'producer/DZP/01_scf').id]: { abacus: { kpt: { mode: 'auto', grid: [6, 6, 6] } } },
  };
  const states = Object.fromEntries(nio.stages.map((s) => [s.id, P.stageState(s.task, null)]));
  states[stageOf(nio, 'qsgw').id] = { code: 'partial' };
  const lineage = { [stageOf(nio, 'qsgw').id]: { kind: 'input_dir', branch: 'producer/DZP' } };
  const ranked = P.rankBandSources(nio, bundles, states, lineage);
  assert.deepEqual(ranked.abacus.map((s) => s.rel), ['producer/DZP/03_bands'], 'a mesh SCF is not a band path');
  assert.deepEqual(ranked.librpa.map((s) => s.rel), ['qsgw']);
});

// --------------------------------------------------------- key numbers ---

test('every gap in the ledger names its producer and source file; none comes from band indices', () => {
  const scfStage = stageOf(nio, 'producer/DZP/01_scf');
  const qsgwStage = stageOf(nio, 'qsgw');
  const bandStage = stageOf(nio, 'producer/DZP/03_bands');
  const bundles = {
    [scfStage.id]: { abacus: { calculation: 'scf', outputDir: 'OUT.NiO_DZP_scf', logFile: 'running_scf.log', kpt: { mode: 'auto', grid: [6, 6, 6] }, log: { iterations: [{ gapEv: 0.9 }, { gapEv: 0.91988 }] } } },
    [qsgwStage.id]: qsgwBundle(ROWS, null, NO_OUTPUT),
    // Band energies alone must not turn into a gap row.
    [bandStage.id]: { abacus: { calculation: 'nscf', outputDir: 'OUT.NiO_DZP_bands', log: { iterations: [{ eFermiEv: 15.4 }] } } },
  };
  const matches = [{ id: 'NiO-afm-gw-1', formula: 'NiO', gwGapEv: 4.1, exxGapEv: null, dftGapEv: 0.9, confidence: 'high', scope: 'bulk' }];
  const rows = P.gapLedger(nio, bundles, null, matches);
  assert.deepEqual(rows.map((r) => [r.producer, r.stage]), [
    ['abacus', 'producer/DZP/01_scf'],
    ['librpa', 'qsgw'],
    ['librpa', 'qsgw'],
    ['db', 'NiO-afm-gw-1'],
    ['db', 'NiO-afm-gw-1'],
  ]);
  assert.equal(rows[0].source, 'OUT.NiO_DZP_scf/running_scf.log');
  assert.equal(rows[2].source, 'librpa.d/qsgw_iterations.dat');
  assert.equal(rows[2].state, 'unconv');
  assert.match(rows[2].quantity, /第 1 次/);
  assert.ok(rows.every((r) => typeof r.source === 'string' && r.source.length > 0));
  assert.equal(P.gapLedger(nio, { [qsgwStage.id]: qsgwBundle(ROWS, null) }, 0, [])[0].valueEv, 0.91988, 'iteration 0 is the starting point row');
});

test('identical ledger rows from sibling stages merge; different values never do', () => {
  const row = (stage, valueEv) => ({ producer: 'abacus', stage, quantity: 'KS 能隙 E_gap(k) · nscf', valueEv, source: 'OUT.ABACUS/running_nscf.log', state: null });
  const merged = P.collapseLedger([row('base_iter1', 0.558), row('frozen', 0.55801), row('refresh', 0.6), row('keep_6', 0.6)]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].stages, ['base_iter1', 'frozen']);
  assert.equal(merged[0].stage, 'base_iter1 等 2 个阶段');
  assert.deepEqual(merged[1].stages, ['refresh', 'keep_6']);
  const db = { producer: 'db', stage: 'r1', quantity: 'GW 能隙 · Si', valueEv: 1.08, source: 'x', state: null };
  assert.equal(P.collapseLedger([db, { ...db, stage: 'r2' }]).length, 2, 'published records stay separate');
});

// ------------------------------------------------------ agent messages ---

test('the ask context carries the absolute path, the kind and the state', () => {
  const t = sampleTasks[1];
  const text = P.buildAskContext({ task: t, status: { label: '已完成' }, abacus: { calculation: 'nscf', outputDir: 'OUT.NiO_DZP_bands' } }, '当前查看：运行结果');
  assert.match(text, /任务：\\\\wsl\$/);
  assert.match(text, /类型：ABACUS，状态 已完成/);
  assert.match(text, /当前查看：运行结果/);
});

test('the handoff message keeps provenance, lists what is missing, and asks before acting', () => {
  const items = [
    { producer: 'abacus', rel: 'producer/DZP/01_scf', state: { code: 'ok', label: '已收敛', detail: 'SCF 收敛' }, facts: 'scf · k 6×6×6' },
    { producer: 'abacus', rel: 'producer/TZDP/01_scf', state: { code: 'none', label: '无输出', detail: '没有 OUT 目录' }, facts: '' },
    { producer: 'librpa', rel: 'qsgw', state: { code: 'partial', label: '证据不全', detail: '没有日志' }, facts: 'qsgw', lineage: 'input_dir → producer/DZP' },
  ];
  const ledger = [{ producer: 'librpa', stage: 'qsgw', quantity: 'QSGW 能隙 · 第 1 次', valueEv: 2.28854, source: 'librpa.d/qsgw_iterations.dat', note: '未收敛' }];
  const intents = P.handoffIntents({ unconverged: 0, missing: 2, hasQsgw: true, inSeries: false, hasLibrary: false, research: false });
  assert.ok(intents.some((i) => i.id === 'missing'));
  assert.ok(!intents.some((i) => i.id === 'note'), 'no research.md, no AITP note intent');
  const message = P.buildHandoffMessage({ run: nio, stages: items, ledger, research: { found: false }, intent: intents[0] });
  assert.match(message, /目录：.*nio-matched-dzp-k666-20261016-r1/);
  assert.match(message, /\[ABACUS\] producer\/TZDP\/01_scf · 无输出/);
  assert.match(message, /2\.289 eV（librpa\.d\/qsgw_iterations\.dat）/);
  assert.match(message, /缺失或可疑：[\s\S]*qsgw：证据不全/);
  assert.match(message, /请先向我确认/);
  assert.doesNotMatch(message, /research\.md/, 'nothing is claimed about AITP without a file');
  const withNote = P.buildHandoffMessage({ run: nio, stages: items, ledger, research: { found: true, path: '\\\\wsl$\\x\\topics\\research.md' }, intent: intents[0] });
  assert.match(withNote, /从运行目录向上查找得到，不是 AITP 声明的关联/);
});

test('formatting helpers', () => {
  assert.equal(P.fmtMeV(0.0262), '+26.2 meV');
  assert.equal(P.fmtMeV(-0.1982), '-198.2 meV');
  assert.equal(P.fmtMeV(-0.00008), '-0.08 meV', 'sub-meV differences keep their digits');
  assert.ok(P.natCompare('keep_6', 'keep_10') < 0);
  assert.ok(P.natCompare('01_scf', '02_export') < 0);
  assert.deepEqual(P.ticksFor(0, 1, 5).ticks, [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.equal(P.tailPath('a'.repeat(10)), 'a'.repeat(10));
});

// ---------------------------------------------------------------- ask box (§3.2) ---
//
// DSH passes `sessionId` to the right-dock tab only; the global `main` slot gets the standard
// hooks and nothing else. The ask box therefore resolves its session from the Client's
// `sessions` service. These tests pin that decision and the order-independent reading of
// what DSH reports back after a send.

const LIST = {
  phase: 'ready',
  byId: {
    s1: { id: 's1', title: '旧对话', retainedBy: { sidebarChat: 1 } },
    s2: { id: 's2', title: 'NiO QSGW 收敛', retainedBy: { mainView: 1, sidebarChat: 1 } },
  },
};

test('the main view session is the one the workspace retains as mainView', () => {
  assert.equal(P.mainViewSessionId(LIST), 's2');
  assert.equal(P.mainViewSessionId({ byId: { a: { id: 'a', retainedBy: { sidebarChat: 2 } } } }), undefined, 'other retains do not count');
  assert.equal(P.mainViewSessionId({ byId: { a: { id: 'a', retainedBy: { mainView: 0 } } } }), undefined);
  assert.equal(P.mainViewSessionId(null), undefined);
  assert.equal(P.mainViewSessionId({}), undefined);
});

test('the main page links through the session list; the dock through its sessionId', () => {
  const main = P.describeSessionLink({ slot: 'main', service: true, mainViewId: 's2', title: 'NiO QSGW 收敛', bound: true, promptable: true });
  assert.equal(main.ok, true);
  assert.equal(main.sessionId, 's2');
  assert.match(main.accessor, /retainedBy\.mainView/);
  const dock = P.describeSessionLink({ slot: 'dock', propSessionId: 's1', service: true, mainViewId: 's2', bound: true, promptable: true });
  assert.equal(dock.sessionId, 's1', 'a slot-provided id wins over the main view');
  assert.equal(dock.accessor, 'props.sessionId');
});

test('every way the ask box can fail to link names the accessor and a reason', () => {
  const noService = P.describeSessionLink({ slot: 'main', service: false });
  assert.equal(noService.ok, false);
  assert.match(noService.accessor, /ctx\.get\('sessions'\)/);
  assert.match(noService.reason, /会话服务/);

  const noCurrent = P.describeSessionLink({ slot: 'main', service: true, listPhase: 'ready' });
  assert.equal(noCurrent.ok, false);
  assert.match(noCurrent.reason, /没有打开的对话/);

  const loading = P.describeSessionLink({ slot: 'main', service: true, listPhase: 'pending' });
  assert.match(loading.reason, /还在加载/);

  const unbound = P.describeSessionLink({ slot: 'main', service: true, mainViewId: 's2', title: 'NiO QSGW 收敛', bound: false });
  assert.equal(unbound.ok, false);
  assert.match(unbound.accessor, /sessions\.binding\(id\)$/);
  assert.match(unbound.reason, /「NiO QSGW 收敛」/);

  const old = P.describeSessionLink({ slot: 'dock', propSessionId: 's1', service: true, bound: true, promptable: false });
  assert.match(old.reason, /beginSubmission\/prompt/);
  for (const link of [noService, noCurrent, loading, unbound, old]) assert.ok(link.reason && link.reason.length > 8, 'never silent');
});

/** Fold a sequence of reports the way the ask box does. */
const fold = (events) => events.reduce((state, event) => P.submissionStep(state, event), null);

test('a submission moves forward only, whatever order DSH reports in', () => {
  assert.equal(fold([{ type: 'sending' }, { type: 'accepted' }, { type: 'observed' }]).phase, 'delivered');
  // The transcript can show the message before the admission reply arrives.
  assert.equal(fold([{ type: 'sending' }, { type: 'observed' }, { type: 'accepted' }]).phase, 'delivered');
  assert.equal(fold([{ type: 'sending', queued: true }, { type: 'accepted' }]).queued, true);
});

test('a refusal keeps its reason even when the echo is retired first', () => {
  // DSH retires the echo inside prompt() before prompt() resolves with the error.
  const refused = fold([{ type: 'sending' }, { type: 'retired' }, { type: 'refused', detail: 'session/busy：会话正在关闭' }]);
  assert.equal(refused.phase, 'rejected');
  assert.equal(refused.detail, 'session/busy：会话正在关闭');
  assert.equal(P.submissionStep(refused, { type: 'accepted' }), refused, 'a rejection is final');
});

test('a rejection after acceptance is reported as late, not dropped', () => {
  const late = fold([{ type: 'sending' }, { type: 'accepted' }, { type: 'retired' }]);
  assert.equal(late.phase, 'rejected');
  assert.equal(late.late, true);
  assert.match(P.submissionLabel(late, 'NiO'), /没有送达「NiO」：对话先接收了这条消息，随后又把它撤下/);
  assert.match(P.submissionLabel({ phase: 'accepted', queued: true }, 'NiO'), /排在当前回合之后/);
});

/**
 * A stand-in for DSH's `ISession` with the semantics of its real implementation
 * (dsh-api-session-controller): beginSubmission registers the echo and sends nothing;
 * prompt() is the call that reaches the Host; a failed identified prompt retires the echo
 * before it resolves.
 */
function fakeSession(behaviour) {
  const calls = [];
  const settlements = new Map();
  let serial = 0;
  return {
    calls,
    getSnapshot: () => ({ running: behaviour === 'running' }),
    beginSubmission(input) {
      serial += 1;
      const requestId = `r${serial}`;
      calls.push(['beginSubmission', input.mode, input.text, input.attachments.length]);
      settlements.set(requestId, input.onRetire);
      return { requestId, abandon: () => calls.push(['abandon', requestId]) };
    },
    async prompt(content, mode, signal, requestId) {
      calls.push(['prompt', content, mode, requestId]);
      if (behaviour === 'throw') throw new Error('socket closed');
      if (behaviour === 'refuse') {
        settlements.get(requestId)({ reason: 'failed' });
        return { ok: false, error: { code: 'session/busy', message: '会话正在关闭' } };
      }
      setTimeout(() => settlements.get(requestId)(behaviour === 'withdraw' ? { reason: 'failed' } : { reason: 'observed', attachments: [] }), 5);
      return { ok: true, value: { accepted: true } };
    },
  };
}

async function send(behaviour) {
  const session = fakeSession(behaviour);
  const events = [];
  P.postToSession(session, '【来自 ABACUS 面板】这个结果收敛了吗？', (event) => events.push(event));
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { session, events, state: fold(events) };
}

test('posting calls beginSubmission and then prompt with the same request id', async () => {
  const { session, state } = await send('ok');
  assert.deepEqual(session.calls[0], ['beginSubmission', 'queue', '【来自 ABACUS 面板】这个结果收敛了吗？', 0]);
  const prompt = session.calls[1];
  assert.equal(prompt[0], 'prompt', 'beginSubmission alone sends nothing; prompt must follow');
  assert.deepEqual(prompt[1], [{ type: 'text', text: '【来自 ABACUS 面板】这个结果收敛了吗？' }]);
  assert.equal(prompt[2], 'queue');
  assert.equal(prompt[3], 'r1', 'prompt carries the echo’s request id, so DSH can retire the right bubble');
  assert.equal(state.phase, 'delivered');
});

test('posting reports a refusal, a throw and a late withdrawal', async () => {
  const refused = await send('refuse');
  assert.equal(refused.state.phase, 'rejected');
  assert.equal(refused.state.detail, 'session/busy：会话正在关闭');

  const threw = await send('throw');
  assert.equal(threw.state.phase, 'rejected');
  assert.match(threw.state.detail, /socket closed/);
  assert.ok(threw.session.calls.some((c) => c[0] === 'abandon'), 'a prompt that throws abandons its echo');

  const withdrawn = await send('withdraw');
  assert.equal(withdrawn.state.phase, 'rejected');
  assert.equal(withdrawn.state.late, true);

  const busy = await send('running');
  assert.equal(busy.events[0].queued, true, 'a running session queues the message, and the label says so');
});

// ------------------------------------------------------- database figures (§3.1) ---

const fig = (label, kind, quantity, stem, extra = {}) => ({ label, kind, quantity, stem, url: `https://huggingface.co/x/${stem}.${kind}`, ...extra });

test('figures are grouped by quantity; a PNG and its PDF make one card', () => {
  const { tabs, defaultKey } = P.groupFigures([
    fig('cuinp2se6_ks.png', 'png', 'KS', 'cuinp2se6_ks'),
    fig('cuinp2se6_ks.pdf', 'pdf', 'KS', 'cuinp2se6_ks'),
    fig('cuinp2se6_gw.png', 'png', 'GW', 'cuinp2se6_gw'),
    fig('cuinp2se6_gw.pdf', 'pdf', 'GW', 'cuinp2se6_gw'),
    fig('cuinp2se6_exx.png', 'png', 'EXX', 'cuinp2se6_exx'),
  ]);
  assert.deepEqual(tabs.map((t) => t.key), ['KS', 'EXX', 'GW'], 'physics order');
  assert.equal(defaultKey, 'GW');
  const ks = tabs[0].cards;
  assert.equal(ks.length, 1);
  assert.equal(ks[0].image.kind, 'png');
  assert.equal(ks[0].pdf.kind, 'pdf');
  assert.equal(ks[0].caption, 'cuinp2se6_ks.png');
});

test('SVG figures are shown; a primary figure decides the opening tab', () => {
  const { tabs, defaultKey } = P.groupFigures([
    fig('EXX occupation-separated frontier', 'svg', 'EXX', 'exx_frontier', { primary: true }),
    fig('GW occupation-separated frontier', 'svg', 'GW', 'gw_frontier'),
    fig('KS / EXX / GW band comparison', 'svg', 'compare', 'band_comparison'),
  ]);
  assert.deepEqual(tabs.map((t) => [t.key, t.label]), [['EXX', 'EXX'], ['GW', 'GW'], ['compare', '对比']]);
  assert.equal(defaultKey, 'EXX');
  assert.equal(tabs[1].cards[0].image.kind, 'svg');
  assert.equal(tabs[1].cards[0].caption, 'GW occupation-separated frontier');
});

test('a PDF without an image, an unknown kind and a refused URL stay listed', () => {
  const { tabs } = P.groupFigures([
    fig('hbn_zoom.pdf', 'pdf', 'other', 'hbn_zoom'),
    fig('weird.eps', 'other', 'other', 'weird'),
    { label: 'bad.png', kind: 'png', quantity: 'GW', stem: 'bad', url: null },
  ]);
  const other = tabs.find((t) => t.key === 'other').cards;
  assert.equal(other[0].image, null);
  assert.equal(other[0].pdf.label, 'hbn_zoom.pdf');
  assert.equal(other[1].image, null, 'an unknown kind is never put in an <img>');
  assert.equal(other[1].files.length, 1);
  assert.equal(tabs.find((t) => t.key === 'GW').cards[0].image.url, null);
  assert.deepEqual(P.groupFigures([]), { tabs: [], defaultKey: null });
});

test('the JSON outline lists one level with types and sizes, never the whole document', () => {
  const audit = {
    schema_version: 2,
    note: 'Sampled path only, not a global Brillouin-zone gap',
    methods: { GW: { sampled_path_gap_ev: 1.81713, mapping_one_based: [[14, 15]] }, EXX: {} },
    rejected: { KS: 'raw archived band table absent' },
    display_energies_ev: [-0.55982, -0.10454, 2.2206],
    empty: [],
  };
  const { entries, more } = P.jsonOutline(audit);
  const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
  assert.equal(byKey.schema_version.preview, '2');
  assert.equal(byKey.note.type, 'string');
  assert.equal(byKey.methods.size, 2);
  assert.equal(byKey.methods.expandable, true);
  assert.equal(byKey.display_energies_ev.preview, '[3] -0.55982, -0.10454, 2.2206');
  assert.equal(byKey.empty.expandable, false);
  assert.equal(more, 0);
  assert.equal(P.jsonOutline(Array.from({ length: 250 }, (_, i) => i)).more, 50);
  assert.deepEqual(P.jsonOutline('scalar'), { entries: [], more: 0 });
});

// ------------------------------------------------------- stage diagnosis (§4.1) ---

test('the diagnosis handed to the agent keeps every quoted line with its file and line', () => {
  const diagnosis = {
    verdict: { tone: 'err', text: '运行被终止：作业被调度器取消（CANCELLED）（librpa.err 第 1 行）' },
    lines: [
      { file: 'librpa.err', line: 1, why: '作业被调度器取消（CANCELLED）', text: 'slurmstepd: error: *** STEP 3704890.0 CANCELLED AT 2026-10-19T16:27:44 ***', kind: 'fatal' },
      { file: 'librpa.out', line: 20012, why: '日志末行：没有成功结束标记', text: 'Task   25. libRI G0W0', kind: 'last' },
    ],
    checks: [{ asked: 'task = qsgw', found: 'librpa.d/qsgw_iterations.dat：第 0–1 次', ok: false, note: '没有一行达到判据' }],
    missing: [{ name: 'librpa.out', why: '主日志', need: 'expected' }, { name: 'KPT', why: 'k 点文件', need: 'required' }],
    notes: ['input_dir 是集群上的路径'],
  };
  const stage = { rel: 'run', name: 'run', task: { absPath: `${ROOT}\\bi2se3-soc-qsgw-option5\\run` } };
  const message = P.buildDiagnosisMessage({ run: { name: 'bi2se3-soc-qsgw-option5' }, stage, state: { label: '运行中' }, diagnosis });
  assert.match(message, /^【来自 ABACUS 面板 · 阶段诊断】/);
  assert.match(message, /结论：运行被终止/);
  assert.match(message, /- librpa\.err 第 1 行（作业被调度器取消（CANCELLED））：slurmstepd/);
  assert.match(message, /- librpa\.out 第 20012 行/);
  assert.match(message, /- ✗ task = qsgw → librpa\.d\/qsgw_iterations\.dat/);
  assert.match(message, /- KPT：k 点文件（必需）/);
  assert.doesNotMatch(message, /librpa\.out：主日志（必需）/, 'an expected file is not called required');
  assert.match(message, /请先向我确认/);
  assert.deepEqual(Object.keys(P.DIAGNOSIS_GLYPH).sort(), ['err', 'info', 'ok', 'warn']);
});

// -------------------------------------------- published vs local (§4.2) ---
//
// Shapes from the real data: the local Bi2Se3 SOC QSGW run (ABACUS LCAO, lspinorb 1) against
// the database's bi2se3-abacus-gw-dzp (ABACUS 1dd0199 + LibRPA G0W0, "spin-unpolarized, no
// SOC", band-path gap). Same basis files, very different calculations.

const BI_RECORD = {
  id: 'bi2se3-abacus-gw-dzp',
  formula: 'Bi2Se3',
  observable: 'G0W0 gap',
  gwGapEv: 0.25166,
  exxGapEv: 2.25717,
  dftGapEv: 0.14874,
  gapDefinition: 'LibRPA final printed GW bandgap, historical selected band-path calculation; not a universal PP/NAO accuracy claim',
  notes: 'Historical KS HPC backup run: ABACUS LCAO DZP-basis scf/nscf plus LibRPA G0W0 on the bulk Bi2Se3 rhombohedral 5-atom cell (spin-unpolarized, no SOC).',
  frontend: 'abacus',
  workflowTask: 'gw',
  software: [{ name: 'abacus', commit: '1dd0199', missing: null }, { name: 'librpa', commit: null, missing: 'not logged' }],
  species: [
    { element: 'Bi', pp: 'Bi.upf', nao: 'Bi_gga_10au_130Ry_3s3p2d.orb', abf: 'Bi_4s4p3d2f2g_1e-4.abfs' },
    { element: 'Se', pp: 'Se.upf', nao: 'Se_gga_10au_110Ry_3s3p2d.orb', abf: 'Se_4s4p3d2f2g_1e-4.abfs' },
  ],
  atomCount: 5,
  pathKpoints: 101,
  gapProperties: [{ method: 'G0W0', label: 'Band gap', valueEv: 0.25166, definition: null, summaryKey: 'gw_gap_ev' }],
};

const BI_SCF = {
  abacus: {
    versions: { version: '3.10.1', commit: 'a1b2c3d4e' },
    input: { params: { nspin: '4', lspinorb: '1', dft_functional: 'pbe' } },
    stru: { natom: 5, species: [
      { label: 'Bi', pp: 'Bi.upf', orbitals: ['../resources/Bi_gga_10au_130Ry_3s3p2d.orb'] },
      { label: 'Se', pp: 'Se.upf', orbitals: ['../resources/Se_gga_10au_110Ry_3s3p2d.orb'] },
    ] },
    kpt: { mode: 'auto', grid: [6, 6, 6] },
  },
};
const BI_QSGW = qsgwBundle(ROWS, null, { code: 'FINISHED', label: '已完成' });

test('local facts come from the SCF producer and the LibRPA consumer, nothing invented', () => {
  const local = P.localCompareFacts({ scf: BI_SCF, consumer: BI_QSGW, scfRel: 'producer/work/scf' });
  assert.equal(local.method, 'QSGW');
  assert.deepEqual(local.species.map((s) => [s.element, s.nao]), [['Bi', 'Bi_gga_10au_130Ry_3s3p2d.orb'], ['Se', 'Se_gga_10au_110Ry_3s3p2d.orb']]);
  assert.equal(local.kMesh, '6×6×6');
  assert.equal(local.soc, true);
  assert.equal(local.nspin, 4);
  assert.equal(local.librpa.commit, null, 'no build block in this bundle: unknown, not guessed');
});

const MESH_KS = { producer: 'abacus', stage: 'producer/work/scf', quantity: 'KS 能隙 E_gap(k) · scf · 6×6×6 网格', valueEv: 0.3101, source: 'OUT.soc/running_scf.log' };
const PATH_KS = { producer: 'abacus', stage: 'producer/work/band_full', quantity: 'KS 能隙 E_gap(k) · nscf · 101 个显式 k 点', valueEv: 0.311, source: 'OUT.soc/running_nscf.log' };

test('the comparison says same, differs or cannot tell — row by row', () => {
  const rows = P.compareWithRecord(P.localCompareFacts({ scf: BI_SCF, consumer: BI_QSGW, scfRel: 'producer/work/scf', ledger: [MESH_KS] }), BI_RECORD);
  const v = Object.fromEntries(rows.map((r) => [r.key, r.verdict]));
  assert.equal(v.method, 'differs', 'QSGW is not G0W0');
  assert.equal(v.frontend, 'same');
  assert.equal(v.version, 'differs', 'ABACUS a1b2c3d4e vs 1dd0199');
  assert.equal(v.nao, 'same', 'same orbital files, compared by file name');
  assert.equal(v.pp, 'same');
  assert.equal(v.soc, 'differs', 'local SOC vs "no SOC" in the record notes');
  assert.equal(v.nspin, 'unknown', 'nspin 4 has no counterpart in the notes prose');
  assert.equal(v.kmesh, 'unknown', 'the record has no SCF mesh');
  assert.equal(v.definition, 'differs', 'a mesh KS gap vs a band-path gap');
  assert.equal(v.abf, 'unknown');
  assert.match(rows.find((r) => r.key === 'soc').published, /据记录说明文字/);
  assert.match(rows.find((r) => r.key === 'kmesh').note, /能带路径 101 个点/);
  // A KS gap read from explicit k points may well be the same path: not claimed either way.
  const onPath = P.compareWithRecord(P.localCompareFacts({ scf: BI_SCF, consumer: BI_QSGW, ledger: [PATH_KS] }), BI_RECORD);
  const definition = onPath.find((r) => r.key === 'definition');
  assert.equal(definition.verdict, 'unknown');
  assert.match(definition.local, /101 个显式 k 点/);
});

test('a LibRPA built outside git (GITDIR-NO) has no commit, and the row says so', () => {
  const consumer = { ...BI_QSGW, librpa: { ...BI_QSGW.librpa, log: { build: { 'Source code Git hash': 'GITDIR-NO' } } } };
  const local = P.localCompareFacts({ scf: BI_SCF, consumer });
  assert.equal(local.librpa.commit, null);
  const version = P.compareWithRecord(local, BI_RECORD).find((r) => r.key === 'version');
  assert.match(version.local, /构建信息是 GITDIR-NO，没有提交号/);
});

test('published gaps sit next to local ones with sources; the difference carries its caveats', () => {
  const ledger = [
    MESH_KS,
    { producer: 'librpa', stage: 'qsgw', quantity: '能隙 · 第 0 次（迭代起点）', valueEv: 0.91988, source: 'librpa.d/qsgw_iterations.dat' },
    { producer: 'librpa', stage: 'qsgw', quantity: 'QSGW 能隙 · 第 1 次', valueEv: 2.28854, source: 'librpa.d/qsgw_iterations.dat' },
    { producer: 'db', stage: 'bi2se3-abacus-gw-dzp', quantity: 'GW 能隙', valueEv: 0.25166, source: 'LibRPA-database' },
  ];
  const rows = P.compareWithRecord(P.localCompareFacts({ scf: BI_SCF, consumer: BI_QSGW, ledger }), BI_RECORD);
  const pairs = P.gapComparison(ledger, BI_RECORD, rows);
  const ks = pairs.find((p) => p.key === 'ks');
  assert.equal(ks.local.source, 'OUT.soc/running_scf.log');
  assert.equal(ks.published.source, 'bi2se3-abacus-gw-dzp · summary.dft_gap_ev');
  assert.ok(Math.abs(ks.deltaEv - (0.3101 - 0.14874)) < 1e-9);
  const gw = pairs.find((p) => p.key === 'gw');
  assert.equal(gw.local.what, 'qsgw · QSGW 能隙 · 第 1 次', 'the QSGW row, not the iteration-0 start');
  assert.match(gw.caveats, /不同：方法、版本、自旋轨道耦合、能隙定义/);
  assert.match(gw.caveats, /无法核对：.*SCF k 网格/);
  const exx = pairs.find((p) => p.key === 'exx');
  assert.equal(exx.local, null, 'no local EXX gap is made up');
  assert.equal(exx.deltaEv, null);
});

test('method families are read conservatively', () => {
  assert.equal(P.methodFamily('qsgw_band0'), 'QSGW');
  assert.equal(P.methodFamily('G0W0 band gap (sampled path)'), 'G0W0');
  assert.equal(P.methodFamily('gw'), 'GW', 'an unspecified GW is not assumed to be G0W0');
  assert.equal(P.methodFamily(''), null);
  assert.deepEqual(P.recordSpinFacts('collinear spin-polarized antiferromagnetic'), { nspin: 2, soc: null });
  assert.deepEqual(P.recordSpinFacts('non-spin-polarized, without SOC'), { nspin: 1, soc: false });
  assert.equal(P.baseName('../assets/basis/DZP/Ni_gga_8au_100Ry_4s2p2d1f.orb'), 'Ni_gga_8au_100Ry_4s2p2d1f.orb');
});
