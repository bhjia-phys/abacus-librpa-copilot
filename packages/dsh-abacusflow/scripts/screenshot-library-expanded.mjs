#!/usr/bin/env node
/**
 * Capture the database tab with a record expanded, so the on-demand figure is visible.
 *
 *   node scripts/screenshot-library-expanded.mjs [outPng]
 *
 * Drives headless Chrome over the DevTools protocol: loads the real preview server, clicks
 * the first record row to expand it, waits for the upstream figure to load, then screenshots.
 * This is the only way to verify that a 250 KB figure really travels from Hugging Face through
 * the host proxy into the panel.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outPng = resolve(process.argv[2] ?? resolve(here, '..', '..', '..', 'screenshots-v2', 'library-expanded.png'));

const CHROME = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;

mkdirSync(dirname(outPng), { recursive: true });

// ---- preview server ----------------------------------------------------------------
const server = spawn(process.execPath, [resolve(here, 'preview-server.mjs')], {
  cwd: resolve(here, '..'),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let baseUrl = null;
server.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  const m = /(http:\/\/127\.0\.0\.1:\d+)/.exec(text);
  if (m && !baseUrl) baseUrl = m[1];
});
await new Promise((done, fail) => {
  const timer = setTimeout(() => fail(new Error('preview server did not print a URL')), 30_000);
  const check = setInterval(() => {
    if (baseUrl) {
      clearTimeout(timer);
      clearInterval(check);
      done();
    }
  }, 200);
});

// ---- chrome ------------------------------------------------------------------------
const profile = resolve(here, '..', '..', '..', '.chrome-profile-libshot');
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--hide-scrollbars',
  '--window-size=1440,1200',
  'about:blank',
], { stdio: 'ignore' });

const waitForDevtools = async () => {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Chrome DevTools did not start');
};

const wsUrl = await waitForDevtools();
const ws = new WebSocket(wsUrl);
await new Promise((done) => ws.addEventListener('open', done, { once: true }));

let seq = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve: ok, reject: bad } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) bad(new Error(msg.error.message));
    else ok(msg.result);
  } else if (msg.method) {
    events.push(msg);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((ok, bad) => {
    const id = ++seq;
    pending.set(id, { resolve: ok, reject: bad });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

const target = await send('Target.createTarget', { url: 'about:blank' });
const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
const sessionId = attached.sessionId;

await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride',
  { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false }, sessionId);

const goto = async (url) => {
  await send('Page.navigate', { url }, sessionId);
  await new Promise((r) => setTimeout(r, 1500));
};
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
  return res.result.value;
};

// The panel remembers its place in `abacusflow:ui`; seed it so the app opens on 数据库 rather
// than defaulting to 运行 (a `place=` query parameter is not a thing the client reads).
const seed = encodeURIComponent(JSON.stringify({ 'abacusflow:ui': JSON.stringify({ place: 'library' }) }));
await goto(`${baseUrl}/?view=main&reset=1&seed=${seed}`);

// Wait for the record list, then expand the first row.
await evaluate(`(async () => {
  for (let i = 0; i < 100; i++) {
    const rows = document.querySelectorAll('.af-lib-record-head');
    if (rows.length > 0) { rows[0].click(); return rows.length; }
    await new Promise(r => setTimeout(r, 200));
  }
  return -1;
})()`);

// Wait until the upstream figure has actually decoded.
const state = await evaluate(`(async () => {
  for (let i = 0; i < 200; i++) {
    const img = document.querySelector('.af-lib-img');
    if (img && img.complete && img.naturalWidth > 0) {
      return { ok: true, w: img.naturalWidth, h: img.naturalHeight, src: img.src.slice(0, 90) };
    }
    await new Promise(r => setTimeout(r, 200));
  }
  const img = document.querySelector('.af-lib-img');
  return { ok: false, present: Boolean(img), src: img ? img.src.slice(0, 90) : null };
})()`);

const errors = events
  .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => JSON.stringify(e.params).slice(0, 200));

await send('Page.captureScreenshot', { format: 'png' }, sessionId).then((shot) => {
  writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
});

console.log('figure:', JSON.stringify(state));
console.log('page errors:', errors.length ? errors : 'none');
console.log('wrote', outPng);

ws.close();
chrome.kill();
server.kill();
process.exit(state.ok ? 0 : 1);
