#!/usr/bin/env node
/**
 * Exercise every Agent tool against a real calculation directory.
 *
 *   node scripts/probe-tools.mjs <abacus-run-root> [<librpa-run-root>]
 *
 * This is the "does the model-facing half actually work" check: it drives the tool
 * `execute` functions exactly as the Agent loop would, so a broken tool surfaces here
 * rather than in a conversation.
 */
import { apply } from '../lib/index.js';

const [abacusRoot, librpaRoot] = process.argv.slice(2);
if (!abacusRoot && !librpaRoot) {
  console.error('usage: node scripts/probe-tools.mjs <abacus-run-root> [<librpa-run-root>]');
  process.exit(2);
}

/** Minimal Cordis-shaped context that records what the plugin registers. */
const tools = {};
const routes = [];
const ctx = {
  effect(fn) {
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  tools: {
    register(definition) {
      tools[definition.name] = definition;
      return () => {};
    },
  },
  webServer: {
    register(route) {
      routes.push(route.path);
      return () => {};
    },
  },
  get() {
    return undefined;
  },
};

apply(ctx, {});

console.log(`tools registered   ${Object.keys(tools).join(', ')}`);
console.log(`routes registered  ${routes.join(', ')}`);

const exec = { agent: { session: { header: { cwd: process.cwd() } } } };

function show(label, value) {
  console.log(`\n=== ${label}`);
  console.log(`  error: ${JSON.stringify(value.error ?? null)}`);
  if (value.render) {
    const blocks = value.render;
    const text = Array.isArray(blocks) ? blocks.map((b) => b.text).join('\n') : String(blocks);
    for (const line of text.split('\n').slice(0, 14)) console.log(`  | ${line}`);
  }
}

// ---- ABACUS ---------------------------------------------------------------
if (abacusRoot) {
  const scan = await tools.abacus_scan.execute({ rootPath: abacusRoot, maxDepth: 4 }, exec);
  show('abacus_scan', { ...scan, render: tools.abacus_scan.output.render({}, scan) });

  const rel = scan.tasks[0]?.relPath;
  if (!rel) {
    console.log('\nno tasks found — skipping the per-task tools');
  } else {
    const inspect = await tools.abacus_inspect.execute({ rootPath: abacusRoot, relPaths: [rel] }, exec);
    show('abacus_inspect', { ...inspect, render: tools.abacus_inspect.output.render({}, inspect) });

    const conv = await tools.abacus_convergence.execute({ rootPath: abacusRoot, relPaths: [rel] }, exec);
    show('abacus_convergence', { ...conv, render: tools.abacus_convergence.output.render({}, conv) });

    const stru = await tools.abacus_structure.execute({ rootPath: abacusRoot, relPaths: [rel] }, exec);
    show('abacus_structure', { ...stru, render: tools.abacus_structure.output.render({}, stru) });
    console.log(`  scene atoms=${stru.results[0]?.scene?.atoms?.length} bonds=${stru.results[0]?.scene?.bonds?.length}`);

    const inputs = await tools.abacus_inputs.execute({ rootPath: abacusRoot, relPaths: [rel] }, exec);
    show('abacus_inputs', { ...inputs, render: tools.abacus_inputs.output.render({}, inputs) });
  }
}

// ---- LibRPA ---------------------------------------------------------------
if (librpaRoot) {
  const scan = await tools.abacus_scan.execute({ rootPath: librpaRoot, maxDepth: 6 }, exec);
  const rel = scan.tasks.find((t) => t.kind !== 'abacus')?.relPath;
  if (!rel) {
    console.log('\nno LibRPA task found under the given root');
  } else {
    const lib = await tools.librpa_inspect.execute({ rootPath: librpaRoot, relPaths: [rel] }, exec);
    show('librpa_inspect', { ...lib, render: tools.librpa_inspect.output.render({}, lib) });
  }
}

console.log('\nprobe-tools: done');
