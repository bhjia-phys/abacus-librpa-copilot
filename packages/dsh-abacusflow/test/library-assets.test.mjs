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
import { existsSync } from 'node:fs';

import {
  validateAssetUrl,
  listAssets,
  detectLibraryLayout,
} from '../lib/host/library-assets.js';
import { loadLibrary, matchTask } from '../lib/host/library.js';

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
  assert.deepEqual(groups.bandData, []);
});

// ------------------------------------------------------- index vs repo ------

const INDEX_ROOT = 'F:\\AI_Workspace\\dsh-abacusflow\\database\\library-index';
const REPO_ROOT = 'F:\\AI_Workspace\\dsh-abacusflow\\database\\LibRPA-database';
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
