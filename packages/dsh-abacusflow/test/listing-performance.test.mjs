/**
 * Directory listing must not stat every entry.
 *
 * This is a performance regression guard with a concrete cause: on a UNC path each `stat`
 * is a network round trip, and one real ABACUS `OUT.*` directory in this repository holds
 * 1473 files. Statting each took ~30 s for a single directory and made a 27-task scan take
 * 20 s. `readdir({ withFileTypes })` already provides the entry type, which is all the
 * scanner needs, so sizes are opt-in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listDir, listDirAsync, statFilesParallel } from '../lib/host/shared/paths.js';
import { scanProject } from '../lib/host/scanner.js';
import { physicsPath } from '../scripts/lib/local-data.mjs';

function makeDir(fileCount) {
  const root = mkdtempSync(join(tmpdir(), 'abacusflow-listdir-'));
  for (let i = 0; i < fileCount; i += 1) {
    writeFileSync(join(root, `file-${String(i).padStart(4, '0')}.txt`), 'x');
  }
  mkdirSync(join(root, 'sub'), { recursive: true });
  return root;
}

test('listDirAsync reports entry types without asking for sizes', async () => {
  const root = makeDir(20);
  try {
    const entries = await listDirAsync(root);
    assert.equal(entries.length, 21, '20 files + 1 directory');
    const sub = entries.find((e) => e.name === 'sub');
    assert.equal(sub.isDir, true);
    assert.equal(sub.size, null, 'size is null (not asked for), not 0');
    const file = entries.find((e) => e.name.startsWith('file-'));
    assert.equal(file.isDir, false);
    assert.equal(file.size, null);
    // Directory entries sort before files.
    assert.equal(entries[0].isDir, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listDir honours withStats when sizes are wanted', async () => {
  const root = makeDir(5);
  try {
    const plain = listDir(root);
    assert.equal(plain.find((e) => e.name.startsWith('file-')).size, null);

    const sized = await listDirAsync(root, { withStats: true });
    const file = sized.find((e) => e.name.startsWith('file-'));
    assert.equal(typeof file.size, 'number');
    assert.ok(file.size >= 1, `size should be the real byte count, got ${file.size}`);
    assert.ok(file.mtimeMs > 0);

    const syncSized = listDir(root, { withStats: true });
    assert.ok(syncSized.find((e) => e.name.startsWith('file-')).size >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('statFilesParallel returns sizes for files only', async () => {
  const root = makeDir(8);
  try {
    const stats = await statFilesParallel(root);
    assert.equal(stats.size, 8, 'the subdirectory is not included');
    for (const [, value] of stats) {
      assert.ok(value.size >= 1);
      assert.ok(value.mtimeMs > 0);
    }
    // A missing directory yields null rather than throwing.
    assert.equal(await statFilesParallel(join(root, 'nope')), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a scan of a directory with many files does not stat them', async () => {
  // 500 files in one output directory: with per-entry stat this is the case that made a
  // real scan take tens of seconds. The scan must not care how many files there are.
  const root = mkdtempSync(join(tmpdir(), 'abacusflow-scanspeed-'));
  try {
    const task = join(root, 'task');
    mkdirSync(join(task, 'OUT.t'), { recursive: true });
    writeFileSync(join(task, 'INPUT'), 'INPUT_PARAMETERS\nsuffix t\ncalculation scf\n');
    writeFileSync(join(task, 'STRU'), 'ATOMIC_SPECIES\nH 1 H.upf\nLATTICE_CONSTANT\n10\nLATTICE_VECTORS\n1 0 0\n0 1 0\n0 0 1\nATOMIC_POSITIONS\nDirect\nH\n0\n1\n0 0 0\n');
    for (let i = 0; i < 500; i += 1) {
      writeFileSync(join(task, 'OUT.t', `dump-${i}.txt`), 'x');
    }

    const started = Date.now();
    const scan = await scanProject(root, { maxDepth: 3 });
    const elapsed = Date.now() - started;

    assert.equal(scan.error, '');
    assert.equal(scan.tasks.length, 1);
    assert.equal(scan.tasks[0].relPath, 'task');
    // Generous bound: the point is that cost does not scale with the file count.
    assert.ok(elapsed < 5000, `scan took ${elapsed} ms for 500 files`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The real directory that motivated the fix: 1473 entries. Assert the *shape* of the
// contract (no sizes collected) rather than wall-clock, which varies by machine.
const BIG_DIR = physicsPath('topics', 'gw', 'nio_calculation', 'share', 'NiO-AFM-II-ABACUS-G0W0-QSGW-check-20261014', 'abacus', 'bands', 'OUT.nio_afm_frozen_line');

test('the real 1473-entry directory is listed without statting it', { skip: !existsSync(BIG_DIR) }, async () => {
  const started = Date.now();
  const entries = await listDirAsync(BIG_DIR);
  const elapsed = Date.now() - started;
  assert.ok(entries.length > 1000, `expected >1000 entries, got ${entries.length}`);
  for (const entry of entries) {
    assert.equal(entry.size, null, 'no per-entry stat during a scan');
  }
  // Statting each of these took ~30 s on this machine; listing alone is ~20 ms.
  assert.ok(elapsed < 5000, `listing took ${elapsed} ms`);
});
