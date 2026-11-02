/**
 * ABACUS `STRU` parser plus its physical-cell helpers, and the structure scene.
 *
 * The decisive assertions here are the *non-orthogonal* cells: the Si2 diamond fixture is
 * cubic-symmetric, so it cannot distinguish ABACUS's row-vector convention
 * (`cart = frac * latvec`) from the transposed one (`cart = latvec * frac`). The hexagonal
 * fixture can, which is why it exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseStru,
  cellAngstrom,
  cellVolume,
  toCart,
  toFrac,
  invert3,
  applyLatname,
} from '../lib/host/abacus/stru.js';
import { latticeFromLatname } from '../lib/host/abacus/latname.js';
import { struToScene, radiusOf, colorOf, atomicNumberOf, hillFormula } from '../lib/host/abacus/stru-scene.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', 'abacus', name), 'utf8');

/** Bohr -> Angstrom (CODATA 2018). */
const BOHR = 0.529177210903;

const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ------------------------------------------------------------- Si2 diamond --

test('STRU parses the Si2 diamond fixture', () => {
  const stru = parseStru(fixture('STRU'));
  assert.equal(stru.natom, 2);
  assert.equal(stru.species.length, 1);
  assert.equal(stru.species[0].label, 'Si');
  assert.equal(stru.species[0].pp, 'Si.pz-vbc.UPF');
  assert.equal(stru.species[0].mass, 1.0);
  assert.deepEqual(stru.species[0].orbitals, ['./Si_lda_8.0au_50Ry_2s2p1d']);
  assert.deepEqual(stru.orbitals, ['./Si_lda_8.0au_50Ry_2s2p1d']);
  assert.equal(stru.latticeConstant, 10.2);
  assert.equal(stru.latticeConstantUnit, 'Bohr');
  assert.deepEqual(stru.latticeVectors, [[0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]]);
  assert.equal(stru.coordinateMode, 'Cartesian');
  assert.equal(stru.coordinateModeRaw, 'Cartesian');
  assert.equal(stru.coordinateSystem, 'cartesian_lat0');
  assert.equal(stru.originCentered, false);
  // Cartesian coordinates are in units of LATTICE_CONSTANT.
  assert.deepEqual(stru.atoms[0].coords, [0, 0, 0]);
  assert.deepEqual(stru.atoms[1].coords, [0.25, 0.25, 0.25]);
  assert.deepEqual(stru.atoms[0].move, [0, 0, 0]);
  assert.deepEqual(stru.atoms[1].move, [1, 1, 1]);
  assert.equal(stru.atoms[0].index, 1);
  assert.equal(stru.atoms[1].index, 2);
  assert.equal(stru.atoms[0].speciesIndex, 0);
  assert.deepEqual(stru.warnings, []);
});

test('STRU cell volume matches the analytic FCC primitive cell', () => {
  const stru = parseStru(fixture('STRU'));
  const a0 = 10.2 * BOHR;
  assert.ok(close(cellVolume(stru), a0 ** 3 / 4, 1e-9), `volume ${cellVolume(stru)}`);
  const cell = cellAngstrom(stru);
  assert.ok(close(cell[0][1], 0.5 * a0, 1e-12));
});

test('STRU fractional coordinates round-trip through a non-orthogonal lattice', () => {
  const stru = parseStru(fixture('STRU'));
  const cell = cellAngstrom(stru);
  for (const atom of stru.atoms) {
    const back = toCart(atom.frac, cell);
    for (let i = 0; i < 3; i += 1) {
      assert.ok(close(back[i], atom.cartesian[i], 1e-9), `${atom.label}${atom.index} axis ${i}`);
    }
  }
});

// ----------------------------------------------------------- hexagonal cell --

test('STRU uses the ABACUS row-vector convention for Direct -> Cartesian', () => {
  const stru = parseStru(fixture('STRU-hexagonal'));
  assert.equal(stru.coordinateSystem, 'direct');
  assert.equal(stru.latticeConstantUnit, 'Angstrom');
  // Direct coordinates pass through untouched.
  assert.deepEqual(stru.atoms[0].frac, [0.3, 0.7, 0.25]);
  assert.deepEqual(stru.atoms[1].frac, [0.0, 0.0, 0.0]);

  const cell = cellAngstrom(stru);
  assert.ok(close(cell[0][0], 1.0) && close(cell[1][0], -0.5), 'cell stays row-major');
  assert.ok(close(cell[1][1], Math.sqrt(3) / 2, 1e-12));

  // cart_j = sum_i frac_i * cell[i][j]. The transposed convention would give a different
  // y (0.6062… instead of 0.3208…) and a different z, so this pins the convention.
  const expected = [
    0.3 * 1.0 + 0.7 * -0.5 + 0.25 * 0,
    0.3 * 0.0 + 0.7 * (Math.sqrt(3) / 2) + 0.25 * 0,
    0.25 * 2.0,
  ];
  for (let i = 0; i < 3; i += 1) {
    assert.ok(close(stru.atoms[0].cartesian[i], expected[i], 1e-12),
      `cart[${i}] ${stru.atoms[0].cartesian[i]} vs ${expected[i]}`);
  }
  // Volume is |a1 . (a2 x a3)| of the physical cell: (1 x sqrt3/2 x 2).
  assert.ok(close(cellVolume(stru), (Math.sqrt(3) / 2) * 2, 1e-12), `volume ${cellVolume(stru)}`);
});

test('toCart and toFrac are exact inverses for a triclinic cell', () => {
  const cell = [
    [3.0, 0.0, 0.0],
    [1.1, 2.7, 0.0],
    [-0.6, 0.9, 4.2],
  ];
  const inv = invert3(cell);
  assert.ok(inv);
  const frac = [0.13, 0.77, 0.41];
  const back = toFrac(toCart(frac, cell), inv);
  for (let i = 0; i < 3; i += 1) assert.ok(close(back[i], frac[i], 1e-12), `axis ${i}`);
  // A singular cell must return null rather than Infinity/NaN.
  assert.equal(invert3([[1, 2, 3], [2, 4, 6], [0, 0, 1]]), null);
});

// ------------------------------------------------------ coordinate systems --

test('STRU handles Direct coordinates with per-atom magnetism (SOC noncollinear)', () => {
  const stru = parseStru(fixture('STRU-soc-magnetic'));
  assert.equal(stru.natom, 3);
  assert.equal(stru.coordinateMode, 'Direct');
  assert.equal(stru.coordinateSystem, 'direct');
  assert.deepEqual(stru.species.map((s) => s.label), ['Fe', 'Bi']);
  // Two Fe atoms then one Bi, in ATOMIC_SPECIES order.
  assert.deepEqual(stru.atoms.map((a) => a.label), ['Fe', 'Fe', 'Bi']);
  assert.equal(stru.atoms[0].startMag, 1.0);
  // `mag 2.4` is the scalar form: one number, no peek into the next token.
  assert.deepEqual(stru.atoms[0].mag, [2.4]);
  assert.deepEqual(stru.atoms[1].mag, [2.4]);
  // `mag 0.0 0.0 1.5` is the vector form: three numbers.
  assert.deepEqual(stru.atoms[2].mag, [0, 0, 1.5]);
  // Direct coordinates pass through untouched; the cell is the unit cube.
  assert.deepEqual(stru.atoms[0].frac, [0, 0, 0]);
  assert.deepEqual(stru.atoms[2].frac, [0.25, 0.25, 0.25]);
  assert.ok(close(cellVolume(stru), (5.29177210903 * BOHR) ** 3, 1e-6));
  assert.deepEqual(stru.warnings, []);
});

test('STRU parses mag with angle1/angle2 and lambda/sc constraints', () => {
  const text = `ATOMIC_SPECIES
Fe 55.845 Fe.upf
LATTICE_CONSTANT
1.0
LATTICE_VECTORS
1 0 0
0 1 0
0 0 1
ATOMIC_POSITIONS
Direct
Fe
1.0
2
0.0 0.0 0.0 m 0 0 0 mag 1.0 angle1 90 angle2 0
0.5 0.5 0.5 m 1 1 1 mag 1.0 angle1 90 angle2 180 lambda 0.1 0.2 0.3 sc 0.5 0.5 1.0
`;
  const stru = parseStru(text);
  assert.deepEqual(stru.atoms[0].mag, [1.0]);
  assert.deepEqual(stru.atoms[0].angle, [
    { kind: 'angle1', degrees: 90 },
    { kind: 'angle2', degrees: 0 },
  ]);
  assert.deepEqual(stru.atoms[1].angle, [
    { kind: 'angle1', degrees: 90 },
    { kind: 'angle2', degrees: 180 },
  ]);
  assert.deepEqual(stru.atoms[1].constraint, { lambda: [0.1, 0.2, 0.3], target: [0.5, 0.5, 1.0] });
  assert.deepEqual(stru.warnings, []);
});

test('STRU honours Cartesian_angstrom and an Angstrom lattice constant', () => {
  const stru = parseStru(fixture('STRU-angstrom'));
  assert.equal(stru.latticeConstant, 8.0);
  assert.equal(stru.latticeConstantUnit, 'Angstrom');
  assert.equal(stru.coordinateSystem, 'angstrom');
  // Coordinates are already Angstrom: they must NOT be multiplied by a0.
  assert.deepEqual(stru.atoms[0].cartesian, [0.1, 0.2, 0.3]);
  assert.ok(close(cellVolume(stru), 512, 1e-9));
  assert.ok(close(stru.atoms[0].frac[0], 0.1 / 8, 1e-12));
});

test('STRU handles Cartesian_au (Bohr) and the origin-centred variants', () => {
  const au = `ATOMIC_SPECIES
H 1.008 H.upf
LATTICE_CONSTANT
2.0
LATTICE_VECTORS
1 0 0
0 1 0
0 0 1
ATOMIC_POSITIONS
Cartesian_au
H
0.0
1
1.0 0.0 0.0
`;
  const struAu = parseStru(au);
  assert.equal(struAu.coordinateSystem, 'bohr');
  assert.ok(close(struAu.atoms[0].cartesian[0], BOHR, 1e-12), 'Bohr coordinates convert by BOHR_TO_ANG');

  // The centre of this 2 A cube is (1,1,1) A (a0 = 2 Bohr = 1.0583 A per unit vector).
  const centred = au.replace('Cartesian_au', 'Cartesian_angstrom_center_xyz');
  const struC = parseStru(centred);
  assert.equal(struC.originCentered, true);
  assert.deepEqual(struC.centerAxes, ['x', 'y', 'z']);
  const half = (2 * BOHR) / 2;
  assert.ok(close(struC.atoms[0].cartesian[0], 1.0 + half, 1e-12), `x ${struC.atoms[0].cartesian[0]}`);
  assert.ok(close(struC.atoms[0].cartesian[1], 0.0 + half, 1e-12));
  assert.ok(close(struC.atoms[0].cartesian[2], 0.0 + half, 1e-12));

  // A single-axis centred variant shifts only that axis.
  const xyOnly = parseStru(au.replace('Cartesian_au', 'Cartesian_angstrom_center_xy'));
  assert.deepEqual(xyOnly.centerAxes, ['x', 'y']);
  assert.ok(close(xyOnly.atoms[0].cartesian[2], 0.0, 1e-12), 'z must not be shifted');
});

// ------------------------------------------------------ degraded / broken --

test('STRU without LATTICE_VECTORS warns instead of throwing, then latname rebuilds it', () => {
  const stru = parseStru(fixture('STRU-latname'));
  assert.equal(stru.latticeVectors, null);
  assert.ok(stru.warnings.some((w) => w.includes('LATTICE_VECTORS')));
  assert.equal(cellAngstrom(stru), null);
  assert.equal(cellVolume(stru), null);
  // Not throwing is the contract: the caller decides how to degrade.
  assert.equal(stru.natom, 2);

  // This is the real path taken by the H2 run in this workspace (latname = sc).
  applyLatname(stru, 'sc');
  assert.deepEqual(stru.latticeVectors, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  assert.ok(close(cellVolume(stru), (10 * BOHR) ** 3, 1e-9));
  assert.ok(!stru.warnings.some((w) => w.includes('缺少 LATTICE_VECTORS')));
  assert.ok(stru.warnings.some((w) => w.includes('latname=sc')));
  // Fractions are recomputed once the cell is known, and wrap into [0,1) the way ABACUS's
  // check_dtau does: this is the H2 run, whose STRU says z = -0.06614 while ABACUS's own
  // STRU.cif reports the same atom at z = 0.93386.
  assert.ok(close(stru.atoms[0].frac[2], 0.93386, 1e-9), `frac ${stru.atoms[0].frac[2]}`);
  // The coordinate exactly as written is preserved.
  assert.ok(close(stru.atoms[0].coords[2], -0.06614, 1e-12));
});

test('applyLatname leaves an already-complete cell alone and reports unknown latnames', () => {
  const complete = parseStru(fixture('STRU'));
  const before = JSON.stringify(complete.latticeVectors);
  applyLatname(complete, 'fcc');
  assert.equal(JSON.stringify(complete.latticeVectors), before, 'a known cell must not be overwritten');

  const broken = parseStru(fixture('STRU-latname'));
  applyLatname(broken, 'nonsense');
  assert.equal(broken.latticeVectors, null);
  assert.ok(broken.warnings.some((w) => w.includes('latname')));
});

test('latname builders cover the documented lattices', () => {
  assert.deepEqual(latticeFromLatname('sc').vectors, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  const fcc = latticeFromLatname('fcc').vectors;
  assert.deepEqual(fcc, [[0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]]);
  const hex = latticeFromLatname('hexagonal', [2, 3]).vectors;
  assert.ok(close(hex[1][1], Math.sqrt(3), 1e-12));
  assert.equal(hex[2][2], 3);
  assert.equal(latticeFromLatname('user_defined_lattice').vectors, null);
  assert.equal(latticeFromLatname('nonsense').vectors, null);
  assert.ok(latticeFromLatname('nonsense').note.includes('latname'));
});

test('STRU wraps fractional coordinates into [0,1) like ABACUS check_dtau', () => {
  const text = `ATOMIC_SPECIES
H 1.008 H.upf
LATTICE_CONSTANT
10.0
ATOMIC_POSITIONS
Cartesian
H
0.0
2
0.0 0.0 -0.006614
0.0 0.0  0.006614
`;
  const stru = parseStru(text);
  applyLatname(stru, 'sc');
  // Negative fractions wrap to the top of the cell, matching ABACUS's STRU.cif output.
  assert.ok(close(stru.atoms[0].frac[2], 0.993386, 1e-9), `frac ${stru.atoms[0].frac[2]}`);
  assert.ok(close(stru.atoms[1].frac[2], 0.006614, 1e-9));
  // coords keeps exactly what the file said.
  assert.ok(close(stru.atoms[0].coords[2], -0.006614, 1e-12));
  // The Cartesian position is not wrapped: only the fractional view is.
  assert.ok(close(stru.atoms[0].cartesian[2], -0.006614 * 10 * BOHR, 1e-12));
});

test('STRU never throws on malformed content and always reports why', () => {
  const cases = [
    ['', '缺少'],
    ['ATOMIC_SPECIES\nSi\n', 'ATOMIC_SPECIES'],
    ['LATTICE_CONSTANT\nabc\n', 'LATTICE_CONSTANT'],
    ['LATTICE_VECTORS\n1 0 0\n', 'LATTICE_VECTORS'],
    ['ATOMIC_POSITIONS\nDirect\nSi\n0\n1\n0 0\n', '坐标'],
    ['ATOMIC_POSITIONS\nNonsense\nSi\n0\n1\n0 0 0\n', '坐标类型'],
    ['ATOMIC_POSITIONS\nDirect\nSi\n0\n2\n0 0 0\n', '只找到'],
  ];
  for (const [text, needle] of cases) {
    let stru;
    assert.doesNotThrow(() => { stru = parseStru(text); }, `threw on: ${text}`);
    assert.ok(stru.warnings.length > 0, `no warning for: ${text}`);
    assert.ok(Number.isInteger(stru.natom));
    if (needle) {
      assert.ok(stru.warnings.some((w) => w.includes(needle)),
        `expected a warning containing "${needle}", got: ${stru.warnings.join(' | ')}`);
    }
  }
  // Unparseable coordinates are dropped, never turned into NaN.
  const partial = parseStru('ATOMIC_SPECIES\nSi 28 Si.upf\nLATTICE_CONSTANT\n1\nLATTICE_VECTORS\n1 0 0\n0 1 0\n0 0 1\nATOMIC_POSITIONS\nDirect\nSi\n0\n2\nx y z\n0.5 0.5 0.5\n');
  assert.equal(partial.natom, 1);
  assert.ok(!JSON.stringify(partial).includes('NaN'));
});

test('STRU ignores unrecognised trailing tokens with a warning', () => {
  const text = `ATOMIC_SPECIES
Si 28 Si.upf
LATTICE_CONSTANT
1
LATTICE_VECTORS
1 0 0
0 1 0
0 0 1
ATOMIC_POSITIONS
Direct
Si
0
1
0 0 0 1 1 1 bogus 7
`;
  const stru = parseStru(text);
  assert.deepEqual(stru.atoms[0].move, [1, 1, 1]);
  assert.ok(stru.warnings.some((w) => w.includes('bogus')));
});

// ---------------------------------------------------------- scene contract --

test('struToScene builds bonds, a formula and element metadata', () => {
  const stru = parseStru(fixture('STRU'));
  const scene = struToScene(stru, { includeConnectivity: true });
  assert.equal(scene.natom, 2);
  assert.equal(scene.formula, 'Si2');
  assert.deepEqual(scene.counts, { Si: 2 });
  assert.equal(scene.cell.length, 3);
  assert.ok(scene.volume > 0);

  // The Si-Si nearest-neighbour distance in diamond is sqrt(3)/4 * a, and they must bond.
  assert.equal(scene.bonds.length, 1);
  assert.equal(scene.bonds[0].i, 0);
  assert.equal(scene.bonds[0].j, 1);
  assert.equal(scene.bonds[0].order, 1);
  const a0 = 10.2 * BOHR;
  assert.ok(Math.abs(scene.bonds[0].length - (Math.sqrt(3) / 4) * a0) < 1e-4,
    `bond ${scene.bonds[0].length}`);

  // Atom records carry everything the viewer needs.
  assert.equal(scene.atoms[0].element, 'Si');
  assert.equal(scene.atoms[0].z, 14);
  assert.equal(scene.atoms[0].color, colorOf('Si'));
  assert.equal(scene.atoms[0].radius, radiusOf('Si'));
  assert.equal(scene.atoms[0].index, 1);
  assert.equal(scene.atoms[0].label, 'Si1');
  assert.deepEqual(scene.atoms[0].move, [0, 0, 0]);
  assert.equal(scene.connectivityLimited, false);
  assert.equal(scene.bondAlgorithm, 'crystal-nn');
  assert.deepEqual(scene.cellVectors.map((v) => v.label), ['a', 'b', 'c']);
});

test('struToScene detects periodic bonds across the cell boundary', () => {
  // A two-H cell along x with the atoms at x=0 and x=0.8 A. The direct separation (0.8 A)
  // is just outside the H-H cutoff (1.2 * (0.31 + 0.31) = 0.744 A), but the minimum image
  // through the periodic boundary is 0.2 A, which is inside. A non-periodic search would
  // find no bond, so this pins the minimum-image behaviour.
  const text = `ATOMIC_SPECIES
H 1.008 H.upf
LATTICE_CONSTANT
1.0 angstrom
LATTICE_VECTORS
1.0 0 0
0 20 0
0 0 20
ATOMIC_POSITIONS
Cartesian_angstrom
H
0.0
2
0.0 0.0 0.0
0.8 0.0 0.0
`;
  const scene = struToScene(parseStru(text));
  assert.equal(scene.bonds.length, 1, 'the minimum image must be found');
  assert.ok(close(scene.bonds[0].length, 0.2, 1e-5), `length ${scene.bonds[0].length}`);
});

test('struToScene ignores coincident atoms instead of bonding them', () => {
  const text = `ATOMIC_SPECIES
Si 28 Si.upf
LATTICE_CONSTANT
1.0 angstrom
LATTICE_VECTORS
5 0 0
0 5 0
0 0 5
ATOMIC_POSITIONS
Cartesian_angstrom
Si
0.0
2
0.0 0.0 0.0
0.0 0.0 0.0
`;
  // Two atoms at the same point are a duplicate, not a zero-length bond.
  assert.deepEqual(struToScene(parseStru(text)).bonds, []);
});

test('struToScene skips connectivity above the atom cap', () => {
  const stru = parseStru(fixture('STRU'));
  const scene = struToScene(stru, { includeConnectivity: true, maxBondAtoms: 1 });
  assert.equal(scene.connectivityLimited, true);
  assert.deepEqual(scene.bonds, []);
  assert.ok(scene.warnings.some((w) => w.includes('成键')));
  // The atoms and cell are still delivered.
  assert.equal(scene.natom, 2);
});

test('struToScene can skip connectivity entirely and rejects an unknown algorithm', () => {
  const stru = parseStru(fixture('STRU'));
  assert.deepEqual(struToScene(stru, { includeConnectivity: false }).bonds, []);
  assert.equal(struToScene(stru, { includeConnectivity: false }).connectivityLimited, false);
  const odd = struToScene(stru, { bondAlgorithm: 'nonsense' });
  assert.ok(odd.warnings.some((w) => w.includes('nonsense')));
});

test('struToScene degrades without a cell instead of throwing', () => {
  const stru = parseStru(fixture('STRU-latname'));
  const scene = struToScene(stru);
  assert.equal(scene.cell, null);
  assert.equal(scene.cellVectors, null);
  assert.equal(scene.volume, null);
  assert.equal(scene.natom, 2);
  assert.ok(scene.warnings.some((w) => w.includes('晶胞')));

  const empty = struToScene(parseStru(''));
  assert.equal(empty.natom, 0);
  assert.deepEqual(empty.atoms, []);
  assert.deepEqual(empty.bonds, []);
  assert.equal(empty.formula, '');
  assert.doesNotThrow(() => struToScene(null));
});

// -------------------------------------------------------- element metadata --

test('element radius, colour and atomic number fall back for unknown symbols', () => {
  assert.equal(radiusOf('Si'), 1.11);
  assert.equal(radiusOf('Xx'), 1.2);
  assert.equal(colorOf('Si'), '#f0c8a0');
  assert.equal(colorOf('Xx'), '#b0b0b0');
  assert.equal(atomicNumberOf('Si'), 14);
  assert.equal(atomicNumberOf('Fe'), 26);
  assert.equal(atomicNumberOf('Xx'), 0);
  // Labels with a suffix or odd case still resolve.
  assert.equal(atomicNumberOf('Si1'), 14);
  assert.equal(atomicNumberOf('si'), 14);
  assert.equal(atomicNumberOf(' Fe '), 26);
});

test('the CPK palette and covalent radii cover H through Kr at least', () => {
  const symbols = ['H', 'C', 'N', 'O', 'F', 'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl',
    'K', 'Ca', 'Fe', 'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr'];
  for (const symbol of symbols) {
    assert.match(colorOf(symbol), /^#[0-9a-f]{6}$/i, `${symbol} colour`);
    assert.ok(radiusOf(symbol) > 0 && radiusOf(symbol) < 3, `${symbol} radius`);
    assert.ok(atomicNumberOf(symbol) > 0, `${symbol} atomic number`);
  }
});

test('hillFormula puts C first then H, and sorts otherwise', () => {
  assert.equal(hillFormula({ Si: 2 }), 'Si2');
  assert.equal(hillFormula({ O: 3, Fe: 2 }), 'Fe2O3');
  assert.equal(hillFormula({ C: 6, H: 6 }), 'C6H6');
  assert.equal(hillFormula({ H: 2, O: 1 }), 'H2O');
  assert.equal(hillFormula({ C: 1, H: 4, O: 1 }), 'CH4O');
  assert.equal(hillFormula({}), '');
});
