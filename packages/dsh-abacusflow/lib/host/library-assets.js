/**
 * On-demand access to the LibRPA-database assets hosted on Hugging Face.
 *
 * ## Why the repository is not cloned
 *
 * The database keeps its bulk data out of Git: every record's `files[*]` entry carries an
 * `external_url` pointing at the exact object on
 * `https://huggingface.co/datasets/AroundPeking/LibRPA-database`. Cloning resolves those into
 * LFS pointers and drags in ~75 MB of history for what is really **3.1 MB of metadata**
 * (122 `record.json` files). Measured: 264 MB cloned vs 3.12 MB of records.
 *
 * So the panel works from a metadata-only index and fetches a figure or a band file *when it
 * is asked for*. That is also why "look at the real band plot without pulling the database"
 * is possible at all: the plot already exists as a PNG upstream, and the curve data as a
 * `.dat` of the same shape LibRPA writes locally.
 *
 * ## Caching
 *
 * Fetched bytes are cached on disk by content URL, so a second look at the same figure is
 * free. The cache is bounded by count, not age: these objects are immutable (the URL pins a
 * commit hash), so there is nothing to invalidate.
 *
 * @module abacusflow/host/library-assets
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Refuse anything that is not the known Hugging Face host, so a record cannot redirect us. */
const ALLOWED_HOSTS = new Set([
  'huggingface.co',
  'hf-mirror.com',
]);

/** How long a single fetch may take. Figures are a few hundred KB; band files ~1.3 MB. */
const FETCH_TIMEOUT_MS = 60_000;

/** Cap the on-disk cache. 200 objects covers every figure in the database plus spare. */
const MAX_CACHED_OBJECTS = 200;

/**
 * Validate an external URL from a record.
 *
 * A record is data, and data must not be able to make the host fetch an arbitrary URL. Only
 * https on the two known dataset mirrors is accepted.
 *
 * @param {string} url
 * @returns {string|null} the URL when acceptable, else null
 */
export function validateAssetUrl(url) {
  if (typeof url !== 'string' || url === '') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!ALLOWED_HOSTS.has(parsed.hostname)) return null;
  return parsed.toString();
}

/** A stable cache file name for a URL. */
function cacheKey(url) {
  return createHash('sha256').update(url).digest('hex').slice(0, 32);
}

/**
 * Fetch one asset, using and filling the disk cache.
 *
 * @param {{ cacheDir:string, url:string, maxBytes?:number }} options
 * @returns {Promise<{ ok:boolean, bytes?:Buffer, contentType?:string, cached?:boolean,
 *                     url?:string, error:string }>}
 */
export async function fetchAsset(options) {
  const { cacheDir } = options;
  const url = validateAssetUrl(options.url);
  if (!url) {
    return { ok: false, error: `拒绝的地址（只允许 https + 已知数据库镜像）：${options.url}`, };
  }

  if (cacheDir) {
    const path = join(cacheDir, cacheKey(url));
    if (existsSync(path)) {
      try {
        const bytes = readFileSync(path);
        return { ok: true, bytes, contentType: guessType(url), cached: true, url, error: '' };
      } catch {
        // Fall through to a refetch rather than failing the request.
      }
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) {
      return { ok: false, error: `上游返回 ${response.status} ${response.statusText}`, url };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const limit = options.maxBytes ?? 32 * 1024 * 1024;
    if (buffer.length > limit) {
      return { ok: false, error: `对象过大（${buffer.length} > ${limit} 字节）`, url };
    }
    if (cacheDir) {
      try {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(join(cacheDir, cacheKey(url)), buffer);
        pruneCache(cacheDir);
      } catch {
        // A cache write failure must not fail the fetch.
      }
    }
    return {
      ok: true,
      bytes: buffer,
      contentType: response.headers.get('content-type') || guessType(url),
      cached: false,
      url,
      error: '',
    };
  } catch (error) {
    const message = error?.name === 'AbortError' ? `请求超时（${FETCH_TIMEOUT_MS} ms）` : String(error.message || error);
    return { ok: false, error: message, url };
  } finally {
    clearTimeout(timer);
  }
}

/** Guess a content type from the extension; the upstream header is preferred when present. */
function guessType(url) {
  const clean = String(url).split('?')[0].toLowerCase();
  if (clean.endsWith('.png')) return 'image/png';
  if (clean.endsWith('.pdf')) return 'application/pdf';
  if (clean.endsWith('.json')) return 'application/json';
  if (clean.endsWith('.dat') || clean.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

/** Keep the cache bounded by dropping the oldest objects first. */
function pruneCache(cacheDir) {
  let entries;
  try {
    entries = readdirSync(cacheDir)
      .map((name) => {
        const path = join(cacheDir, name);
        try {
          return { path, mtime: statSync(path).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return;
  }
  if (entries.length <= MAX_CACHED_OBJECTS) return;
  entries.sort((a, b) => a.mtime - b.mtime);
  for (const entry of entries.slice(0, entries.length - MAX_CACHED_OBJECTS)) {
    try {
      unlinkSync(entry.path);
    } catch {
      /* best effort */
    }
  }
}

/**
 * A record's viewable assets, grouped so the panel can offer them without decoding `files`.
 *
 * @param {object} record a full `record.json`
 * @returns {{ figures:Array, bandData:Array, inputs:Array, logs:Array, results:Array }}
 */
export function listAssets(record) {
  const groups = { figures: [], bandData: [], inputs: [], logs: [], results: [] };
  for (const [role, entries] of Object.entries(record?.files ?? {})) {
    for (const entry of entries ?? []) {
      const url = validateAssetUrl(entry.external_url) ?? validateAssetUrl(entry.external_url_backup);
      const label = entry.label || entry.original_name || (entry.path ? entry.path.split('/').pop() : 'file');
      const item = {
        label,
        role,
        url,
        sizeBytes: typeof entry.size_bytes === 'number' ? entry.size_bytes : null,
        path: entry.path ?? null,
        sha256: entry.sha256 ?? null,
      };
      // Band curves are the point of the database for this panel; surface them separately
      // from generic "results" so the panel can plot them directly.
      if (/_(KS|EXX|GW|QSGW)\.dat$/i.test(label)) groups.bandData.push(item);
      else if (role === 'figures') groups.figures.push(item);
      else if (role === 'inputs') groups.inputs.push(item);
      else if (role === 'logs') groups.logs.push(item);
      else groups.results.push(item);
    }
  }
  // PNG before PDF: a panel shows the raster; the PDF is for the paper.
  groups.figures.sort((a, b) => {
    const rank = (x) => (/\.png$/i.test(x.label) ? 0 : /\.pdf$/i.test(x.label) ? 1 : 2);
    return rank(a) - rank(b) || a.label.localeCompare(b.label);
  });
  groups.bandData.sort((a, b) => {
    // KS, EXX, GW order is the physics order of the pipeline.
    const rank = (x) => {
      if (/_KS\.dat$/i.test(x.label)) return 0;
      if (/_EXX\.dat$/i.test(x.label)) return 1;
      if (/_GW\.dat$/i.test(x.label)) return 2;
      return 3;
    };
    return rank(a) - rank(b) || a.label.localeCompare(b.label);
  });
  return groups;
}

/**
 * Find the metadata index: a directory of `<dim>/<material>/<id>.json` records.
 *
 * Accepts either that flat index or a full repository checkout (`data/calculations/...`),
 * because a user may already have one.
 *
 * @param {string} root
 * @returns {{ ok:boolean, root:string, kind:'index'|'repo'|'none', error:string }}
 */
export function detectLibraryLayout(root) {
  const abs = resolve(String(root ?? ''));
  if (!existsSync(abs)) return { ok: false, root: abs, kind: 'none', error: `目录不存在：${abs}` };
  if (existsSync(join(abs, 'data', 'calculations'))) {
    return { ok: true, root: abs, kind: 'repo', error: '' };
  }
  // A flat index has dimension folders at the top (2d / 3d / 0d …).
  const entries = readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (entries.length > 0) return { ok: true, root: abs, kind: 'index', error: '' };
  return { ok: false, root: abs, kind: 'none', error: `既不是索引也不是仓库：${abs}` };
}
