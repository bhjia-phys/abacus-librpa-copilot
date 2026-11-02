/**
 * Panel interaction features: ask-from-panel, cross-task band comparison, band detection.
 *
 * These pin behaviours that are easy to break silently:
 *   - the ask box must carry the task's absolute path and state, or the agent has to search;
 *   - the comparison basket must key channels per task, or two tasks' `QSGW spin 1` collapse
 *     into one entry and the plot silently shows a single curve;
 *   - band detection must look inside `OUT.<suffix>/`, or plain ABACUS band runs report
 *     "no bands" and the panel offers nothing to plot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectBands } from '../lib/host/scanner.js';
import { probeBandFiles } from '../lib/host/bands.js';

const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// ------------------------------------------------------ band detection -----

test('detectBands sees LibRPA per-iteration band files', () => {
  const info = detectBands([
    { name: 'QSGW_band_spin_1_10.dat', isDir: false },
    { name: 'KS_band_spin_2_1.dat', isDir: false },
    { name: 'INPUT', isDir: false },
  ]);
  assert.equal(info.hasBands, true);
  assert.deepEqual(info.kinds, ['librpa']);
});

test('detectBands sees ABACUS band files beside INPUT', () => {
  const info = detectBands([
    { name: 'bands1.txt', isDir: false },
    { name: 'bands2.txt', isDir: false },
  ]);
  assert.equal(info.hasBands, true);
  assert.deepEqual(info.kinds, ['abacus']);
});

test('detectBands reports both producers when a task holds both', () => {
  // `frozen` in the Si runs: an ABACUS stage and the QSGW band files in one directory.
  const info = detectBands([
    { name: 'bands1.txt', isDir: false },
    { name: 'QSGW_band_spin_1_1.dat', isDir: false },
  ]);
  assert.equal(info.hasBands, true);
  assert.deepEqual(info.kinds.sort(), ['abacus', 'librpa']);
});

test('an OUT.<suffix> directory alone is flagged as worth looking', () => {
  // Plain ABACUS band runs keep band.txt inside OUT.*; the top level shows only a dir.
  const info = detectBands([{ name: 'OUT.NiO_DZP_bands', isDir: true }]);
  assert.equal(info.hasBands, false);
  assert.equal(info.mayHaveBandsInOutDir, true);
});

test('probeBandFiles resolves band files inside OUT.<suffix>', () => {
  const root = mkdtempSync(join(tmpdir(), 'abacusflow-probe-'));
  try {
    const task = join(root, 'task');
    mkdirSync(join(task, 'OUT.t'), { recursive: true });
    writeFileSync(join(task, 'OUT.t', 'bands1.txt'), '1 0 0 1\n');
    writeFileSync(join(task, 'OUT.t', 'bands2.txt'), '1 0 0 2\n');
    writeFileSync(join(task, 'INPUT'), 'INPUT_PARAMETERS\nsuffix t\n');

    const found = probeBandFiles(task, { outDir: 'OUT.t' });
    assert.deepEqual(found.abacus, ['bands1.txt', 'bands2.txt']);
    assert.deepEqual(found.librpa, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('probeBandFiles finds LibRPA bands in librpa.d', () => {
  const root = mkdtempSync(join(tmpdir(), 'abacusflow-probe-'));
  try {
    const task = join(root, 'task');
    mkdirSync(join(task, 'librpa.d'), { recursive: true });
    writeFileSync(join(task, 'librpa.d', 'QSGW_band_spin_1_10.dat'), '1 0 0 0 2.0 -1.0\n');
    const found = probeBandFiles(task, {});
    assert.deepEqual(found.librpa, ['QSGW_band_spin_1_10.dat']);
    assert.deepEqual(found.abacus, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ----------------------------------------------------- panel behaviours -----

test('the ask box sends the task path and state with the question', () => {
  // Structural: `buildAskContext` must include the absolute path, or the agent has to guess
  // which calculation the user means.
  const block = clientSource.slice(
    clientSource.indexOf('function buildAskContext'),
    clientSource.indexOf('function tailPath'),
  );
  assert.ok(block.length > 0, 'buildAskContext found');
  assert.match(block, /task\.absPath/, 'the absolute path is included');
  assert.match(block, /bundle\.status/, 'the run status is included');
  assert.match(block, /KIND_LABEL/, 'the task kind is included');
});

test('asking posts a real submission rather than only prefilling', () => {
  const block = clientSource.slice(
    clientSource.indexOf('function askAgent'),
    clientSource.indexOf('function prefillComposer'),
  );
  assert.match(block, /beginSubmission/, 'uses the session submission API');
  assert.match(block, /mode:\s*'queue'/, 'queues the message');
  // The fallback must still exist for the no-session case.
  assert.match(block, /prefillComposer/, 'falls back to prefilling');
});

test('comparison channels are keyed per task, so two tasks cannot collapse', () => {
  const block = clientSource.slice(
    clientSource.indexOf('function buildBandChannels'),
    clientSource.indexOf('function useCompareBasket'),
  );
  // The key embeds the task label; without it, `QSGW spin 1` from two runs would be the
  // same key and the second would be dropped by the dedupe in addToCompare.
  assert.match(block, /key:\s*`\$\{taskLabel/, 'channel keys include the task label');
  assert.match(block, /shortLabel/, 'a short label exists for the legend');
});

test('adding to the basket dedupes and notifies subscribers', () => {
  const block = clientSource.slice(
    clientSource.indexOf('function addToCompare'),
    clientSource.indexOf('function removeFromCompare'),
  );
  assert.match(block, /compareBasket\.some/, 'checks for an existing channel');
  assert.match(block, /compareListeners\.forEach/, 'notifies subscribers');
});

/** Source of one top-level function in the client, from its declaration to the next one. */
function functionBlock(name) {
  const start = clientSource.indexOf(`function ${name}(`);
  assert.ok(start > 0, `function ${name} found`);
  const next = clientSource.indexOf('\n    function ', start + 10);
  return clientSource.slice(start, next > 0 ? next : undefined);
}

// Redesign (UI.md §4): the single CompareTray was split into the default-on in-run overlay
// (BandOverlay) and the cross-run basket (BasketPlace). Both can mix producers, so the old
// assertion on CompareTray is replaced by one on the shared note and on both surfaces.
test('every plot that can mix producers states that the two energy zeros may differ', () => {
  const note = /const ENERGY_ZERO_NOTE =\s*'([^']*)'/.exec(clientSource);
  assert.ok(note, 'the shared note exists');
  assert.match(note[1], /能量零点/, 'it names the energy zero');
  assert.match(note[1], /不做任何平移/, 'it says nothing is shifted');
  assert.match(functionBlock('BandOverlay'), /ENERGY_ZERO_NOTE/, 'the in-run overlay shows it');
  assert.match(functionBlock('BasketPlace'), /ENERGY_ZERO_NOTE/, 'the cross-run basket shows it');
});

// Redesign: the ask box became the agent dock and the scroller is `.af-content-scroll`
// (the old `.af-pane` and `h(AskBox…)` markers no longer exist). Same defect guarded: inside
// the scroller the dock only appears after scrolling past everything.
test('the agent dock is pinned outside the scrolling content', () => {
  const block = functionBlock('RunScope');
  assert.match(
    block,
    /h\('div', \{ className: 'af-content-scroll' \}, page\),\s*h\(AgentDock,/,
    'the dock is the sibling after the scroller, not a child of it',
  );
});

test('the dock tells the user the panel is read-only and the agent does the computing', () => {
  const block = functionBlock('AgentDock');
  assert.match(block, /面板只读/, 'read-only is stated');
  assert.match(block, /Agent 执行/, 'the agent is named as the actor');
  assert.match(block, /askAgent\(session/, 'it posts through the session submission path');
});
