/**
 * In-memory task store.
 *
 * The panel and the agent tools must see the same numbers, so both read through this
 * one store. It holds, per scan root, the last scan result; per task, the last parsed
 * bundle (invalidated when the underlying files change).
 *
 * Nothing here is persisted: a task id is only meaningful inside one host process, which
 * is why every tool also accepts `rootPath + relPath`.
 */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeRel } from './shared/paths.js';

/** Files whose (size, mtime) makes a cached parse stale. */
function stampOf(paths) {
  const parts = [];
  for (const p of paths) {
    try {
      const st = statSync(p);
      parts.push(`${st.size}:${Math.trunc(st.mtimeMs)}`);
    } catch {
      parts.push('-');
    }
  }
  return parts.join('|');
}

export class TaskStore {
  constructor({ ttlMs = 60_000, bundleTtlMs = 15_000, maxBundles = 40 } = {}) {
    /** @type {Map<string, { at:number, root:string, data:object }>} */
    this.scans = new Map();
    /** @type {Map<string, { at:number, stamp:string, data:object }>} */
    this.bundles = new Map();
    this.ttlMs = ttlMs;
    this.bundleTtlMs = bundleTtlMs;
    this.maxBundles = maxBundles;
    this.version = 0;
  }

  /** Record a scan result for a root. */
  putScan(rootPath, data) {
    this.scans.set(resolve(String(rootPath)), { at: Date.now(), root: resolve(String(rootPath)), data });
    this.version += 1;
    return data;
  }

  /** @returns {object|null} */
  getScan(rootPath, ttlMs = this.ttlMs) {
    const hit = this.scans.get(resolve(String(rootPath)));
    if (!hit) return null;
    if (Date.now() - hit.at > ttlMs) return null;
    return hit.data;
  }

  /** Locate a task by id across every cached scan. @returns {object|null} */
  taskById(taskId) {
    for (const { data } of this.scans.values()) {
      const found = (data.tasks ?? []).find((t) => t.id === taskId || t.relPath === taskId);
      if (found) return found;
    }
    return null;
  }

  /**
   * Cache a parsed bundle keyed by task id, invalidated by its source file stamps.
   * @param {string} taskId
   * @param {string} stamp identity of the underlying files
   */
  putBundle(taskId, stamp, data) {
    this.bundles.set(taskId, { at: Date.now(), stamp, data });
    if (this.bundles.size > this.maxBundles) {
      const oldest = [...this.bundles.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.bundles.delete(oldest[0]);
    }
    this.version += 1;
    return data;
  }

  /** @returns {object|null} */
  getBundle(taskId, stamp, ttlMs = this.bundleTtlMs) {
    const hit = this.bundles.get(taskId);
    if (!hit) return null;
    if (hit.stamp !== stamp) return null;
    if (Date.now() - hit.at > ttlMs) return null;
    return hit.data;
  }

  /** Identity of a task's source files, used as the bundle cache key. */
  static stampFor(task) {
    const names = ['INPUT', 'STRU', 'KPT', 'librpa.in'];
    const base = task.absPath;
    const paths = names.map((n) => `${base}/${n}`);
    if (task.outputDir) {
      const outDir = `${base}/${task.outputDir}`;
      paths.push(
        `${outDir}/INPUT.info`,
        `${outDir}/running_scf.log`,
        `${outDir}/running_relax.log`,
        `${outDir}/running_md.log`,
        `${outDir}/running_cell-relax.log`,
        `${outDir}/warning.log`,
      );
    }
    paths.push(`${base}/librpa.out`, `${base}/librpa.err`, `${base}/librpa.exitcode`);
    return stampOf(paths);
  }

  clear() {
    this.scans.clear();
    this.bundles.clear();
    this.version += 1;
  }
}

export { normalizeRel };
