#!/usr/bin/env node
/**
 * Drive the band tools against real topics, exactly as the Agent loop would.
 *
 *   node scripts/probe-band-tools.mjs <root> <relPath> [<relPath> ...]
 */
import { apply } from '../lib/index.js';

const [root, ...relPaths] = process.argv.slice(2);
if (!root || relPaths.length === 0) {
  console.error('usage: node scripts/probe-band-tools.mjs <root> <relPath> ...');
  process.exit(2);
}

const tools = {};
const ctx = {
  effect(fn) {
    const d = fn();
    return typeof d === 'function' ? d : () => {};
  },
  tools: { register(def) { tools[def.name] = def; return () => {}; } },
  webServer: { register() { return () => {}; } },
  get() { return undefined; },
};
apply(ctx, {});

const exec = { agent: { session: { header: { cwd: process.cwd() } } } };

const bands = await tools.abacus_bands.execute({ rootPath: root, relPaths }, exec);
console.log('=== abacus_bands ===');
console.log(`error: ${JSON.stringify(bands.error)}`);
console.log(tools.abacus_bands.output.render({}, bands)[0].text);

const lib = await tools.librpa_bands.execute({ rootPath: root, relPaths }, exec);
console.log('\n=== librpa_bands ===');
console.log(`error: ${JSON.stringify(lib.error)}`);
console.log(tools.librpa_bands.output.render({}, lib)[0].text);
