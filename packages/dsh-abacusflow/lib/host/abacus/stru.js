/**
 * ABACUS `STRU` parser.
 *
 * Block structure and semantics were taken from `source_cell/read_atom_species.cpp`,
 * `source_cell/read_atoms.cpp` and `source_cell/read_atoms_helper.cpp` (ABACUS v3.9.0.25).
 * Four details are easy to get wrong and are handled explicitly here:
 *
 *  1. **Coordinate systems.** The `ATOMIC_POSITIONS` flag is not just Direct/Cartesian.
 *     ABACUS accepts eight literals (`validate_coordinate_system`):
 *
 *         Direct, Cartesian, Cartesian_angstrom, Cartesian_au,
 *         Cartesian_angstrom_center_{xy,xz,yz,xyz}
 *
 *     `Cartesian` is measured in units of `LATTICE_CONSTANT`; `*_angstrom*` are already
 *     Å; `Cartesian_au` is Bohr; the `center_*` variants measure from the cell centre.
 *     `transform_atom_coordinates` shows each of these conversions.
 *
 *  2. **Matrix convention.** ABACUS stores the cell row-major (`e11..e33` are the three
 *     lattice vectors) and converts with *row-vector × matrix*:
 *
 *         Direct_to_Cartesian:    cart = direct * latvec      (`mathzone.h`)
 *         Cartesian_to_Direct:    direct = cart * latvec^-1   (`mathzone.h`)
 *
 *     Both are `Vector3 * Matrix3`, i.e. `out_j = Σ_i in_i * M[i][j]`. Using the
 *     column-vector convention (`M * v`) silently transposes the cell: it happens to be
 *     invisible for cubic/symmetric cells such as the Si2 diamond test case but is wrong
 *     for every hexagonal, monoclinic or triclinic cell.
 *
 *  3. **Per-atom trailing properties.** After `<x> <y> <z>` the line may carry the move
 *     triple, then keywords `m`/`mag`/`magmom`/`angle1`/`angle2`/`lambda`/`sc`/`v`/`vel`/
 *     `velocity`. `mag`, `lambda` and `sc` take either one number or three, and ABACUS
 *     decides by peeking at the next character: if it is a digit or `-`, two more numbers
 *     follow. So `mag 0 0 5` is a vector and `mag 1.0 angle1 90` is a scalar.
 *
 *  4. **`LATTICE_VECTORS` may be absent.** It is only used when `latname` is
 *     `user_defined_lattice` (the default). A STRU alone cannot know INPUT's `latname`,
 *     so a missing block yields `latticeVectors: null` plus a warning and the caller may
 *     rebuild the cell with {@link applyLatname}.
 *
 * @module abacusflow/host/abacus/stru
 */
import { toLines, toNum, warn, BOHR_TO_ANG } from '../shared/numbers.js';
import { latticeFromLatname } from './latname.js';

/** Bohr -> Angstrom (CODATA 2018), re-exported from the shared table for readability. */
const ANG_PER_BOHR = BOHR_TO_ANG;

/** Physical default when `LATTICE_CONSTANT` is missing but vectors are given. */
const DEFAULT_LATTICE_CONSTANT = 1;

/**
 * The eight coordinate-system literals ABACUS accepts, mapped to the semantics used here.
 * `system` selects the unit conversion, `centerAxes` the origin shift.
 */
const COORD_FLAGS = new Map(
  [
    ['direct', { system: 'direct', originCentered: false }],
    ['cartesian', { system: 'cartesian_lat0', originCentered: false }],
    ['cartesian_angstrom', { system: 'angstrom', originCentered: false }],
    ['cartesian_au', { system: 'bohr', originCentered: false }],
    ['cartesian_angstrom_center_xy', { system: 'angstrom', originCentered: true, centerAxes: ['x', 'y'] }],
    ['cartesian_angstrom_center_xz', { system: 'angstrom', originCentered: true, centerAxes: ['x', 'z'] }],
    ['cartesian_angstrom_center_yz', { system: 'angstrom', originCentered: true, centerAxes: ['y', 'z'] }],
    ['cartesian_angstrom_center_xyz', { system: 'angstrom', originCentered: true, centerAxes: ['x', 'y', 'z'] }],
  ],
);

/**
 * Block headers ABACUS knows. Anything else is reported and skipped, never guessed at.
 * `NUMERICAL_DESCRIPTOR`, `ABFS_ORBITAL`, `ABFS_JLES_ORBITAL`, `PAW_FILES` and
 * `SEP_POTENTIAL` appear in the reader's own block list, so they are recognised even
 * though this module does not interpret them.
 */
const BLOCKS = new Set([
  'ATOMIC_SPECIES',
  'NUMERICAL_ORBITAL',
  'NUMERICAL_DESCRIPTOR',
  'ABFS_ORBITAL',
  'ABFS_JLES_ORBITAL',
  'PAW_FILES',
  'SEP_POTENTIAL',
  'LATTICE_CONSTANT',
  'LATTICE_VECTORS',
  'LATTICE_PARAMETERS',
  'ATOMIC_POSITIONS',
]);

/** Keywords accepted after the coordinates of one atom (`parse_atom_properties`). */
const VELOCITY_KEYS = new Set(['v', 'vel', 'velocity']);
const MAG_KEYS = new Set(['mag', 'magmom']);
const ANGLE_KEYS = new Set(['angle1', 'angle2']);

/** Strip `#`/`!`/`//` comments and surrounding whitespace. */
function clean(line) {
  return String(line ?? '')
    .replace(/\/\/.*$/, '')
    .replace(/[#!].*$/, '')
    .trim();
}

/** Canonical coordinate label exposed as `coordinateMode`. */
function canonicalMode(system) {
  return system === 'direct' ? 'Direct' : 'Cartesian';
}

/**
 * Parse an ABACUS STRU file.
 *
 * Never throws on content: malformed blocks are skipped with an entry in `warnings`.
 *
 * @param {string} text
 * @returns {{
 *   latticeConstant: number|null,
 *   latticeConstantUnit: 'Bohr'|'Angstrom',
 *   latticeVectors: number[][]|null,
 *   latticeParameters: number[]|null,
 *   species: Array<{ label:string, mass:number|null, pp:string|null, orbitals:string[], extra:string[] }>,
 *   orbitals: string[],
 *   coordinateMode: 'Direct'|'Cartesian'|null,
 *   coordinateModeRaw: string|null,
 *   coordinateSystem: 'direct'|'cartesian_lat0'|'angstrom'|'bohr'|null,
 *   originCentered: boolean,
 *   centerAxes: string[]|null,
 *   atoms: Array<object>,
 *   natom: number,
 *   warnings: string[]
 * }}
 */
export function parseStru(text) {
  const warnings = [];
  const lines = toLines(text);

  const species = [];
  const orbitals = [];
  const atoms = [];
  let descriptor = null;
  let latticeConstant = null;
  let latticeConstantUnit = 'Bohr';
  let latticeVectors = null;
  let latticeParameters = null;
  let coordinateModeRaw = null;
  let coordinateSystem = null;
  let originCentered = false;
  let centerAxes = null;

  /** Species already emitted by ATOMIC_POSITIONS, for the order check. */
  const parsedSpecies = new Set();

  /** Find the next block header at or after `from`, or `lines.length`. */
  const nextBlock = (from) => {
    for (let k = from; k < lines.length; k += 1) {
      const token = clean(lines[k]).split(/\s+/)[0]?.toUpperCase();
      if (token && BLOCKS.has(token)) return k;
    }
    return lines.length;
  };

  let i = 0;
  while (i < lines.length) {
    const cleaned = clean(lines[i]);
    if (!cleaned) {
      i += 1;
      continue;
    }
    const block = cleaned.split(/\s+/)[0].toUpperCase();

    // ---- ATOMIC_SPECIES ----------------------------------------------------
    // `label mass pp_file [type]` — `read_atom_species.cpp` reads the first three
    // tokens and treats a fourth as the pseudopotential type (auto/upf/vwr/upf201/blps)
    // or the literal `1/r` marking a Coulomb potential.
    if (block === 'ATOMIC_SPECIES') {
      const end = nextBlock(i + 1);
      for (let k = i + 1; k < end; k += 1) {
        const row = clean(lines[k]).split(/\s+/).filter(Boolean);
        if (row.length === 0) continue;
        if (row.length < 3) {
          warn(warnings, `ATOMIC_SPECIES 第 ${k + 1} 行字段不足 3 个（label mass pp）：${lines[k].trim()}`);
        }
        species.push({
          label: row[0],
          mass: row[1] === undefined ? null : toNum(row[1]),
          pp: row[2] ?? null,
          ppType: row[3] ?? null,
          extra: row.slice(3),
          orbitals: [],
        });
      }
      i = end;
      continue;
    }

    // ---- NUMERICAL_ORBITAL -------------------------------------------------
    if (block === 'NUMERICAL_ORBITAL') {
      const end = nextBlock(i + 1);
      for (let k = i + 1; k < end; k += 1) {
        const value = clean(lines[k]);
        if (value) orbitals.push(value);
      }
      i = end;
      continue;
    }

    // ---- NUMERICAL_DESCRIPTOR (DeePKS only) --------------------------------
    if (block === 'NUMERICAL_DESCRIPTOR') {
      const end = nextBlock(i + 1);
      for (let k = i + 1; k < end; k += 1) {
        const value = clean(lines[k]);
        if (value) {
          descriptor = value;
          break;
        }
      }
      i = end;
      continue;
    }

    // ---- LATTICE_CONSTANT --------------------------------------------------
    // Bohr by default; a trailing `angstrom`/`bohr` token on the same line (or the
    // following one) switches the unit.
    if (block === 'LATTICE_CONSTANT') {
      const end = nextBlock(i + 1);
      for (let k = i + 1; k < end; k += 1) {
        const row = clean(lines[k]).split(/\s+/).filter(Boolean);
        if (row.length === 0) continue;
        latticeConstant = toNum(row[0]);
        if (latticeConstant === null) {
          warn(warnings, `LATTICE_CONSTANT 不是数字：${lines[k].trim()}`);
        }
        for (const token of row.slice(1)) {
          const t = token.toLowerCase();
          if (t.startsWith('angstrom') || t === 'ang' || t === 'a') latticeConstantUnit = 'Angstrom';
          else if (t.startsWith('bohr') || t === 'au' || t === 'a.u.') latticeConstantUnit = 'Bohr';
        }
        if (latticeConstant !== null && latticeConstant <= 0) {
          warn(warnings, `LATTICE_CONSTANT 必须为正，读到 ${latticeConstant}`);
        }
        break;
      }
      i = end;
      continue;
    }

    // ---- LATTICE_VECTORS ---------------------------------------------------
    // Three rows of three numbers, each in units of LATTICE_CONSTANT.
    if (block === 'LATTICE_VECTORS') {
      const end = nextBlock(i + 1);
      const rows = [];
      for (let k = i + 1; k < end; k += 1) {
        const row = clean(lines[k]).split(/\s+/).filter(Boolean).map(toNum);
        if (row.length === 0) continue;
        if (row.length < 3 || row.slice(0, 3).some((v) => v === null)) {
          warn(warnings, `LATTICE_VECTORS 第 ${k + 1} 行不是 3 个数字`);
          continue;
        }
        if (row.length > 3) {
          warn(warnings, `LATTICE_VECTORS 第 ${k + 1} 行多于 3 个数字，只取前 3 个`);
        }
        rows.push(row.slice(0, 3));
      }
      if (rows.length >= 3) {
        latticeVectors = rows.slice(0, 3);
        if (rows.length > 3) warn(warnings, `LATTICE_VECTORS 有 ${rows.length} 行，只取前 3 行`);
      } else {
        warn(warnings, `LATTICE_VECTORS 只有 ${rows.length} 行，需要 3 行`);
      }
      i = end;
      continue;
    }

    // ---- LATTICE_PARAMETERS (only with latname) ----------------------------
    if (block === 'LATTICE_PARAMETERS') {
      const end = nextBlock(i + 1);
      const values = [];
      for (let k = i + 1; k < end; k += 1) {
        for (const v of clean(lines[k]).split(/\s+/).filter(Boolean).map(toNum)) {
          if (v !== null) values.push(v);
        }
      }
      latticeParameters = values;
      i = end;
      continue;
    }

    // ---- ATOMIC_POSITIONS --------------------------------------------------
    if (block === 'ATOMIC_POSITIONS') {
      const end = nextBlock(i + 1);
      let k = i + 1;

      // (1) coordinate system, first non-blank line of the block.
      while (k < end) {
        const line = clean(lines[k]);
        if (!line) {
          k += 1;
          continue;
        }
        const token = line.split(/\s+/)[0];
        const flags = COORD_FLAGS.get(token.toLowerCase());
        coordinateModeRaw = token;
        if (flags) {
          coordinateSystem = flags.system;
          originCentered = flags.originCentered;
          centerAxes = flags.centerAxes ?? null;
        } else {
          warn(warnings, `ATOMIC_POSITIONS 的坐标类型「${token}」不是 ABACUS 接受的 8 种之一，按 Cartesian 处理`);
          coordinateSystem = 'cartesian_lat0';
        }
        k += 1;
        break;
      }

      // (2) repeating groups: label / start_mag / natom / natom coordinate lines.
      let globalIndex = 0;
      while (k < end) {
        const labelLine = clean(lines[k]);
        if (!labelLine) {
          k += 1;
          continue;
        }
        const label = labelLine.split(/\s+/)[0];
        k += 1;

        if (k >= end) {
          warn(warnings, `元素「${label}」缺少 start_mag 行`);
          break;
        }
        const startMag = toNum(clean(lines[k]).split(/\s+/)[0]);
        k += 1;

        if (k >= end) {
          warn(warnings, `元素「${label}」缺少原子数行`);
          break;
        }
        const countRaw = clean(lines[k]).split(/\s+/)[0];
        const count = toNum(countRaw);
        k += 1;
        if (count === null || count < 0 || !Number.isInteger(count)) {
          warn(warnings, `元素「${label}」的原子数「${countRaw}」不是非负整数`);
          continue;
        }
        if (count === 0) {
          // ABACUS permits zero atoms for an element (DP model ordering).
          warn(warnings, `元素「${label}」的原子数为 0`);
        }

        const speciesIndex = species.findIndex((s) => s.label === label);
        if (species.length > 0 && speciesIndex < 0) {
          warn(warnings, `ATOMIC_POSITIONS 中的「${label}」不在 ATOMIC_SPECIES 里`);
        } else if (speciesIndex >= 0) {
          const expectedIndex = species.findIndex((s) => !parsedSpecies.has(s.label));
          if (expectedIndex >= 0 && expectedIndex !== speciesIndex) {
            warn(
              warnings,
              `ATOMIC_POSITIONS 的元素顺序与 ATOMIC_SPECIES 不一致（读到「${label}」，期望「${species[expectedIndex].label}」）`,
            );
          }
          parsedSpecies.add(label);
        }

        for (let n = 0; n < count; n += 1) {
          // A blank line is not a coordinate line: skip it rather than letting a file's
          // trailing newline consume one of the declared atoms.
          while (k < end && clean(lines[k]) === '') k += 1;
          if (k >= end) {
            warn(warnings, `元素「${label}」声明 ${count} 个原子，但只找到 ${n} 行坐标`);
            break;
          }
          const parsed = parseAtomLine(clean(lines[k]), label, warnings, k + 1);
          k += 1;
          if (!parsed) continue;
          globalIndex += 1;
          atoms.push({
            label,
            speciesIndex: speciesIndex < 0 ? null : speciesIndex,
            index: globalIndex,
            startMag,
            coords: parsed.coords,
            move: parsed.move,
            mag: parsed.mag,
            velocity: parsed.velocity,
            constraint: parsed.constraint,
            angle: parsed.angle,
            frac: null,
            cartesian: null,
          });
        }
      }
      i = end;
      continue;
    }

    // A recognised-but-uninterpreted block: skip its payload quietly.
    if (BLOCKS.has(block)) {
      i = nextBlock(i + 1);
      continue;
    }

    warn(warnings, `忽略无法识别的行 ${i + 1}：${cleaned.slice(0, 80)}`);
    i += 1;
  }

  // ---- structural sanity ---------------------------------------------------
  if (latticeConstant === null && latticeVectors) {
    latticeConstant = DEFAULT_LATTICE_CONSTANT;
    warn(warnings, '缺少 LATTICE_CONSTANT，按 1.0 Bohr 处理');
  } else if (latticeConstant === null) {
    warn(warnings, '缺少 LATTICE_CONSTANT');
  }
  if (!latticeVectors) {
    warn(warnings, '缺少 LATTICE_VECTORS（可能由 INPUT 的 latname 决定），无法还原物理晶胞');
  }
  if (!coordinateSystem) {
    warn(warnings, '缺少 ATOMIC_POSITIONS 或其中的坐标类型');
  }
  if (species.length === 0) warn(warnings, '缺少 ATOMIC_SPECIES');
  if (atoms.length === 0) warn(warnings, '没有解析到任何原子');
  if (orbitals.length > 0 && species.length > 0 && orbitals.length !== species.length) {
    warn(warnings, `NUMERICAL_ORBITAL 有 ${orbitals.length} 行，但 ATOMIC_SPECIES 有 ${species.length} 个元素`);
  }

  // Attach orbital files per species (NUMERICAL_ORBITAL is read by species order).
  for (let s = 0; s < species.length; s += 1) {
    species[s].orbitals = orbitals[s] ? [orbitals[s]] : [];
  }

  const stru = {
    latticeConstant,
    latticeConstantUnit,
    latticeVectors,
    latticeParameters,
    species,
    orbitals,
    descriptor,
    coordinateMode: coordinateSystem ? canonicalMode(coordinateSystem) : null,
    coordinateModeRaw,
    coordinateSystem,
    originCentered,
    centerAxes,
    atoms,
    natom: atoms.length,
    warnings,
  };

  fillGeometry(stru);
  return stru;
}

/**
 * Parse one coordinate line: `x y z` followed by ABACUS's trailing property grammar.
 *
 * The single-vs-vector decision for `mag` / `lambda` / `sc` mirrors
 * `parse_atom_properties`: read one number, then peek — a digit or `-` means two more
 * numbers belong to the same keyword.
 *
 * @returns {{ coords:number[], move:number[]|null, mag:number[]|null,
 *             velocity:number[]|null, constraint:object|null,
 *             angle:Array<{kind:string,degrees:number}>|null } | null}
 */
function parseAtomLine(line, label, warnings, lineNumber) {
  const tokens = String(line ?? '').split(/\s+/).filter(Boolean);
  if (tokens.length < 3) {
    warn(warnings, `第 ${lineNumber} 行（${label}）坐标不足 3 个`);
    return null;
  }
  const coords = [toNum(tokens[0]), toNum(tokens[1]), toNum(tokens[2])];
  if (coords.some((v) => v === null)) {
    warn(warnings, `第 ${lineNumber} 行（${label}）坐标不是数字`);
    return null;
  }

  let move = null;
  let mag = null;
  let velocity = null;
  let constraint = null;
  let angle = null;

  /** Read one number at `t`, or null. */
  const numAt = (t) => (t < tokens.length ? toNum(tokens[t]) : null);
  /** True when `t` holds a number, i.e. the peek ABACUS performs. */
  const isNum = (t) => numAt(t) !== null;

  let t = 3;
  while (t < tokens.length) {
    const token = tokens[t];
    const lower = token.toLowerCase();

    // Bare leading digits: the classic `0 0 0` move triple (ABACUS reads three ints).
    if (isNum(t)) {
      if (isNum(t + 1) && isNum(t + 2)) {
        const triple = [numAt(t), numAt(t + 1), numAt(t + 2)];
        if (move === null && triple.every((v) => v === 0 || v === 1)) {
          move = triple;
        } else if (move === null) {
          // Numeric but out of range: still ABACUS's move triple, reported.
          move = triple.map((v) => Math.round(v));
          warn(warnings, `第 ${lineNumber} 行（${label}）的 move 三元组不是 0/1：${triple.join(' ')}`);
        } else {
          warn(warnings, `第 ${lineNumber} 行（${label}）有多余的数字「${token}」`);
        }
        t += 3;
        continue;
      }
      warn(warnings, `第 ${lineNumber} 行（${label}）有无法归属的数字「${token}」`);
      break;
    }

    if (lower === 'm') {
      if (isNum(t + 1) && isNum(t + 2) && isNum(t + 3)) {
        move = [numAt(t + 1), numAt(t + 2), numAt(t + 3)].map((v) => Math.round(v));
        t += 4;
      } else {
        warn(warnings, `第 ${lineNumber} 行（${label}）的「m」缺少 3 个整数`);
        break;
      }
      continue;
    }

    if (VELOCITY_KEYS.has(lower)) {
      if (isNum(t + 1) && isNum(t + 2) && isNum(t + 3)) {
        velocity = [numAt(t + 1), numAt(t + 2), numAt(t + 3)];
        t += 4;
      } else {
        warn(warnings, `第 ${lineNumber} 行（${label}）的「${token}」缺少 3 个数字`);
        break;
      }
      continue;
    }

    if (MAG_KEYS.has(lower)) {
      const first = numAt(t + 1);
      if (first === null) {
        warn(warnings, `第 ${lineNumber} 行（${label}）的「${token}」缺少数值`);
        break;
      }
      // Peek: another number means this is the vector form (mx my mz).
      if (isNum(t + 2) && isNum(t + 3)) {
        mag = [first, numAt(t + 2), numAt(t + 3)];
        t += 4;
      } else {
        mag = [first];
        t += 2;
      }
      continue;
    }

    if (ANGLE_KEYS.has(lower)) {
      const value = numAt(t + 1);
      if (value === null) {
        warn(warnings, `第 ${lineNumber} 行（${label}）的「${token}」缺少角度值`);
        break;
      }
      angle = angle ?? [];
      angle.push({ kind: lower, degrees: value });
      t += 2;
      continue;
    }

    if (lower === 'lambda' || lower === 'sc') {
      const first = numAt(t + 1);
      if (first === null) {
        warn(warnings, `第 ${lineNumber} 行（${label}）的「${lower}」缺少数值`);
        break;
      }
      const field = lower === 'lambda' ? 'lambda' : 'target';
      if (isNum(t + 2) && isNum(t + 3)) {
        constraint = { ...(constraint ?? {}), [field]: [first, numAt(t + 2), numAt(t + 3)] };
        t += 4;
      } else {
        constraint = { ...(constraint ?? {}), [field]: [first] };
        t += 2;
      }
      continue;
    }

    warn(warnings, `第 ${lineNumber} 行（${label}）有无法识别的尾部记号「${token}」`);
    break;
  }

  return { coords, move, mag, velocity, constraint, angle };
}

/** Species labels already emitted by ATOMIC_POSITIONS, for the order check. */
/**
 * Attach a `latname`-derived cell when the file has no `LATTICE_VECTORS`.
 *
 * A STRU file cannot know INPUT's `latname`, so the caller passes it in once INPUT has
 * been parsed. This is the real path taken by the H2 run in this workspace
 * (`latname = sc`, no `LATTICE_VECTORS`).
 *
 * @param {object} stru parsed STRU (mutated in place)
 * @param {string} latname value of INPUT's `latname`
 * @returns {object} the same stru
 */
export function applyLatname(stru, latname) {
  if (!stru || stru.latticeVectors) return stru;
  const result = latticeFromLatname(latname, stru.latticeParameters ?? []);
  if (result.vectors) {
    stru.latticeVectors = result.vectors;
    stru.latticeSource = 'latname';
    stru.warnings = stru.warnings.filter((w) => !String(w).startsWith('缺少 LATTICE_VECTORS'));
    warn(stru.warnings, result.note);
    fillGeometry(stru);
  } else {
    warn(stru.warnings, result.note);
  }
  return stru;
}

/** Invert a 3x3 row-major matrix. Returns null when singular. */
export function invert3(m) {
  if (!Array.isArray(m) || m.length !== 3) return null;
  const [[a, b, c], [d, e, f], [g, h, k]] = m;
  const det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [
    [(e * k - f * h) / det, (c * h - b * k) / det, (b * f - c * e) / det],
    [(f * g - d * k) / det, (a * k - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

/**
 * Fractional -> Cartesian, using ABACUS's row-vector convention
 * (`Direct_to_Cartesian`: `out_j = Σ_i frac_i * cell[i][j]`).
 * @returns {number[]} Cartesian in the same unit as `cell`
 */
export function toCart(frac, cell) {
  return [
    frac[0] * cell[0][0] + frac[1] * cell[1][0] + frac[2] * cell[2][0],
    frac[0] * cell[0][1] + frac[1] * cell[1][1] + frac[2] * cell[2][1],
    frac[0] * cell[0][2] + frac[1] * cell[1][2] + frac[2] * cell[2][2],
  ];
}

/**
 * Cartesian -> fractional, the exact inverse of {@link toCart} and the same convention
 * as ABACUS's `Cartesian_to_Direct` (`out_j = Σ_i cart_i * inv[i][j]`).
 * @returns {number[]}
 */
export function toFrac(cart, inv) {
  return [
    cart[0] * inv[0][0] + cart[1] * inv[1][0] + cart[2] * inv[2][0],
    cart[0] * inv[0][1] + cart[1] * inv[1][1] + cart[2] * inv[2][1],
    cart[0] * inv[0][2] + cart[1] * inv[1][2] + cart[2] * inv[2][2],
  ];
}

/**
 * Physical lattice in Angstrom, row-major (each row is one lattice vector).
 * @returns {number[][]|null}
 */
export function cellAngstrom(stru) {
  if (!stru || !stru.latticeVectors || typeof stru.latticeConstant !== 'number') return null;
  if (!Number.isFinite(stru.latticeConstant) || stru.latticeConstant === 0) return null;
  const a0 = stru.latticeConstantUnit === 'Angstrom' ? stru.latticeConstant : stru.latticeConstant * ANG_PER_BOHR;
  return stru.latticeVectors.map((row) => row.map((v) => v * a0));
}

/** Cell volume in Angstrom^3. */
export function cellVolume(stru) {
  const cell = cellAngstrom(stru);
  if (!cell) return null;
  const [a, b, c] = cell;
  const det =
    a[0] * (b[1] * c[2] - b[2] * c[1]) -
    a[1] * (b[0] * c[2] - b[2] * c[0]) +
    a[2] * (b[0] * c[1] - b[1] * c[0]);
  return Math.abs(det);
}

/**
 * Fill `frac` and `cartesian` on every atom when the lattice allows it.
 * Mutates and returns `stru`.
 */
function fillGeometry(stru) {
  const cell = cellAngstrom(stru);
  if (!cell) return stru;

  const inv = invert3(cell);
  if (!inv) {
    warn(stru.warnings, '晶格矩阵不可逆，无法换算坐标');
    return stru;
  }

  const a0Ang =
    stru.latticeConstantUnit === 'Angstrom' ? stru.latticeConstant : stru.latticeConstant * ANG_PER_BOHR;
  const system = stru.coordinateSystem ?? 'cartesian_lat0';

  // Cell centre in Angstrom, used by the `*_center_*` variants:
  // `calculate_lattice_center` averages the three lattice vectors, in units of lat0.
  const centre = [
    ((cell[0][0] + cell[1][0] + cell[2][0]) / 2),
    ((cell[0][1] + cell[1][1] + cell[2][1]) / 2),
    ((cell[0][2] + cell[1][2] + cell[2][2]) / 2),
  ];

  for (const atom of stru.atoms) {
    const raw = atom.coords;
    let cart;

    if (system === 'direct') {
      // Fractional input: convert to Cartesian, keep the given fractions (wrapped).
      cart = toCart(raw, cell);
      atom.cartesian = cart;
      atom.frac = raw.map(wrapFrac);
      continue;
    } else if (system === 'cartesian_lat0') {
      // Cartesian in units of LATTICE_CONSTANT.
      cart = raw.map((v) => v * a0Ang);
    } else if (system === 'angstrom') {
      // Already Angstrom.
      cart = [...raw];
    } else if (system === 'bohr') {
      cart = raw.map((v) => v * ANG_PER_BOHR);
    } else {
      cart = toCart(raw, cell);
      atom.cartesian = cart;
      atom.frac = raw.map(wrapFrac);
      continue;
    }

    if (stru.originCentered) cart = offsetFromCentre(cart, centre, stru.centerAxes);
    atom.cartesian = cart;
    atom.frac = toFrac(cart, inv).map(wrapFrac);
  }

  return stru;
}

/**
 * Wrap a fractional coordinate into [0, 1), which is what ABACUS does in `check_dtau`
 * (`fmod(x + 10000, 1.0)`). Without it an atom written at z = -0.06614 and the same atom
 * as ABACUS reports it (z = 0.93386) would look different, even though they are the same
 * point. `atom.coords` still holds the value exactly as written.
 */
function wrapFrac(v) {
  if (!Number.isFinite(v)) return v;
  const w = v - Math.floor(v);
  // Guard against returning exactly 1 for tiny negative values.
  return w >= 1 ? 0 : w;
}

/**
 * ABACUS `*_center_*` modes measure the coordinate from the cell centre on the named
 * axes, so the centre offset is added on exactly those components.
 */
function offsetFromCentre(cart, centre, axes) {
  const out = [...cart];
  const list = axes ?? ['x', 'y', 'z'];
  if (list.includes('x')) out[0] += centre[0];
  if (list.includes('y')) out[1] += centre[1];
  if (list.includes('z')) out[2] += centre[2];
  return out;
}

export { COORD_FLAGS, BLOCKS, ANG_PER_BOHR };
