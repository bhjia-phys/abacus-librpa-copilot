/**
 * Material identity, and matching a local calculation against the LibRPA database.
 *
 * The database (`https://github.com/AroundPeking/LibRPA-database`) indexes published GW
 * results by material. To be useful from the panel it has to answer one question: *what
 * material is this task, and what does the database know about it?*
 *
 * ## Why this is not a string match
 *
 * A task directory is named by a person, not by a schema: `nio-matched-dzp-k666-20261016-r1`,
 * `bi2se3-soc-abacus-reexport`, `si-qsgw-k444-headwing-kconv`. Meanwhile `STRU` carries the
 * authoritative species list and counts, and the database keys on `formula` (`NiO`, `Bi2Se3`,
 * `Si`). So the species composition from STRU is the primary signal, directory text is the
 * fallback, and every match reports how confident it is and why.
 *
 * ## What it refuses to do
 *
 * It will not silently claim a match. `Si` vs `Si2`, `C` vs `C512`, and `MoS2` vs
 * `MoS2-WS2` are different records with different results; the matcher reports candidates
 * with the evidence, and the panel shows them rather than auto-selecting one.
 *
 * @module abacusflow/host/library
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Count atoms per element from a parsed STRU.
 *
 * The species *declaration* in STRU (`ATOMIC_SPECIES`) lists each element once no matter
 * how many atoms of it exist; the composition lives in the atom list. Reading the
 * declaration instead produced `BiSe` for Bi2Se3 — a formula that matches nothing in the
 * database. Counting `atoms` is the only correct source.
 *
 * @param {{ atoms?: Array<{label?:string, species?:string}>, species?: Array }} stru
 * @returns {Record<string, number>}
 */
export function speciesCountsFromStru(stru) {
  const counts = {};
  for (const atom of stru?.atoms ?? []) {
    const label = String(atom.label ?? atom.species ?? '').trim();
    if (!label) continue;
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

/**
 * The chemical formula from a species->count map, in Hill-ish order.
 *
 * Counts are reduced by their greatest common divisor, because a periodic cell holds a
 * whole number of formula units: NiO's 2+2 and Si's 2-atom cell must read `NiO` and `Si`,
 * not `Ni2O2` and `Si2`. The database keys on the reduced formula, so without this the
 * matcher misses every cell larger than one formula unit — which is most of them.
 *
 * **Single-element and diatomic cases are the exception.** There the count *is* the
 * material: the database holds `Li2`, `N2`, `H2`, `C2` and `Si2` as distinct records from
 * `C`/`Si`, because they are molecules with a fixed stoichiometry. Reducing those would
 * turn a Li2 calculation into "Li" and silently match nothing. So reduction only applies
 * when there are at least two distinct elements (a genuine compound).
 *
 * @param {Array<{label:string, count?:number}>|Record<string,number>} species
 * @returns {string}
 */
export function formulaFromSpecies(species) {
  /** @type {Record<string, number>} */
  const counts = {};
  if (Array.isArray(species)) {
    for (const item of species) {
      const label = String(item.label ?? item.element ?? '').trim();
      if (!label) continue;
      counts[label] = (counts[label] ?? 0) + (Number(item.count) || 1);
    }
  } else if (species && typeof species === 'object') {
    for (const [label, count] of Object.entries(species)) {
      counts[label] = Number(count) || 0;
    }
  }
  const keys = Object.keys(counts).filter((k) => counts[k] > 0);
  if (keys.length === 0) return '';

  // One element: keep the exact atom count (Si2, C2, Li2 are real distinct records).
  if (keys.length === 1) {
    const [only] = keys;
    return counts[only] === 1 ? only : `${only}${counts[only]}`;
  }

  // A compound: reduce to the formula unit.
  const divisor = keys.reduce((acc, k) => gcd(acc, counts[k]), counts[keys[0]]);

  const ordered = counts.C !== undefined
    ? ['C', ...(counts.H ? ['H'] : []), ...keys.filter((k) => k !== 'C' && k !== 'H').sort()]
    : keys.sort();
  return ordered
    .filter((k) => counts[k] > 0)
    .map((k) => {
      const reduced = counts[k] / divisor;
      return reduced === 1 ? k : `${k}${reduced}`;
    })
    .join('');
}

/** Greatest common divisor of two positive integers. */
function gcd(a, b) {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

/** Parse `Bi2Se3` into `{Bi:2, Se:3}`; `Si` into `{Si:1}`. @returns {Record<string,number>|null} */
export function parseFormula(formula) {
  const text = String(formula ?? '').trim();
  if (!text) return null;
  const counts = {};
  const re = /([A-Z][a-z]?)(\d*)/g;
  let match;
  let consumed = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index !== consumed) return null;
    consumed = match.index + match[0].length;
    const count = match[2] === '' ? 1 : Number(match[2]);
    if (!Number.isFinite(count) || count <= 0) return null;
    counts[match[1]] = (counts[match[1]] ?? 0) + count;
  }
  if (consumed !== text.length) return null;
  return counts;
}

/** True when two formulas describe the same composition, regardless of order. */
export function sameFormula(a, b) {
  const pa = parseFormula(a);
  const pb = parseFormula(b);
  if (!pa || !pb) return String(a).toLowerCase() === String(b).toLowerCase();
  const ka = Object.keys(pa).sort();
  const kb = Object.keys(pb).sort();
  if (ka.join(',') !== kb.join(',')) return false;
  return ka.every((k) => pa[k] === pb[k]);
}

/**
 * Identifiers to try when guessing the material of a task.
 *
 * Ordered by reliability: the STRU composition first, then the directory name, then the
 * parent directory name (the Si runs put the material in `si-qsgw-...`, not in `frozen`).
 *
 * A single-element cell yields **both** readings. A two-atom silicon cell is ambiguous on
 * composition alone: it can be the bulk diamond primitive cell (database record `Si`) or a
 * dimer (`Si2`), and both records exist. Emitting both candidates lets the panel show the
 * alternatives with their gaps instead of picking one and being quietly wrong.
 *
 * @param {{ species?: Array<{label:string}>, speciesCounts?: Record<string,number>,
 *           relPath?: string, name?: string }} task
 * @returns {Array<{ value:string, kind:'struct'|'dir'|'parent', note:string }>}
 */
export function materialCandidates(task) {
  const out = [];
  const fromCounts = task.speciesCounts ? formulaFromSpecies(task.speciesCounts) : '';
  const fromSpecies = task.species ? formulaFromSpecies(task.species) : '';
  const composition = fromCounts || fromSpecies;
  if (composition) {
    out.push({ value: composition, kind: 'struct', note: 'STRU 的物种与计数' });
  }

  // Single element with more than one atom: also offer the element symbol, so a bulk cell
  // finds the elemental record as well as the molecular one.
  const counts = task.speciesCounts ?? null;
  if (counts) {
    const keys = Object.keys(counts).filter((k) => counts[k] > 0);
    if (keys.length === 1 && counts[keys[0]] > 1) {
      out.push({
        value: keys[0],
        kind: 'struct',
        note: `STRU 中 ${keys[0]} 有 ${counts[keys[0]]} 个原子（块体原胞 vs 分子，两种都列出）`,
      });
    }
  }

  const segments = String(task.relPath ?? '')
    .split(/[\\/]/)
    .filter(Boolean);
  const name = task.name || segments[segments.length - 1] || '';
  const parent = segments[segments.length - 2] || '';

  // Directory names are free text; these are the tokens that carry a material identity.
  for (const [kind, text] of [['dir', name], ['parent', parent]]) {
    if (!text) continue;
    const token = text.split(/[-_.]/).filter(Boolean);
    for (const piece of token) {
      if (!/^[A-Za-z]+\d*[A-Za-z0-9]*$/.test(piece)) continue;
      if (piece.length < 2) continue;
      if (DUPLICATE_FORMULA_TOKENS.has(piece.toLowerCase())) continue;
      out.push({ value: piece, kind, note: `${kind === 'dir' ? '目录名' : '上级目录名'}「${text}」` });
    }
  }
  return out;
}

/** Tokens that look like formulas but are workflow words. */
const DUPLICATE_FORMULA_TOKENS = new Set([
  'k444', 'k555', 'k666', 'k777', 'k888', 'k999', 'k333',
  'dzp', 'tzdp', 'soc', 'pbe', 'pbe0', 'hse', 'scf', 'nscf', 'bands', 'band',
  'frozen', 'headonly', 'refresh', 'validation', 'g0w0', 'qsgw', 'rpa', 'exx',
  'abacus', 'librpa', 'producer', 'consumer', 'run', 'work', 'mesh', 'orbitals',
]);

/**
 * An index over the database's records, loaded once.
 *
 * @param {string} root metadata index (`<dim>/<material>/<id>.json`) or a repository checkout
 * @returns {{ ok:boolean, root:string, records:Array, byFormula:Map<string,Array>,
 *             formulas:string[], error:string }}
 */
export function loadLibrary(root) {
  const abs = resolve(String(root ?? ''));

  // Two layouts are accepted:
  //   - repo:  <root>/data/calculations/<dim>/<material>/<case>/record.json
  //   - index: <root>/<dim>/<material>/<case>/record.json  (metadata only; ~3.1 MB for 122
  //            records, versus ~264 MB for a clone, because the bulk data stays upstream)
  const repoDir = join(abs, 'data', 'calculations');
  const calculations = existsSync(repoDir) ? repoDir : abs;
  if (!existsSync(calculations)) {
    return {
      ok: false,
      root: abs,
      records: [],
      byFormula: new Map(),
      formulas: [],
      error: `数据库目录不存在：${abs}（可放置仅含元数据的索引，见 database/library-index）`,
    };
  }

  const records = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      // `record.json` in a repository checkout; `<id>.json` in the flattened metadata index.
      if (!entry.name.endsWith('.json')) continue;
      try {
        const record = JSON.parse(readFileSync(full, 'utf8'));
        // Only accept an object that looks like a record, so a stray JSON file in the index
        // directory cannot be mistaken for one.
        if (!record || typeof record !== 'object' || !record.material) continue;
        records.push({ ...record, _path: full });
      } catch {
        // A broken record must not hide the other 121.
      }
    }
  };
  walk(calculations);

  const byFormula = new Map();
  for (const record of records) {
    const key = String(record.formula ?? record.material ?? '');
    if (!key) continue;
    if (!byFormula.has(key)) byFormula.set(key, []);
    byFormula.get(key).push(record);
  }

  return {
    ok: true,
    root: abs,
    records,
    byFormula,
    formulas: [...byFormula.keys()].sort(),
    error: '',
  };
}

/**
 * Compact a database record for the panel.
 *
 * Only what a reader uses to judge relevance: identity, the gaps, the software provenance,
 * and the record's own scope note. The full record stays on disk.
 */
export function summarizeRecord(record) {
  const summary = record.summary ?? {};
  return {
    id: record.id ?? null,
    material: record.material ?? null,
    formula: record.formula ?? null,
    dimension: record.dimension ?? null,
    recordType: record.record_type ?? null,
    dftGapEv: numberOrNull(summary.dft_gap_ev),
    exxGapEv: numberOrNull(summary.exx_gap_ev),
    gwGapEv: numberOrNull(summary.gw_gap_ev),
    observable: summary.observable ?? null,
    value: numberOrNull(summary.value),
    unit: summary.unit ?? null,
    scientificStatus: summary.scientific_status ?? null,
    scope: summary.scope ?? null,
    notes: summary.notes ?? null,
    species: (record.species ?? []).map((s) => ({
      element: s.element ?? null,
      pp: s.asset_aliases?.pp ?? null,
      nao: s.asset_aliases?.nao ?? null,
      abf: s.asset_aliases?.abf ?? null,
    })),
    abacusCommit: record.software?.abacus?.abbreviated_commit ?? null,
    librpaCommit: record.software?.librpa?.abbreviated_commit ?? null,
    path: record._path ?? null,
    // What a published-vs-local comparison can check, each as the record states it. A
    // field the record does not carry stays null; nothing is inferred to fill it.
    gapDefinition: summary.gap_definition ?? null,
    frontend: record.workflow?.frontend ?? null,
    workflowTask: record.workflow?.task ?? null,
    software: Object.entries(record.software ?? {}).map(([name, sw]) => ({
      name,
      commit: sw?.abbreviated_commit ?? (typeof sw?.commit === 'string' ? sw.commit.slice(0, 9) : null),
      missing: sw?.missing_reason ?? null,
    })),
    atomCount: numberOrNull(record.computational_scale?.atom_count),
    pathKpoints: numberOrNull(record.computational_scale?.n_path_kpoints),
    gapProperties: (record.properties ?? [])
      .filter((p) => p && p.key === 'band_gap' && typeof p.value === 'number')
      .map((p) => ({ method: p.method ?? null, label: p.label ?? null, valueEv: p.value, definition: p.definition ?? null, summaryKey: p.source_summary_key ?? null })),
  };
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Match a task against the database.
 *
 * Returns every candidate with its evidence and a confidence, never a single "the answer":
 * `Si` and `Si2` are distinct records, and only the reader can say which geometry applies.
 *
 * @param {{ speciesCounts?:Record<string,number>, species?:Array, relPath?:string, name?:string }} task
 * @param {object} library result of `loadLibrary`
 * @returns {{ matches:Array, tried:Array, exact:boolean }}
 */
export function matchTask(task, library) {
  if (!library || !library.ok) return { matches: [], tried: [], exact: false };

  const candidates = materialCandidates(task);
  const seen = new Set();
  const matches = [];

  for (const candidate of candidates) {
    for (const [formula, records] of library.byFormula) {
      const equal = sameFormula(candidate.value, formula);
      if (!equal) continue;
      const confidence = candidate.kind === 'struct' ? 'high' : candidate.kind === 'dir' ? 'medium' : 'low';
      for (const record of records) {
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        matches.push({
          ...summarizeRecord(record),
          matchedBy: candidate.kind,
          matchedValue: candidate.value,
          matchedFormula: formula,
          evidence: candidate.note,
          confidence,
        });
      }
    }
  }

  // High confidence first, then more updates over fewer.
  matches.sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 };
    const d = rank[a.confidence] - rank[b.confidence];
    if (d !== 0) return d;
    return String(a.id).localeCompare(String(b.id));
  });

  return {
    matches,
    tried: candidates.map((c) => `${c.value}（${c.kind}）`),
    exact: matches.some((m) => m.confidence === 'high'),
  };
}
