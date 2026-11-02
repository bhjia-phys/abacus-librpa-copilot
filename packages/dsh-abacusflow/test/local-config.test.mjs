/**
 * Machine-specific settings live in a git-ignored local-config.json (lib/host/local-config.js)
 * so the published cordis.patch.yml carries no personal paths. These pin the precedence rule:
 * the patch wins; the local file only fills what the patch leaves out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withLocalConfig, readLocalConfig, LOCAL_CONFIG_KEYS } from '../lib/host/local-config.js';

const local = {
  defaultScanRoot: '/runs/local',
  libraryRoot: '/db/index',
  remoteHost: 'cluster',
  dev: { physicsHome: '/home/user/physics' },
  unrelated: 'ignored',
};

test('the patch wins; the local file fills only missing keys', () => {
  const merged = withLocalConfig({ maxDepth: 4, defaultScanRoot: '/from/patch' }, local);
  assert.equal(merged.defaultScanRoot, '/from/patch', 'a key set in the patch is kept');
  assert.equal(merged.libraryRoot, '/db/index', 'a missing key comes from the local file');
  assert.equal(merged.remoteHost, 'cluster');
  assert.equal(merged.maxDepth, 4);
});

test('an explicit empty value in the patch is respected, not replaced', () => {
  // Tests pass libraryRoot: '' to run without a database; that must stay empty.
  assert.equal(withLocalConfig({ libraryRoot: '' }, local).libraryRoot, '');
});

test('only plugin settings are merged; the dev block and unknown keys are not', () => {
  const merged = withLocalConfig({}, local);
  assert.equal(merged.dev, undefined);
  assert.equal(merged.unrelated, undefined);
  assert.ok(Object.keys(merged).every((k) => LOCAL_CONFIG_KEYS.includes(k)));
});

test('the patch object is not modified', () => {
  const raw = { maxDepth: 3 };
  withLocalConfig(raw, local);
  assert.deepEqual(raw, { maxDepth: 3 });
});

test('a missing or invalid local file reads as empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abacusflow-localcfg-'));
  try {
    assert.deepEqual(readLocalConfig(join(dir, 'absent.json')), {});
    writeFileSync(join(dir, 'bad.json'), '{ not json');
    assert.deepEqual(readLocalConfig(join(dir, 'bad.json')), {});
    writeFileSync(join(dir, 'array.json'), '[1, 2]');
    assert.deepEqual(readLocalConfig(join(dir, 'array.json')), {});
    writeFileSync(join(dir, 'ok.json'), JSON.stringify({ libraryRoot: '/x' }));
    assert.deepEqual(readLocalConfig(join(dir, 'ok.json')), { libraryRoot: '/x' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
