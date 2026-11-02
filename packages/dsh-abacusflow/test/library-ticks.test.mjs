/**
 * Band-path ticks and the LibRPA-database library.
 *
 * Two things are pinned here:
 *   - the KPT's `# Label` comments become x-axis ticks at the right *positions*, not just
 *     names in a list (a band plot is drawn against cumulative path length);
 *   - the material matcher identifies NiO / Bi2Se3 / Si from their STRU compositions and
 *     does not collapse chemically distinct records into one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { parseKpt } from '../lib/host/abacus/kpt.js';
import { placeTicks, readKTicks } from '../lib/host/bands.js';
import {
  formulaFromSpecies,
  parseFormula,
  sameFormula,
  speciesCountsFromStru,
  materialCandidates,
  loadLibrary,
  matchTask,
} from '../lib/host/library.js';

// ---------------------------------------------------------------- ticks -----

const BI2SE3_KPT = `K_POINTS
 5
Line
   0.00000000   0.00000000   0.00000000   10     #Γ
   0.00000000   0.00000000   0.50000000   30 #Z
   0.50000000   0.50000000   0.00000000   30     #F
   0.00000000   0.00000000   0.00000000   30     #Γ
   0.50000000   0.00000000   0.00000000   1      #L
`;

const NIO_KPT = `K_POINTS
13
Line
0 0 0 40 # G
0.5 0 0 40 # L
0.5 0.1875 -0.375 1 # B1
0.8125 0.5 -0.3125 40 # B
0.5 0.5 0 40 # Z
0 0 0 40 # G
0.34375 0 -0.34375 1 # X
0.65625 0.34375 -0.34375 40 # Q
0.5 0.5 -0.5 40 # F
0.65625 0.65625 -0.46875 40 # P1
0.5 0.5 0 1 # Z
0.5 0 0 40 # L
0.8125 0.34375 0 1 # P
`;

test('KPT line-mode labels are captured, including Unicode Greek', () => {
  const parsed = parseKpt(BI2SE3_KPT);
  assert.deepEqual(parsed.specialLabels, ['Γ', 'Z', 'F', 'Γ', 'L']);
  assert.equal(parsed.nkpts, 101, '10 + 30 + 30 + 30 + 1');
});

test('a repeated label is kept, because it marks a real return to that point', () => {
  const parsed = parseKpt(BI2SE3_KPT);
  assert.equal(parsed.specialLabels.filter((l) => l === 'Γ').length, 2);
});

test('NiO labels keep their numeric suffixes (B1, P1 are not B or P)', () => {
  const parsed = parseKpt(NIO_KPT);
  assert.deepEqual(parsed.specialLabels, ['G', 'L', 'B1', 'B', 'Z', 'G', 'X', 'Q', 'F', 'P1', 'Z', 'L', 'P']);
  assert.equal(parsed.nkpts, 364);
});

test('segments carry their endpoint labels', () => {
  const parsed = parseKpt(BI2SE3_KPT);
  assert.equal(parsed.segments.length, 4);
  assert.equal(parsed.segments[0].fromLabel, 'Γ');
  assert.equal(parsed.segments[0].toLabel, 'Z');
  assert.equal(parsed.segments[3].toLabel, 'L');
});

test('a KPT without labels yields nulls rather than inventing names', () => {
  const plain = 'K_POINTS\n2\nLine\n0 0 0 5\n0.5 0 0 1\n';
  const parsed = parseKpt(plain);
  assert.deepEqual(parsed.specialLabels, [null, null]);
});

test('a comment with only a number is not treated as a point name', () => {
  const parsed = parseKpt('K_POINTS\n2\nLine\n0 0 0 5 # 1\n0.5 0 0 1 # 2\n');
  assert.deepEqual(parsed.specialLabels, [null, null]);
});

test('placeTicks maps indices onto cumulative path length', () => {
  const kpath = [0, 0.1, 0.2, 0.3, 0.4];
  const ticks = [
    { label: 'Γ', index: 0, position: null },
    { label: 'X', index: 2, position: null },
    { label: 'L', index: 4, position: null },
  ];
  const placed = placeTicks(ticks, kpath);
  assert.deepEqual(placed.map((t) => t.label), ['Γ', 'X', 'L']);
  assert.deepEqual(placed.map((t) => t.position), [0, 0.2, 0.4]);
});

test('placeTicks drops out-of-range indices instead of clamping them', () => {
  // A truncated or re-exported band file can have fewer k points than the KPT declares;
  // clamping would put a label on the wrong point.
  const placed = placeTicks(
    [
      { label: 'Γ', index: 0, position: null },
      { label: 'L', index: 900, position: null },
    ],
    [0, 0.5, 1.0],
  );
  assert.deepEqual(placed.map((t) => t.label), ['Γ']);
});

// ------------------------------------------------------------- formulas -----

test('species counts come from the atom list, not the species declaration', () => {
  // STRU declares each element once in ATOMIC_SPECIES; only the atoms give the ratio.
  const stru = {
    species: [{ label: 'Bi' }, { label: 'Se' }],
    atoms: [
      { label: 'Bi' }, { label: 'Bi' },
      { label: 'Se' }, { label: 'Se' }, { label: 'Se' },
    ],
  };
  const counts = speciesCountsFromStru(stru);
  assert.deepEqual(counts, { Bi: 2, Se: 3 });
  assert.equal(formulaFromSpecies(counts), 'Bi2Se3');
});

test('compounds are reduced to the formula unit', () => {
  // NiO's conventional cell is 2+2; the database keys on NiO.
  assert.equal(formulaFromSpecies({ Ni: 2, O: 2 }), 'NiO');
  assert.equal(formulaFromSpecies({ Mg: 4, O: 4 }), 'MgO');
});

test('single elements keep their exact atom count', () => {
  // Si2, C2, Li2 and N2 are real distinct records from Si, C, Li, N.
  assert.equal(formulaFromSpecies({ Si: 2 }), 'Si2');
  assert.equal(formulaFromSpecies({ C: 2 }), 'C2');
  assert.equal(formulaFromSpecies({ Li: 4 }), 'Li4', 'no reduction for one element');
});

test('parseFormula and sameFormula agree on composition, ignoring order', () => {
  assert.deepEqual(parseFormula('Bi2Se3'), { Bi: 2, Se: 3 });
  assert.deepEqual(parseFormula('Si'), { Si: 1 });
  assert.equal(sameFormula('Se3Bi2', 'Bi2Se3'), true);
  assert.equal(sameFormula('Si', 'Si2'), false);
  assert.equal(sameFormula('C', 'C2'), false);
  assert.equal(sameFormula('MoS2', 'MoS2-WS2'), false);
});

test('a repeated element in a formula is summed', () => {
  assert.deepEqual(parseFormula('CH3CH3'), { C: 2, H: 6 });
});

test('a two-atom single-element cell offers both the molecule and the element', () => {
  const candidates = materialCandidates({ speciesCounts: { Si: 2 }, relPath: 'run/frozen', name: 'frozen' });
  const values = candidates.map((c) => c.value);
  assert.ok(values.includes('Si2'), 'the 2-atom reading');
  assert.ok(values.includes('Si'), 'and the elemental reading');
});

// -------------------------------------------------------------- library -----

const LIB_ROOT = 'F:\\AI_Workspace\\dsh-abacusflow\\database\\LibRPA-database';
const hasLibrary = existsSync(LIB_ROOT + '\\data\\calculations');

test('the real database loads its records and formulas', { skip: !hasLibrary }, () => {
  const library = loadLibrary(LIB_ROOT);
  assert.equal(library.ok, true);
  assert.ok(library.records.length >= 100, `records: ${library.records.length}`);
  assert.ok(library.formulas.includes('NiO'));
  assert.ok(library.formulas.includes('Bi2Se3'));
  assert.ok(library.formulas.includes('Si'));
});

test('NiO is matched from its STRU composition', { skip: !hasLibrary }, () => {
  const library = loadLibrary(LIB_ROOT);
  const result = matchTask({ speciesCounts: { Ni: 2, O: 2 }, relPath: 'x/03_bands', name: '03_bands' }, library);
  assert.ok(result.matches.length > 0, 'a NiO record exists');
  assert.equal(result.exact, true);
  const top = result.matches[0];
  assert.equal(top.confidence, 'high', 'matched via the STRU, not the directory name');
  assert.ok(top.id.toLowerCase().includes('nio'), `record: ${top.id}`);
});

test('Bi2Se3 is matched from its STRU composition', { skip: !hasLibrary }, () => {
  const library = loadLibrary(LIB_ROOT);
  const result = matchTask({ speciesCounts: { Bi: 2, Se: 3 }, relPath: 'x/band_full', name: 'band_full' }, library);
  assert.ok(result.matches.length > 0);
  assert.equal(result.exact, true);
  assert.ok(result.matches[0].id.toLowerCase().includes('bi2se3'));
  assert.equal(typeof result.matches[0].dftGapEv, 'number');
});

test('a material absent from the database reports no match, not a wrong one', { skip: !hasLibrary }, () => {
  const library = loadLibrary(LIB_ROOT);
  const result = matchTask({ speciesCounts: { Xx: 1, Yy: 1 }, relPath: 'x/y', name: 'y' }, library);
  assert.equal(result.matches.length, 0);
  assert.equal(result.exact, false);
});

test('summarized records carry the gap fields the panel compares against', { skip: !hasLibrary }, () => {
  const library = loadLibrary(LIB_ROOT);
  const result = matchTask({ speciesCounts: { Bi: 2, Se: 3 }, relPath: 'x', name: 'x' }, library);
  const record = result.matches[0];
  for (const key of ['id', 'formula', 'dimension', 'gwGapEv', 'dftGapEv', 'scope']) {
    assert.ok(key in record, `missing ${key}`);
  }
});
