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
