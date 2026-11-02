/**
 * Filesystem helpers shared by every host module.
 *
 * All functions are defensive: a missing path, a permission error or a broken symlink
 * returns a sentinel instead of throwing. Callers decide what a sentinel means.
 *
 * Paths may be Windows (`C:\x\y`), Linux (`/x/y`) or a UNC share
 * (`\\wsl$\Ubuntu2204\home\...`). Nothing here assumes a separator.
 */
import { promises as fsp, statSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep, normalize } from 'node:path';

/** Normalize a relative path to forward slashes with no leading/trailing slash. */
export function normalizeRel(p) {
  const s = String(p ?? '').replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '');
  return s === '.' ? '' : s;
}

/**
 * Resolve `rel` under `rootAbs` and refuse to escape it.
 * @returns {{ abs: string, rel: string }}
 */
export function resolveInside(rootAbs, rel) {
  const root = resolve(rootAbs);
  const target = resolve(root, normalizeRel(rel) || '.');
  const relPath = relative(root, target);
  if (relPath !== '' && (isAbsolute(relPath) || relPath === '..' || relPath.startsWith(`..${sep}`))) {
    throw new Error(`path escapes root: ${rel}`);
  }
  return { abs: target, rel: normalizeRel(relPath) };
}

export function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** @returns {{ size:number, mtimeMs:number, isDir:boolean } | null} */
export function safeStat(p) {
  try {
    const st = statSync(p);
    return { size: st.size, mtimeMs: st.mtimeMs, isDir: st.isDirectory() };
  } catch {
    return null;
  }
}

/**
 * Read at most `maxBytes` of a UTF-8 text file.
 * @returns {{ text:string, truncated:boolean } | null}
 */
export function readTextCapped(p, maxBytes = 8 * 1024 * 1024) {
  let fd = null;
  try {
    const st = statSync(p);
    if (!st.isFile()) return null;
    fd = openSync(p, 'r');
    const want = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(want);
    const read = readSync(fd, buf, 0, want, 0);
    return { text: buf.toString('utf8', 0, read), truncated: st.size > maxBytes };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Read a whole text file, or null when unreadable. */
export function readAllText(p) {
  const got = readTextCapped(p, Number.MAX_SAFE_INTEGER);
  return got ? got.text : null;
}

/**
 * Synchronous directory listing.
 *
 * Same rule as the async version: no per-entry `stat` unless `withStats` is asked for.
 * A directory holding 1473 files costs 1473 network round trips otherwise, which is the
 * single largest cost in a scan over a UNC path.
 *
 * @param {string} p
 * @param {{ withStats?: boolean }} [options]
 * @returns {Array<{ name:string, isDir:boolean, size:number|null, mtimeMs:number|null }> | null}
 */
export function listDir(p, options = {}) {
  const withStats = options.withStats === true;
  let dirents;
  try {
    dirents = readdirSync(p, { withFileTypes: true });
  } catch {
    return null;
  }
  const out = [];
  for (const d of dirents) {
    if (!withStats) {
      out.push({ name: d.name, isDir: d.isDirectory(), size: null, mtimeMs: null });
      continue;
    }
    const st = safeStat(resolve(p, d.name));
    out.push({
      name: d.name,
      isDir: st ? st.isDir : d.isDirectory(),
      size: st ? st.size : 0,
      mtimeMs: st ? st.mtimeMs : 0,
    });
  }
  out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return out;
}

/**
 * Async directory listing; preferred for UNC paths and deep scans.
 *
 * **Do not stat per entry by default.** On a network path (`\\wsl$\...`, an SMB share)
 * every `stat` is a round trip, so a directory with N files costs N x latency: one real
 * ABACUS `OUT.*` folder here holds 1473 files, and statting each took 30 s for a single
 * directory. `readdir` with `withFileTypes` already tells us the entry type from the
 * directory enumeration, which is all the scanner needs.
 *
 * Pass `withStats: true` only where size/mtime are genuinely required (a single task's
 * own file list), where the cost is bounded by that one directory.
 *
 * @param {string} p
 * @param {{ withStats?: boolean }} [options]
 * @returns {Promise<Array<{ name:string, isDir:boolean, size:number|null, mtimeMs:number|null }> | null>}
 */
export async function listDirAsync(p, options = {}) {
  const withStats = options.withStats === true;
  let dirents;
  try {
    dirents = await fsp.readdir(p, { withFileTypes: true });
  } catch {
    return null;
  }

  if (!withStats) {
    return dirents
      .map((d) => ({
        name: d.name,
        isDir: d.isDirectory(),
        // `null` means "not asked for" — distinct from a real zero-byte file.
        size: null,
        mtimeMs: null,
      }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  }

  const out = [];
  for (const d of dirents) {
    const full = resolve(p, d.name);
    let isDir = d.isDirectory();
    let size = 0;
    let mtimeMs = 0;
    try {
      const st = await fsp.stat(full);
      isDir = st.isDirectory();
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      /* dangling entry: keep the name */
    }
    out.push({ name: d.name, isDir, size, mtimeMs });
  }
  out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return out;
}

/**
 * Size and mtime of every file in one directory, in a single parallel burst.
 *
 * Used for the file browser, where the user expects sizes but the directory is one task's
 * own (tens of files), so a bounded fan-out is fine. Never call this during a tree scan.
 *
 * @param {string} p
 * @param {number} [concurrency]
 * @returns {Promise<Map<string, { size:number, mtimeMs:number }> | null>}
 */
export async function statFilesParallel(p, concurrency = 16) {
  let dirents;
  try {
    dirents = await fsp.readdir(p, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = dirents.filter((d) => d.isFile());
  const out = new Map();
  let cursor = 0;
  const workers = new Array(Math.min(concurrency, files.length)).fill(null).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= files.length) return;
      const d = files[index];
      try {
        const st = await fsp.stat(resolve(p, d.name));
        out.set(d.name, { size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        out.set(d.name, { size: 0, mtimeMs: 0 });
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/** Join path fragments to a forward-slash relative path. */
export function joinRel(...parts) {
  return normalize(parts.filter((x) => x !== undefined && x !== null && x !== '').join('/')).replace(/\\/g, '/');
}

/** True when `childAbs` is inside (or equal to) `parentAbs`. */
export function containsPath(parentAbs, childAbs) {
  const rel = relative(resolve(parentAbs), resolve(childAbs));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Convert `mtimeMs` to an age in seconds. */
export function ageSeconds(mtimeMs, now = Date.now()) {
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs) || mtimeMs <= 0) return null;
  return Math.max(0, (now - mtimeMs) / 1000);
}

/** Stable short id from a relative path (for task ids). */
export function pathId(prefix, rel) {
  const body = normalizeRel(rel).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return `${prefix}-${body || 'root'}`;
}
