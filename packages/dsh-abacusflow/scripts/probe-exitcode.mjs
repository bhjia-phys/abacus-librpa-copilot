#!/usr/bin/env node
/**
 * Probe `classifyLibrpaRun` across exit codes against a real log.
 *
 *   node scripts/probe-exitcode.mjs <librpa.out>
 *
 * The question this answers: does a non-zero `librpa.exitcode` ever override a log that
 * ended with `libRPA finished successfully`? It must not, because the regression harness
 * records whatever the shell reported and that is not always 0.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyLibrpaRun } from '../lib/host/librpa/output.js';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/probe-exitcode.mjs <librpa.out>');
  process.exit(2);
}
const text = readFileSync(resolve(target), 'utf8');

for (const exitcode of [0, 1, 2, 137, null]) {
  const status = classifyLibrpaRun({ hasOutput: true, logText: text, exitcode, mtimeAgeSeconds: 99999 });
  console.log(`exitcode=${String(exitcode).padStart(4)}  ->  ${status.code.padEnd(9)} ${status.label}  | ${status.reason.slice(0, 70)}`);
  if (status.evidence.length > 0) console.log(`                 evidence: ${status.evidence.join(' / ').slice(0, 160)}`);
}
