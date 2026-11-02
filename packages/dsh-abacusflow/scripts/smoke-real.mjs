#!/usr/bin/env node
/**
 * Smoke-check the parsers against real calculation directories.
 *
 * Usage:
 *   node scripts/smoke-real.mjs <dir> [<dir> ...]
 *   node scripts/smoke-real.mjs --depth 5 <dir>
 *
 * For each directory it scans, prints every task it recognises together with the facts
 * the panel would show. This is the fastest way to tell "the parser is wrong" apart from
 * "the panel is wrong" when a real calculation looks off.
 */
import { scanProject } from '../lib/host/scanner.js';
import { buildTaskBundle } from '../lib/host/task-bundle.js';

const argv = process.argv.slice(2);
let depth = 4;
const roots = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--depth') {
    depth = Number(argv[i + 1]);
    i += 1;
  } else {
    roots.push(argv[i]);
  }
}

if (roots.length === 0) {
  console.error('usage: node scripts/smoke-real.mjs [--depth N] <dir> [<dir> ...]');
  process.exit(2);
}

const fmt = (v, d = 6) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');

let failures = 0;

for (const root of roots) {
  console.log(`\n=== ${root} (depth ${depth}) ===`);
  const scan = await scanProject(root, { maxDepth: depth });
  if (scan.error) {
    console.error(`  scan error: ${scan.error}`);
    failures += 1;
    continue;
  }
  console.log(
    `  ${scan.counts.total} task(s): abacus ${scan.counts.abacus}, librpa ${scan.counts.librpa}, ` +
      `coupled ${scan.counts.coupled}; ${scan.scannedDirs} dirs in ${scan.elapsedMs} ms`,
  );
  if (scan.tasks.length === 0) {
    console.log('  (no tasks recognised)');
    continue;
  }
  for (const task of scan.tasks) {
    const bundle = buildTaskBundle(task);
    console.log(`\n  [${task.relPath || '.'}] ${task.kind} -> ${bundle.status.label} (${bundle.status.code})`);
    console.log(`    reason: ${bundle.status.reason}`);
    if (bundle.status.evidence?.length) console.log(`    evidence: ${bundle.status.evidence.join(' | ')}`);

    const a = bundle.abacus;
    if (a) {
      if (a.versions) console.log(`    ABACUS ${a.versions.version ?? '?'} (${a.versions.commit ?? 'no commit'})`);
      console.log(`    calculation=${a.calculation ?? '?'} basis=${a.basisType ?? '?'} output=${a.outputDir ?? 'missing'}`);
      if (a.stru) {
        console.log(
          `    structure: ${a.stru.species.map((s) => s.label).join('/')} natom=${a.stru.natom} ` +
            `a0=${fmt(a.stru.latticeConstant)} ${a.stru.latticeConstantUnit} V=${fmt(a.cellVolumeAngstrom3, 3)} A^3`,
        );
      }
      if (a.kpt) {
        console.log(
          `    kpt: ${a.kpt.mode === 'auto' ? `${a.kpt.centering} ${(a.kpt.grid ?? []).join('x')} shift ${(a.kpt.shift ?? []).join(',')}` : `${a.kpt.nkpts ?? (a.kpt.points ?? []).length} explicit`}`,
        );
      }
      if (a.log) {
        const lg = a.log;
        const last = lg.iterations[lg.iterations.length - 1];
        console.log(
          `    log ${a.logFile}: ${lg.iterations.length} SCF records, ${new Set(lg.iterations.map((i) => i.ionicStep)).size} ionic steps`,
        );
        console.log(
          `      scfConverged=${lg.scfConverged} finished=${lg.finished} maxForce=${fmt(lg.maxForce)} ` +
            `lastE=${fmt(last?.eKohnShamEv)} eV gap=${fmt(last?.gapEv)} rho=${fmt(last?.rhoDeviation)}`,
        );
        if (lg.errors.length) console.log(`      errors: ${lg.errors.map((e) => e.code).join(', ')}`);
        if (lg.timings.length) console.log(`      timing rows: ${lg.timings.length}, memory rows: ${lg.memory.length}`);
      }
      if (a.warnings.length) console.log(`    warning.log: ${a.warnings.length} lines`);
    }

    const l = bundle.librpa;
    if (l) {
      console.log(`    librpa task=${l.task ?? '?'} output=${l.outputDir} files=${bundle.files.length}`);
      if (l.log) {
        console.log(
          `      build: ${l.log.build['Build type'] ?? '?'} / hash ${l.log.build['Source code Git hash'] ?? '?'} / LibRI ${l.log.build['Use LibRI'] ?? '?'}`,
        );
        console.log(`      finished=${l.log.finished} driverParams=${Object.keys(l.log.driverParams).length} timings=${l.log.timings.length}`);
      }
      if (l.qsgw?.iterations?.rows?.length) {
        const rows = l.qsgw.iterations.rows;
        const tail = rows[rows.length - 1];
        console.log(
          `      qsgw iterations=${rows.length} convergedIter=${l.qsgw.iterations.convergedIter} ` +
            `lastGap=${fmt(tail.gap_eV)} eV lastDeltaE=${fmt(tail.max_delta_eV)} eV`,
        );
      }
      if (l.qsgw?.eigenvalues) {
        const e = l.qsgw.eigenvalues;
        console.log(
          `      qsgw eigenvalues: nIter=${e.nIter} nK=${e.nKpoint} nBand=${e.nBand} ` +
            `range ${fmt(e.minEnergyEv)} .. ${fmt(e.maxEnergyEv)} eV`,
        );
      }
      if (l.qsgw?.hasMatrices) console.log(`      qsgw_matrices.dat ${(l.qsgw.matricesBytes / 1024).toFixed(0)} KiB`);
    }
    if (bundle.notes.length) console.log(`    notes: ${bundle.notes.join(' | ')}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} root(s) failed to scan`);
  process.exit(1);
}
console.log('\nsmoke: done');
