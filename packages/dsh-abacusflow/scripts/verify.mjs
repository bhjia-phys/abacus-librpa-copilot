#!/usr/bin/env node
/**
 * Verify the package is installable and self-consistent.
 *
 * Checks:
 *  1. every file listed in package.json "files"/"exports" exists;
 *  2. every relative import inside lib/**.js resolves;
 *  3. no third-party import anywhere in lib/ (only node: builtins and relative paths);
 *  4. client.js is loadable as a script body (parses) and declares the module-loader
 *     wrapper with id '@local/abacusflow';
 *  5. cordis.patch.yml references the package name declared in package.json;
 *  6. locale JSON files parse and carry meta.title/meta.description;
 *  7. icon.svg exists and is a plausible SVG.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

function ok(message) {
  notes.push(message);
}

const pkgPath = join(root, 'package.json');
if (!existsSync(pkgPath)) {
  console.error('FATAL: package.json missing');
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

// 1 -------------------------------------------------------------------------
const required = [
  'lib/index.js',
  'lib/client.js',
  'cordis.patch.yml',
  'icon.svg',
  'locale/zh.json',
  'locale/en.json',
];
for (const rel of required) {
  if (!existsSync(join(root, rel))) fail(`required file missing: ${rel}`);
}
for (const [key, value] of Object.entries(pkg.exports ?? {})) {
  if (value === './package.json') continue;
  const paths = typeof value === 'string' ? [value] : Object.values(value);
  for (const p of paths) {
    if (String(p).includes('*')) continue;
    if (!existsSync(join(root, String(p)))) fail(`exports["${key}"] points at missing file: ${p}`);
  }
}
const filesGlobs = pkg.files ?? [];
if (!filesGlobs.some((g) => g.startsWith('lib'))) fail('package.json "files" does not include lib/');
if (!filesGlobs.includes('cordis.patch.yml')) fail('package.json "files" does not include cordis.patch.yml');
ok(`manifest: ${pkg.name}@${pkg.version}, ${required.length} required files present`);

// 2 + 3 ---------------------------------------------------------------------
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const libFiles = existsSync(join(root, 'lib')) ? walk(join(root, 'lib')) : [];
const importRe = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g;
const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

for (const file of libFiles) {
  const text = readFileSync(file, 'utf8');
  const relFile = relative(root, file).replace(/\\/g, '/');
  for (const re of [importRe, dynamicRe]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const spec = m[1];
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const target = resolve(dirname(file), spec);
        if (!existsSync(target)) fail(`${relFile}: unresolved import ${spec}`);
        continue;
      }
      fail(`${relFile}: third-party import "${spec}" (only node: builtins and relative paths allowed)`);
    }
  }
}
ok(`imports: ${libFiles.length} lib files scanned, no third-party imports`);

// 4 -------------------------------------------------------------------------
const clientPath = join(root, 'lib/client.js');
if (existsSync(clientPath)) {
  const source = readFileSync(clientPath, 'utf8');
  if (!source.includes('__ModuleLoader__')) fail('lib/client.js does not reference window.__ModuleLoader__');
  if (!source.includes('@local/abacusflow')) fail("lib/client.js does not declare id '@local/abacusflow'");
  if (!/inject\s*:\s*\[/.test(source)) fail('lib/client.js does not export an inject list');
  if (!/apply\s*\(\s*ctx\s*\)/.test(source)) fail('lib/client.js does not export apply(ctx)');
  try {
    new vm.Script(source, { filename: 'client.js' });
    ok(`client.js: parses as a script (${(source.length / 1024).toFixed(1)} KiB)`);
  } catch (error) {
    fail(`lib/client.js does not parse: ${error.message}`);
  }
} else {
  fail('lib/client.js missing');
}

// 5 -------------------------------------------------------------------------
const patchPath = join(root, 'cordis.patch.yml');
if (existsSync(patchPath)) {
  const patch = readFileSync(patchPath, 'utf8');
  if (!patch.includes(pkg.name)) fail(`cordis.patch.yml does not mention the package name ${pkg.name}`);
  if (!/^\s*-?\s*insert:/m.test(patch)) fail('cordis.patch.yml has no insert: block');
  ok('cordis.patch.yml: insert block present and references the package name');
}

// 6 -------------------------------------------------------------------------
for (const rel of ['locale/zh.json', 'locale/en.json']) {
  const p = join(root, rel);
  if (!existsSync(p)) continue;
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    if (!data?.meta?.title) fail(`${rel}: missing meta.title`);
    if (!data?.meta?.description) fail(`${rel}: missing meta.description`);
  } catch (error) {
    fail(`${rel}: invalid JSON (${error.message})`);
  }
}
ok('locale: zh/en metadata present');

// 7 -------------------------------------------------------------------------
const iconPath = join(root, 'icon.svg');
if (existsSync(iconPath)) {
  const svg = readFileSync(iconPath, 'utf8').trim();
  if (!svg.startsWith('<svg')) fail('icon.svg does not start with <svg');
  if (!svg.includes('viewBox')) fail('icon.svg has no viewBox');
  const bytes = Buffer.byteLength(svg, 'utf8');
  if (bytes > 256 * 1024) fail(`icon.svg exceeds 256 KiB (${bytes} bytes)`);
  ok(`icon.svg: ${bytes} bytes, has viewBox`);
}

// host half loads -----------------------------------------------------------
try {
  const mod = await import(new URL('./lib/index.js', `file://${root.replace(/\\/g, '/')}/`).href);
  if (!mod.apply) fail('lib/index.js does not export apply');
  if (!Array.isArray(mod.inject)) fail('lib/index.js does not export inject array');
  ok(`host: apply/inject exported (inject: ${JSON.stringify(mod.inject)})`);
} catch (error) {
  fail(`lib/index.js failed to load: ${error.message}`);
}

// ---------------------------------------------------------------------------
for (const n of notes) console.log(`  ok  ${n}`);
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log('\nverify: all checks passed');
