#!/usr/bin/env node
/**
 * Drive the ask box of the REAL panel (scripts/preview-server.mjs) in headless Chrome, on the
 * main page and in the right dock separately, against each behaviour of the stand-in session
 * service: type a question, press 发送, and report what the status line says, what reached
 * the stand-in session, and the `[abacusflow] ask box` trace the panel logged.
 *
 *   node scripts/check-ask-box.mjs [--only <main|dock|mode>]
 *
 * This checks the panel's side of the contract (which accessor, which calls, which order,
 * what the user is told). It is not a live DSH session: the stand-in mirrors the shapes of
 * DSH's session controller as read from its bundle, and nothing more.
 *
 * Exit code 1 when a case does not end in the expected state.
 */
import { startPreviewServer } from './preview-server.mjs';
import { harnessQuery, launchChrome, openPage } from './lib/chrome.mjs';
import { localData } from './lib/local-data.mjs';

const args = process.argv.slice(2);
const onlyIndex = args.indexOf('--only');
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null;
const SCAN_ROOT = localData().sampleRoot;
if (!SCAN_ROOT) {
  console.error('No sample data configured: set ABACUSFLOW_SCAN_ROOT or dev.sampleRoot in local-config.json.');
  process.exit(2);
}

// What the status line must say after a send, per stand-in behaviour.
const CASES = [
  { mode: 'ok', expect: /已出现在「NiO QSGW 收敛（预览）」里/, posted: true },
  { mode: 'running', expect: /已出现在|排在当前回合之后/, posted: true },
  { mode: 'refuse', expect: /没有送达.*session\/busy/, posted: false },
  { mode: 'late', expect: /没有送达.*随后又把它撤下/, posted: false },
  { mode: 'none', expect: /没有发送：.*没有打开的对话|没有发送：侧栏没有收到会话/, posted: false },
  { mode: 'noservice', expect: /没有发送：拿不到 DSH 的会话服务/, posted: false },
];

const TYPE_AND_SEND = `(async () => {
  const input = document.querySelector('.af-agent .af-ask-row input');
  if (!input) return 'no ask box';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, '这个结果收敛了吗？');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  document.querySelector('.af-agent .af-ask-row .af-btn').click();
  await new Promise((r) => setTimeout(r, 1200));
  return 'sent';
})()`;

const server = await startPreviewServer({ root: SCAN_ROOT });
const chrome = await launchChrome();
const traces = [];
chrome.cdp.listeners.push((msg) => {
  if (msg.method !== 'Runtime.consoleAPICalled' || msg.params.type !== 'info') return;
  const first = msg.params.args[0];
  if (first && typeof first.value === 'string' && first.value.startsWith('[abacusflow] ask box')) traces.push({ sessionId: msg.sessionId, text: first.value });
});
let failures = 0;
try {
  const scan = await (await fetch(`${server.url}/abacusflow/api/scan?rootPath=${encodeURIComponent(SCAN_ROOT)}`)).json();
  const run = 'nio-matched-dzp-k666-20261016-r1';
  const seed = { 'abacusflow:ui': { place: 'runs', view: 'results', runByRoot: { [scan.rootPath]: run } } };
  for (const view of ['main', 'dock']) {
    for (const c of CASES) {
      if (only && only !== view && only !== c.mode) continue;
      const shot = { view, width: view === 'dock' ? 1180 : 1440, height: 1000, dockWidth: 420, theme: 'light', seed, session: c.mode };
      const page = await openPage(chrome.cdp, `${server.url}/?${harnessQuery(shot)}`, shot);
      const sent = await page.evaluate(TYPE_AND_SEND);
      const status = await page.evaluate("(document.querySelector('.af-agent .af-agent-status') || {}).textContent || ''");
      const posted = await page.evaluate('JSON.stringify(window.__afPosted)');
      const observed = JSON.parse(posted || '[]').some((p) => p.phase === 'observed');
      const trace = traces.filter((t) => t.sessionId === page.sessionId).map((t) => t.text);
      const ok = sent === 'sent' && c.expect.test(status) && observed === c.posted && page.problems.length === 0;
      if (!ok) failures += 1;
      console.log(`${ok ? 'ok' : '!!'}  ${view.padEnd(4)} ${c.mode.padEnd(9)} status: ${status}`);
      console.log(`      reached the session: ${observed ? 'yes' : 'no'} · trace: ${trace[trace.length - 1] || '(none)'}`);
      for (const p of page.problems) console.log(`      ${p}`);
      await page.done();
    }
  }
} finally {
  chrome.close();
  await server.close();
}
console.log(failures === 0 ? '\nall ask-box cases behaved as expected' : `\n${failures} case(s) did not`);
process.exit(failures === 0 ? 0 : 1);
