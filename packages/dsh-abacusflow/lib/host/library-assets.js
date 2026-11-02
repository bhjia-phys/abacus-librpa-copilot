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
import { parseLibrpaBand } from './librpa/bands.js';
import { cumulativePathLength } from './bands.js';
import { describeChannel } from './kconvergence.js';

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
      // The extension decides for known kinds, so a fresh fetch and a cache hit agree.
      contentType: KIND_TYPES[assetKind(url)] || response.headers.get('content-type') || guessType(url),
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

/** Content types for the kinds a record holds; `assetKind` names them. */
const KIND_TYPES = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
  json: 'application/json; charset=utf-8',
  dat: 'text/plain; charset=utf-8',
  text: 'text/plain; charset=utf-8',
};

/**
 * What an asset is, from the extension of its URL path (the record's `path` as fallback).
 *
 * The record's `label` is a caption ("GW occupation-separated frontier"), not a file name,
 * so it says nothing about the format. The panel used to test the label for `.png` and
 * therefore never showed the 214 SVG figures.
 *
 * @param {string|null} url
 * @param {string|null} [path]
 * @returns {'svg'|'png'|'jpg'|'pdf'|'json'|'dat'|'text'|'other'}
 */
export function assetKind(url, path) {
  const ext = (value) => {
    if (typeof value !== 'string' || value === '') return '';
    let pathname = value;
    try {
      pathname = new URL(value).pathname;
    } catch {
      /* a repository path, not a URL */
    }
    const m = /\.([a-z0-9]+)$/i.exec(pathname);
    return m ? m[1].toLowerCase() : '';
  };
  const found = ext(url) || ext(path);
  if (found === 'jpeg') return 'jpg';
  if (found === 'txt' || found === 'out' || found === 'log') return 'text';
  return Object.hasOwn(KIND_TYPES, found) ? found : 'other';
}

/**
 * The content type a kind is served as. For a known kind the extension decides, not the
 * upstream header: the mirror sends JSON as text/plain, and a cache hit has no header at
 * all — an SVG that came back as application/octet-stream would not render in an <img>.
 */
function guessType(url) {
  return KIND_TYPES[assetKind(url)] || 'application/octet-stream';
}

/** Filename tokens that name a quantity of the KS → EXX → GW chain. */
const QUANTITY_TOKENS = { ks: 'KS', exx: 'EXX', gw: 'GW', g0w0: 'GW', gw0: 'GW', evgw: 'GW', qsgw: 'QSGW' };
const QUANTITY_ORDER = ['KS', 'EXX', 'GW', 'QSGW'];

/**
 * Which quantity a figure or band file shows, read from its caption and file name.
 *
 * Words are split on everything that is not a letter or digit, underscores included, so
 * `cuinp2se6_ks.png` reads as KS. The record's directory is not consulted: every path of a
 * GW record contains "-gw", which would label its KS figure GW.
 *
 * @param {string|null} label
 * @param {string|null} path
 * @returns {{ quantity: 'KS'|'EXX'|'GW'|'QSGW'|'compare'|'other', quantities: string[] }}
 */
export function assetQuantity(label, path) {
  const fileName = typeof path === 'string' ? path.split('/').pop() : '';
  const tokens = `${label ?? ''} ${fileName}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const found = new Set(tokens.map((t) => QUANTITY_TOKENS[t]).filter(Boolean));
  const quantities = QUANTITY_ORDER.filter((q) => found.has(q));
  if (quantities.length === 0) return { quantity: 'other', quantities };
  return { quantity: quantities.length === 1 ? quantities[0] : 'compare', quantities };
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
 * Every item carries `kind` (from the URL's extension; see `assetKind`), `quantity` (from
 * its caption and file name; see `assetQuantity`) and `stem` (the file name without its
 * extension, so a PNG and the PDF of the same plot can be paired).
 *
 * - `figures`: plots — SVG, PNG, JPG, and PDF renderings of them.
 * - `audits`: JSON filed under figures (display mappings, raw audits, provenance). They
 *   document a plot; they are not one, so they are not offered as peers of the plots.
 * - `bandData`: band tables (`.dat` whose name carries KS/EXX/GW/QSGW), e.g. NiO's
 *   `GW_band_spin_1.dat` or CuInP2Se6's `GW_bands.dat` captioned `cuinp2se6_GW.dat`.
 *
 * @param {object} record a full `record.json`
 * @returns {{ figures:Array, audits:Array, bandData:Array, inputs:Array, logs:Array, results:Array }}
 */
export function listAssets(record) {
  const groups = { figures: [], audits: [], bandData: [], inputs: [], logs: [], results: [] };
  for (const [role, entries] of Object.entries(record?.files ?? {})) {
    for (const entry of entries ?? []) {
      const url = validateAssetUrl(entry.external_url) ?? validateAssetUrl(entry.external_url_backup);
      const label = entry.label || entry.original_name || (entry.path ? entry.path.split('/').pop() : 'file');
      const kind = assetKind(entry.external_url ?? null, entry.path ?? null);
      const { quantity, quantities } = assetQuantity(label, entry.path ?? null);
      const fileName = typeof entry.path === 'string' ? entry.path.split('/').pop() : '';
      const spin = /(?:^|[^a-z])spin_?(\d+)/i.exec(`${fileName} ${label}`);
      const item = {
        label,
        role,
        url,
        kind,
        quantity,
        quantities,
        stem: fileName.replace(/\.[a-z0-9]+$/i, '') || null,
        spin: spin ? Number(spin[1]) : null,
        primary: entry.display_priority === 'primary',
        sizeBytes: typeof entry.size_bytes === 'number' ? entry.size_bytes : null,
        path: entry.path ?? null,
        sha256: entry.sha256 ?? null,
      };
      // Band curves are surfaced apart from generic results so the panel can plot them.
      if (kind === 'dat' && quantity !== 'other' && quantity !== 'compare') groups.bandData.push(item);
      else if (role === 'figures' && kind === 'json') groups.audits.push(item);
      else if (role === 'figures') groups.figures.push(item);
      else if (role === 'inputs') groups.inputs.push(item);
      else if (role === 'logs') groups.logs.push(item);
      else groups.results.push(item);
    }
  }
  // Physics order (KS → EXX → GW → QSGW → comparisons → the rest), then images before PDFs.
  const quantityRank = (x) => {
    const at = [...QUANTITY_ORDER, 'compare'].indexOf(x.quantity);
    return at < 0 ? QUANTITY_ORDER.length + 1 : at;
  };
  const kindRank = (x) => ({ svg: 0, png: 1, jpg: 2, pdf: 3 })[x.kind] ?? 4;
  groups.figures.sort((a, b) => quantityRank(a) - quantityRank(b) || kindRank(a) - kindRank(b) || a.label.localeCompare(b.label));
  groups.bandData.sort((a, b) => quantityRank(a) - quantityRank(b) || (a.spin ?? 0) - (b.spin ?? 0) || a.label.localeCompare(b.label));
  return groups;
}

/**
 * A published band table as a channel, built exactly the way a local LibRPA band file is.
 *
 * The database's band tables are LibRPA's own format (`ik kx ky kz` then `occupation
 * energy` pairs: NiO's `GW_band_spin_1.dat`, CuInP2Se6's `GW_bands.dat`). So the same parser
 * (`parseLibrpaBand`), the same path length (`cumulativePathLength` over the file's k
 * coordinates) and the same occupation-based band edges (`describeChannel`) apply. Whether
 * it may share an axis with a local channel is then the panel's ordinary alignment check —
 * nothing here resamples or shifts anything.
 *
 * @param {string} text the file's contents
 * @param {{ label:string, quantity:string, spin:number|null, path:string|null }} item from `listAssets(record).bandData`
 * @returns {{ ok:boolean, error:string, file:string, kind:string, spin:number, nKpoint:number, nBand:number,
 *             kpath:number[], energies:number[][], vbmEv:number|null, cbmEv:number|null, gapEv:number|null,
 *             invertedKpoints:number, minEnergyEv:number|null, maxEnergyEv:number|null, warnings:string[] }}
 */
export function publishedBandChannel(text, item) {
  const file = (item.path || item.label || '').split('/').pop();
  const parsed = parseLibrpaBand(text, { fileName: file });
  const base = { file, kind: item.quantity, spin: item.spin ?? 1, warnings: parsed.warnings };
  if (parsed.rows.length === 0) {
    return { ok: false, error: '文件里没有可识别的 LibRPA 能带行（ik kx ky kz，然后是占据数/能量对）', ...base };
  }
  const kpath = cumulativePathLength(parsed.rows.map((r) => r.k));
  const energies = parsed.rows.map((r) => r.energiesEv);
  const summary = describeChannel({
    label: item.label,
    kind: item.quantity,
    spin: item.spin ?? 1,
    nKpoint: parsed.nKpoint,
    nBand: parsed.nState,
    kpath,
    energies,
    occupations: parsed.rows.map((r) => r.occupations),
    minEnergyEv: parsed.minEnergyEv,
    maxEnergyEv: parsed.maxEnergyEv,
  });
  // Same transport rounding as `compactBands`: three decimals of an eV / of a path length.
  const round = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
  return {
    ok: true,
    error: '',
    ...base,
    nKpoint: parsed.nKpoint,
    nBand: parsed.nState,
    kpath: kpath.map(round),
    energies: energies.map((row) => row.map(round)),
    vbmEv: summary.vbmEv,
    cbmEv: summary.cbmEv,
    gapEv: summary.gapEv,
    invertedKpoints: summary.invertedKpoints,
    minEnergyEv: summary.minEnergyEv,
    maxEnergyEv: summary.maxEnergyEv,
  };
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
