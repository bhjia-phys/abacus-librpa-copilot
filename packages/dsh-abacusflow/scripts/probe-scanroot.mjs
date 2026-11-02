#!/usr/bin/env node
/**
 * Check the scan-root default logic the panel implements.
 *
 * The panel resolves a starting path as `pinned (localStorage) || configured (defaultScanRoot)`.
 * This reproduces that resolution here so the precedence can be tested without a browser,
 * and verifies a real configured directory is present.
 *
 *   node scripts/probe-scanroot.mjs <configured-default>
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const configured = process.argv[2] ?? '';

/** Same resolution the client uses on first mount (values are trimmed first). */
function resolveInitialRoot({ pinned, configuredRoot }) {
  const trimmedPinned = String(pinned ?? '').trim();
  const trimmedConfigured = String(configuredRoot ?? '').trim();
  return trimmedPinned || trimmedConfigured || '';
}

const cases = [
  { pinned: '', configuredRoot: '', expect: '' },
  { pinned: '', configuredRoot: '/from/config', expect: '/from/config' },
  { pinned: '/pinned/here', configuredRoot: '/from/config', expect: '/pinned/here' },
  { pinned: '/pinned/here', configuredRoot: '', expect: '/pinned/here' },
  { pinned: '   ', configuredRoot: '/from/config', expect: '/from/config' },
  { pinned: '  /pinned  ', configuredRoot: '/from/config', expect: '/pinned' },
  { pinned: '   ', configuredRoot: '   ', expect: '' },
];

let failed = 0;
for (const c of cases) {
  const got = resolveInitialRoot(c);
  const ok = got === c.expect;
  if (!ok) failed += 1;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  pinned=${JSON.stringify(c.pinned).padEnd(16)} ` +
      `configured=${JSON.stringify(c.configuredRoot).padEnd(14)} -> ${JSON.stringify(got)}`,
  );
}

console.log('');
console.log(`configured default : ${configured || '(empty)'}`);
if (configured) {
  const exists = existsSync(resolve(configured));
  console.log(`exists on disk     : ${exists}`);
  if (!exists) failed += 1;
}

// The patch file must actually declare the default, otherwise a fresh browser lands blank.
const patch = resolve('cordis.patch.yml');
if (existsSync(patch)) {
  const text = readFileSync(patch, 'utf8');
  const m = /defaultScanRoot:\s*'([^']*)'/.exec(text);
  console.log(`patch defaultScanRoot: ${m ? JSON.stringify(m[1]) : '(not found)'}`);
  if (!m) failed += 1;
}

process.exit(failed === 0 ? 0 : 1);
