#!/usr/bin/env node
/**
 * Screenshot the REAL panel (scripts/preview-server.mjs) in headless Chrome, light and dark,
 * full page and right-dock width, and report every console error and page exception.
 *
 *   node scripts/screenshots.mjs [outDir] [--only <name-substring>]
 *
 * Chrome is driven over the DevTools protocol (scripts/lib/chrome.mjs), so the script can
 * seed the panel's per-browser state (which run, which view), click (e.g. open the agent
 * handoff sheet) and wait until no request is in flight before capturing.
 *
 * Environment: CHROME_PATH (default: the standard Windows install), ABACUSFLOW_SCAN_ROOT,
 * ABACUSFLOW_LIBRARY, ABACUSFLOW_KSTUDY (a snapshot.json for the k-study shot).
 * Exit code 1 when any shot logged a console error or a page exception.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPreviewServer } from './preview-server.mjs';
import { harnessQuery, launchChrome, openPage } from './lib/chrome.mjs';
import { localData } from './lib/local-data.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const onlyIndex = args.indexOf('--only');
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null;
const outDir = resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--only') ?? join(here, '..', '..', '..', 'screenshots'));
// Sample locations: env vars or the `dev` block of the git-ignored local-config.json.
const SCAN_ROOT = localData().sampleRoot;
const LIBRARY = localData().libraryRoot || resolve(here, '..', '..', '..', 'database', 'library-index');
const KSTUDY = localData().kstudySnapshot;
if (!SCAN_ROOT) {
  console.error('No sample data configured: set ABACUSFLOW_SCAN_ROOT or dev.sampleRoot in local-config.json.');
  process.exit(2);
}

async function plan(base) {
  const scan = await (await fetch(`${base}/abacusflow/api/scan?rootPath=${encodeURIComponent(SCAN_ROOT)}`)).json();
  if (scan.error) throw new Error(`scan failed: ${scan.error}`);
  const rootKey = scan.rootPath;
  const id = (rel) => (scan.tasks.find((t) => t.relPath === rel) || {}).id;
  const NIO = 'nio-matched-dzp-k666-20261016-r1';
  const SI = 'si-qsgw-k666-headwing-kconv-20260517-203305';
  const BI = 'bi2se3-soc-abacus-reexport-20261025-r1';
  const BI5 = 'bi2se3-soc-qsgw-option5-20261016-r1';
  const ui = (patch, run) => ({ 'abacusflow:ui': { place: 'runs', view: 'results', ...(run ? { runByRoot: { [rootKey]: run } } : {}), ...patch } });
  const openHandoff = "document.querySelector('.af-agent [aria-expanded]').click()";
  const diagnose = (rel) => ({ view: 'stage', stageId: id(rel), stageTab: 'diagnose' });
  // Wait for the diagnosis, then hand it to the agent: the draft sheet opens in the dock.
  const draftDiagnosis = `(async () => {
    for (let i = 0; i < 100 && !document.querySelector('.af-verdict .af-btn'); i++) await new Promise((r) => setTimeout(r, 100));
    document.querySelector('.af-verdict .af-btn').click();
  })()`;
  // Expand a database record and wait until its figures have decoded (an <img> is not a fetch).
  const openRecord = (recordId) => `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let head = null;
    for (let i = 0; i < 100 && !head; i++) { head = [...document.querySelectorAll('.af-lib-record-head')].find((b) => b.textContent.includes(${JSON.stringify(recordId)})); if (!head) await sleep(100); }
    head.click();
    for (let i = 0; i < 300; i++) {
      const imgs = [...document.querySelectorAll('.af-lib-img')];
      if (document.querySelector('.af-lib-assets') && imgs.every((img) => img.complete)) break;
      await sleep(100);
    }
    head.scrollIntoView({ block: 'start' });
  })()`;
  // Open the published-vs-local comparison (its section remembers being open) and bring it into view.
  const published = (patch, run) => ({ ...ui(patch, run), 'abacusflow:section:results-published': '1' });
  const showPublished = `(async () => {
    for (let i = 0; i < 150; i++) {
      const s = [...document.querySelectorAll('.af-section')].find((x) => x.textContent.includes('与已发表记录对照'));
      if (s && s.querySelector('.af-compare')) { s.scrollIntoView({ block: 'start' }); return; }
      await new Promise((r) => setTimeout(r, 150));
    }
  })()`;
  // Type a question into the ask box and send it to the stand-in session.
  const ask = `(async () => {
    const input = document.querySelector('.af-agent .af-ask-row input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '这个结果收敛了吗？');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    document.querySelector('.af-agent .af-ask-row .af-btn').click();
    await new Promise((r) => setTimeout(r, 1200));
  })()`;
  const main = { view: 'main', width: 1440, height: 1000 };
  const tall = { view: 'main', width: 1440, height: 2050 };
  const dock = { view: 'dock', width: 1180, height: 1000, dockWidth: 420 };
  const dockTall = { view: 'dock', width: 1180, height: 1900, dockWidth: 420 };
  return [
    { name: '01-main-light-nio-results', ...tall, theme: 'light', seed: ui({}, NIO) },
    { name: '02-main-dark-nio-results', ...tall, theme: 'dark', seed: ui({}, NIO) },
    { name: '03-dock-light-nio-results', ...dockTall, theme: 'light', seed: ui({}, NIO) },
    { name: '04-dock-dark-nio-results', ...dockTall, theme: 'dark', seed: ui({}, NIO) },
    { name: '05-main-light-bi2se3-results', ...tall, theme: 'light', seed: ui({}, BI) },
    { name: '06-main-light-si-coupled-results', ...tall, theme: 'light', seed: ui({}, SI) },
    { name: '07-main-light-nio-stage-qsgw', ...main, theme: 'light', seed: ui({ view: 'stage', stageId: id(`${NIO}/qsgw`), stageTab: 'qsgw' }, NIO) },
    { name: '08-main-dark-nio-stage-scf', ...main, theme: 'dark', seed: ui({ view: 'stage', stageId: id(`${NIO}/producer/DZP/01_scf`), stageTab: 'scf' }, NIO) },
    { name: '09-main-light-studies-series', ...tall, theme: 'light', seed: ui({ place: 'studies' }) },
    { name: '10-main-light-studies-snapshot', ...tall, theme: 'light', seed: ui({ place: 'studies', kstudyPath: KSTUDY, kstudyMaterial: 'Si' }) },
    { name: '11-main-light-library', ...main, theme: 'light', seed: ui({ place: 'library', libraryQuery: 'NiO' }, NIO) },
    { name: '12-main-light-handoff', ...main, theme: 'light', seed: ui({}, NIO), actions: [openHandoff] },
    { name: '13-dock-dark-handoff', ...dock, theme: 'dark', seed: ui({}, NIO), actions: [openHandoff] },
    { name: '14-dock-light-picker', ...dock, theme: 'light', seed: ui({}, NIO), actions: ["document.querySelector('.af-picker-btn').click()"] },
    { name: '15-main-dark-first-screen', ...main, theme: 'dark', seed: ui({}, NIO) },
    { name: '16-dock-light-first-screen', ...dock, theme: 'light', seed: ui({}, NIO) },
    // §4.1 per-stage diagnosis
    { name: '17-main-light-diagnose-nio-qsgw', ...tall, theme: 'light', seed: ui(diagnose(`${NIO}/qsgw`), NIO) },
    { name: '18-main-dark-diagnose-bi2se3-cancelled', ...tall, theme: 'dark', seed: ui(diagnose(`${BI5}/run`), BI5) },
    { name: '19-main-light-diagnose-nio-scf-ok', ...tall, theme: 'light', seed: ui(diagnose(`${NIO}/producer/DZP/01_scf`), NIO) },
    { name: '20-dock-dark-diagnose-draft', ...dockTall, theme: 'dark', seed: ui(diagnose(`${NIO}/qsgw`), NIO), actions: [draftDiagnosis] },
    { name: '21-dock-light-diagnose-bi2se3', ...dockTall, theme: 'light', seed: ui(diagnose(`${BI5}/run`), BI5) },
    // §3.1 database figures by kind and quantity
    { name: '22-main-light-library-nio-svg', ...tall, theme: 'light', seed: ui({ place: 'library', libraryQuery: 'nio-aims-gw-int' }), actions: [openRecord('nio-aims-gw-int')] },
    { name: '23-main-dark-library-cuinp2se6-png-pdf', ...tall, theme: 'dark', seed: ui({ place: 'library', libraryQuery: 'cuinp2se6-table-gw' }), actions: [openRecord('cuinp2se6-table-gw')] },
    { name: '24-dock-light-library-bi2se3', ...dockTall, theme: 'light', seed: ui({ place: 'library', libraryQuery: 'bi2se3-abacus-gw-dzp' }), actions: [openRecord('bi2se3-abacus-gw-dzp')] },
    { name: '25-dock-dark-library-no-figures', ...dock, theme: 'dark', seed: ui({ place: 'library', libraryQuery: 'c-delta-st-rpa-20260824' }), actions: [openRecord('c-delta-st-rpa-20260824')] },
    // §3.2 ask box: where it posts, and what it says when it cannot
    { name: '26-main-light-ask-delivered', ...main, theme: 'light', seed: ui({}, NIO), actions: [ask] },
    { name: '27-dock-dark-ask-delivered', ...dock, theme: 'dark', seed: ui({}, NIO), actions: [ask] },
    { name: '28-main-dark-ask-no-session', ...main, theme: 'dark', seed: ui({}, NIO), session: 'none', actions: [ask] },
    { name: '29-dock-light-ask-refused', ...dock, theme: 'light', seed: ui({}, NIO), session: 'refuse', actions: [ask] },
    // §4.2 published vs local
    { name: '30-main-light-published-bi2se3', ...tall, theme: 'light', seed: published({}, BI), actions: [showPublished] },
    { name: '31-main-dark-published-nio', ...tall, theme: 'dark', seed: published({}, NIO), actions: [showPublished] },
    { name: '32-dock-light-published-bi2se3', ...dockTall, theme: 'light', seed: published({}, BI), actions: [showPublished] },
    { name: '33-dock-dark-published-nio', ...dockTall, theme: 'dark', seed: published({}, NIO), actions: [showPublished] },
    // A hot-reloaded panel against the first release's host (DSH not fully restarted)
    { name: '34-main-light-old-host-library', ...tall, theme: 'light', seed: ui({ place: 'library', libraryQuery: 'nio-aims-gw-int' }), host: 'old', actions: [openRecord('nio-aims-gw-int')] },
    { name: '35-dock-dark-old-host-diagnose', ...dockTall, theme: 'dark', seed: ui(diagnose(`${NIO}/qsgw`), NIO), host: 'old' },
    // The record the user saw failing (KCl), as it reads now; and a download that fails
    { name: '36-main-light-library-kcl', ...tall, theme: 'light', seed: ui({ place: 'library', libraryQuery: 'kcl-jctc-aims-gw' }), actions: [openRecord('kcl-jctc-aims-gw')] },
    { name: '37-main-dark-library-download-failed', ...main, theme: 'dark', seed: ui({ place: 'library', libraryQuery: 'kcl-jctc-aims-gw' }), assetfail: true, actions: [openRecord('kcl-jctc-aims-gw')] },
  ];
}

mkdirSync(outDir, { recursive: true });
const server = await startPreviewServer({ root: SCAN_ROOT, library: LIBRARY });
const chrome = await launchChrome();
let failures = 0;
try {
  const shots = (await plan(server.url)).filter((s) => !only || s.name.includes(only));
  for (const shot of shots) {
    const started = Date.now();
    const page = await openPage(chrome.cdp, `${server.url}/?${harnessQuery(shot)}`, shot);
    writeFileSync(join(outDir, `${shot.name}.png`), await page.screenshot());
    await page.done();
    console.log(`${page.problems.length ? '!!' : 'ok'}  ${shot.name}.png  (${Date.now() - started} ms)`);
    for (const p of page.problems) console.log(`      ${p}`);
    if (page.problems.some((p) => p.startsWith('exception') || p.startsWith('error'))) failures += 1;
  }
} finally {
  chrome.close();
  await server.close();
}
console.log(`\n${failures === 0 ? 'no page errors' : `${failures} shot(s) with page errors`} · screenshots in ${outDir}`);
process.exit(failures === 0 ? 0 : 1);
