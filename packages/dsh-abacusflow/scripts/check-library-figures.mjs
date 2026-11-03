#!/usr/bin/env node
/**
 * Open database records in the REAL panel (scripts/preview-server.mjs, headless Chrome) and
 * check that every figure tab renders: each image card's <img> decodes, PDF-only cards say so,
 * audits open as an outline. Screenshots each record, light and dark.
 *
 *   node scripts/check-library-figures.mjs [outDir] [--ids a,b,c]
 *
 * Defaults to the four §3.1 verification records: NiO (2 SVG + audit JSON), Bi2Se3 (3 SVG +
 * audit JSON), CuInP2Se6 (3 PNG + 3 PDF) and C (no figures). Figures travel from Hugging Face
 * through the host proxy and its disk cache, so the first run needs the network.
 *
 * Exit code 1 when an image does not decode, a tab is missing, or the page logs an error.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPreviewServer } from './preview-server.mjs';
import { harnessQuery, launchChrome, openPage } from './lib/chrome.mjs';
import { localData } from './lib/local-data.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const idsIndex = args.indexOf('--ids');
const IDS = idsIndex >= 0 ? args[idsIndex + 1].split(',') : ['nio-aims-gw-int', 'bi2se3-abacus-gw-dzp', 'cuinp2se6-table-gw', 'c-delta-st-rpa-20260824'];
const outDir = resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--ids') ?? join(here, '..', '..', '..', 'screenshots'));
const LIBRARY = localData().libraryRoot || resolve(here, '..', '..', '..', 'database', 'library-index');
// What each record must show (tab keys in order), when known.
const EXPECT = {
  'nio-aims-gw-int': { tabs: ['EXX', 'GW'], audits: 1 },
  'bi2se3-abacus-gw-dzp': { tabs: ['KS', 'EXX', 'GW'], audits: 1 },
  'cuinp2se6-table-gw': { tabs: ['KS', 'EXX', 'GW'], audits: 0 },
  'c-delta-st-rpa-20260824': { tabs: [], audits: 0 },
};

// Expand the record, then walk every quantity tab and wait for its images to decode.
const INSPECT = (id) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let head = null;
  for (let i = 0; i < 100 && !head; i++) {
    head = [...document.querySelectorAll('.af-lib-record-head')].find((b) => b.textContent.includes(${JSON.stringify(id)}));
    if (!head) await sleep(200);
  }
  if (!head) return { error: 'record row not found' };
  head.click();
  let assets = null;
  for (let i = 0; i < 150 && !assets; i++) {
    assets = document.querySelector('.af-lib-assets');
    if (!assets) await sleep(200);
  }
  if (!assets) return { error: 'assets did not load' };
  const decode = async () => {
    const imgs = [...assets.querySelectorAll('.af-lib-img')];
    for (let i = 0; i < 200; i++) {
      if (imgs.every((img) => img.complete)) break;
      await sleep(150);
    }
    return imgs.map((img) => ({ ok: img.naturalWidth > 0, w: img.naturalWidth, h: img.naturalHeight, alt: img.alt }));
  };
  const seg = assets.querySelector('.af-lib-assets-head .af-seg');
  const buttons = seg ? [...seg.querySelectorAll('button')] : [];
  const tabs = [];
  if (buttons.length === 0) {
    tabs.push({ tab: '(single)', images: await decode(), placeholders: assets.querySelectorAll('.af-lib-frame[data-placeholder]').length });
  }
  for (const button of buttons) {
    button.click();
    await sleep(120);
    tabs.push({ tab: button.textContent, images: await decode(), placeholders: assets.querySelectorAll('.af-lib-frame[data-placeholder]').length });
  }
  // Leave the default tab showing for the screenshot.
  if (buttons.length) { buttons[buttons.length - 1].click(); await sleep(100); }
  // Audits and band tables sit in light disclosure rows inside the record.
  const sectionHeads = [...assets.querySelectorAll('.af-disclosure-head')];
  const auditHead = sectionHeads.find((s) => s.textContent.includes('审计'));
  let outline = null;
  if (auditHead) {
    auditHead.click();
    await sleep(100);
    const open = [...assets.querySelectorAll('button')].find((b) => b.textContent === '展开结构');
    if (open) {
      open.click();
      for (let i = 0; i < 200 && !outline; i++) {
        const rows = assets.querySelectorAll('.af-json-row');
        if (rows.length) outline = [...rows].slice(0, 8).map((r) => r.textContent.replace(/\\s+/g, ' ').trim());
        else await sleep(150);
      }
    }
  }
  const empty = assets.textContent.includes('这条记录没有上传图');
  return { tabs, audits: auditHead ? 1 : 0, outline, empty, headText: assets.querySelector('.af-lib-assets-head').textContent };
})()`;

mkdirSync(outDir, { recursive: true });
const server = await startPreviewServer({ root: localData().sampleRoot || undefined, library: LIBRARY });
const chrome = await launchChrome();
let failures = 0;
try {
  for (const id of IDS) {
    for (const theme of ['light', 'dark']) {
      const shot = { view: 'main', width: 1440, height: 1500, theme, seed: { 'abacusflow:ui': { place: 'library', libraryQuery: id } } };
      const page = await openPage(chrome.cdp, `${server.url}/?${harnessQuery(shot)}`, shot);
      const result = await page.evaluate(INSPECT(id));
      await new Promise((r) => setTimeout(r, 300));
      const name = `library-${id}-${theme}`;
      writeFileSync(join(outDir, `${name}.png`), await page.screenshot());
      const expect = EXPECT[id];
      const tabKeys = (result.tabs || []).filter((t) => t.tab !== '(single)').map((t) => t.tab.replace(/\s+\d+$/, ''));
      const decoded = (result.tabs || []).every((t) => t.images.every((img) => img.ok));
      const problems = [...page.problems];
      if (result.error) problems.push(result.error);
      if (!decoded) problems.push('an image did not decode');
      if (expect && tabKeys.join(',') !== expect.tabs.join(',') && !(expect.tabs.length <= 1 && tabKeys.length === 0)) problems.push(`tabs ${tabKeys.join(',')} ≠ ${expect.tabs.join(',')}`);
      if (expect && result.audits !== expect.audits) problems.push(`audits ${result.audits} ≠ ${expect.audits}`);
      if (expect && expect.tabs.length === 0 && !result.empty) problems.push('a record without figures does not say so');
      if (problems.length) failures += 1;
      console.log(`${problems.length ? '!!' : 'ok'}  ${name}.png`);
      for (const t of result.tabs || []) {
        console.log(`      tab ${t.tab.padEnd(6)} images ${t.images.map((i) => (i.ok ? `${i.w}×${i.h}` : 'FAILED')).join(' ') || '—'}${t.placeholders ? ` · ${t.placeholders} placeholder(s)` : ''}`);
      }
      if (result.outline) console.log(`      audit outline: ${result.outline.slice(0, 4).join(' | ')}`);
      if (result.empty) console.log('      says: 这条记录没有上传图');
      for (const p of problems) console.log(`      ${p}`);
      await page.done();
    }
  }
} finally {
  chrome.close();
  await server.close();
}
console.log(failures === 0 ? `\nall records rendered · screenshots in ${outDir}` : `\n${failures} record view(s) with problems`);
process.exit(failures === 0 ? 0 : 1);
