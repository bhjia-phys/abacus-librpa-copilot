/**
 * ABACUS main log (`OUT.<suffix>/running_<calculation>.log`).
 *
 * The file name is not fixed — ABACUS builds it from `calculation`
 * (`read_set_globalv.cpp`, `"running_" + cal_type + ".log"`), so nothing here assumes one.
 *
 * ## Line grammar (all verified against ABACUS v3.9.0.25 sources)
 *
 *   write_head()              ` --> #ION MOVE#         1  #ELEC ITER#         3`
 *                             (`source_io/module_output/output_log.cpp`)
 *   write_head_td()           ` --> #ION MOVE#         1 #ELEC PROP#         1  #ELEC ITER#   3`
 *   charge mixing            ` Electron density deviation 0.091088`
 *   energy table             `  E_KohnSham     -2.3189359026        -31.5507415719`   (Ry | eV)
 *   output_convergence_after_scf()
 *                            ` #SCF IS CONVERGED#` / ` !!SCF IS NOT CONVERGED!!`
 *                            ` #TOTAL ENERGY# -31.552277937 eV`
 *   output_after_relax()     ` Relaxation is converged, but the SCF is unconverged!`
 *   print_force()            ` #TOTAL-FORCE (eV/Angstrom)#` + rows `Label fx fy fz`
 *                            (element+index label, `%8s` + 3 x `%20.10f`)
 *   print_stress()           ` #TOTAL-STRESS (kbar)#` + three rows of three numbers
 *   timer::print_all()       `TIME STATISTICS` + `CLASS_NAME NAME TIME/s CALLS AVG/s PER/%`
 *   Memory::print_all()      ` NAME---|MEMORY(MB)---` + `name  MB`
 *   print_info()             ` Total  Time  : 0 h 0 mins 0 secs `
 *
 * ## Memory strategy (why this file never calls `text.split`)
 *
 * A 30 MB `running_scf.log` holds ~5·10^5 lines. `text.split(/\n/)` would materialise
 * every one of them as a JS string before the first number is read — easily 3–5x the
 * file size, all live at once. Instead the parser walks the original string with
 * `indexOf('\n')`, slices exactly one line at a time, consumes it and drops it. Retained
 * state is bounded and independent of line count:
 *
 *   - `iterations` — one small object per electronic step (hundreds),
 *   - rows of the **last** force / stress table only (maxForce is defined over the last
 *     table anyway, so a new `TOTAL-FORCE` header discards the previous rows),
 *   - the once-per-run timing and memory tables,
 *   - at most MAX_ERRORS error signatures.
 *
 * One pass, no seeks, so this stays a pure function of its `text` argument.
 *
 * @module abacusflow/host/abacus/log
 */
import { toNum, RY_TO_EV, toLines, warn } from '../shared/numbers.js';

/** Retained error signatures cap (crash loops repeat the same line thousands of times). */
const MAX_ERRORS = 64;
/** Retained rows cap for the auxiliary tables. */
const MAX_TABLE_ROWS = 5000;

/** `#ION MOVE# n #ELEC ITER# m`, with the optional RT-TDDFT `#ELEC PROP#` field. */
const RE_ION_MOVE = /#ION MOVE#\s+(\d+)(?:\s+#ELEC PROP#\s+(\d+))?\s+#ELEC ITER#\s+(\d+)/;
const RE_RHO_DEVIATION = /Electron density deviation\s+([-+0-9.eEdD]+)/;
/** Two-column energy row; the eV column is optional so a truncated row stays usable. */
const RE_ENERGY_ROW = /^\s*(E_KohnSham|E_Harris|E_Fermi|E_gap\(k\))\s+([-+0-9.eEdD]+)(?:\s+([-+0-9.eEdD]+))?/;
const RE_SCF_CONVERGED = /^\s*#SCF IS CONVERGED#/;
const RE_SCF_NOT_CONVERGED = /^\s*!!SCF IS NOT CONVERGED!!/;
const RE_TOTAL_ENERGY = /^\s*#TOTAL ENERGY#\s+([-+0-9.eEdD]+)\s*eV/;
const RE_RELAX_CONVERGED_SCF_NOT = /Relaxation is converged, but the SCF is unconverged/i;
const RE_TOTAL_TIME = /TOTAL\s+Time\s*:/i;
const RE_CALCULATION = /^\s*calculation\b\s*[=:]?\s*([A-Za-z0-9_-]+)/i;
/**
 * ABACUS's fatal banner. `WARNING_QUIT` prints a 57-dash rule, a centred `!NOTICE!`,
 * the message, and a `CHECK IN FILE : .../warning.log` line (`tool_quit.cpp:96,123`),
 * then finalises MPI and exits. This is the in-band abort signal in v3.9.
 */
const RE_NOTICE = /^\s*!NOTICE!\s*$/;
const RE_EXX_NOT_CONVERGED = /!!EXX IS NOT CONVERGED!!/i;
const RE_RELAX_CONVERGED = /^\s*Relaxation is converged!\s*$/;
const RE_RELAX_NOT_CONVERGED = /Relaxation is not converged yet/;
const RE_ION_NOT_CONVERGED = /Ion relaxation is not converged yet/;
const RE_GEOM_CONVERGED = /Geometry relaxation is converged!/;
const RE_GEOM_NOT_CONVERGED = /Geometry relaxation is not converged/;
/** `TOTAL-FORCE (eV/Angstrom)`; `print_force` wraps the name in `#...#`. */
const RE_FORCE_HEADER = /TOTAL-FORCE\s*\(eV\/Angstrom\)/i;
const RE_STRESS_HEADER = /TOTAL-STRESS\s*\(/i;
const RE_DRIFT = /total\s+drift|drift\s*(?:=|:)/i;
const RE_TIME_HEADER = /CLASS_NAME\s+NAME/i;
const RE_MEMORY_HEADER = /NAME\s*-{3,}\|.*MEMORY\(MB\)/i;
const RE_RULE = /^\s*[-=_*]{3,}\s*$/;
const RE_NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:(?:[eEdD])[-+]?\d+)?$/;

/** Labels that are really column titles, never atom labels. */
const NOT_AN_ATOM_LABEL = /^(?:atoms?|label|labels|total|element|species|force_[xyz]|x|y|z)$/i;

/**
 * Machine-fatal signatures. `SCF_NOT_CONVERGED` / `RELAX_CONVERGED_SCF_NOT` are *results*,
 * not crashes, and are recorded separately (CONTRACT.md §6).
 */
const FATAL_SIGNATURES = [
  { code: 'FORRTL_SEVERE', re: /forrtl:\s*(?:severe|error)/i, message: 'Intel Fortran 运行库严重错误（forrtl: severe）' },
  { code: 'SEGFAULT', re: /segmentation fault|SIGSEGV/i, message: '段错误（Segmentation fault）' },
  { code: 'MPI_ABORT', re: /MPI_ABORT|MPI_Abort|MPI_ABORT was invoked|MPI_ERRORS_ARE_FATAL/i, message: 'MPI 中止（MPI_ABORT）' },
  { code: 'BAD_TERMINATION', re: /BAD TERMINATION/i, message: 'MPI 非正常终止（BAD TERMINATION）' },
  { code: 'OUT_OF_MEMORY', re: /std::bad_alloc|\bout of memory\b|oom-kill|cudaErrorMemoryAllocation/i, message: '内存不足（out of memory）' },
  { code: 'TIME_LIMIT', re: /DUE TO TIME LIMIT|time limit exceeded|CANCELLED AT .*DUE TO TIME LIMIT/i, message: '触及作业时限（time limit）' },
];

/** Hard errors: they mean the process died, so the run cannot be trusted or reported done. */
const HARD_ERROR_CODES = new Set([
  'SEGFAULT', 'MPI_ABORT', 'FORRTL_SEVERE', 'BAD_TERMINATION', 'OUT_OF_MEMORY', 'TIME_LIMIT',
  // ABACUS's own fatal path: a 57-dash banner with a centred `!NOTICE!`
  // (`tool_quit.cpp:96,123`). There is no MPI_Abort in v3.9 — this IS the abort.
  'WARNING_QUIT',
]);

/** The only error codes this module is allowed to emit (CONTRACT.md §6). */
export const ABACUS_ERROR_CODES = Object.freeze([
  'SCF_NOT_CONVERGED',
  'RELAX_CONVERGED_SCF_NOT',
  'EXX_NOT_CONVERGED',
  'WARNING_QUIT',
  'SEGFAULT',
  'MPI_ABORT',
  'FORRTL_SEVERE',
  'BAD_TERMINATION',
  'OUT_OF_MEMORY',
  'TIME_LIMIT',
]);

/** Status labels, Chinese (CONTRACT.md §6). */
const STATUS_LABELS = Object.freeze({
  NO_OUTPUT: '未开始',
  RUNNING: '运行中',
  FINISHED: '已完成',
  FINISHED_UNCONVERGED: '完成但未收敛',
  ERROR: '出错',
});

/**
 * Walk `text` one line at a time without building the full line array.
 * CRLF and a trailing CR are stripped. `visit` may return `false` to stop.
 *
 * `visit` receives `(line, index, nextOffset)` where `nextOffset` is the character
 * offset of the following line — enough for a bounded look-ahead into the original
 * string without materialising it.
 */
function scanLines(text, visit) {
  const n = text.length;
  let start = 0;
  let index = 0;
  while (start <= n) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = n;
    let stop = end;
    if (stop > start && text.charCodeAt(stop - 1) === 13) stop -= 1;
    const nextOffset = end === n ? n : end + 1;
    if (visit(text.slice(start, stop), index, nextOffset) === false) return;
    index += 1;
    if (end === n) return;
    start = end + 1;
  }
}

/**
 * Parse one force-table row.
 *
 * Two layouts exist and both must work:
 *   - ABACUS v3.9 `print_force` (`%8s` + 3 x `%20.10f`): `<label> <fx> <fy> <fz>`,
 *     label = element + 1-based index (`H1`, `Si2`);
 *   - the wide layout quoted in SPEC.md §1.5: `<label> <x> <y> <z> <fx> <fy> <fz>`.
 *
 * In both, the **last three** numbers are the force.
 * @returns {{ label:string, fx:number, fy:number, fz:number } | null}
 */
function parseForceRow(line) {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length !== 4 && tokens.length < 7) return null;
  const label = tokens[0];
  if (!/^[A-Za-z]/.test(label) || NOT_AN_ATOM_LABEL.test(label)) return null;
  for (let i = 1; i < tokens.length; i += 1) {
    if (!RE_NUMBER.test(tokens[i])) return null;
  }
  const fx = toNum(tokens[tokens.length - 3]);
  const fy = toNum(tokens[tokens.length - 2]);
  const fz = toNum(tokens[tokens.length - 1]);
  if (fx === null || fy === null || fz === null) return null;
  return { label, fx, fy, fz };
}

/**
 * Parse one stress-table row: three bare numbers (`print_stress` prints no row label),
 * or four tokens when a build prefixes the row with a name.
 * @returns {{ label:string, values:number[] } | null}
 */
function parseStressRow(line) {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length === 3) {
    const values = tokens.map(toNum);
    if (values.some((v) => v === null)) return null;
    return { label: '', values };
  }
  if (tokens.length === 4 && !NOT_AN_ATOM_LABEL.test(tokens[0]) && /^[A-Za-z]/.test(tokens[0])) {
    const values = tokens.slice(1).map(toNum);
    if (values.some((v) => v === null)) return null;
    return { label: tokens[0], values };
  }
  return null;
}

/**
 * Parse one timing row of `CLASS_NAME NAME TIME/s CALLS AVG/s PER/%`.
 * Both name columns may be empty or contain spaces, so the four trailing numeric
 * columns are located from the right.
 * @returns {{ name:string, calls:number, seconds:number, percent:number } | null}
 */
function parseTimingRow(line) {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length < 5) return null;
  const [secondsT, callsT, avgT, percentT] = tokens.slice(-4);
  const seconds = toNum(secondsT);
  const calls = toNum(callsT);
  const avg = toNum(avgT);
  const percent = toNum(percentT);
  if (seconds === null || calls === null || avg === null || percent === null) return null;
  const name = tokens.slice(0, tokens.length - 4).join(' ').trim();
  if (!name) return null;
  return { name, calls: Math.trunc(calls), seconds, percent };
}

/** One memory row: `<name> <MB>`. */
function parseMemoryRow(line) {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length < 2) return null;
  const mb = toNum(tokens[tokens.length - 1]);
  if (mb === null) return null;
  const name = tokens.slice(0, tokens.length - 1).join(' ').trim();
  if (!name) return null;
  return { name, mb };
}

/**
 * Status code from already-extracted facts. Shared with `classifyAbacusRun` so a log and
 * its classification can never disagree.
 * @returns {'NO_OUTPUT'|'RUNNING'|'FINISHED'|'FINISHED_UNCONVERGED'|'ERROR'}
 */
function deriveCode(facts) {
  if (!facts.hasContent) return 'NO_OUTPUT';
  if (facts.hardError) return 'ERROR';
  if (facts.finished) {
    if (facts.scfNotConverged || facts.ionicConvergedScfNot || facts.scfConverged === false) {
      return 'FINISHED_UNCONVERGED';
    }
    return 'FINISHED';
  }
  return 'RUNNING';
}

/**
 * Parse an ABACUS main log.
 *
 * @param {string} text
 * @returns {{
 *   calculation: string|null,
 *   code: 'NO_OUTPUT'|'RUNNING'|'FINISHED'|'FINISHED_UNCONVERGED'|'ERROR',
 *   iterations: Array<{
 *     ionicStep:number, scfIter:number, rhoDeviation:number|null,
 *     eKohnShamRy:number|null, eKohnShamEv:number|null,
 *     eHarrisEv:number|null, eFermiEv:number|null, gapEv:number|null
 *   }>,
 *   scfConverged: boolean|null,
 *   scfNotConverged: boolean,
 *   ionicConvergedScfNot: boolean,
 *   lastTotalEnergyEv: Array<{ ionicStep:number, energyEv:number }>,
 *   forces: Array<{ label:string, fx:number, fy:number, fz:number }>,
 *   maxForce: number|null,
 *   stress: Array<{ label:string, values:number[] }>,
 *   finished: boolean,
 *   timings: Array<{ name:string, calls:number, seconds:number, percent:number }>,
 *   memory: Array<{ name:string, mb:number }>,
 *   errors: Array<{ code:string, message:string, evidence:string }>,
 *   warnings: string[]
 * }}
 */
export function parseScfLog(text) {
  const warnings = [];
  const source = text === null || text === undefined ? '' : String(text);

  const iterations = [];
  const lastTotalEnergyEv = [];
  const errors = [];
  const timings = [];
  const memory = [];
  let forces = [];
  let stress = [];

  let calculation = null;
  let code = null;
  let scfConverged = null;
  let scfNotConverged = false;
  let ionicConvergedScfNot = false;
  let exxNotConverged = false;
  let ionicConverged = null;
  let finished = false;
  let hardError = false;
  let sawContent = false;
  let forceUnit = null;
  let stressUnit = null;
  let pressure = null;

  /** The iteration currently being accumulated. */
  let current = null;
  let lastIonicStep = 1;
  let implicitIter = 0;

  let forceMode = false;
  let forceBlanks = 0;
  let stressMode = false;
  let stressBlanks = 0;
  let timingMode = false;
  let memoryMode = false;

  const pushError = (code, message, evidence) => {
    if (errors.length >= MAX_ERRORS) return;
    const line = String(evidence ?? '').trim().slice(0, 300);
    if (errors.some((e) => e.code === code && e.evidence === line)) return;
    errors.push({ code, message, evidence: line });
  };

  const flush = () => {
    if (!current) return;
    const it = current;
    current = null;
    if (
      it.rhoDeviation !== null ||
      it.eKohnShamEv !== null ||
      it.eHarrisEv !== null ||
      it.eFermiEv !== null ||
      it.gapEv !== null
    ) {
      iterations.push(it);
    }
  };

  const begin = (ionicStep, scfIter) => {
    flush();
    current = {
      ionicStep,
      scfIter,
      rhoDeviation: null,
      eKohnShamRy: null,
      eKohnShamEv: null,
      eHarrisEv: null,
      eFermiEv: null,
      gapEv: null,
    };
  };

  /** Current iteration, started implicitly when the log has no `#ION MOVE#` header. */
  const active = () => {
    if (current) return current;
    implicitIter += 1;
    begin(lastIonicStep, implicitIter);
    return current;
  };

  try {
    scanLines(source, (line, index, nextOffset) => {
      if (!sawContent && line.trim() !== '') sawContent = true;

      // ---- table sections are consumed before the generic row matching, because a
      // ---- stress row (3 numbers) and a force row can otherwise be confused.
      if (timingMode) {
        if (line.trim() === '') return;
        if (RE_RULE.test(line)) {
          if (timings.length > 0) timingMode = false;
          return;
        }
        const row = parseTimingRow(line);
        if (row) {
          if (timings.length < MAX_TABLE_ROWS) timings.push(row);
          return;
        }
        timingMode = false; // header noise ended the table; reinterpret the line below
      }

      if (memoryMode) {
        if (/has been ignored/i.test(line) || RE_RULE.test(line)) {
          memoryMode = false;
          return;
        }
        if (line.trim() === '') return;
        const row = parseMemoryRow(line);
        if (row) {
          if (memory.length < MAX_TABLE_ROWS) memory.push(row);
          return;
        }
        memoryMode = false;
      }

      if (forceMode) {
        if (line.trim() === '') {
          forceBlanks += 1;
          if (forceBlanks >= 2 && forces.length > 0) forceMode = false;
          return;
        }
        forceBlanks = 0;
        if (RE_RULE.test(line)) {
          if (forces.length > 0) forceMode = false;
          return; // the FmtTable frame before the data
        }
        if (RE_DRIFT.test(line)) {
          forceMode = false;
          return;
        }
        const row = parseForceRow(line);
        if (row) {
          if (forces.length < MAX_TABLE_ROWS) forces.push(row);
          return;
        }
        // Column titles (`Atoms Force_x Force_y Force_z`) are tolerated; anything else
        // ends the table.
        if (forces.length > 0 || !/force|atoms?\b|x\s+y\s+z/i.test(line)) forceMode = false;
        return;
      }

      if (stressMode) {
        if (line.trim() === '') {
          stressBlanks += 1;
          if (stressBlanks >= 2 && stress.length > 0) stressMode = false;
          return;
        }
        stressBlanks = 0;
        if (RE_RULE.test(line)) {
          if (stress.length > 0) stressMode = false;
          return;
        }
        if (/TOTAL-PRESSURE/i.test(line)) {
          // End the tensor and fall through so the pressure value itself is captured.
          stressMode = false;
        } else {
          const row = parseStressRow(line);
          if (row) {
            if (stress.length === 0 && row.label === '') {
              // ABACUS prints one row per tensor component, in x/y/z order.
              row.label = ['x', 'y', 'z'][stress.length] ?? String(stress.length + 1);
            }
            if (stress.length < MAX_TABLE_ROWS) stress.push(row);
            return;
          }
          if (stress.length > 0 || !/stress|kbar/i.test(line)) stressMode = false;
          return;
        }
      }

      const trimmed = line.trim();
      if (trimmed === '') return;

      // ---- table section headers
      if (RE_TIME_HEADER.test(line)) {
        timingMode = true;
        return;
      }
      if (RE_MEMORY_HEADER.test(line)) {
        memoryMode = true;
        return;
      }
      if (RE_FORCE_HEADER.test(line)) {
        // Only the last force table is exposed; drop the previous ionic step's rows.
        forces = [];
        forceMode = true;
        forceBlanks = 0;
        // The title carries the unit: ` #TOTAL-FORCE (eV/Angstrom)#` or the PW variant
        // `   TOTAL-FORCE (Ry/Bohr)`.
        const unit = /TOTAL-FORCE\s*\(([^)]*)\)/i.exec(line);
        forceUnit = unit ? unit[1].trim() : null;
        return;
      }
      if (RE_STRESS_HEADER.test(line)) {
        stress = [];
        stressMode = true;
        stressBlanks = 0;
        const unit = /TOTAL-STRESS\s*\(([^)]*)\)/i.exec(line);
        stressUnit = unit ? unit[1].trim() : null;
        return;
      }
      // ` #TOTAL-PRESSURE# (EXCLUDE KINETIC PART OF IONS): 3.4482 kbar`
      if (/TOTAL-PRESSURE/i.test(line)) {
        const press = /:\s*([-+0-9.eEdD]+)\s*(\S+)?\s*$/.exec(line);
        if (press) {
          const value = toNum(press[1]);
          if (value !== null) pressure = { value, unit: (press[2] ?? stressUnit ?? 'kbar').trim() };
        }
        return;
      }

      // ---- run-level verdicts and terminators
      if (RE_TOTAL_TIME.test(line)) {
        finished = true;
        return;
      }
      if (RE_SCF_NOT_CONVERGED.test(line)) {
        scfNotConverged = true;
        scfConverged = false;
        pushError('SCF_NOT_CONVERGED', '电子步未收敛（!!SCF IS NOT CONVERGED!!）', line);
        return;
      }
      if (RE_SCF_CONVERGED.test(line)) {
        scfConverged = true;
        return;
      }
      if (RE_EXX_NOT_CONVERGED.test(line)) {
        exxNotConverged = true;
        pushError('EXX_NOT_CONVERGED', 'EXX 自洽未收敛（!!EXX IS NOT CONVERGED!!）', line);
        return;
      }
      // ABACUS's fatal banner. The message is on the following lines, so capture the
      // next few non-blank, non-rule lines as evidence.
      if (RE_NOTICE.test(line)) {
        const evidence = [];
        // Look ahead in the original text, not in a materialised line array.
        const tail = source.slice(nextOffset, nextOffset + 1200);
        for (const candidate of tail.split(/\r\n|\n|\r/).slice(1)) {
          const text = candidate.trim();
          if (text === '' || /^[-=]{5,}$/.test(text) || text === 'NOTICE') continue;
          evidence.push(text);
          if (evidence.length >= 4) break;
        }
        pushError('WARNING_QUIT', evidence[0] || 'ABACUS 主动中止（WARNING_QUIT）', evidence.join(' | ') || line);
        hardError = true;
        return;
      }
      if (RE_RELAX_CONVERGED.test(line)) {
        ionicConverged = true;
        return;
      }
      if (RE_RELAX_NOT_CONVERGED.test(line) || RE_ION_NOT_CONVERGED.test(line)) {
        ionicConverged = false;
        return;
      }
      if (RE_GEOM_CONVERGED.test(line)) {
        ionicConverged = true;
        return;
      }
      if (RE_GEOM_NOT_CONVERGED.test(line)) {
        ionicConverged = false;
        return;
      }
      if (RE_RELAX_CONVERGED_SCF_NOT.test(line)) {
        ionicConvergedScfNot = true;
        pushError('RELAX_CONVERGED_SCF_NOT', '离子步收敛但电子步未收敛，结果不可靠', line);
        return;
      }
      if (RE_TOTAL_ENERGY.test(line)) {
        const energyEv = toNum(RE_TOTAL_ENERGY.exec(line)[1]);
        if (energyEv === null) {
          warn(warnings, `无法解析 #TOTAL ENERGY# 行：${trimmed}`);
        } else {
          lastTotalEnergyEv.push({ ionicStep: current ? current.ionicStep : lastIonicStep, energyEv });
        }
        return;
      }

      // ---- per-iteration block
      const ion = RE_ION_MOVE.exec(line);
      if (ion) {
        lastIonicStep = Number(ion[1]);
        begin(lastIonicStep, Number(ion[3]));
        return;
      }
      const rho = RE_RHO_DEVIATION.exec(line);
      if (rho) {
        const value = toNum(rho[1]);
        if (value === null) warn(warnings, `无法解析 Electron density deviation 行：${trimmed}`);
        else active().rhoDeviation = value;
        return;
      }
      const energy = RE_ENERGY_ROW.exec(line);
      if (energy) {
        const name = energy[1];
        const ry = toNum(energy[2]);
        let ev = energy[3] === undefined ? null : toNum(energy[3]);
        if (ry === null && ev === null) {
          warn(warnings, `无法解析能量行：${trimmed}`);
          return;
        }
        // The eV column is authoritative; only derive it when the column is missing.
        if (ev === null && ry !== null) ev = ry * RY_TO_EV;
        const iter = active();
        if (name === 'E_KohnSham') {
          iter.eKohnShamRy = ry;
          iter.eKohnShamEv = ev;
        } else if (name === 'E_Harris') {
          iter.eHarrisEv = ev;
        } else if (name === 'E_Fermi') {
          iter.eFermiEv = ev;
        } else {
          iter.gapEv = ev;
        }
        return;
      }

      // ---- miscellaneous markers (cheap, after the hot paths)
      if (calculation === null) {
        const calc = RE_CALCULATION.exec(line);
        if (calc) calculation = calc[1];
      }
      if (errors.length < MAX_ERRORS) {
        for (const sig of FATAL_SIGNATURES) {
          if (sig.re.test(line)) {
            hardError = true;
            pushError(sig.code, sig.message, line);
            break;
          }
        }
      }
    });
  } catch (error) {
    warn(warnings, `日志解析中断：${error && error.message ? error.message : String(error)}`);
  }

  flush();

  if (!sawContent) {
    warn(warnings, '日志为空');
  } else if (iterations.length === 0) {
    warn(warnings, '没有找到 SCF 迭代记录（缺少 #ION MOVE# / 能量表）');
  }

  let maxForce = null;
  if (forces.length > 0) {
    let best = 0;
    for (const row of forces) {
      const norm = Math.sqrt(row.fx * row.fx + row.fy * row.fy + row.fz * row.fz);
      if (Number.isFinite(norm) && norm > best) best = norm;
    }
    maxForce = best;
  }

  return {
    calculation,
    code: deriveCode({
      hasContent: sawContent,
      hardError,
      finished,
      scfConverged,
      scfNotConverged,
      ionicConvergedScfNot,
    }),
    iterations,
    scfConverged,
    scfNotConverged,
    ionicConvergedScfNot,
    exxNotConverged,
    ionicConverged,
    lastTotalEnergyEv,
    forces,
    forceUnit,
    maxForce,
    stress,
    stressUnit,
    pressure,
    finished,
    timings,
    memory,
    errors,
    warnings,
  };
}

/** Last non-empty line of the log, trimmed — used as classification evidence. */
function lastLine(text) {
  const lines = toLines(String(text).slice(-8192))
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.length === 0 ? '' : lines[lines.length - 1].slice(0, 200);
}

/**
 * Decide a run's status from filesystem facts plus the main log.
 *
 * Rules (CONTRACT.md §6), in priority order:
 *   1. no `OUT.<suffix>` directory → `NO_OUTPUT`;
 *   2. directory present but no readable `running_*.log` (and no other evidence) →
 *      `NO_OUTPUT`;
 *   3. a hard error signature (`SEGFAULT`, `MPI_ABORT`, `FORRTL_SEVERE`,
 *      `BAD_TERMINATION`, `OUT_OF_MEMORY`, `TIME_LIMIT`) → `ERROR`;
 *   4. `Total  Time  :` present and no unconverged verdict → `FINISHED`;
 *   5. `Total  Time  :` present with `!!SCF IS NOT CONVERGED!!` or the
 *      "Relaxation is converged, but the SCF is unconverged" banner →
 *      `FINISHED_UNCONVERGED`;
 *   6. anything else → `RUNNING`; a stale mtime is reported in `evidence`, never as a
 *      different code, because a missing terminator genuinely cannot distinguish
 *      "still running" from "killed by the scheduler".
 *
 * Rule 3 outranks rule 4 deliberately: a fatal signature means the process died, so a
 * preceding `Total  Time  :` (only reachable if the crash happened after finalisation)
 * must not be reported as a clean finish. In practice the two never co-occur.
 *
 * @param {{ hasOutputDir?:boolean, logText:string|null, logFileName:string|null,
 *           mtimeAgeSeconds:number|null }} input
 * @returns {{ code:'NO_OUTPUT'|'RUNNING'|'FINISHED'|'FINISHED_UNCONVERGED'|'ERROR',
 *             label:string, reason:string, evidence:string[] }}
 */
export function classifyAbacusRun(input) {
  const source = input && typeof input === 'object' ? input : {};
  const hasOutputDir = source.hasOutputDir === true;
  const logText = typeof source.logText === 'string' ? source.logText : null;
  const logFileName = typeof source.logFileName === 'string' && source.logFileName ? source.logFileName : null;
  const age =
    typeof source.mtimeAgeSeconds === 'number' && Number.isFinite(source.mtimeAgeSeconds)
      ? source.mtimeAgeSeconds
      : null;

  if (!hasOutputDir) {
    return {
      code: 'NO_OUTPUT',
      label: STATUS_LABELS.NO_OUTPUT,
      reason: '没有 OUT.<suffix> 输出目录，任务尚未开始',
      evidence: [],
    };
  }

  if (logText === null || logText.trim() === '') {
    return {
      code: 'NO_OUTPUT',
      label: STATUS_LABELS.NO_OUTPUT,
      reason: logFileName
        ? `输出目录存在，但主日志 ${logFileName} 为空或不可读`
        : '输出目录存在，但没有任何 running_*.log 主日志',
      evidence: logFileName ? [`日志文件：${logFileName}`, '输出目录存在'] : ['输出目录存在'],
    };
  }

  const log = parseScfLog(logText);
  const evidence = [];
  if (logFileName) evidence.push(`日志文件：${logFileName}`);
  if (log.calculation) evidence.push(`calculation = ${log.calculation}`);
  if (log.iterations.length > 0) {
    const ionicSteps = new Set(log.iterations.map((it) => it.ionicStep)).size;
    evidence.push(`SCF 记录 ${log.iterations.length} 条，${ionicSteps} 个离子步`);
  } else {
    evidence.push('没有 SCF 迭代记录');
  }
  if (log.scfConverged === true) evidence.push('出现 #SCF IS CONVERGED#');
  if (log.scfNotConverged) evidence.push('出现 !!SCF IS NOT CONVERGED!!');
  if (log.ionicConvergedScfNot) evidence.push('出现 "Relaxation is converged, but the SCF is unconverged"');

  const hardErrors = log.errors.filter((err) => HARD_ERROR_CODES.has(err.code));
  for (const err of hardErrors.slice(0, 4)) evidence.push(`${err.code}：${err.evidence}`);
  if (log.finished) evidence.push('出现 Total  Time  :（运行正常结束）');

  const code = deriveCode({
    hasContent: true,
    hardError: hardErrors.length > 0,
    finished: log.finished,
    scfConverged: log.scfConverged,
    scfNotConverged: log.scfNotConverged,
    ionicConvergedScfNot: log.ionicConvergedScfNot,
  });

  let reason;
  if (code === 'ERROR') {
    reason = `日志出现致命错误签名（${hardErrors.map((err) => err.code).join('、')}）`;
  } else if (code === 'FINISHED_UNCONVERGED') {
    reason = log.ionicConvergedScfNot
      ? '离子步收敛但电子步未收敛：结果不可靠'
      : '运行正常结束，但电子步未收敛（!!SCF IS NOT CONVERGED!!）';
  } else if (code === 'FINISHED') {
    reason =
      log.scfConverged === true
        ? '运行正常结束（Total  Time  :）且电子步已收敛'
        : '运行正常结束（Total  Time  :），日志未记录收敛结论';
  } else {
    reason = '日志中没有 Total  Time  : 结束标记，任务可能仍在运行或被中断';
  }

  if (code === 'RUNNING') {
    if (age === null) {
      evidence.push('无法读取日志修改时间');
    } else if (age < 600) {
      evidence.push(`日志 ${Math.max(0, Math.round(age))} 秒前仍在更新`);
    } else {
      evidence.push(`日志已 ${(age / 3600).toFixed(1)} 小时未更新（可能是被中断的旧日志，但缺少终止标记）`);
    }
    const tail = lastLine(logText);
    if (tail) evidence.push(`日志末行：${tail}`);
  }

  return { code, label: STATUS_LABELS[code] ?? '未知', reason, evidence };
}

/**
 * The markers this classifier decides on, for the per-stage diagnosis (lib/host/diagnose.js),
 * which quotes the lines that matched them with their line numbers. Read-only views of the
 * constants above, so the diagnosis can never disagree with the classifier about a pattern.
 */
export const ABACUS_LOG_MARKERS = Object.freeze({
  fatal: Object.freeze(FATAL_SIGNATURES.map((sig) => Object.freeze({ ...sig }))),
  notice: RE_NOTICE,
  scfConverged: RE_SCF_CONVERGED,
  scfNotConverged: RE_SCF_NOT_CONVERGED,
  exxNotConverged: RE_EXX_NOT_CONVERGED,
  relaxConvergedScfNot: RE_RELAX_CONVERGED_SCF_NOT,
  totalTime: RE_TOTAL_TIME,
});
