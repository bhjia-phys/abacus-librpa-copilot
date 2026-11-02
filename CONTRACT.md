# dsh-abacusflow — module contract for parallel implementation

Every module below is a **plain ESM `.js`** file under `packages/dsh-abacusflow/`.
No third-party imports. Only `node:` builtins. All functions are pure (text in → data out)
except the scanners, which touch the filesystem.

Rules for all implementers:

- Never throw for bad *content*; return a `warnings: string[]` entry and keep going.
  Only throw for programming errors (missing argument).
- Numbers: parse with a helper that tolerates `D` exponents (`1.0D+02`) and returns
  `null` for unparseable text — never `NaN` inside returned data.
- Every parser returns a top-level `warnings` array.
- Write `node --test` tests beside the code. Fixtures: small hand-written files that
  reproduce the real formats quoted in `SPEC.md`. Do not copy multi-MB data.

---

## Lead-owned shared utilities (already written; import, don't duplicate)

### `lib/host/shared/paths.js`

```js
export function normalizeRel(p)               // -> 'a/b/c', '' for '.'
export function resolveInside(rootAbs, rel)   // -> { abs, rel }  throws if it escapes root
export function isDirectory(p)                // -> boolean, never throws
export function safeStat(p)                   // -> { size, mtimeMs, isDir } | null
export function readTextCapped(p, maxBytes)   // -> { text, truncated } | null
export function listDir(p)                    // -> [{ name, isDir, size, mtimeMs }] | null
```

### `lib/host/shared/numbers.js`

```js
export function toNum(text)        // -> number|null ; handles 'D' exponents
export function fmtEv(v, digits)   // -> string|null
```

---

## 1. `lib/host/abacus/input-params.js`  (owner: abacus-core)

ABACUS `INPUT` file.

```js
/** @returns {{
 *   keywordOrder: string[],            // in file order, original case
 *   params: Record<string,string>,     // lower-case keyword -> joined value string ('' for bare flags)
 *   entries: Array<{ keyword: string, key: string, values: string[], line: number, raw: string }>,
 *   duplicates: string[],              // keys that appeared more than once (last wins in params)
 *   unknownLines: string[],
 *   warnings: string[]
 * }} */
export function parseAbacusInput(text)

/** Case-insensitive lookup. @returns {string|undefined} */
export function getParam(params, name)

/** Numeric lookup. @returns {number|null} */
export function getNumber(params, name)

/** Boolean flag: present with no value, or value in {1,true,T}. */
export function getFlag(params, name)

/** Keyword metadata used by the UI and by validation.
 *  @type {Record<string,{category:string, unit?:string, type:'string'|'number'|'flag'|'enum', values?:string[], doc:string}>}
 */
export const KEYWORD_INFO

/**
 * Group the parsed params for display.
 * @returns {{ groups: Array<{ category: string, items: Array<{
 *   key: string, value: string, known: boolean, unit?: string, doc?: string }> }>,
 *   unknownKeys: string[] }}
 */
export function summarizeParams(params)
```

Requirements:

- First non-comment, non-empty line must be `INPUT_PARAMETERS`; if it is missing add a
  warning but still parse.
- `#` and `!` start a comment; a whole-line comment is skipped.
- Keyword matching is case-insensitive; values may be empty.
- `KEYWORD_INFO` must cover at least every keyword listed in `SPEC.md` §1.1 with a
  `category` of one of: `System`, `Accuracy`, `Electronic`, `Occupational`, `Mixing`,
  `Structural`, `Relaxation`, `MD`, `RT-TDDFT`, `EXX`, `DFT+U`, `vdW`, `DeepKS`,
  `Output`, `Device`, `Postprocess`. Unknown keys are still returned (`known:false`).

---

## 2. `lib/host/abacus/stru.js`  (owner: abacus-core)

ABACUS `STRU` file.

```js
/** @returns {{
 *   latticeConstant: number|null,
 *   latticeConstantUnit: 'Bohr'|'Angstrom',
 *   latticeVectors: number[][]|null,   // 3x3, dimensionless (in units of latticeConstant)
 *   species: Array<{ label: string, mass: number|null, pp: string|null, orbitals: string[] }>,
 *   coordinateMode: 'Direct'|'Cartesian'|null,
 *   atoms: Array<{
 *     label: string, speciesIndex: number, index: number,   // index: 1-based global
 *     coords: number[],             // as written
 *     frac: number[]|null,          // fractional, always filled when derivable
 *     cartesian: number[]|null,     // Cartesian in Angstrom, always filled when derivable
 *     move: number[]|null, mag: number[]|null
 *   }>,
 *   natom: number,
 *   warnings: string[]
 * }} */
export function parseStru(text)
```

Requirements:

- Blocks may appear in any order; unknown blocks are skipped with a warning.
- `LATTICE_CONSTANT` line may carry a trailing unit token (`angstrom` / `bohr`, any case).
  Default is Bohr. Convert with `1 Bohr = 0.529177210903 Angstrom`.
- `LATTICE_VECTORS`: 3 lines of 3 numbers. They are dimensionless multipliers of
  `latticeConstant` (this is ABACUS semantics; keep `latticeVectors` dimensionless and
  expose the physical cell only through `atoms[].cartesian` and a computed cell helper).
- `ATOMIC_POSITIONS` block: one `Direct|Cartesian` mode line, then repeating groups
  `label` / `magnetism` / `natom` / `natom` atom lines. Cartesian is in units of
  `LATTICE_CONSTANT` (multiply by `latticeConstant`, then convert Bohr→Å).
- Compute `frac` and `cartesian` for every atom when the lattice is known.
- Atom lines may have 3, 6, or 9+ trailing numbers; extras beyond `move`/`mag` go to a
  warning.

```js
/** Physical cell in Angstrom, row-major. @returns {number[][]|null} */
export function cellAngstrom(stru)

/** @returns {number|null} cell volume in Angstrom^3 */
export function cellVolume(stru)
```

---

## 3. `lib/host/abacus/stru-scene.js`  (owner: abacus-core)

Turns a parsed `STRU` into the geometry the client's 3D viewer renders. Mirror the
VASPFlow scene contract closely enough that the viewer code is simple.

```js
/** @returns {{
 *   cell: number[][]|null,               // 3x3 Angstrom
 *   cellVectors: Array<{ a:number[], b:number[], c:number[], label:'a'|'b'|'c' }>|null,
 *   atoms: Array<{ element:string, z:number, cartesian:number[], radius:number,
 *                  color:string, label:string, index:number }>,
 *   bonds: Array<{ i:number, j:number, order:number, length:number }>,
 *   formula: string,
 *   counts: Record<string, number>,
 *   natom: number,
 *   volume: number|null,
 *   connectivityLimited: boolean,
 *   warnings: string[]
 * }} */
export function struToScene(stru, opts)
```

`opts`: `{ includeConnectivity: boolean = true, bondAlgorithm: 'crystal-nn'|'minimum-distance', maxBondAtoms: number = 2000 }`.

- Element colours: CPK palette for H..Kr at minimum; unknown → grey `#b0b0b0`.
- Radii: covalent-radius table in Å; unknown → 1.2.
- Bond detection: periodic minimum-image over neighbouring cells within a cutoff of
  `1.2 * (r_i + r_j)` using `crystal-nn`; skip connectivity (and set
  `connectivityLimited`) when `natom > maxBondAtoms`.
- `formula`: Hill-ish ordering, e.g. `Si2`, `Fe2O3`.

---

## 4. `lib/host/abacus/kpt.js`  (owner: abacus-core)

```js
/** @returns {{
 *   mode: 'auto'|'explicit'|null,
 *   centering: 'Gamma'|'MP'|null,     // only for auto
 *   grid: number[]|null,              // 3 ints
 *   shift: number[]|null,             // 3 ints 0/1
 *   points: Array<{ frac:number[], weight:number|null }>|null,
 *   nkpts: number|null,
 *   warnings: string[]
 * }} */
export function parseKpt(text)
```

Also accept a KPT given directly inside `INPUT` via `kspacing` — do **not** handle that
here; the scanner merges it.

---

## 5. `lib/host/abacus/input-info.js`  (owner: abacus-core)

`OUT.<suffix>/INPUT.info` — ABACUS writes the fully resolved INPUT there.

```js
/** @returns {{ params: Record<string,string>, entries: Array<{key:string,value:string}>,
 *              brackets: number, warnings: string[] }} */
export function parseInputInfo(text)
```

The real file wraps values in `[...]`-style or bare columns; be permissive: a line of the
form `keyword = value`, `keyword  value`, or
`[keyword] [value]` all parse. Ignore separator/banner lines made of `-`, `=`, `+`, `|`.

---

## 6. `lib/host/abacus/log.js`  (owner: abacus-log)

ABACUS main log (`OUT.*/running_scf.log`, `running_relax.log`, `running_md.log`, ……).

```js
/** @returns {{
 *   calculation: string|null,                 // from 'calculation = ...' if echoed
 *   code,                                     // see classifyAbacusRun
 *   iterations: Array<{
 *     ionicStep: number, scfIter: number,
 *     rhoDeviation: number|null,
 *     eKohnShamRy: number|null, eKohnShamEv: number|null,
 *     eHarrisEv: number|null, eFermiEv: number|null, gapEv: number|null
 *   }>,
 *   scfConverged: boolean|null,               // null when the log has no verdict yet
 *   scfNotConverged: boolean,
 *   ionicConvergedScfNot: boolean,            // the 'Relaxation is converged, but the SCF is unconverged' banner
 *   lastTotalEnergyEv: Array<{ ionicStep:number, energyEv:number }>,
 *   forces: Array<{ label:string, fx:number, fy:number, fz:number }>,
 *   maxForce: number|null,
 *   stress: Array<{ label:string, values:number[] }>,   // TOTAL-STRESS rows
 *   finished: boolean,                        // saw 'Total  Time  :'
 *   timings: Array<{ name:string, calls:number, seconds:number, percent:number }>,
 *   memory: Array<{ name:string, mb:number }>,
 *   errors: Array<{ code:string, message:string, evidence:string }>,
 *   warnings: string[]
 * }} */
export function parseScfLog(text)
```

Requirements:

- Iterate lines once, streaming-style friendly (a 30 MB log must not blow up): do not
  build a giant array of all lines if you can avoid it; it is fine to keep the last N
  (N>=2000) lines only for error scanning, but the `iterations` array must cover the
  whole file.
- Recognise, exactly:
  - `/-->\s*#ION MOVE#\s+(\d+)\s+#ELEC ITER#\s+(\d+)/`
  - `/Electron density deviation\s+([-+0-9.eEdD]+)/`
  - `/^\s*E_KohnSham\s+([-+0-9.eEdD]+)\s+([-+0-9.eEdD]+)/`
  - the same for `E_Harris`, `E_Fermi`, `E_gap\(k\)` (only the eV column is kept for
    these three; store Ry too when trivially available)
  - `/^\s*#SCF IS CONVERGED#/`, `/^\s*!!SCF IS NOT CONVERGED!!/`
  - `/^\s*#TOTAL ENERGY#\s+([-+0-9.eEdD]+)\s*eV/`
  - `/Total\s+Time\s+:/`
  - `/Relaxation is converged, but the SCF is unconverged/`
  - `/TOTAL-FORCE \(eV\/Angstrom\)/` then the following atom rows
    `/^\s*([A-Z][a-z]?)\s+([-+0-9.eEdD]+)\s+([-+0-9.eEdD]+)\s+([-+0-9.eEdD]+)\s+([-+0-9.eEdD]+)\s+([-+0-9.eEdD]+)\s+([-+0-9.eEdD]+)/`
    until a `---`/`total drift`/blank-terminated table ends
  - `/TOTAL-STRESS \(KBAR\)/` rows
  - timing table rows after `CLASS_NAME\s+NAME\s+TIME\/s`: `/^\s*(\S+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s*$/`
  - memory table rows after `NAME----|MEMORY\(MB\)`
- `maxForce`: max over the last force table of `sqrt(fx²+fy²+fz²)`.
- Error codes to emit (only these strings):
  `SCF_NOT_CONVERGED`, `RELAX_CONVERGED_SCF_NOT`, `SEGFAULT`, `MPI_ABORT`,
  `FORRTL_SEVERE`, `BAD_TERMINATION`, `OUT_OF_MEMORY`, `TIME_LIMIT`, `UNFINISHED`.
  `UNFINISHED` is emitted by the classifier, not here.

```js
/** Decide the run status.
 * @param {{ hasOutputDir:boolean, logText:string|null, logFileName:string|null,
 *           mtimeAgeSeconds:number|null }} input
 * @returns {{ code:'NO_OUTPUT'|'RUNNING'|'FINISHED'|'FINISHED_UNCONVERGED'|'ERROR',
 *             label:string, reason:string, evidence:string[] }} */
export function classifyAbacusRun(input)
```

Rules:

- no `OUT.<suffix>` dir, or it exists but has no `running_*.log` and no other evidence →
  `NO_OUTPUT`.
- log exists and has `Total  Time  :` and `scfConverged !== false` → `FINISHED`.
- log exists, finished, but `scfNotConverged` or `ionicConvergedScfNot` →
  `FINISHED_UNCONVERGED`.
- any hard error code present → `ERROR`.
- log exists, no terminator, file modified recently (`mtimeAgeSeconds < 600`) →
  `RUNNING`; otherwise → `RUNNING` with reason mentioning stale mtime is still
  `RUNNING` (do not invent a different code) — but set `evidence` accordingly.
- `label` is Chinese: `未开始`/`运行中`/`已完成`/`完成但未收敛`/`出错`.

---

## 7. `lib/host/librpa/input.js`  (owner: abacus-log)

```js
/** @returns {{
 *   entries: Array<{ key:string, value:string, raw:string, line:number }>,
 *   params: Record<string,string>,
 *   warnings: string[]
 * }} */
export function parseLibrpaIn(text)

/** @type {Record<string,{type:'string'|'number'|'bool'|'enum', values?:string[],
 *          group:string, doc:string}>} */
export const LIBRPA_KEYS

/** @returns {{ groups: Array<{ group:string, items:Array<{key:string,value:string,known:boolean,doc?:string}> }>,
 *              unknownKeys: string[] }} */
export function summarizeLibrpaParams(params)
```

`LIBRPA_KEYS` must document at least the keys in `SPEC.md` §2.1, grouped as
`Task`, `Paths`, `Screening`, `Frequency`, `Dielectric`, `Parallel`, `Symmetry`,
`Coulomb`, `QSGW`, `Output`.

---

## 8. `lib/host/librpa/output.js`  (owner: abacus-log)

```js
/** `librpa.d/qsgw_eigenvalues.dat`.
 * @returns {{
 *   header: Record<string,string>,    // '#' comment lines as key -> value (multi-word values joined)
 *   headerLines: string[],
 *   columns: string[],                // from the last '#' line that starts with 'iter '
 *   rows: Array<{ iter:number, channel:number, spin:number, kpoint:number,
 *                 k:number[], band:number, energyEv:number }>,
 *   nIter: number, nBand: number, nKpoint: number, nSpin: number,
 *   minEnergyEv: number|null, maxEnergyEv: number|null,
 *   warnings: string[]
 * }} */
export function parseQsgwEigenvalues(text)

/** `librpa.d/qsgw_iterations.dat`.
 * @returns {{
 *   header: Record<string,string>,
 *   columns: string[],
 *   rows: Array<Record<string, number|string|null>>,   // keyed by the column header
 *   convergedIter: number|null,      // first row whose `converged` is truthy
 *   warnings: string[]
 * }} */
export function parseQsgwIterations(text)

/** `librpa.out` (main log).
 * @returns {{
 *   mpi: { tasks:number|null, nodes:number|null, threads:number|null },
 *   build: Record<string,string>,          // 'Build type', 'Source code Git hash', 'GreenX commit hash', 'Use LibRI', ...
 *   driverParams: Record<string,string>,   // from the '========= Begin driver parameters =========' block
 *   finished: boolean,                     // saw 'libRPA finished successfully'
 *   timings: Array<{ name:string, calls:number, seconds:number, cumSeconds:number }>,
 *   errors: Array<{ code:string, message:string, evidence:string }>,
 *   startTime: string|null, warnings: string[]
 * }} */
export function parseLibrpaLog(text)

/** @returns {{ code:'NO_OUTPUT'|'RUNNING'|'FINISHED'|'ERROR',
 *              label:string, reason:string, evidence:string[] }} */
export function classifyLibrpaRun(input)
```

`classifyLibrpaRun` input: `{ hasOutput:boolean, logText:string|null, exitcode:number|null, mtimeAgeSeconds:number|null }`.
Labels: `未开始` / `运行中` / `已完成` / `出错`.

Notes from the real log:

- Build block lines look like `| Build type               : Debug`.
- Driver param block starts with `========= Begin driver parameters =========` (count the
  `=` loosely: match `/^=+\s*Begin driver parameters/`) and each line is
  `key = value` ending with `========= End driver parameters =========`.
- The successful terminator is the literal line `libRPA finished successfully`.
- The timing table has a `CLASS_NAME NAME TIME/s CALLS AVG/s PER/%`-ish layout; in
  `librpa.out` the columns are `name calls avg cum` — be permissive: match lines with a
  leading indented name and 3 numeric columns, and record what you can.

---

## 9. Client — `lib/client.js`  (owner: client-ui)

> **2026-11-02:** the layout requirements below (task tree, flat tabs) are superseded by
> [UI.md](UI.md) — pipeline-first runs, four places, results-first run page. The loader dialect,
> the HTTP shapes and the dark-theme rule (`body[data-ds-dark-theme]`) still hold; two read-only
> routes were added (`/kcompare`, `/research-context`, see UI.md §9).

Single pre-bundled file in the DSH 0.2 module-loader dialect:

```js
window.__ModuleLoader__.load({
  id: '@local/abacusflow',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // ... components ...
    return { inject: ['slots'], apply(ctx) { /* ... */ } };
  },
});
```

Host HTTP base: `/abacusflow/api`.

| endpoint | response |
|---|---|
| `GET /ping` | `{ ok:true, version:string }` |
| `GET /scan?rootPath=<abs>&maxDepth=<n>` | `{ rootPath, tasks:[Task], directories:[Dir], counts, error:'' }` |
| `GET /task-bundle?id=<taskId>` | `{ task:Task, abacus:{params,kpt,stru,log,status}|null, librpa:{input,log,qsgw}|null, files:[File] , structureScene: Scene|null, error:'' }` |
| `GET /file?id=<taskId>&name=<file>` | `{ name, text, truncated, error:'' }` |

`Task = { id, relPath, absPath, kind:'abacus'|'librpa', calculation:string|null,
           status:{code,label,reason,evidence:string[]}, outputDir:string|null,
           mtimeMs:number, summary:string }`
`Dir  = { relPath, name, taskCount }`
`File = { name, size, mtimeMs, isDir }`

UI requirements:

- A **sidebar panel entry** (`sidebar.panellist`) whose icon is an inline SVG, plus a
  `main` slot entry that renders the full page, plus a `sidebar.right.pane.tab` entry
  (registered via `ctx.get('sidebarRightTabs')`) so it also works as a right dock.
  If `sidebarRightTabs` is unavailable, degrade gracefully (page + panel entry only).
- Root-path input with a scan button, remembering the last value in `localStorage`.
- Task tree grouped by directory; per task a status chip using the returned Chinese label
  and a colour: 未开始 grey, 运行中 blue, 已完成 green, 完成但未收敛 amber, 出错 red.
- **Convergence chart**: hand-written SVG line chart of `E_KohnSham (eV)` vs SCF iteration,
  with ionic steps as separated polylines, plus a second small chart of
  `Electron density deviation` on a log scale. Axis labels, ticks, and a hover readout.
- **Structure viewer**: hand-written `<canvas>` (2D projection of 3D points) with
  drag-to-rotate, wheel-to-zoom, bonds from `scene.bonds`, element colours from
  `scene.atoms[].color`. No three.js.
- **File browser**: list of files, click to preview text (max 500 KB shown, note truncation).
- **LibRPA tab** when the task is a LibRPA task: QSGW iteration table (from
  `qsgw_iterations`), a gap/ΔE convergence chart, and the build provenance block.
- Dark theme: use CSS custom properties with fallbacks, and respect
  `document.body.dataset.dsDarkTheme`.
- All user-visible text in Chinese. Wrap the whole panel in an error boundary that shows
  the message instead of a blank screen.
- `scroll`, resizing and empty states must not throw.

---

## 10. Lead-owned files (do not edit)

`package.json`, `cordis.patch.yml`, `locale/*.json`, `icon.svg`,
`lib/index.js`, `lib/host/scanner.js`, `lib/host/task-store.js`,
`lib/host/shared/*`, `scripts/*`, `test/integration.test.mjs`, `README.md`, `SPEC.md`.
