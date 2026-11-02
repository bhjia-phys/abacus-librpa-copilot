#!/usr/bin/env node
/**
 * Run the REAL panel against REAL data outside DSH, for visual review.
 *
 *   node scripts/preview-server.mjs [--port 5178] [--root <scan root>] [--library <dir>]
 *   then open http://127.0.0.1:5178/?view=main            (full page)
 *                                   ?view=dock&dockWidth=400 (right-dock tab next to a fake chat)
 *                                   &theme=dark              (DSH's body[data-ds-dark-theme])
 *
 * What is real: the host routes (lib/index.js `apply` with a captured webServer), the data on
 * disk, lib/client.js itself (loaded through a stand-in for window.__ModuleLoader__), and —
 * when DeepSeek Harness is installed — DSH's own theme token sheets, read from its app.asar at
 * request time (nothing of DSH's is copied into this repository). What is fake: the session
 * (posted messages are shown in the fake chat column, so the agent dock can be checked) and the
 * slots service.
 *
 * React is NOT a dependency of this package and is not downloaded. The script looks for the
 * CommonJS builds of react, react-dom and scheduler in:
 *   1. $ABACUSFLOW_REACT_DIR   (a folder holding react/, react-dom/, scheduler/ packages)
 *   2. the local pnpm content store (%LOCALAPPDATA%/pnpm/store/v10), materialised once into
 *      the OS temp directory.
 * Only node: builtins are imported.
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { localData } from './lib/local-data.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

// ------------------------------------------------------------------ react ---

function pnpmStoreIndex() {
  const base = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'pnpm', 'store') : null;
  if (!base || !existsSync(base)) return null;
  for (const version of ['v10', 'v11', 'v3']) {
    const index = join(base, version, 'index');
    if (existsSync(index)) return { store: join(base, version), index };
  }
  return null;
}

function findIndexFile(index, name, majorPrefix) {
  const hits = [];
  for (const shard of readdirSync(index)) {
    const dir = join(index, shard);
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const m = new RegExp(`-${name.replace(/[/+]/g, '\\+')}@(${majorPrefix}[0-9.]*)\\.json$`).exec(entry);
      if (m) hits.push({ file: join(dir, entry), version: m[1] });
    }
  }
  hits.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return hits[0] || null;
}

function materialise(store, indexFile, dest) {
  const index = JSON.parse(readFileSync(indexFile, 'utf8'));
  for (const [rel, info] of Object.entries(index.files)) {
    if (!/^(cjs\/|package\.json$|index\.js$|client\.js$)/.test(rel)) continue;
    const hex = Buffer.from(String(info.integrity).replace(/^sha512-/, ''), 'base64').toString('hex');
    let src = join(store, 'files', hex.slice(0, 2), hex.slice(2));
    if (!existsSync(src) && existsSync(`${src}-exec`)) src = `${src}-exec`;
    if (!existsSync(src)) continue;
    const target = join(dest, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(src));
  }
}

function reactDir() {
  const fromEnv = process.env.ABACUSFLOW_REACT_DIR;
  if (fromEnv && existsSync(join(fromEnv, 'react', 'cjs'))) return fromEnv;
  const cache = join(tmpdir(), 'abacusflow-preview-vendor');
  if (existsSync(join(cache, 'react-dom', 'cjs', 'react-dom-client.development.js'))) return cache;
  const pnpm = pnpmStoreIndex();
  if (pnpm) {
    const react = findIndexFile(pnpm.index, 'react', '19.');
    const dom = findIndexFile(pnpm.index, 'react-dom', '19.');
    const scheduler = findIndexFile(pnpm.index, 'scheduler', '0.');
    if (react && dom && scheduler) {
      materialise(pnpm.store, react.file, join(cache, 'react'));
      materialise(pnpm.store, dom.file, join(cache, 'react-dom'));
      materialise(pnpm.store, scheduler.file, join(cache, 'scheduler'));
      if (existsSync(join(cache, 'react-dom', 'cjs', 'react-dom-client.development.js'))) return cache;
    }
  }
  throw new Error(
    'React 19 CommonJS builds not found. Set ABACUSFLOW_REACT_DIR to a folder holding react/, react-dom/ and scheduler/ (e.g. any node_modules with React 19).',
  );
}

/** react, scheduler, react-dom and react-dom/client as one script exposing window.__afRequire. */
function reactBundle() {
  const dir = reactDir();
  const mods = {
    react: join(dir, 'react', 'cjs', 'react.development.js'),
    scheduler: join(dir, 'scheduler', 'cjs', 'scheduler.development.js'),
    'react-dom': join(dir, 'react-dom', 'cjs', 'react-dom.development.js'),
    'react-dom/client': join(dir, 'react-dom', 'cjs', 'react-dom-client.development.js'),
  };
  const defs = Object.entries(mods)
    .map(([name, file]) => `${JSON.stringify(name)}: function (module, exports, require) {\n${readFileSync(file, 'utf8')}\n}`)
    .join(',\n');
  return `(function () {
var process = { env: { NODE_ENV: 'development' } };
var defs = {\n${defs}\n};
var cache = {};
function req(name) {
  if (cache[name]) return cache[name].exports;
  if (!defs[name]) throw new Error('preview: no module ' + name);
  var module = { exports: {} };
  cache[name] = module;
  defs[name](module, module.exports, req);
  return module.exports;
}
window.__afRequire = req;
})();`;
}

// -------------------------------------------------------------- dsh theme ---

function dshThemeCss() {
  const candidates = [
    process.env.DSH_APP_ASAR,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar') : null,
  ].filter(Boolean);
  const asar = candidates.find((p) => existsSync(p));
  if (!asar) return '/* DeepSeek Harness not found: the panel falls back to its own token values */';
  const fd = openSync(asar, 'r');
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);
    const jsonLength = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonLength);
    readSync(fd, json, 0, jsonLength, 16);
    let node = JSON.parse(json.toString('utf8'));
    for (const part of 'dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'.split('/')) node = node && node.files ? node.files[part] : null;
    if (!node || node.unpacked) return '/* DSH theme module not found in app.asar */';
    const buf = Buffer.alloc(node.size);
    readSync(fd, buf, 0, node.size, 8 + headerSize + Number(node.offset));
    const source = buf.toString('utf8');
    const sheets = [];
    for (const m of source.matchAll(/var (\w+)_css_default = ("(?:[^"\\]|\\.)*");/g)) {
      // A string literal and nothing else, evaluated in an empty context.
      sheets.push(`/* ${m[1]} */\n${vm.runInNewContext(m[2], {})}`);
    }
    return sheets.join('\n') || '/* no theme sheets found */';
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------- harness ---

const HARNESS = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>abacusflow preview</title>
<link rel="stylesheet" href="/dsh-theme.css">
<style>
  html, body { margin: 0; height: 100%; }
  body { background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #111); font-family: var(--dsw-font-family, system-ui); }
  #stage { display: flex; height: 100vh; }
  #main { flex: 1; min-width: 0; height: 100%; }
  #chat { flex: 1; min-width: 0; height: 100%; overflow: auto; padding: 20px 24px; box-sizing: border-box;
    border-right: 1px solid var(--dsw-alias-border-l2, #ddd); font-size: 13px; color: var(--dsw-alias-label-secondary, #666); }
  #chat h1 { font-size: 14px; margin: 0 0 12px; color: var(--dsw-alias-label-primary, #111); }
  #chat .msg { white-space: pre-wrap; font: 11px/16px var(--ds-font-family-code, monospace); padding: 10px 12px; margin: 0 0 10px;
    border-radius: 12px; background: var(--dsw-alias-interactive-bg-hover, #f3f4f6); color: var(--dsw-alias-label-primary, #111); }
  #dock { height: 100%; flex: none; }
</style>
</head>
<body>
<div id="stage"></div>
<script>
  window.__afParams = new URLSearchParams(location.search);
  if (__afParams.get('theme') === 'dark') document.body.setAttribute('data-ds-dark-theme', '');
  if (__afParams.get('reset') === '1') localStorage.clear();
  var seed = __afParams.get('seed');
  if (seed) {
    var parsed = JSON.parse(seed);
    for (var k in parsed) localStorage.setItem(k, typeof parsed[k] === 'string' ? parsed[k] : JSON.stringify(parsed[k]));
  }
  // Idle detection for screenshots: no fetch in flight for 700 ms.
  (function () {
    var pending = 0, last = Date.now(), realFetch = window.fetch.bind(window);
    window.fetch = function () {
      pending += 1; last = Date.now();
      return realFetch.apply(null, arguments).finally(function () { pending -= 1; last = Date.now(); });
    };
    window.__afIdle = function (quiet) {
      quiet = quiet || 700;
      return new Promise(function (resolve) {
        (function check() { if (pending === 0 && Date.now() - last > quiet) resolve(true); else setTimeout(check, 100); })();
      });
    };
  })();
  window.__afPosted = [];
</script>
<script src="/vendor/react.js"></script>
<script>
  var registry = {};
  var fakeSession = {
    beginSubmission: function (sub) {
      window.__afPosted.push(sub.text);
      var chat = document.getElementById('chat');
      if (chat) { var div = document.createElement('div'); div.className = 'msg'; div.textContent = sub.text; chat.appendChild(div); }
      return { id: window.__afPosted.length };
    },
  };
  var fakeCtx = {
    slots: {
      inject: function (name, fn) { return fn(); },
      register: function (desc, component) { registry[desc.name] = component; return function () {}; },
    },
    get: function (name) {
      if (name === 'sessions') return { scope: function () { return { get: function () { return fakeSession; } }; } };
      if (name === 'sidebarRightTabs') return { register: function () { return function () {}; } };
      return undefined;
    },
    effect: function (fn) { return fn(); },
  };
  window.__ModuleLoader__ = { load: function (def) { def.factory(window.__afRequire).apply(fakeCtx); } };
</script>
<script src="/client.js"></script>
<script>
  (function () {
    var React = __afRequire('react');
    var createRoot = __afRequire('react-dom/client').createRoot;
    var stage = document.getElementById('stage');
    if ((__afParams.get('view') || 'main') === 'dock') {
      var chat = document.createElement('div');
      chat.id = 'chat';
      chat.innerHTML = '<h1>对话（预览：面板发出的消息出现在这里）</h1>';
      var dock = document.createElement('div');
      dock.id = 'dock';
      dock.style.width = (__afParams.get('dockWidth') || '400') + 'px';
      stage.appendChild(chat);
      stage.appendChild(dock);
      createRoot(dock).render(React.createElement(registry['sidebar.right.pane.tab'], { sessionId: 'preview' }));
    } else {
      var main = document.createElement('div');
      main.id = 'main';
      stage.appendChild(main);
      createRoot(main).render(React.createElement(registry.main, { sessionId: 'preview' }));
    }
  })();
</script>
</body>
</html>`;

// ----------------------------------------------------------------- server ---

/**
 * @param {{ port?: number, root?: string, library?: string }} [options]
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function startPreviewServer(options = {}) {
  const { apply } = await import(pathToFileURL(join(pkgRoot, 'lib', 'index.js')).href);
  const routes = new Map();
  const ctx = {
    effect: (fn) => fn(),
    webServer: { register: (def) => (routes.set(def.path, def.handler), () => routes.delete(def.path)) },
    tools: { register: () => () => {} },
  };
  apply(ctx, {
    defaultScanRoot: options.root || '',
    maxDepth: 4,
    maxTasks: 500,
    libraryRoot: options.library || '',
  });

  let vendor = null;
  let theme = null;
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    try {
      if (routes.has(url.pathname)) return void routes.get(url.pathname)(req, res);
      if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', HARNESS);
      if (url.pathname === '/client.js') return send(200, 'text/javascript; charset=utf-8', readFileSync(join(pkgRoot, 'lib', 'client.js')));
      if (url.pathname === '/vendor/react.js') return send(200, 'text/javascript; charset=utf-8', (vendor ??= reactBundle()));
      if (url.pathname === '/dsh-theme.css') return send(200, 'text/css; charset=utf-8', (theme ??= dshThemeCss()));
      return send(404, 'application/json', JSON.stringify({ error: 'not found' }));
    } catch (error) {
      return send(500, 'text/plain; charset=utf-8', String(error && error.stack ? error.stack : error));
    }
  });
  await new Promise((done) => server.listen(options.port ?? 0, '127.0.0.1', done));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const server = await startPreviewServer({
    port: Number(arg('port', 5178)),
    root: arg('root', localData().sampleRoot),
    // Metadata-only index (3.1 MB). The bulk data — figures and band curves — is fetched from
    // Hugging Face per object, so a full clone must not be required here.
    library: arg('library', resolve(pkgRoot, '..', '..', 'database', 'library-index')),
  });
  console.log(`abacusflow preview: ${server.url}/?view=main   (dock: ${server.url}/?view=dock&dockWidth=400, dark: &theme=dark)`);
}
