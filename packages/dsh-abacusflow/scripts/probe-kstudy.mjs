#!/usr/bin/env node
/**
 * Print a k-point convergence study as the panel shows it.
 *
 *   node scripts/probe-kstudy.mjs <study-dir|snapshot.json> [--material Si]
 *
 * Works with either evidence shape: a live `<material>/k<mesh>` tree, or the analysis
 * snapshot a finished campaign leaves behind.
 */
import { resolve } from 'node:path';
import { buildKStudy, adjacentMeshDeltas } from '../lib/host/kstudy.js';

const args = process.argv.slice(2);
const matIndex = args.indexOf('--material');
const material = matIndex >= 0 ? args[matIndex + 1] : null;
const target = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));

if (!target) {
  console.error('usage: node scripts/probe-kstudy.mjs <study-dir|snapshot.json> [--material Si]');
  process.exit(2);
}

const study = buildKStudy(resolve(target));
console.log(`source        ${study.source}`);
console.log(`observedUtc   ${study.observedUtc ?? '—'}`);
console.log(`error         ${JSON.stringify(study.error)}`);
if (study.limitation) console.log(`limitation    ${study.limitation}`);
console.log('');

const materials = material
  ? study.materials.filter((m) => m.material === material)
  : study.materials;

for (const m of materials) {
  console.log(`=== ${m.material} (${m.meshes.length} meshes)`);
  for (const mesh of m.meshes) {
    const label = `k${String(mesh.mesh).repeat(3)}`;
    const gaps = mesh.iterations.map((i) => i.gapEv);
    const last = gaps.filter((g) => typeof g === 'number').pop();
    const first = gaps.find((g) => typeof g === 'number');
    console.log(
      `  ${label}  ${String(mesh.iterations.length).padStart(2)} iters` +
        `  gap ${typeof first === 'number' ? first.toFixed(4) : '—'} -> ${typeof last === 'number' ? last.toFixed(4) : '—'} eV` +
        (mesh.complete === false ? '  [incomplete]' : ''),
    );
  }
  console.log('');
}

const deltas = material ? study.deltas.filter((d) => d.material === material) : adjacentMeshDeltas(study.materials);
if (deltas.length > 0) {
  console.log('adjacent-mesh gap difference:');
  for (const d of deltas) {
    const meV = typeof d.deltaGapEv === 'number' ? (d.deltaGapEv * 1000).toFixed(1) : '—';
    console.log(
      `  ${d.material.padEnd(4)} k${String(d.coarser).repeat(3)} -> k${String(d.finer).repeat(3)}` +
        `   ${meV} meV`,
    );
  }
}

if (study.warnings.length) {
  console.log('\nwarnings:');
  for (const w of study.warnings) console.log('  !', w);
}
