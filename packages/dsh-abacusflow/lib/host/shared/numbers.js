/**
 * Number parsing shared by all parsers.
 *
 * Fortran writes doubles as `1.23D+02`, ABACUS mixes `E` and `D` exponents, and log
 * columns sometimes carry stray asterisks (overflow) or `NaN`.
 */

const NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:(?:[eEdD])[-+]?\d+)?$/;

/**
 * Parse a numeric token, tolerating `D` exponents and surrounding punctuation.
 * @returns {number|null} null when the token is not a finite number
 */
export function toNum(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  if (typeof text !== 'string') return null;
  const s = text.trim().replace(/[dD]/, 'e');
  if (s === '' || s === '-' || s === '+') return null;
  if (!NUMBER_RE.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

/** Parse the first numeric token in a string. @returns {number|null} */
export function firstNum(text) {
  if (typeof text !== 'string') return null;
  const m = /[-+]?(?:\d+\.?\d*|\.\d+)(?:(?:[eEdD])[-+]?\d+)?/.exec(text);
  return m ? toNum(m[0]) : null;
}

/** Ry -> eV (CODATA 2018: 1 Ry = 13.605693122994 eV). */
export const RY_TO_EV = 13.605693122994;

/** Bohr -> Angstrom (CODATA 2018). */
export const BOHR_TO_ANG = 0.529177210903;

export function ryToEv(ry) {
  return typeof ry === 'number' && Number.isFinite(ry) ? ry * RY_TO_EV : null;
}

export function bohrToAng(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x * BOHR_TO_ANG : null;
}

/** Round to `digits` decimals, keeping null. */
export function round(v, digits = 6) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Human string for an energy in eV, or an em dash. */
export function fmtEv(v, digits = 6) {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(digits)} eV` : '—';
}

/** Push a warning only when the message is non-empty (keeps arrays clean). */
export function warn(list, message) {
  if (message) list.push(String(message));
  return list;
}

/** Split a block of text into lines, tolerating CRLF and CR. */
export function toLines(text) {
  return String(text ?? '').split(/\r\n|\n|\r/);
}
