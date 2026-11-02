#!/usr/bin/env node
/**
 * End-to-end check of the on-demand library assets.
 *
 *   node scripts/probe-library-assets.mjs <library-root> [<record-id>]
 *
 * Verifies, against the real upstream dataset:
 *   - a record's figures / band data are listed with usable URLs;
 *   - a figure really downloads through the host route (correct content type and a PNG
 *     signature), and the second request is served from the disk cache.
 */
import { resolve } from 'node:path';

const [root, wantedId] = process.argv.slice(2);
if (!root) {
  console.error('usage: node scripts/probe-library-assets.mjs <library-root> [<record-id>]');
  process.exit(2);
}

const { apply } = await import('../lib/index.js');

const routes = {};
apply(
  {
    effect(fn) {
      const disposed = fn();
      return typeof disposed === 'function' ? disposed : () => {};
    },
    tools: { register: () => () => {} },
    webServer: {
      register(def) {
        routes[def.path] = def.handler;
        return () => {};
      },
    },
    get: () => undefined,
  },
  { libraryRoot: resolve(root) },
);

function call(path, urlPath) {
  return new Promise((done, fail) => {
    const chunks = [];
    const res = {
      writeHead(code, headers) {
        this.code = code;
        this.headers = headers || {};
      },
      end(body) {
        if (Buffer.isBuffer(body)) chunks.push(body);
        else if (body) chunks.push(Buffer.from(body));
        done({ code: this.code, headers: this.headers, body: Buffer.concat(chunks) });
      },
    };
    Promise.resolve(routes[path]({ url: urlPath }, res)).catch(fail);
  });
}

const id = wantedId || 'cuinp2se6-table-gw';
const listed = await call('/abacusflow/api/library/assets', `/abacusflow/api/library/assets?id=${encodeURIComponent(id)}`);
const info = JSON.parse(listed.body.toString());
if (!info.ok) {
  console.error('listing failed:', info.error);
  process.exit(1);
}
console.log(`record ${info.id} (${info.formula})`);
console.log(`  figures : ${info.figures.map((f) => f.label).join(', ') || '—'}`);
console.log(`  bandData: ${info.bandData.map((f) => f.label).join(', ') || '—'}`);

const png = info.figures.find((f) => /\.png$/i.test(f.label));
if (!png) {
  console.log('no PNG figure in this record; nothing to fetch');
  process.exit(0);
}

const first = await call('/abacusflow/api/library/asset', `/abacusflow/api/library/asset?url=${encodeURIComponent(png.url)}`);
const signature = first.body.subarray(0, 8);
const isPng = signature[0] === 0x89 && signature[1] === 0x50 && signature[2] === 0x4e && signature[3] === 0x47;
console.log(`  fetch #1: ${first.code} ${first.headers['content-type']} ${first.body.length}B cached=${first.headers['x-abacusflow-cached']} png=${isPng}`);

const second = await call('/abacusflow/api/library/asset', `/abacusflow/api/library/asset?url=${encodeURIComponent(png.url)}`);
console.log(`  fetch #2: ${second.code} ${second.body.length}B cached=${second.headers['x-abacusflow-cached']}`);

const ok = first.code === 200 && isPng && second.headers['x-abacusflow-cached'] === '1';
console.log(ok ? '\nOK: figure served and cached' : '\nFAIL: unexpected result');
process.exit(ok ? 0 : 1);
