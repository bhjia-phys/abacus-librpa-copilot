/**
 * ABACUS `OUT.<suffix>/INPUT.info`.
 *
 * ABACUS echoes the *resolved* INPUT here: every keyword with the value it actually used,
 * after defaults, `kspacing` expansion and unit conversion (`ReadInput::write_txt_input` in
 * `source_io/module_parameter/read_input.cpp`). That makes it a far better source than the
 * user's INPUT, which may set nothing at all and rely entirely on defaults.
 *
 * The writer emits:
 *
 *     INPUT_PARAMETERS
 *     #Parameters (1.System)
 *     suffix                         autotest #the name of main output directory
 *     ntype                          1 #atom species number
 *     ...
 *     bessel_nao_rcut                 #radial cutoff for spherical bessel functions(a.u.)
 *
 * i.e. `keyword <spaces> value` with the keyword's own annotation appended as a trailing
 * `#` comment, and the whole value column **empty** for keywords without a value. Because
 * `write_txt_input` also writes the annotation for an empty value, a line can end right at
 * a comment: a naive `keyword whitespace rest` split then mistakes the comment for the
 * value. That case is handled explicitly below.
 *
 * Three shapes are accepted so that forks and older versions parse too:
 *
 *     keyword = value        (also `keyword=value`)
 *     keyword   value
 *     [keyword] [value]      (bracketed, one or both fields)
 *
 * Separator lines (`-----`, `=====`, `+++++`, `|||||`) and banner lines are ignored.
 *
 * @module abacusflow/host/abacus/input-info
 */
import { toLines, warn } from '../shared/numbers.js';

/** A whole line of only separator characters. */
const SEPARATOR = /^[-=+*_~#|/\\\s]+$/;

/** Lines that carry no key/value pair: banners and framed section headers. */
const BANNER = /^(INPUT_PARAMETERS|INPUT\s+FILE|Parameters\s*\()/i;

/**
 * Parse INPUT.info.
 *
 * Never throws on content.
 *
 * @param {string} text
 * @returns {{
 *   params: Record<string,string>,
 *   entries: Array<{ key:string, value:string, comment:string, line:number }>,
 *   brackets: number,
 *   emptyValues: string[],
 *   sections: Array<{ title:string, line:number }>,
 *   warnings: string[]
 * }}
 */
export function parseInputInfo(text) {
  const params = Object.create(null);
  const entries = [];
  const warnings = [];
  const emptyValues = [];
  const sections = [];
  let brackets = 0;

  const lines = toLines(text);

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    if (SEPARATOR.test(trimmed)) continue;

    // Section headers written as `#Parameters (1.System)`: remember them, they group the
    // panel, but they are not parameters.
    if (trimmed.startsWith('#')) {
      const title = trimmed.replace(/^#+\s*/, '').trim();
      if (/^Parameters\b/i.test(title)) sections.push({ title, line: i + 1 });
      continue;
    }
    if (BANNER.test(trimmed)) continue;

    let key = null;
    let rest = '';

    // ---- shape 1: `[keyword] [value]` ------------------------------------
    const bracketed = /^\[([^\]]*)\]\s*(.*)$/.exec(trimmed);
    if (bracketed) {
      brackets += 1;
      key = bracketed[1].trim();
      rest = bracketed[2].trim();
      // A second bracket pair holds the value when present.
      const second = /^\[([^\]]*)\]\s*$/.exec(rest);
      if (second) rest = second[1].trim();
    } else {
      // ---- shape 2: `keyword = value` ------------------------------------
      const eq = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
      if (eq) {
        key = eq[1];
        rest = eq[2];
      } else {
        // ---- shape 3: `keyword   value` ----------------------------------
        const split = /^([A-Za-z_][A-Za-z0-9_]*)\b\s*(.*)$/.exec(trimmed);
        if (split) {
          key = split[1];
          rest = split[2];
        }
      }
    }

    if (key === null || key === '') {
      warn(warnings, `第 ${i + 1} 行无法解析：${trimmed.slice(0, 100)}`);
      continue;
    }

    // ---- split value from the trailing annotation ------------------------
    // The annotation is the keyword's own text, so it must not become the value.
    let value = rest;
    let comment = '';
    const hash = value.search(/[#!]/);
    if (hash >= 0) {
      comment = value.slice(hash + 1).trim();
      value = value.slice(0, hash);
    }
    value = value.trim();

    const normalisedKey = key.toLowerCase();
    if (value === '') emptyValues.push(normalisedKey);
    params[normalisedKey] = value;
    entries.push({ key, value, comment, line: i + 1 });
  }

  if (entries.length === 0) warn(warnings, 'INPUT.info 没有解析到任何参数');

  return { params, entries, brackets, emptyValues, sections, warnings };
}

/** Case-insensitive lookup in an INPUT.info `params` map. @returns {string|undefined} */
export function infoParam(params, name) {
  if (!params) return undefined;
  const lower = String(name).toLowerCase();
  if (lower in params) return params[lower];
  for (const key of Object.keys(params)) if (key.toLowerCase() === lower) return params[key];
  return undefined;
}
