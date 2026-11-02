/**
 * ABACUS `INPUT` parser and keyword documentation.
 *
 * The fixtures reproduce shapes taken verbatim from the ABACUS v3.9.0.25 source and its
 * generated `docs/parameters.yaml`; assertions pin exact values so a regression shows up as
 * a failed constant rather than a silently different panel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseAbacusInput,
  getParam,
  getNumber,
  getNumberList,
  getList,
  getFlag,
  summarizeParams,
  kMeshSource,
  keywordInfo,
  KEYWORD_INFO,
} from '../lib/host/abacus/input-params.js';
import { parseInputInfo, infoParam } from '../lib/host/abacus/input-info.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', 'abacus', name), 'utf8');

// --------------------------------------------------------------- parsing ----

test('INPUT parses keywords, comments and bare flags', () => {
  const parsed = parseAbacusInput(fixture('INPUT'));
  assert.equal(parsed.headerPresent, true);
  assert.equal(getParam(parsed.params, 'suffix'), 'si2');
  assert.equal(getParam(parsed.params, 'ecutwfc'), '60');
  assert.equal(getNumber(parsed.params, 'scf_thr'), 1e-6);
  assert.equal(getNumber(parsed.params, 'scf_nmax'), 100);
  assert.equal(getParam(parsed.params, 'basis_type'), 'lcao');
  // A bare keyword is a truthy flag with an empty value.
  assert.equal(getFlag(parsed.params, 'gamma_only'), true);
  // The comment is stripped, so it never becomes part of the value.
  assert.equal(getParam(parsed.params, 'nspin'), '1');
  assert.deepEqual(parsed.unknownLines, []);
  assert.deepEqual(parsed.warnings, []);
});

test('INPUT records the file order, original case and 1-based line numbers', () => {
  const parsed = parseAbacusInput('INPUT_PARAMETERS\n# leading comment\nECUTWFC 50\n\nSuffix x\n');
  assert.deepEqual(parsed.keywordOrder, ['ECUTWFC', 'Suffix']);
  assert.deepEqual(parsed.entries.map((e) => e.key), ['ecutwfc', 'suffix']);
  assert.deepEqual(parsed.entries.map((e) => e.line), [3, 5]);
  assert.equal(parsed.entries[0].raw, 'ECUTWFC 50');
});

test('INPUT keys are case-insensitive and duplicates are reported, last wins', () => {
  const parsed = parseAbacusInput('INPUT_PARAMETERS\nECUTWFC 50\necutwfc 60\n');
  assert.equal(getNumber(parsed.params, 'ecutwfc'), 60);
  assert.deepEqual(parsed.duplicates, ['ecutwfc']);
  assert.ok(parsed.warnings.some((w) => w.includes('ecutwfc')));
});

test('INPUT keeps a multi-value keyword as one string and can split it again', () => {
  const parsed = parseAbacusInput('INPUT_PARAMETERS\nkspacing 0.02 0.02 0.02\nrelax_method cg 1\n');
  assert.equal(getParam(parsed.params, 'kspacing'), '0.02 0.02 0.02');
  // A scalar question about a vector keyword means its first component.
  assert.equal(getNumber(parsed.params, 'kspacing'), 0.02);
  assert.deepEqual(getNumberList(parsed.params, 'kspacing'), [0.02, 0.02, 0.02]);
  assert.deepEqual(getList(parsed.params, 'relax_method'), ['cg', '1']);
  // A keyword whose value holds no number at all yields no numbers.
  assert.equal(getNumberList(parsed.params, 'basis_type'), null);
  assert.equal(getNumber(parsed.params, 'basis_type'), null);
  // An absent keyword is null / empty, not a zero.
  assert.equal(getNumberList(parsed.params, 'not_there'), null);
  assert.deepEqual(getList(parsed.params, 'not_there'), []);
});

test('INPUT without the INPUT_PARAMETERS header still parses, with a warning', () => {
  const parsed = parseAbacusInput('ecutwfc 60\ncalculation scf\n');
  assert.equal(parsed.headerPresent, false);
  assert.equal(getParam(parsed.params, 'calculation'), 'scf');
  assert.ok(parsed.warnings.some((w) => w.includes('INPUT_PARAMETERS')));
});

test('INPUT accepts both comment markers and strips them mid-line', () => {
  const parsed = parseAbacusInput('INPUT_PARAMETERS\necutwfc 60 # trailing\nscf_thr 1e-6 ! also trailing\n');
  assert.equal(getParam(parsed.params, 'ecutwfc'), '60');
  assert.equal(getParam(parsed.params, 'scf_thr'), '1e-6');
});

test('INPUT tolerates a trailing bare header and an empty file without throwing', () => {
  const twice = parseAbacusInput('INPUT_PARAMETERS\necutwfc 60\nINPUT_PARAMETERS\n');
  assert.equal(getParam(twice.params, 'ecutwfc'), '60');
  assert.ok(twice.warnings.some((w) => w.includes('重复')));
  assert.doesNotThrow(() => parseAbacusInput(''));
  assert.ok(parseAbacusInput('').warnings.length > 0);
});

// ------------------------------------------------------------ flag values ----

test('getFlag follows the ABACUS truthy/falsy sets and stays undefined otherwise', () => {
  const params = { a: '', b: '1', c: 'true', d: 'T', e: 'yes', f: 'on', g: '.TRUE.',
    h: '0', i: 'false', j: 'F', k: 'no', l: 'off', m: 'none', n: 'maybe', o: '0.5' };
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
    assert.equal(getFlag(params, key), true, `${key} should be truthy`);
  }
  for (const key of ['h', 'i', 'j', 'k', 'l', 'm']) {
    assert.equal(getFlag(params, key), false, `${key} should be falsy`);
  }
  // Neither truthy nor falsy: the caller must show the raw string, not invent a boolean.
  for (const key of ['n', 'o']) assert.equal(getFlag(params, key), undefined, `${key} is ambiguous`);
  assert.equal(getFlag(params, 'absent'), undefined);
});

// ------------------------------------------------------ keyword metadata ----

/** Every keyword SPEC.md §1.1 requires. */
const SPEC_KEYS = [
  // system
  'suffix', 'ntype', 'calculation', 'ecutwfc', 'scf_thr', 'scf_nmax', 'basis_type',
  'kspacing', 'pseudo_dir', 'orbital_dir', 'dft_functional', 'nspin', 'symmetry', 'device',
  'ks_solver', 'init_chg', 'init_wfc', 'chg_extrap', 'precision', 'out_level', 'out_chg',
  'out_dos', 'out_band', 'out_proj_band', 'out_stru', 'out_mat_hs', 'out_mat_hs2',
  'out_mat_xc', 'out_mat_dh', 'out_mat_t', 'out_wfc_lcao', 'out_elf', 'out_mul', 'out_pot',
  'out_app_flag',
  // elec_stru
  'ecutrho', 'nbands', 'nbnd', 'smearing_method', 'smearing_sigma', 'mixing_type',
  'mixing_beta', 'mixing_ndim', 'mixing_gg0', 'nupdown', 'nelec', 'ocp', 'ocp_set',
  'lspinorb', 'noncolin', 'dft_plus_u', 'orbital_corr', 'hubbard_u', 'hubbard_alpha',
  'exx_hybrid_alpha', 'exx_hybrid_step', 'exx_ccp_rmesh_times', 'exx_separate_loop',
  'exx_mpi_processor', 'vdw_method', 'vdw_s6', 'vdw_s8', 'vdw_a1', 'vdw_a2', 'vdw_d',
  'vdw_abc', 'berry_phase',
  // relax
  'relax_method', 'relax_nmax', 'force_thr', 'force_thr_ev', 'stress_thr', 'press_thr',
  'relax_new', 'relax_bfgs_w1', 'relax_bfgs_w2', 'relax_bfgs_rmax', 'relax_bfgs_rmin',
  'relax_bfgs_init', 'relax_cg_thr', 'fixed_axes', 'cell_factor',
  // md
  'md_type', 'md_nstep', 'md_dt', 'md_tfirst', 'md_tlast', 'md_nraise', 'md_thermostat',
  // tddft
  'tddft', 'td_dt', 'td_stype', 'td_ttype', 'td_nstep', 'out_dipole',
  // output
  'out_interval', 'out_freq_ion', 'out_freq_elec', 'out_bandgap', 'out_zmatrix',
  'out_current', 'out_vecpot',
];

const ALLOWED_CATEGORIES = new Set([
  'System', 'Accuracy', 'Electronic', 'Occupational', 'Mixing', 'Structural',
  'Relaxation', 'MD', 'RT-TDDFT', 'EXX', 'DFT+U', 'vdW', 'DeepKS', 'Output',
  'Device', 'Postprocess', 'Other',
]);

test('KEYWORD_INFO documents every keyword SPEC.md §1.1 names, with category/type/doc', () => {
  const missing = [];
  for (const key of SPEC_KEYS) {
    const meta = KEYWORD_INFO[key];
    if (!meta) {
      missing.push(key);
      continue;
    }
    assert.ok(ALLOWED_CATEGORIES.has(meta.category), `${key} has an out-of-contract category: ${meta.category}`);
    assert.ok(['string', 'number', 'flag', 'enum'].includes(meta.type), `${key} has a bad type: ${meta.type}`);
    assert.ok(typeof meta.doc === 'string' && meta.doc.length > 6, `${key} has no usable doc`);
    if (meta.type === 'enum') {
      assert.ok(Array.isArray(meta.values) && meta.values.length > 0, `${key} is an enum without values`);
    }
  }
  assert.deepEqual(missing, [], `KEYWORD_INFO missing: ${missing.join(', ')}`);
});

test('KEYWORD_INFO carries units where the physical meaning needs one', () => {
  const units = {
    ecutwfc: 'Ry',
    ecutrho: 'Ry',
    force_thr: 'Ry/Bohr',
    force_thr_ev: 'eV/Angstrom',
    stress_thr: 'kbar',
    md_dt: 'fs',
    md_tfirst: 'K',
    relax_bfgs_rmax: 'Bohr',
    smearing_sigma: 'Ry',
  };
  for (const [key, unit] of Object.entries(units)) {
    assert.equal(KEYWORD_INFO[key].unit, unit, `${key} unit`);
  }
});

test('KEYWORD_INFO flags the SPEC keywords that current ABACUS no longer reads', () => {
  // These ten names appear in SPEC.md §1.1 but are absent from the whole ABACUS source
  // tree and from its generated parameters.yaml, so ABACUS would reject them at run time.
  const legacy = ['nbnd', 'hubbard_alpha', 'exx_hybrid_alpha', 'exx_mpi_processor',
    'press_thr', 'tddft', 'td_nstep', 'out_interval', 'out_bandgap', 'out_zmatrix'];
  for (const key of legacy) {
    const meta = KEYWORD_INFO[key];
    assert.equal(meta.legacy, true, `${key} must be marked legacy`);
    assert.ok(meta.replacedBy, `${key} must name its replacement`);
    assert.ok(meta.doc.length > 20, `${key} must explain why it is legacy`);
  }
  // A real keyword must not be marked legacy.
  assert.equal(KEYWORD_INFO.ecutwfc.legacy, undefined);
});

test('keywordInfo looks up case-insensitively and returns undefined for unknowns', () => {
  assert.equal(keywordInfo('ECUTWFC'), KEYWORD_INFO.ecutwfc);
  assert.equal(keywordInfo('Ecutwfc'), KEYWORD_INFO.ecutwfc);
  assert.equal(keywordInfo('no_such_keyword'), undefined);
  // Object keys are lowercase so `params` and the table agree on spelling.
  for (const key of Object.keys(KEYWORD_INFO)) assert.equal(key, key.toLowerCase());
});

// ------------------------------------------------------------- summarize ----

test('summarizeParams groups known keys and reports unknown ones', () => {
  const parsed = parseAbacusInput(fixture('INPUT'));
  const summary = summarizeParams(parsed.params);
  const categories = summary.groups.map((g) => g.category);
  assert.ok(categories.includes('System'));
  assert.ok(categories.includes('Accuracy'));
  assert.ok(categories.includes('Output'));
  // `some_future_keyword` is deliberately absent from KEYWORD_INFO.
  assert.deepEqual(summary.unknownKeys, ['some_future_keyword']);

  const accuracy = summary.groups.find((g) => g.category === 'Accuracy');
  const ecut = accuracy.items.find((i) => i.key === 'ecutwfc');
  assert.equal(ecut.value, '60');
  assert.equal(ecut.unit, 'Ry');
  assert.equal(ecut.known, true);
  assert.ok(ecut.doc.length > 6);

  // Unknown keys still come back, just flagged and under `Other`.
  const other = summary.groups.find((g) => g.category === 'Other');
  assert.deepEqual(other.items.map((i) => i.key), ['some_future_keyword']);
  assert.equal(other.items[0].known, false);
});

test('summarizeParams flags an out-of-range enum value but not a valid one', () => {
  const summary = summarizeParams({ nspin: '4', smearing_method: 'gausian' });
  const items = summary.groups.flatMap((g) => g.items);
  assert.equal(items.find((i) => i.key === 'nspin').enumOk, true);
  assert.equal(items.find((i) => i.key === 'smearing_method').enumOk, false);
});

test('summarizeParams marks a legacy keyword so the panel can warn about it', () => {
  const summary = summarizeParams({ nbnd: '8', nbands: '8' });
  const items = summary.groups.flatMap((g) => g.items);
  const nbnd = items.find((i) => i.key === 'nbnd');
  assert.equal(nbnd.legacy, true);
  assert.equal(nbnd.replacedBy, 'nbands');
  assert.equal(items.find((i) => i.key === 'nbands').legacy, undefined);
});

test('summarizeParams does not throw on empty or missing input', () => {
  assert.deepEqual(summarizeParams({}), { groups: [], unknownKeys: [] });
  assert.doesNotThrow(() => summarizeParams(undefined));
});

// ------------------------------------------------------------ kMeshSource ----

test('kMeshSource notices that kspacing and gamma_only override KPT', () => {
  assert.equal(kMeshSource({}).source, 'KPT');
  assert.ok(kMeshSource({}).note.includes('KPT'));

  const spacing = kMeshSource({ kspacing: '0.02 0.02 0.02' });
  assert.equal(spacing.source, 'kspacing');
  assert.equal(spacing.kspacing, 0.02, 'the first component gates the ABACUS branch');
  assert.ok(spacing.note.includes('重写'));

  const gamma = kMeshSource({ gamma_only: '' });
  assert.equal(gamma.source, 'gamma_only');
  assert.ok(gamma.note.includes('重写'));

  // gamma_only wins over kspacing: read_kpoints checks it first.
  assert.equal(kMeshSource({ gamma_only: '1', kspacing: '0.02' }).source, 'gamma_only');

  // kspacing = 0 means "read the KPT file", which is the default.
  assert.equal(kMeshSource({ kspacing: '0' }).source, 'KPT');
  assert.equal(kMeshSource({ kspacing: '0 0 0' }).source, 'KPT');
});

// ------------------------------------------------------------ INPUT.info ----

test('INPUT.info parses the resolved-parameter dump written by ABACUS', () => {
  const info = parseInputInfo(fixture('INPUT.info'));

  // Values, not defaults: this is the point of reading INPUT.info.
  assert.equal(info.params.suffix, 'autotest');
  assert.equal(info.params.ecutwfc, '25');
  assert.equal(info.params.basis_type, 'lcao');
  assert.equal(info.params.ks_solver, 'genelpa');
  assert.equal(info.params.scf_thr, '1e-10');
  // A vector-valued keyword keeps its whole value string.
  assert.equal(info.params.kspacing, '0 0 0');
  assert.equal(info.params.relax_method, 'cg 1');
  assert.deepEqual(info.warnings, []);
});

test('INPUT.info never mistakes the trailing annotation for the value', () => {
  const info = parseInputInfo(fixture('INPUT.info'));
  // `bessel_nao_rcut` has no value at all, only its annotation. A naive split would
  // return "radial cutoff for spherical bessel functions(a.u.)" as the value.
  assert.equal(info.params.bessel_nao_rcut, '');
  assert.ok(info.emptyValues.includes('bessel_nao_rcut'));
  // The annotation is still available, separately, for display.
  const entry = info.entries.find((e) => e.key === 'bessel_nao_rcut');
  assert.equal(entry.value, '');
  assert.ok(entry.comment.includes('radial cutoff'));
  // A keyword that does have a value keeps both fields apart.
  const suffix = info.entries.find((e) => e.key === 'suffix');
  assert.equal(suffix.value, 'autotest');
  assert.equal(suffix.comment, 'the name of main output directory');
});

test('INPUT.info records its section headers and totals', () => {
  const info = parseInputInfo(fixture('INPUT.info'));
  assert.ok(info.sections.length >= 6);
  assert.ok(info.sections.some((s) => s.title.includes('System')));
  assert.ok(info.sections.some((s) => s.title.includes('Electronic structure')));
  // Section headers are not parameters.
  assert.equal(info.params['Parameters (1.System)'], undefined);
  assert.ok(info.entries.length > 60, `only ${info.entries.length} entries`);
});

test('INPUT.info accepts the bracketed, equals and spaced shapes', () => {
  const bracketed = parseInputInfo('[suffix] [si2]\n[ecutwfc] [60]\n');
  assert.equal(bracketed.params.suffix, 'si2');
  assert.equal(bracketed.params.ecutwfc, '60');
  assert.equal(bracketed.brackets, 2);

  const spaced = parseInputInfo('suffix    si2\necutwfc   60\n');
  assert.equal(spaced.params.suffix, 'si2');
  assert.equal(spaced.params.ecutwfc, '60');

  const equals = parseInputInfo('suffix = si2\necutwfc=60\n');
  assert.equal(equals.params.suffix, 'si2');
  assert.equal(equals.params.ecutwfc, '60');
});

test('INPUT.info ignores separator and banner lines, and reports unparseable ones', () => {
  const text = [
    'INPUT_PARAMETERS',
    '====================',
    '|  ABACUS INPUT     |',
    '----------------------',
    'suffix   si2',
    '',
    '!!! not a parameter !!!',
  ].join('\n');
  const info = parseInputInfo(text);
  assert.equal(info.params.suffix, 'si2');
  assert.equal(info.entries.length, 1);
  assert.ok(info.warnings.some((w) => w.includes('not a parameter')));
});

test('INPUT.info handles an empty file without throwing', () => {
  const info = parseInputInfo('');
  assert.deepEqual(info.entries, []);
  assert.ok(info.warnings.length > 0);
  assert.doesNotThrow(() => parseInputInfo(undefined));
  // infoParam is a case-insensitive helper over the map.
  assert.equal(infoParam({ Base_Type: 'lcao' }, 'basis_type'), undefined);
  assert.equal(infoParam({ basis_type: 'lcao' }, 'BASIS_TYPE'), 'lcao');
});
