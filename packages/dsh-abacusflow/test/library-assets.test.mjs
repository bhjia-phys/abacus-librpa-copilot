/**
 * On-demand database assets: URL safety, sizes, and asset grouping.
 *
 * The database keeps its bulk data on Hugging Face; only ~3.1 MB of metadata is local. These
 * tests pin the properties that make that safe and cheap:
 *   - only https on the two known dataset mirrors may be fetched (a record is data, and data
 *     must not be able to redirect the host anywhere);
 *   - band curves and figures are separated so the panel can plot the former;
 *   - the flattened metadata index loads the same 122 records as a full checkout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateAssetUrl,
  listAssets,
  detectLibraryLayout,
  assetKind,
  assetQuantity,
  fetchAsset,
  publishedBandChannel,
  mirrorOf,
} from '../lib/host/library-assets.js';
import { loadLibrary, matchTask } from '../lib/host/library.js';
import { localData } from '../scripts/lib/local-data.mjs';

// ------------------------------------------------------------ URL safety -----

test('only https on the known dataset mirrors is accepted', () => {
  assert.ok(validateAssetUrl('https://huggingface.co/datasets/x/y/resolve/a/b.png'));
  assert.ok(validateAssetUrl('https://hf-mirror.com/datasets/x/y/resolve/a/b.png'));
});

test('other hosts and protocols are refused', () => {
  // A record is untrusted data: it must not be able to make the host fetch anything it likes.
  assert.equal(validateAssetUrl('https://evil.example.com/x.png'), null);
  assert.equal(validateAssetUrl('http://huggingface.co/x.png'), null, 'plain http refused');
  assert.equal(validateAssetUrl('file:///etc/passwd'), null);
  assert.equal(validateAssetUrl('ssh://huggingface.co/x'), null);
  assert.equal(validateAssetUrl(''), null);
  assert.equal(validateAssetUrl(null), null);
  // A lookalike host must not pass.
  assert.equal(validateAssetUrl('https://huggingface.co.evil.com/x.png'), null);
});

// ------------------------------------------------------- asset grouping -----

const RECORD = {
  id: 'demo',
  material: 'Demo',
  files: {
    inputs: [{ role: 'inputs', label: 'SCF / INPUT', external_url: 'https://huggingface.co/a/INPUT', size_bytes: 100 }],
    results: [
      { role: 'results', label: 'demo_KS.dat', external_url: 'https://huggingface.co/a/demo_KS.dat', size_bytes: 1000 },
      { role: 'results', label: 'demo_GW.dat', external_url: 'https://huggingface.co/a/demo_GW.dat', size_bytes: 1000 },
      { role: 'results', label: 'demo_EXX.dat', external_url: 'https://huggingface.co/a/demo_EXX.dat', size_bytes: 1000 },
      { role: 'results', label: 'table.json', external_url: 'https://huggingface.co/a/table.json', size_bytes: 50 },
    ],
    figures: [
      { role: 'figures', label: 'demo_gw.pdf', external_url: 'https://huggingface.co/a/demo_gw.pdf', size_bytes: 500 },
      { role: 'figures', label: 'demo_gw.png', external_url: 'https://huggingface.co/a/demo_gw.png', size_bytes: 900 },
      { role: 'figures', label: 'demo_ks.png', external_url: 'https://huggingface.co/a/demo_ks.png', size_bytes: 901 },
    ],
    logs: [],
  },
};

test('band curves are separated from generic results, in KS → EXX → GW order', () => {
  const groups = listAssets(RECORD);
  assert.deepEqual(groups.bandData.map((f) => f.label), ['demo_KS.dat', 'demo_EXX.dat', 'demo_GW.dat']);
  // `table.json` is a result, not a curve.
  assert.ok(groups.results.some((f) => f.label === 'table.json'));
  assert.equal(groups.bandData.some((f) => f.label === 'table.json'), false);
});

test('figures put PNG before PDF, because the panel shows the raster', () => {
  const groups = listAssets(RECORD);
  const pngs = groups.figures.filter((f) => /\.png$/i.test(f.label));
  assert.equal(pngs.length, 2);
  assert.ok(/\.png$/i.test(groups.figures[0].label), `first figure is a PNG: ${groups.figures[0].label}`);
});

test('an asset without an allowed URL is still listed, with url null', () => {
  const groups = listAssets({
    id: 'x',
    files: { figures: [{ role: 'figures', label: 'bad.png', external_url: 'https://evil.example.com/x.png' }] },
  });
  assert.equal(groups.figures.length, 1);
  assert.equal(groups.figures[0].url, null, 'the panel must not render a refused URL');
});

test('a record with no files yields empty groups rather than throwing', () => {
  const groups = listAssets({ id: 'empty' });
  assert.deepEqual(groups.figures, []);
  assert.deepEqual(groups.audits, []);
  assert.deepEqual(groups.bandData, []);
});

// ------------------------------------------- kind and quantity (§3.1) ------
//
// The database's `label` is a caption, not a file name: 214 of its figures are SVGs captioned
// like "GW occupation-separated frontier", and the panel used to keep only labels ending in
// .png. The kind now comes from the URL; the quantity from caption and file-name words.

const HF = 'https://huggingface.co/datasets/AroundPeking/LibRPA-database/resolve/0123abc/data/calculations';

test('the kind comes from the URL path, never from the caption', () => {
  assert.equal(assetKind(`${HF}/3d/NiO/nio-aims-gw-int/figures/gw_frontier.svg`), 'svg');
  assert.equal(assetKind(`${HF}/2d/X/x/figures/x_ks.png?download=true`), 'png');
  assert.equal(assetKind(`${HF}/2d/X/x/figures/x_ks.PDF`), 'pdf');
  assert.equal(assetKind(`${HF}/3d/NiO/nio-aims-gw-int/figures/band_frontier_metadata.json`), 'json');
  assert.equal(assetKind(`${HF}/3d/NiO/nio-aims-gw-int/results/GW_band2001.out`), 'text');
  assert.equal(assetKind(null, 'data/calculations/3d/NiO/x/results/GW_band_spin_1.dat'), 'dat', 'the record path is the fallback');
  assert.equal(assetKind(`${HF}/3d/NiO/x/inputs/KPT_band`), 'other');
});

test('the quantity is read from caption and file-name words, not from the record path', () => {
  assert.equal(assetQuantity('cuinp2se6_ks.png', 'data/calculations/2d/CuInP2Se6/cuinp2se6-table-gw/figures/cuinp2se6_ks.png').quantity, 'KS',
    'an underscore separates words, and the record directory ("-gw") is ignored');
  assert.equal(assetQuantity('GW occupation-separated frontier', 'x/figures/gw_frontier.svg').quantity, 'GW');
  assert.equal(assetQuantity('EXX occupation-separated frontier', 'x/figures/exx_frontier.svg').quantity, 'EXX');
  const both = assetQuantity('KS / EXX / GW band comparison', 'x/figures/band_comparison.svg');
  assert.equal(both.quantity, 'compare');
  assert.deepEqual(both.quantities, ['KS', 'EXX', 'GW']);
  assert.equal(assetQuantity('hbn_tzdp10_cutoff_zoom.png', 'x/figures/figures__hbn_tzdp10_cutoff_zoom.png').quantity, 'other');
  assert.equal(assetQuantity('G0W0 frontier', null).quantity, 'GW');
  assert.equal(assetQuantity('QSGW_band_spin_1.dat', null).quantity, 'QSGW');
});

const NIO_LIKE = {
  id: 'nio-like',
  material: 'NiO',
  files: {
    results: [
      { label: 'GW_band_spin_1.dat', path: 'data/calculations/3d/NiO/nio-like/results/GW_band_spin_1.dat', external_url: `${HF}/3d/NiO/nio-like/results/GW_band_spin_1.dat` },
      { label: 'EXX_band_spin_1.dat', path: 'data/calculations/3d/NiO/nio-like/results/EXX_band_spin_1.dat', external_url: `${HF}/3d/NiO/nio-like/results/EXX_band_spin_1.dat` },
      { label: 'GW_band2001.out', path: 'data/calculations/3d/NiO/nio-like/results/GW_band2001.out', external_url: `${HF}/3d/NiO/nio-like/results/GW_band2001.out` },
      { label: 'cuinp2se6_GW.dat', path: 'data/calculations/2d/C/c/results/GW_bands.dat', external_url: `${HF}/2d/C/c/results/GW_bands.dat` },
    ],
    figures: [
      { label: 'GW occupation-separated frontier', path: 'data/calculations/3d/NiO/nio-like/figures/gw_frontier.svg', external_url: `${HF}/3d/NiO/nio-like/figures/gw_frontier.svg`, display_priority: 'primary' },
      { label: 'EXX occupation-separated frontier', path: 'data/calculations/3d/NiO/nio-like/figures/exx_frontier.svg', external_url: `${HF}/3d/NiO/nio-like/figures/exx_frontier.svg` },
      { label: 'Frontier display mappings, raw audit and provenance', path: 'data/calculations/3d/NiO/nio-like/figures/band_frontier_metadata.json', external_url: `${HF}/3d/NiO/nio-like/figures/band_frontier_metadata.json` },
    ],
  },
};

test('SVG figures are listed as figures; their audit JSON is listed apart', () => {
  const groups = listAssets(NIO_LIKE);
  assert.deepEqual(groups.figures.map((f) => [f.kind, f.quantity]), [['svg', 'EXX'], ['svg', 'GW']], 'physics order: EXX before GW');
  assert.equal(groups.figures[1].primary, true);
  assert.equal(groups.figures[1].stem, 'gw_frontier');
  assert.deepEqual(groups.audits.map((f) => f.label), ['Frontier display mappings, raw audit and provenance']);
  assert.equal(groups.audits[0].kind, 'json');
});

test('band tables are found by file name, whatever their caption', () => {
  const groups = listAssets(NIO_LIKE);
  assert.deepEqual(groups.bandData.map((f) => [f.label, f.quantity, f.spin]), [
    ['EXX_band_spin_1.dat', 'EXX', 1],
    ['cuinp2se6_GW.dat', 'GW', null],
    ['GW_band_spin_1.dat', 'GW', 1],
  ]);
  assert.ok(groups.results.some((f) => f.label === 'GW_band2001.out'), 'an FHI-aims band segment is a result, not a band table');
});

test('a cached SVG is served as image/svg+xml, as on the first fetch', async () => {
  // A cache hit has no upstream header. It used to fall back to application/octet-stream,
  // which an <img> refuses for SVG: the figure showed once and broke on the second look.
  const cacheDir = mkdtempSync(join(tmpdir(), 'abacusflow-assets-'));
  try {
    const url = `${HF}/3d/NiO/nio-like/figures/gw_frontier.svg`;
    writeFileSync(join(cacheDir, createHash('sha256').update(url).digest('hex').slice(0, 32)), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const hit = await fetchAsset({ cacheDir, url });
    assert.equal(hit.ok, true);
    assert.equal(hit.cached, true);
    assert.equal(hit.contentType, 'image/svg+xml');
    const json = `${HF}/3d/NiO/nio-like/figures/band_frontier_metadata.json`;
    writeFileSync(join(cacheDir, createHash('sha256').update(json).digest('hex').slice(0, 32)), '{}');
    assert.match((await fetchAsset({ cacheDir, url: json })).contentType, /^application\/json/);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- index vs repo ------

const INDEX_ROOT = localData().libraryRoot || fileURLToPath(new URL('../../../database/library-index', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../database/LibRPA-database', import.meta.url));
const hasIndex = existsSync(INDEX_ROOT);

test('layout detection distinguishes an index from a repository checkout', () => {
  if (hasIndex) {
    const index = detectLibraryLayout(INDEX_ROOT);
    assert.equal(index.ok, true);
    assert.equal(index.kind, 'index');
  }
  if (existsSync(REPO_ROOT)) {
    const repo = detectLibraryLayout(REPO_ROOT);
    assert.equal(repo.kind, 'repo');
  }
  assert.equal(detectLibraryLayout('F:\\definitely-not-here').ok, false);
});

test('the metadata index loads every record and matches materials', { skip: !hasIndex }, () => {
  const library = loadLibrary(INDEX_ROOT);
  assert.equal(library.ok, true);
  assert.ok(library.records.length >= 100, `records: ${library.records.length}`);
  assert.ok(library.formulas.includes('Bi2Se3'));

  const result = matchTask({ speciesCounts: { Bi: 2, Se: 3 } }, library);
  assert.ok(result.matches.length > 0);
  assert.ok(result.matches[0].id.toLowerCase().includes('bi2se3'));
});

test('index records carry the external URLs the panel fetches from', { skip: !hasIndex }, () => {
  const library = loadLibrary(INDEX_ROOT);
  const withFigures = library.records.filter((r) => listAssets(r).figures.length > 0);
  assert.ok(withFigures.length > 50, `records with figures: ${withFigures.length}`);

  const sample = listAssets(withFigures[0]);
  assert.ok(sample.figures[0].url, 'a figure URL survived validation');
  assert.match(sample.figures[0].url, /^https:\/\/(huggingface\.co|hf-mirror\.com)\//);
});

// The four records §3.1 is verified against: SVG + audit JSON (NiO, Bi2Se3), PNG + PDF
// pairs (CuInP2Se6), and a record with no figures at all.
test('real records: every figure kind is offered, audits apart', { skip: !hasIndex }, () => {
  const library = loadLibrary(INDEX_ROOT);
  const groupsOf = (id) => {
    const record = library.records.find((r) => r.id === id);
    assert.ok(record, `record ${id} present`);
    return listAssets(record);
  };
  const nio = groupsOf('nio-aims-gw-int');
  assert.deepEqual(nio.figures.map((f) => `${f.kind}:${f.quantity}`), ['svg:EXX', 'svg:GW']);
  assert.equal(nio.audits.length, 1);
  assert.deepEqual(nio.bandData.map((f) => f.quantity), ['EXX', 'GW']);

  const bi = groupsOf('bi2se3-abacus-gw-dzp');
  assert.deepEqual(bi.figures.map((f) => `${f.kind}:${f.quantity}`), ['svg:KS', 'svg:EXX', 'svg:GW']);
  assert.equal(bi.audits.length, 1);
  assert.equal(bi.bandData.length, 3);

  const cu = groupsOf('cuinp2se6-table-gw');
  assert.deepEqual(cu.figures.map((f) => `${f.kind}:${f.quantity}`), ['png:KS', 'pdf:KS', 'png:EXX', 'pdf:EXX', 'png:GW', 'pdf:GW']);
  assert.equal(cu.audits.length, 0);
  assert.deepEqual(cu.bandData.map((f) => f.quantity), ['KS', 'EXX', 'GW']);

  const none = groupsOf('c-delta-st-rpa-20260824');
  assert.equal(none.figures.length + none.audits.length, 0);

  // Across the whole index nothing is lost: every figure entry lands in figures or audits.
  let entries = 0;
  let listed = 0;
  for (const record of library.records) {
    entries += (record.files?.figures ?? []).length;
    const g = listAssets(record);
    listed += g.figures.filter((f) => f.role === 'figures').length + g.audits.length;
  }
  assert.equal(listed, entries, 'every figure entry is offered');
});

// ------------------------------------------------ published band tables (§4.2) ---

test('a published band table is read exactly like a local LibRPA band file', () => {
  // LibRPA's layout: ik kx ky kz, then (occupation energy) per state. Two occupied, one empty.
  const text = [
    '1 0.000 0.000 0.000  1.0 -1.20  1.0 -0.50  0.0 1.30',
    '2 0.100 0.000 0.000  1.0 -1.10  1.0 -0.40  0.0 1.10',
    '3 0.200 0.000 0.000  1.0 -1.00  1.0 -0.45  0.0 0.90',
  ].join('\n');
  const ch = publishedBandChannel(text, { label: 'GW_band_spin_1.dat', quantity: 'GW', spin: 1, path: 'x/results/GW_band_spin_1.dat' });
  assert.equal(ch.ok, true, ch.error);
  assert.equal(ch.nKpoint, 3);
  assert.equal(ch.nBand, 3);
  assert.deepEqual(ch.kpath, [0, 0.1, 0.2], 'cumulative path length over the file coordinates');
  assert.equal(ch.vbmEv, -0.4, 'VBM from occupations, per k');
  assert.equal(ch.cbmEv, 0.9);
  assert.ok(Math.abs(ch.gapEv - 1.3) < 1e-9);
  assert.equal(ch.file, 'GW_band_spin_1.dat');
});

test('a file that is not a LibRPA band table is refused with a reason, not plotted', () => {
  const ch = publishedBandChannel('# k  E1 E2\n0.0 -1.0 1.0\n', { label: 'x.dat', quantity: 'GW', spin: 1, path: 'x.dat' });
  assert.equal(ch.ok, false);
  assert.match(ch.error, /LibRPA 能带行/);
});

// ------------------------------------------------ mirror fallback (live failure) ---
//
// In live use a figure failed to load in the panel and came through 2 s later: downloads from
// abroad are unreliable here. A failed attempt is retried once on the other mirror, which
// serves the dataset under identical paths.

const SVG_URL = 'https://huggingface.co/datasets/AroundPeking/LibRPA-database/resolve/339cc46/data/calculations/3d/KCl/kcl-jctc-aims-gw/figures/gw_frontier.svg';
const fakeFetch = (plan) => {
  const calls = [];
  const impl = async (url) => {
    calls.push(new URL(url).hostname);
    const step = plan[calls.length - 1];
    if (step instanceof Error) throw step;
    return new Response(step.body ?? '', { status: step.status ?? 200, statusText: step.statusText ?? '' });
  };
  return { impl, calls };
};

test('the other mirror has the same path', () => {
  assert.equal(mirrorOf(SVG_URL), SVG_URL.replace('huggingface.co', 'hf-mirror.com'));
  assert.equal(mirrorOf(SVG_URL.replace('huggingface.co', 'hf-mirror.com')), SVG_URL);
  assert.equal(mirrorOf('https://example.com/x.svg'), null);
});

test('a failed download is retried on the other mirror, and cached under the record URL', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'abacusflow-mirror-'));
  try {
    const net = fakeFetch([Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } }), { body: '<svg xmlns="http://www.w3.org/2000/svg"/>' }]);
    const got = await fetchAsset({ cacheDir, url: SVG_URL, fetchImpl: net.impl });
    assert.equal(got.ok, true);
    assert.deepEqual(net.calls, ['huggingface.co', 'hf-mirror.com']);
    assert.equal(got.mirror, true);
    assert.equal(got.contentType, 'image/svg+xml');
    const again = await fetchAsset({ cacheDir, url: SVG_URL, fetchImpl: async () => { throw new Error('offline'); } });
    assert.equal(again.cached, true, 'the next look is served from the cache, keyed by the record URL');
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('a missing object is not retried; when both mirrors fail, both reasons are reported', async () => {
  const missing = fakeFetch([{ status: 404, statusText: 'Not Found' }]);
  const notFound = await fetchAsset({ url: SVG_URL, fetchImpl: missing.impl });
  assert.equal(notFound.ok, false);
  assert.deepEqual(missing.calls, ['huggingface.co'], 'a 404 is the object\'s answer, not the network\'s');
  const down = fakeFetch([{ status: 503, statusText: 'Service Unavailable' }, Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })]);
  const both = await fetchAsset({ url: SVG_URL, fetchImpl: down.impl });
  assert.equal(both.ok, false);
  assert.match(both.error, /huggingface\.co 返回 503.*hf-mirror\.com 连接失败（ECONNRESET）/);
});
