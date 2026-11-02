#!/usr/bin/env node
/**
 * Extract a .tar.gz using Node's own stream, into a UNC path.
 *
 * `tar.exe` on Windows writes files through a code path (`\\?\UNC\...` plus metadata) that
 * fails for some names on a `\\wsl$\...` share with "Invalid argument", even though the
 * same path accepts a plain write. Node's `fs` goes through the ordinary Win32 path and
 * works, so this is the extractor the pull workflow uses.
 *
 *   node extract-tar.mjs <archive.tar.gz> <dest-dir>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const [archive, destArg] = process.argv.slice(2);
if (!archive || !destArg) {
  console.error('usage: node extract-tar.mjs <archive.tar.gz> <dest-dir>');
  process.exit(2);
}
const dest = resolve(destArg);
mkdirSync(dest, { recursive: true });

const buffer = gunzipSync(readFileSync(archive));
const BLOCK = 512;

/** Read a NUL-terminated string from a fixed-width field. */
function field(buf, offset, length) {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? length : end).toString('utf8');
}

/** Parse an octal numeric field, tolerating leading spaces and NUL padding. */
function octal(buf, offset, length) {
  const text = field(buf, offset, length).trim();
  if (text === '') return 0;
  const value = parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

let offset = 0;
let files = 0;
let dirs = 0;
let skipped = 0;
/** Symlinks whose target had not been written yet when they were seen. */
const pendingLinks = [];

while (offset + BLOCK <= buffer.length) {
  const header = buffer.subarray(offset, offset + BLOCK);
  // Two zero blocks end the archive.
  if (header.every((b) => b === 0)) break;

  let name = field(header, 0, 100);
  const prefix = field(header, 345, 155);
  if (prefix) name = `${prefix}/${name}`;

  const size = octal(header, 124, 12);
  const typeflag = String.fromCharCode(header[156] || 48);
  const mode = octal(header, 100, 8);

  // GNU long-name entries: the real name is in the next block's data.
  if (typeflag === 'L') {
    const dataStart = offset + BLOCK;
    const longName = buffer.subarray(dataStart, dataStart + size).toString('utf8').replace(/\0.*$/, '');
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    // Re-read this entry as a header named longName.
    const next = buffer.subarray(offset, offset + BLOCK);
    const nextSize = octal(next, 124, 12);
    const nextType = String.fromCharCode(next[156] || 48);
    const target = join(dest, longName);
    if (nextType === '5') {
      mkdirSync(target, { recursive: true });
      dirs += 1;
    } else if (nextType === '0' || nextType === '\0' || nextType === '7') {
      const dataStart2 = offset + BLOCK;
      writeMember(target, buffer.subarray(dataStart2, dataStart2 + nextSize), mode);
      files += 1;
    }
    offset = offset + BLOCK + Math.ceil(nextSize / BLOCK) * BLOCK;
    continue;
  }

  if (typeflag === '5') {
    mkdirSync(join(dest, name), { recursive: true });
    dirs += 1;
    offset += BLOCK;
    continue;
  }

  if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
    const dataStart = offset + BLOCK;
    writeMember(join(dest, name), buffer.subarray(dataStart, dataStart + size), mode);
    files += 1;
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    continue;
  }

  // Hard links: copy the already-extracted target.
  if (typeflag === '1') {
    const linkname = field(header, 157, 100);
    try {
      writeMember(join(dest, name), readFileSync(join(dest, linkname)), 0o644);
      files += 1;
    } catch {
      skipped += 1;
    }
    offset += BLOCK;
    continue;
  }

  // Symbolic links: real runs use these for inputs shared with a sibling stage
  // (e.g. `run/librpa.in -> ../librpa.in`). Resolve when the target is inside the
  // archive, otherwise materialise a small placeholder file so the directory still
  // reads as a task — a dangling symlink would be worse than an approximate copy.
  if (typeflag === '2') {
    const linkname = field(header, 157, 100);
    const target = join(dest, name);
    const resolved = resolve(dirname(target), linkname);
    if (resolved.startsWith(resolve(dest))) {
      try {
        writeMember(target, readFileSync(resolved), 0o644);
        files += 1;
      } catch {
        // Target comes later in the archive: record it and fix up at the end.
        pendingLinks.push({ target, resolved });
        skipped += 1;
      }
    } else {
      writeFileSync(target, `# symlink -> ${linkname} (target outside archive)\n`);
      files += 1;
    }
    offset += BLOCK;
    continue;
  }

  // Other entries (devices, pax extended headers): skip their data.
  skipped += 1;
  offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
}

// Second pass: symlinks whose target appeared after them.
for (const { target, resolved } of pendingLinks) {
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(resolved));
    files += 1;
    skipped -= 1;
  } catch {
    /* leave it unresolved; the report below says how many */
  }
}

/**
 * Write one member. Synchronous on purpose: the process must not exit before the bytes
 * are on disk, and these members are at most a few megabytes.
 */
function writeMember(target, data, mode) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, Buffer.from(data));
  void mode;
}

console.log(`extracted ${files} files, ${dirs} dirs, skipped ${skipped} special entries -> ${dest}`);
