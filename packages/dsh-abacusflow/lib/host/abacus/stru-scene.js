/**
 * Build the 3D scene the browser renders from a parsed STRU.
 *
 * The client ships no three.js (the DSH profile has none and the plugin must not add
 * dependencies), so this module hands it plain geometry: the cell in Å, atom centres in Å,
 * element radii/colours, and a bond list computed with periodic minimum images.
 *
 * Bond criterion: two atoms are bonded when their minimum-image distance is below
 * `1.2 * (r_i + r_j)` using covalent radii — the same rule VASPFlow applies to VASP, kept
 * here so both panels behave alike. The search is O(n² · 27), so it is skipped entirely
 * above `maxBondAtoms` and the caller is told via `connectivityLimited`.
 *
 * @module abacusflow/host/abacus/stru-scene
 */
import { cellAngstrom, cellVolume } from './stru.js';

/**
 * Element table: symbol -> { z (atomic number), r (covalent radius in Å), color (CPK) }.
 *
 * Radii are Cordero et al. (2008) covalent radii; colours are the standard CPK/Jmol
 * palette. Keeping one table (rather than two parallel maps) guarantees that a symbol
 * either has every field or none, which is what the client assumes.
 */
const ELEMENTS = {
  H: [1, 0.31, '#ffffff'], He: [2, 0.28, '#d9ffff'],
  Li: [3, 1.28, '#cc80ff'], Be: [4, 0.96, '#c2ff00'], B: [5, 0.84, '#ffb5b5'],
  C: [6, 0.76, '#909090'], N: [7, 0.71, '#3050f8'], O: [8, 0.66, '#ff0d0d'],
  F: [9, 0.57, '#90e050'], Ne: [10, 0.58, '#b3e3f5'],
  Na: [11, 1.66, '#ab5cf2'], Mg: [12, 1.41, '#8aff00'], Al: [13, 1.21, '#bfa6a6'],
  Si: [14, 1.11, '#f0c8a0'], P: [15, 1.07, '#ff8000'], S: [16, 1.05, '#ffff30'],
  Cl: [17, 1.02, '#1ff01f'], Ar: [18, 1.06, '#80d1e3'],
  K: [19, 2.03, '#8f40d4'], Ca: [20, 1.76, '#3dff00'], Sc: [21, 1.7, '#e6e6e6'],
  Ti: [22, 1.6, '#bfc2c7'], V: [23, 1.53, '#a6a6ab'], Cr: [24, 1.39, '#8a99c7'],
  Mn: [25, 1.39, '#9c7ac7'], Fe: [26, 1.32, '#e06633'], Co: [27, 1.26, '#f090a0'],
  Ni: [28, 1.24, '#50d050'], Cu: [29, 1.32, '#c88033'], Zn: [30, 1.22, '#7d80b0'],
  Ga: [31, 1.22, '#c28f8f'], Ge: [32, 1.2, '#668f8f'], As: [33, 1.19, '#bd80e3'],
  Se: [34, 1.2, '#ffa100'], Br: [35, 1.2, '#a62929'], Kr: [36, 1.16, '#5cb8d1'],
  Rb: [37, 2.2, '#702eb0'], Sr: [38, 1.95, '#00ff00'], Y: [39, 1.9, '#94ffff'],
  Zr: [40, 1.75, '#94e0e0'], Nb: [41, 1.64, '#73c2c9'], Mo: [42, 1.54, '#54b5b5'],
  Tc: [43, 1.47, '#3b9e9e'], Ru: [44, 1.46, '#248f8f'], Rh: [45, 1.42, '#0a7d8c'],
  Pd: [46, 1.39, '#006985'], Ag: [47, 1.45, '#c0c0c0'], Cd: [48, 1.44, '#ffd98f'],
  In: [49, 1.42, '#a67573'], Sn: [50, 1.39, '#668080'], Sb: [51, 1.39, '#9e63b5'],
  Te: [52, 1.38, '#d47a00'], I: [53, 1.39, '#940094'], Xe: [54, 1.4, '#429eb0'],
  Cs: [55, 2.44, '#57178f'], Ba: [56, 2.15, '#00c900'], La: [57, 2.07, '#70d4ff'],
  Ce: [58, 2.04, '#ffffc7'], Pr: [59, 2.03, '#d9ffc7'], Nd: [60, 2.01, '#c7ffc7'],
  Pm: [61, 1.99, '#a3ffc7'], Sm: [62, 1.98, '#8fffc7'], Eu: [63, 1.98, '#61ffc7'],
  Gd: [64, 1.96, '#45ffc7'], Tb: [65, 1.94, '#30ffc7'], Dy: [66, 1.92, '#1fffc7'],
  Ho: [67, 1.92, '#00ff9c'], Er: [68, 1.89, '#00e675'], Tm: [69, 1.9, '#00d452'],
  Yb: [70, 1.87, '#00bf38'], Lu: [71, 1.87, '#00ab24'], Hf: [72, 1.75, '#4dc2ff'],
  Ta: [73, 1.7, '#4da6ff'], W: [74, 1.62, '#2194d6'], Re: [75, 1.51, '#267dab'],
  Os: [76, 1.44, '#266696'], Ir: [77, 1.41, '#175487'], Pt: [78, 1.36, '#d0d0e0'],
  Au: [79, 1.36, '#ffd123'], Hg: [80, 1.32, '#b8b8d0'], Tl: [81, 1.45, '#a6544d'],
  Pb: [82, 1.46, '#575961'], Bi: [83, 1.48, '#9e4fb5'], Po: [84, 1.4, '#ab5c00'],
  At: [85, 1.5, '#754f45'], Rn: [86, 1.5, '#428296'],
};

const UNKNOWN_COLOR = '#b0b0b0';
const UNKNOWN_RADIUS = 1.2;
const UNKNOWN_Z = 0;

/** Strip a trailing label suffix so `Si1`, `si` and `Si_up` all resolve to `Si`. */
function normaliseSymbol(label) {
  const text = String(label ?? '').trim();
  if (text === '') return '';
  // ABACUS labels are element symbols, optionally with a numeric/underscore suffix.
  const match = /^([A-Za-z]{1,2})/.exec(text);
  if (!match) return '';
  const raw = match[1];
  return raw[0].toUpperCase() + raw.slice(1).toLowerCase();
}

/** Look up an element record, or null. */
function elementRecord(label) {
  return ELEMENTS[normaliseSymbol(label)] ?? null;
}

/** Atomic number; 0 for an element the table does not know. */
export function atomicNumberOf(label) {
  const record = elementRecord(label);
  return record ? record[0] : UNKNOWN_Z;
}

/** Covalent radius in Angstrom. */
export function radiusOf(label) {
  const record = elementRecord(label);
  return record ? record[1] : UNKNOWN_RADIUS;
}

/** CPK colour for an element symbol. */
export function colorOf(label) {
  const record = elementRecord(label);
  return record ? record[2] : UNKNOWN_COLOR;
}

/**
 * Hill formula from an element -> count map.
 *
 * Hill: carbon first, hydrogen second, then every other element alphabetically. When the
 * system has no carbon the strict rule is plain alphabetical order, which is what this
 * returns — e.g. water becomes `H2O` and silica `O2Si`.
 */
export function hillFormula(counts) {
  const symbols = Object.keys(counts ?? {}).filter((s) => counts[s] > 0);
  if (symbols.length === 0) return '';
  let ordered;
  if (symbols.includes('C')) {
    ordered = ['C', ...(symbols.includes('H') ? ['H'] : []), ...symbols.filter((s) => s !== 'C' && s !== 'H').sort()];
  } else {
    ordered = [...symbols].sort();
  }
  return ordered.map((s) => (counts[s] === 1 ? s : `${s}${counts[s]}`)).join('');
}

const BOND_ALGORITHMS = new Set(['crystal-nn', 'minimum-distance']);

/**
 * Build a renderable scene from a parsed STRU.
 *
 * @param {object} stru parsed STRU from `parseStru`
 * @param {{ includeConnectivity?:boolean, bondAlgorithm?:string, maxBondAtoms?:number }} [opts]
 * @returns {{
 *   cell: number[][]|null,
 *   cellVectors: Array<{ label:'a'|'b'|'c', vector:number[], from:number[], to:number[] }>|null,
 *   edges: Array<{ from:number[], to:number[] }>|null,
 *   atoms: Array<{ element:string, z:number, cartesian:number[], radius:number,
 *                  color:string, label:string, index:number, frac:number[]|null,
 *                  move:number[]|null, mag:number[]|null }>,
 *   bonds: Array<{ i:number, j:number, order:number, length:number }>,
 *   formula: string,
 *   counts: Record<string, number>,
 *   natom: number,
 *   volume: number|null,
 *   bondAlgorithm: string,
 *   connectivityLimited: boolean,
 *   warnings: string[]
 * }}
 */
export function struToScene(stru, opts = {}) {
  const includeConnectivity = opts.includeConnectivity !== false;
  const maxBondAtoms = Number.isFinite(opts.maxBondAtoms) ? opts.maxBondAtoms : 2000;
  const bondAlgorithm = opts.bondAlgorithm ?? 'crystal-nn';

  const warnings = [...(stru?.warnings ?? [])];
  if (!BOND_ALGORITHMS.has(bondAlgorithm)) {
    warnings.push(`未知的 bondAlgorithm「${bondAlgorithm}」，按 crystal-nn 处理`);
  }

  const cell = cellAngstrom(stru);
  const sourceAtoms = Array.isArray(stru?.atoms) ? stru.atoms : [];

  if (sourceAtoms.length === 0) {
    return {
      cell: cell ?? null,
      cellVectors: cell ? buildCellVectors(cell) : null,
      edges: cell ? buildEdges(cell) : null,
      atoms: [],
      bonds: [],
      formula: '',
      counts: {},
      natom: 0,
      volume: cellVolume(stru),
      bondAlgorithm,
      connectivityLimited: false,
      warnings: [...warnings, '没有原子可渲染'],
    };
  }

  if (!cell) warnings.push('无法确定晶胞，结构按孤立原子显示');

  // ---- atoms ---------------------------------------------------------------
  const counts = Object.create(null);
  const atoms = sourceAtoms.map((atom, index) => {
    const element = normaliseSymbol(atom.label) || String(atom.label ?? '?');
    counts[element] = (counts[element] ?? 0) + 1;

    // `cartesian` is filled by parseStru whenever the cell is known. Without a cell a
    // Direct coordinate cannot be placed in space, so fall back to the raw numbers and
    // say so once, rather than pretending they are Angstrom.
    let cartesian = Array.isArray(atom.cartesian) ? [...atom.cartesian] : null;
    if (!cartesian) {
      if (stru?.coordinateSystem === 'direct' && cell) {
        cartesian = [0, 0, 0];
      } else {
        cartesian = Array.isArray(atom.coords) ? [...atom.coords.slice(0, 3)] : [0, 0, 0];
      }
    }

    return {
      element,
      z: atomicNumberOf(element),
      cartesian,
      radius: radiusOf(element),
      color: colorOf(element),
      label: String(atom.label ?? element) + (index + 1),
      index: typeof atom.index === 'number' ? atom.index : index + 1,
      frac: Array.isArray(atom.frac) ? [...atom.frac] : null,
      move: Array.isArray(atom.move) ? [...atom.move] : null,
      mag: Array.isArray(atom.mag) ? [...atom.mag] : null,
    };
  });

  // ---- bonds ---------------------------------------------------------------
  let bonds = [];
  let connectivityLimited = false;
  if (includeConnectivity) {
    if (atoms.length > maxBondAtoms) {
      connectivityLimited = true;
      warnings.push(`原子数 ${atoms.length} 超过 ${maxBondAtoms}，跳过成键分析`);
    } else {
      bonds = findBonds(atoms, cell);
    }
  }

  return {
    cell: cell ?? null,
    cellVectors: cell ? buildCellVectors(cell) : null,
    edges: cell ? buildEdges(cell) : null,
    atoms,
    bonds,
    formula: hillFormula(counts),
    counts: { ...counts },
    natom: atoms.length,
    volume: cellVolume(stru),
    bondAlgorithm,
    connectivityLimited,
    warnings,
  };
}

/**
 * The three lattice vectors, labelled a/b/c, as arrow segments from the origin in Å.
 *
 * `vector` is the vector itself; `from`/`to` give it as a drawable segment and `a`/`b`
 * are kept as aliases because the scene contract spells the segment that way.
 */
function buildCellVectors(cell) {
  return ['a', 'b', 'c'].map((label, i) => {
    const origin = [0, 0, 0];
    const vector = [...cell[i]];
    return { label, vector, from: origin, to: [...vector], a: origin, b: [...vector] };
  });
}

/** The 12 edges of the parallelepiped, as pairs of points in Å (for wireframe drawing). */
function buildEdges(cell) {
  const [a, b, c] = cell;
  const corner = (i, j, k) => [
    i * a[0] + j * b[0] + k * c[0],
    i * a[1] + j * b[1] + k * c[1],
    i * a[2] + j * b[2] + k * c[2],
  ];
  const corners = [];
  for (let i = 0; i <= 1; i += 1) {
    for (let j = 0; j <= 1; j += 1) {
      for (let k = 0; k <= 1; k += 1) corners.push([i, j, k]);
    }
  }
  const edges = [];
  for (let p = 0; p < corners.length; p += 1) {
    for (let q = p + 1; q < corners.length; q += 1) {
      const [i1, j1, k1] = corners[p];
      const [i2, j2, k2] = corners[q];
      // Two corners are adjacent when they differ in exactly one index (Manhattan = 1).
      if (Math.abs(i1 - i2) + Math.abs(j1 - j2) + Math.abs(k1 - k2) !== 1) continue;
      edges.push({ from: corner(i1, j1, k1), to: corner(i2, j2, k2) });
    }
  }
  return edges;
}

/**
 * Periodic bond search over the 27 neighbouring cells, keeping the minimum-image distance.
 *
 * Without a lattice the search degrades to a plain pairwise distance (a molecule), which
 * is what a STRU missing `LATTICE_VECTORS` describes.
 *
 * @returns {Array<{ i:number, j:number, order:number, length:number }>}
 */
function findBonds(atoms, cell) {
  const bonds = [];
  // Ignore pairs closer than this: they are duplicate atoms, not bonds. The shortest real
  // bond (H-H in H2) is 0.74 A, so 0.05 A only ever catches coincident atoms.
  const MIN_BOND = 0.05;

  if (!cell) {
    for (let i = 0; i < atoms.length; i += 1) {
      for (let j = i + 1; j < atoms.length; j += 1) {
        const d = distance(atoms[i].cartesian, atoms[j].cartesian);
        const cutoff = 1.2 * (atoms[i].radius + atoms[j].radius);
        if (d >= MIN_BOND && d <= cutoff) bonds.push({ i, j, order: 1, length: round(d) });
      }
    }
    return bonds;
  }

  // Precompute the 27 lattice translations once (a·a1 + b·a2 + c·a3).
  const shifts = [];
  for (let a = -1; a <= 1; a += 1) {
    for (let b = -1; b <= 1; b += 1) {
      for (let c = -1; c <= 1; c += 1) {
        shifts.push([
          a * cell[0][0] + b * cell[1][0] + c * cell[2][0],
          a * cell[0][1] + b * cell[1][1] + c * cell[2][1],
          a * cell[0][2] + b * cell[1][2] + c * cell[2][2],
        ]);
      }
    }
  }

  for (let i = 0; i < atoms.length; i += 1) {
    const [x0, y0, z0] = atoms[i].cartesian;
    for (let j = i + 1; j < atoms.length; j += 1) {
      const cutoff = 1.2 * (atoms[i].radius + atoms[j].radius);
      const dx0 = atoms[j].cartesian[0] - x0;
      const dy0 = atoms[j].cartesian[1] - y0;
      const dz0 = atoms[j].cartesian[2] - z0;
      let best = Infinity;
      for (const shift of shifts) {
        const dx = dx0 + shift[0];
        const dy = dy0 + shift[1];
        const dz = dz0 + shift[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < best) best = d2;
      }
      const d = Math.sqrt(best);
      if (d >= MIN_BOND && d <= cutoff) bonds.push({ i, j, order: 1, length: round(d) });
    }
  }
  return bonds;
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Round for serialisation; bonds are display data, not analysis data. */
function round(v) {
  return Math.round(v * 1e5) / 1e5;
}

export { ELEMENTS, UNKNOWN_COLOR, UNKNOWN_RADIUS, BOND_ALGORITHMS };
