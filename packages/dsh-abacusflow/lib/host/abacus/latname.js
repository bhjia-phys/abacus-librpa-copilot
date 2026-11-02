/**
 * The 14 Bravais lattices ABACUS can build from `latname`.
 *
 * When INPUT sets `latname` to anything other than `user_defined_lattice`, the STRU file
 * must NOT carry `LATTICE_VECTORS` and the cell is constructed here instead
 * (`source_cell/read_lattice_constant.cpp`, v3.9.0.25). The real H2 test run in this
 * repository uses exactly this path (`latname = sc`, no `LATTICE_VECTORS`), so a STRU-only
 * parser that ignores `latname` loses the cell entirely.
 *
 * Each builder receives the optional `LATTICE_PARAMETERS` values (in units of
 * `LATTICE_CONSTANT`) and returns three row vectors, or null when the parameters are
 * insufficient.
 *
 * @module abacusflow/host/abacus/latname
 */

/** @typedef {(p:number[]) => number[][]|null} Builder */

const SQRT3 = Math.sqrt(3);

/** @type {Record<string, Builder>} */
const BUILDERS = {
  // Simple cubic
  sc: () => [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],

  // Face-centred cubic
  fcc: () => [
    [0, 0.5, 0.5],
    [0.5, 0, 0.5],
    [0.5, 0.5, 0],
  ],

  // Body-centred cubic
  bcc: () => [
    [-0.5, 0.5, 0.5],
    [0.5, -0.5, 0.5],
    [0.5, 0.5, -0.5],
  ],

  // Simple tetragonal: [a, c]
  st: (p) => {
    const a = p[0] ?? 1;
    const c = p[1] ?? 1;
    return [
      [a, 0, 0],
      [0, a, 0],
      [0, 0, c],
    ];
  },

  // Body-centred tetragonal: [a, c]
  bct: (p) => {
    const a = p[0] ?? 1;
    const c = p[1] ?? 1;
    return [
      [-0.5 * a, 0.5 * a, 0.5 * c],
      [0.5 * a, -0.5 * a, 0.5 * c],
      [0.5 * a, 0.5 * a, -0.5 * c],
    ];
  },

  // Hexagonal: [a, c]
  hexagonal: (p) => {
    const a = p[0] ?? 1;
    const c = p[1] ?? 1;
    return [
      [a, 0, 0],
      [-0.5 * a, 0.5 * SQRT3 * a, 0],
      [0, 0, c],
    ];
  },

  // Rhombohedral / trigonal: [a, alpha(deg)]
  trigonal: (p) => {
    const a = p[0] ?? 1;
    const alpha = ((p[1] ?? 60) * Math.PI) / 180;
    const cos = Math.cos(alpha);
    const sin = Math.sin(alpha);
    const x = a * Math.sqrt((1 - cos) / 2);
    const tanHalf = Math.sin(alpha / 2) / Math.cos(alpha / 2);
    return [
      [a * Math.sqrt((1 - cos) / 2), -a * Math.sqrt((1 - cos) / 6), a * Math.sqrt((1 + 2 * cos) / 3)],
      [0, a * Math.sqrt(2 * (1 - cos) / 3), a * Math.sqrt((1 + 2 * cos) / 3)],
      [-a * Math.sqrt((1 - cos) / 2), -a * Math.sqrt((1 - cos) / 6), a * Math.sqrt((1 + 2 * cos) / 3)],
    ];
    void sin; void x; void tanHalf;
  },

  // Simple orthorhombic: [a, b, c]
  so: (p) => {
    const a = p[0] ?? 1;
    const b = p[1] ?? 1;
    const c = p[2] ?? 1;
    return [
      [a, 0, 0],
      [0, b, 0],
      [0, 0, c],
    ];
  },

  // Base-centred orthorhombic: [a, b, c]
  baco: (p) => {
    const a = p[0] ?? 1;
    const b = p[1] ?? 1;
    const c = p[2] ?? 1;
    return [
      [0.5 * a, 0.5 * b, 0],
      [-0.5 * a, 0.5 * b, 0],
      [0, 0, c],
    ];
  },

  // Face-centred orthorhombic: [a, b, c]
  fco: (p) => {
    const a = p[0] ?? 1;
    const b = p[1] ?? 1;
    const c = p[2] ?? 1;
    return [
      [0, 0.5 * b, 0.5 * c],
      [0.5 * a, 0, 0.5 * c],
      [0.5 * a, 0.5 * b, 0],
    ];
  },

  // Body-centred orthorhombic: [a, b, c]
  bco: (p) => {
    const a = p[0] ?? 1;
    const b = p[1] ?? 1;
    const c = p[2] ?? 1;
    return [
      [-0.5 * a, 0.5 * b, 0.5 * c],
      [0.5 * a, -0.5 * b, 0.5 * c],
      [0.5 * a, 0.5 * b, -0.5 * c],
    ];
  },

  // Simple monoclinic: [a, b, c, beta(deg)] — beta is the a^c angle
  sm: (p) => {
    const a = p[0] ?? 1;
    const b = p[1] ?? 1;
    const c = p[2] ?? 1;
    const beta = ((p[3] ?? 90) * Math.PI) / 180;
    return [
      [a, 0, 0],
      [0, b, 0],
      [c * Math.cos(beta), 0, c * Math.sin(beta)],
    ];
  },

  // Base-centred monoclinic: [a, b, c, beta(deg)]
  bacm: (p) => {
    const a = p[0] ?? 1;
    const b = p[1] ?? 1;
    const c = p[2] ?? 1;
    const beta = ((p[3] ?? 90) * Math.PI) / 180;
    return [
      [0.5 * a, 0.5 * b, 0],
      [-0.5 * a, 0.5 * b, 0],
      [c * Math.cos(beta), 0, c * Math.sin(beta)],
    ];
  },

  // Triclinic: [a, b, c, alpha, beta, gamma] all angles in degrees
  triclinic: (p) => {
    const a = p[0] ?? 1;
    const b = p[1] ?? 1;
    const c = p[2] ?? 1;
    const alpha = ((p[3] ?? 90) * Math.PI) / 180;
    const beta = ((p[4] ?? 90) * Math.PI) / 180;
    const gamma = ((p[5] ?? 90) * Math.PI) / 180;
    const cosA = Math.cos(alpha);
    const cosB = Math.cos(beta);
    const cosG = Math.cos(gamma);
    const sinG = Math.sin(gamma);
    const vx = c * cosB;
    const vy = (c * (cosA - cosB * cosG)) / sinG;
    const vz2 = c * c - vx * vx - vy * vy;
    if (vz2 <= 0) return null;
    const vz = Math.sqrt(vz2);
    return [
      [a, 0, 0],
      [b * cosG, b * sinG, 0],
      [vx, vy, vz],
    ];
  },
};

/** The `latname` values ABACUS accepts (plus the sentinel). */
export const LATNAME_VALUES = ['user_defined_lattice', ...Object.keys(BUILDERS)];

/**
 * Build the dimensionless lattice vectors for a `latname`.
 *
 * @param {string} latname
 * @param {number[]} [parameters] LATTICE_PARAMETERS values
 * @returns {{ vectors:number[][]|null, usedParameters:number, note:string }}
 */
export function latticeFromLatname(latname, parameters = []) {
  const key = String(latname ?? '').toLowerCase().trim();
  if (!key || key === 'user_defined_lattice') {
    return { vectors: null, usedParameters: 0, note: 'latname 为 user_defined_lattice，应使用 STRU 中的 LATTICE_VECTORS。' };
  }
  const builder = BUILDERS[key];
  if (!builder) {
    return { vectors: null, usedParameters: 0, note: `未知的 latname「${latname}」，ABACUS 会报 "latname not supported!"。` };
  }
  const vectors = builder(Array.isArray(parameters) ? parameters : []);
  if (!vectors) {
    return { vectors: null, usedParameters: 0, note: `latname=${key} 的 LATTICE_PARAMETERS 不足或无效。` };
  }
  const used = key === 'sc' || key === 'fcc' || key === 'bcc' ? 0
    : key === 'st' || key === 'bct' || key === 'hexagonal' ? 2
    : key === 'trigonal' ? 2
    : key === 'so' || key === 'baco' || key === 'fco' || key === 'bco' ? 3
    : key === 'sm' || key === 'bacm' ? 4
    : key === 'triclinic' ? 6
    : 0;
  return {
    vectors,
    usedParameters: used,
    note: used > 0 ? `由 latname=${key} 与 LATTICE_PARAMETERS（${used} 个值）构造晶胞。` : `由 latname=${key} 构造晶胞。`,
  };
}
