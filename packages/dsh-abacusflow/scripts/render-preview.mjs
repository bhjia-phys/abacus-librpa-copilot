#!/usr/bin/env node
/**
 * Render the panel to ONE static HTML file for review without DSH:
 *
 *   node scripts/render-preview.mjs <out.html> [--theme light|dark] [--view main|dock] [--run <run name>]
 *
 * Unlike the earlier hand-written mock, this renders the REAL lib/client.js against the REAL
 * host routes and data (scripts/preview-server.mjs), waits until every request has settled,
 * and saves the resulting DOM with its stylesheets inlined (the panel's CSS from client.js and,
 * when DeepSeek Harness is installed, DSH's theme tokens). Scripts are stripped: the file is a
 * snapshot to open in any browser or screenshot headlessly, not a working panel.
 *
 * Needs Chrome (CHROME_PATH) and React's CommonJS builds (see preview-server.mjs).
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPreviewServer } from './preview-server.mjs';
import { harnessQuery, launchChrome, openPage } from './lib/chrome.mjs';
import { localData } from './lib/local-data.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const out = resolve(args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? 'preview.html');
const theme = flag('theme', 'light');
const view = flag('view', 'main');
const runName = flag('run', 'nio-matched-dzp-k666-20261016-r1');
// Sample locations: env vars or the `dev` block of the git-ignored local-config.json.
const SCAN_ROOT = localData().sampleRoot;
const LIBRARY = localData().libraryRoot || resolve(here, '..', '..', '..', 'database', 'library-index');
if (!SCAN_ROOT) {
  console.error('No sample data configured: set ABACUSFLOW_SCAN_ROOT or dev.sampleRoot in local-config.json.');
  process.exit(2);
}

const server = await startPreviewServer({ root: SCAN_ROOT, library: LIBRARY });
const chrome = await launchChrome();
try {
  const scan = await (await fetch(`${server.url}/abacusflow/api/scan?rootPath=${encodeURIComponent(SCAN_ROOT)}`)).json();
  const seed = { 'abacusflow:ui': { place: 'runs', view: 'results', runByRoot: { [scan.rootPath]: runName } } };
  const size = view === 'dock' ? { width: 1180, height: 1400, dockWidth: 420 } : { width: 1440, height: 2050 };
  const page = await openPage(chrome.cdp, `${server.url}/?${harnessQuery({ view, theme, seed, ...size })}`, size);
  // Inline every stylesheet (the DSH theme <link> and the panel's injected <style>), drop scripts.
  const html = await page.evaluate(`(async () => {
    for (const link of [...document.querySelectorAll('link[rel=stylesheet]')]) {
      const style = document.createElement('style');
      style.textContent = await (await fetch(link.href)).text();
      link.replaceWith(style);
    }
    for (const script of [...document.querySelectorAll('script')]) script.remove();
    return '<!doctype html>\\n' + document.documentElement.outerHTML;
  })()`);
  await page.done();
  writeFileSync(out, html, 'utf8');
  console.log(`wrote ${out} (${(html.length / 1024).toFixed(1)} KiB)${page.problems.length ? `; page problems:\n  ${page.problems.join('\n  ')}` : ''}`);
} finally {
  chrome.close();
  await server.close();
}
