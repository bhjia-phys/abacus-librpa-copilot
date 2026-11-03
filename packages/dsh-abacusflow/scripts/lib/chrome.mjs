/**
 * Headless Chrome over the DevTools protocol, with Node's built-in WebSocket (Node ≥ 22).
 * Shared by scripts/screenshots.mjs and scripts/render-preview.mjs. node: builtins only.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data || ''}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const listener of this.listeners) listener(msg);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  once(method, sessionId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
      const listener = (msg) => {
        if (msg.method === method && msg.sessionId === sessionId) {
          clearTimeout(timer);
          this.listeners = this.listeners.filter((l) => l !== listener);
          resolve(msg.params);
        }
      };
      this.listeners.push(listener);
    });
  }
}

export async function launchChrome() {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; set CHROME_PATH`);
  const profile = mkdtempSync(join(tmpdir(), 'abacusflow-chrome-'));
  const child = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--force-device-scale-factor=1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i += 1) await new Promise((r) => setTimeout(r, 100));
  const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return {
    cdp: new Cdp(ws),
    close: () => {
      ws.close();
      child.kill();
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        /* Chrome may still hold the profile for a moment */
      }
    },
  };
}

/**
 * Open `url` in a fresh tab at `width`×`height`, run `actions` (JS expressions), and wait
 * until the harness reports no request in flight. Returns the tab plus every console error,
 * warning and page exception seen. Call `done()` to close the tab.
 */
export async function openPage(cdp, url, { width, height, actions = [] }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const problems = [];
  const listener = (msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      problems.push(`exception: ${d.exception ? d.exception.description : d.text}`);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
      problems.push(`${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400)}`);
    }
  };
  cdp.listeners.push(listener);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  const loaded = cdp.once('Page.loadEventFired', sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  await loaded;
  const idle = () => cdp.send('Runtime.evaluate', { expression: 'window.__afIdle(900)', awaitPromise: true }, sessionId);
  await idle();
  for (const action of actions) {
    await cdp.send('Runtime.evaluate', { expression: action, awaitPromise: true }, sessionId);
    await idle();
  }
  await new Promise((r) => setTimeout(r, 400));
  const evaluate = async (expression) => (await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
  return {
    sessionId,
    problems,
    evaluate,
    screenshot: async () => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)).data, 'base64'),
    done: async () => {
      cdp.listeners = cdp.listeners.filter((l) => l !== listener);
      await cdp.send('Target.closeTarget', { targetId });
    },
  };
}

/** Query string for the preview harness (scripts/preview-server.mjs). */
export function harnessQuery({ view = 'main', theme = 'light', seed = {}, dockWidth, session, host }) {
  return new URLSearchParams({
    view,
    theme,
    reset: '1',
    seed: JSON.stringify(seed),
    ...(dockWidth ? { dockWidth: String(dockWidth) } : {}),
    // How the stand-in session service behaves (see the harness in preview-server.mjs).
    ...(session ? { session } : {}),
    // `old` makes the harness answer like the first release's host (see preview-server.mjs).
    ...(host ? { host } : {}),
  }).toString();
}
