/**
 * The two read-only routes the redesigned panel added, driven through the real `apply()`:
 *
 *   /kcompare          k-mesh series → occupation-based band edges (lib/host/kconvergence.js)
 *   /research-context  nearest research.md above a run (the only AITP link the panel claims)
 *
 * A fake Cordis context captures the registered handlers; a synthetic project holds two
 * k-mesh runs whose QSGW band files have known band edges, under a topic with a research.md.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/index.js';
import { findResearchContext, firstHeading } from '../lib/host/research-context.js';

let root;
let runsRoot;
const routes = new Map();

/** `<ik> <kx> <ky> <kz>` then `<occupation> <energy_eV>` pairs, as LibRPA writes them. */
function bandFile(cbmShift) {
  return [
    `1 0.0 0.0 0.0  2 -1.0  2 0.0  0 ${1.5 + cbmShift}  0 2.5`,
    `2 0.1 0.0 0.0  2 -0.9  2 0.2  0 ${1.4 + cbmShift}  0 2.6`,
    `3 0.2 0.0 0.0  2 -1.1  2 0.1  0 ${1.6 + cbmShift}  0 2.4`,
  ].join('\n');
}

function makeRun(name, cbmShift) {
  const dir = join(runsRoot, name, 'frozen');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'librpa.in'), 'task = qsgw\noutput_dir = librpa.d\n');
  writeFileSync(join(dir, 'QSGW_band_spin_1_1.dat'), bandFile(cbmShift));
}

function call(path) {
  const url = new URL(path, 'http://127.0.0.1');
  const handler = routes.get(url.pathname);
  assert.ok(handler, `route ${url.pathname} registered`);
  return new Promise((resolve, reject) => {
    const res = {
      status: 0,
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        try {
          resolve({ status: this.status, body: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      },
    };
    handler({ url: path }, res);
  });
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'abacusflow-routes-'));
  const topic = join(root, 'topic');
  runsRoot = join(topic, 'runs');
  mkdirSync(runsRoot, { recursive: true });
  writeFileSync(join(topic, 'research.md'), '---\nstatus: active\n---\n\n# Si k-mesh study\n\nnotes\n');
  makeRun('si-k444-x', 0);
  makeRun('si-k666-x', 0.05);

  const ctx = {
    effect(fn) {
      return fn();
    },
    webServer: {
      register(def) {
        routes.set(def.path, def.handler);
        return () => routes.delete(def.path);
      },
    },
    tools: {
      register() {
        return () => {};
      },
    },
  };
  apply(ctx, { maxDepth: 4, libraryRoot: '' });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

async function scanIds() {
  const scan = await call(`/abacusflow/api/scan?rootPath=${encodeURIComponent(runsRoot)}&force=1`);
  assert.equal(scan.status, 200);
  const byRel = Object.fromEntries(scan.body.tasks.map((t) => [t.relPath, t.id]));
  return { k444: byRel['si-k444-x/frozen'], k666: byRel['si-k666-x/frozen'] };
}

test('kcompare reports occupation-based gaps for a k-mesh series', async () => {
  const ids = await scanIds();
  assert.ok(ids.k444 && ids.k666, 'both runs scanned as LibRPA tasks');
  const { status, body } = await call(`/abacusflow/api/kcompare?ids=${ids.k444},${ids.k666}&kind=QSGW&spin=1`);
  assert.equal(status, 200);
  assert.equal(body.kPathIdentical, true);
  assert.equal(body.rows.length, 2);
  const [a, b] = body.rows;
  // VBM = max over k of the highest occupied state (0.2); CBM = min lowest empty (1.4).
  assert.ok(Math.abs(a.vbmEv - 0.2) < 1e-9 && Math.abs(a.cbmEv - 1.4) < 1e-9);
  assert.ok(Math.abs(a.gapEv - 1.2) < 1e-9);
  assert.ok(Math.abs(b.deltaGapVsReferenceEv - 0.05) < 1e-9);
  assert.equal(a.usableKpoints, 3);
  // Scalars only: the panel draws curves from /bands, so no band arrays come back here.
  assert.ok(body.runs.every((r) => !('energies' in r) && !('kpath' in r)));
});

test('kcompare rejects unknown ids and empty requests', async () => {
  assert.equal((await call('/abacusflow/api/kcompare?ids=nope')).status, 404);
  assert.equal((await call('/abacusflow/api/kcompare')).status, 400);
});

test('research-context finds the nearest research.md and reports how it was found', async () => {
  const ids = await scanIds();
  const { status, body } = await call(`/abacusflow/api/research-context?id=${ids.k444}`);
  assert.equal(status, 200);
  assert.equal(body.found, true);
  assert.equal(body.levelsUp, 3, 'frozen → si-k444-x → runs → topic');
  assert.equal(body.title, 'Si k-mesh study');
  assert.ok(body.path.endsWith(join('topic', 'research.md')));
});

test('research-context claims nothing when no note is within reach', () => {
  const lonely = mkdtempSync(join(tmpdir(), 'abacusflow-lonely-'));
  try {
    const deep = join(lonely, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    const result = findResearchContext(deep, { maxLevels: 2 });
    assert.equal(result.found, false);
    assert.equal(result.path, null);
    assert.equal(result.searched, 3);
  } finally {
    rmSync(lonely, { recursive: true, force: true });
  }
  assert.equal(firstHeading('intro\n## Topic: NiO QSGW ##\n'), 'Topic: NiO QSGW');
  assert.equal(firstHeading('no heading here'), null);
});
