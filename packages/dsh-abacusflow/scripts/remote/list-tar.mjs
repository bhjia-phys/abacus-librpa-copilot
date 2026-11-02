#!/usr/bin/env node
/** List tar members with type/size, to see why one member fails to extract. */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const buf = gunzipSync(readFileSync(process.argv[2]));
const BLOCK = 512;
const field = (b, o, l) => {
  const s = b.subarray(o, o + l);
  const e = s.indexOf(0);
  return s.subarray(0, e === -1 ? l : e).toString('utf8');
};
let off = 0;
let shown = 0;
while (off + BLOCK <= buf.length && shown < 80) {
  const h = buf.subarray(off, off + BLOCK);
  if (h.every((x) => x === 0)) break;
  let name = field(h, 0, 100);
  const prefix = field(h, 345, 155);
  if (prefix) name = `${prefix}/${name}`;
  const size = parseInt(field(h, 124, 12).trim() || '0', 8) || 0;
  const type = String.fromCharCode(h[156] || 48);
  const mode = field(h, 100, 8).trim();
  console.log(`type=${JSON.stringify(type)} size=${String(size).padStart(9)} mode=${mode.padStart(7)} ${name}`);
  shown += 1;
  off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
}
