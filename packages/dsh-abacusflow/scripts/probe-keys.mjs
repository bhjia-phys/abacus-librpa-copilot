#!/usr/bin/env node
/**
 * Print the full key set of a parse result, so a contract mismatch shows up immediately.
 *
 *   node scripts/probe-keys.mjs <module> <export> <file> [<file> ...]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [modPath, exportName, ...files] = process.argv.slice(2);
if (!modPath || !exportName || files.length === 0) {
  console.error('usage: node scripts/probe-keys.mjs <module> <export> <file> ...');
  process.exit(2);
}

const mod = await import(pathToFileURL(resolve(modPath)).href);
const fn = mod[exportName];
if (typeof fn !== 'function') {
  console.error(`export ${exportName} is not a function (got ${typeof fn})`);
  process.exit(1);
}

for (const file of files) {
  const text = readFileSync(resolve(file), 'utf8');
  const value = fn(text);
  console.log(`\n=== ${file}`);
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item)) {
      console.log(`  ${key.padEnd(22)} array(${item.length})`);
    } else if (item && typeof item === 'object') {
      console.log(`  ${key.padEnd(22)} object{${Object.keys(item).slice(0, 8).join(',')}${Object.keys(item).length > 8 ? ',…' : ''}}`);
    } else {
      console.log(`  ${key.padEnd(22)} ${typeof item} = ${JSON.stringify(item)}`);
    }
  }
}
