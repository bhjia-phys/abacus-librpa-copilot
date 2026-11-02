#!/usr/bin/env node
/**
 * Smoke-check the *scanner* alone (no parser dependencies).
 *
 *   node scripts/smoke-scan.mjs [--depth N] <dir> [<dir> ...]
 */
import { scanProject } from '../lib/host/scanner.js';

const argv = process.argv.slice(2);
let depth = 4;
const roots = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--depth') {
    depth = Number(argv[i + 1]);
    i += 1;
  } else roots.push(argv[i]);
}
if (roots.length === 0) {
  console.error('usage: node scripts/smoke-scan.mjs [--depth N] <dir> ...');
  process.exit(2);
}

for (const root of roots) {
  const scan = await scanProject(root, { maxDepth: depth });
  console.log(`\n=== ${root} ===`);
  if (scan.error) {
    console.error(`  error: ${scan.error}`);
    continue;
  }
  console.log(
    `  ${scan.counts.total} task(s) — abacus ${scan.counts.abacus}, librpa ${scan.counts.librpa}, ` +
      `coupled ${scan.counts.coupled}; ${scan.scannedDirs} dirs in ${scan.elapsedMs} ms; truncated=${scan.truncated}`,
  );
  for (const t of scan.tasks) {
    console.log(
      `   - ${t.relPath || '.'}  [${t.kind}]  out=${t.outputDir ?? '—'}  ` +
        `stru=${t.hasStru} kpt=${t.hasKpt}  files=${t.files.length}`,
    );
  }
}
