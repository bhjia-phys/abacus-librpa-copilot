#!/usr/bin/env node
/**
 * Drive the remote tools end to end: list a real remote run, then pull it.
 *
 *   node scripts/probe-remote.mjs <host> <remote-run> <local-root> [--pull]
 */
import { apply } from '../lib/index.js';

const [host, remoteRun, localRoot] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const doPull = process.argv.includes('--pull');

if (!host || !remoteRun) {
  console.error('usage: node scripts/probe-remote.mjs <host> <remote-run> [<local-root>] [--pull]');
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
apply(ctx, { remoteHost: host, remoteLocalRoot: localRoot ?? '' });

const list = await tools.abacus_remote_list.execute({ host, run: remoteRun });
console.log('=== abacus_remote_list');
console.log(`error: ${JSON.stringify(list.error)}`);
console.log(`elapsed: ${list.elapsedMs} ms (SSH connection setup is ~11.5 s of this)`);
console.log(tools.abacus_remote_list.output.render({}, list)[0].text);

if (doPull) {
  if (!localRoot) {
    console.error('\n--pull needs a local-root argument');
    process.exit(1);
  }
  console.log('\n=== abacus_remote_pull');
  const pulled = await tools.abacus_remote_pull.execute({ host, run: remoteRun, localRoot });
  console.log(tools.abacus_remote_pull.output.render({}, pulled)[0].text);
}
