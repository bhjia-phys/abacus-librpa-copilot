/**
 * Nearest `research.md` above a calculation directory.
 *
 * AITP marks a research topic with a `research.md` file and exposes no service another
 * plugin can call, so the only honest link the panel can draw between a run and a topic is
 * a file it can see. This walks up from the task directory and reports the first
 * `research.md` it meets, how many levels up it was, and the note's first heading — nothing
 * more. The panel labels the result as inferred from the directory tree.
 *
 * Read-only and cheap: at most `maxLevels + 1` stats, plus the first 4 KiB of the note.
 *
 * @module abacusflow/host/research-context
 */
import { dirname, join } from 'node:path';
import { readTextCapped, safeStat } from './shared/paths.js';

/** A topic note is never far above its runs; stop before wandering the whole drive. */
export const MAX_LEVELS = 8;

/**
 * First Markdown heading of a note, used as its display title.
 * @param {string} text
 * @returns {string|null}
 */
export function firstHeading(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) return m[1].trim().slice(0, 120);
  }
  return null;
}

/**
 * @param {string} startDir absolute directory to start from (checked first)
 * @param {{ maxLevels?: number, fileName?: string }} [options]
 * @returns {{ found:boolean, path:string|null, dir:string|null, levelsUp:number|null,
 *             title:string|null, searched:number }}
 */
export function findResearchContext(startDir, options = {}) {
  if (!startDir) throw new Error('findResearchContext: startDir is required');
  const maxLevels = options.maxLevels ?? MAX_LEVELS;
  const fileName = options.fileName ?? 'research.md';
  let dir = startDir;
  for (let level = 0; level <= maxLevels; level += 1) {
    const candidate = join(dir, fileName);
    const stat = safeStat(candidate);
    if (stat && !stat.isDir) {
      const head = readTextCapped(candidate, 4096);
      return {
        found: true,
        path: candidate,
        dir,
        levelsUp: level,
        title: firstHeading(head ? head.text : ''),
        searched: level + 1,
      };
    }
    const parent = dirname(dir);
    if (!parent || parent === dir) {
      return { found: false, path: null, dir: null, levelsUp: null, title: null, searched: level + 1 };
    }
    dir = parent;
  }
  return { found: false, path: null, dir: null, levelsUp: null, title: null, searched: maxLevels + 1 };
}
