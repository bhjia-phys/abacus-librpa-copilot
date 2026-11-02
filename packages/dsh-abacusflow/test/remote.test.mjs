/**
 * Remote-run helpers: manifest parsing, classification, and shell quoting.
 *
 * No network here. The SSH paths are covered by `scripts/probe-remote.mjs` (which needs a
 * live host); what these tests pin is the parsing and the safety of the command line we
 * build, because a quoting mistake there would be a remote-shell injection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseManifest, classifyRemoteTask, shellQuote } from '../lib/host/remote.js';

const SAMPLE = [
  '#RUN\t/data/home/u/ai-runs/foo',
  'TASK\tproducer/DZP/01_scf\tINPUT STRU KPT\tOUT.NiO_DZP_scf',
  'TASK\tproducer/DZP/03_bands\tINPUT STRU KPT\tOUT.NiO_DZP_bands',
  'TASK\tproducer/TZDP/03_bands\tINPUT STRU KPT\t',
  'TASK\tproducer/DZP/librpa/analysis\tlibrpa.in\t',
  'TASK\tqsgw\tlibrpa.in\t',
  'TASK\tproducer/provenance/NAO/DZP/O\tINPUT\t',
  '',
].join('\n');

test('parseManifest reads the run path, markers and output dirs', () => {
  const parsed = parseManifest(SAMPLE);
  assert.equal(parsed.run, '/data/home/u/ai-runs/foo');
  assert.equal(parsed.tasks.length, 6);

  const scf = parsed.tasks[0];
  assert.equal(scf.relPath, 'producer/DZP/01_scf');
  assert.deepEqual(scf.markers, ['INPUT', 'STRU', 'KPT']);
  assert.deepEqual(scf.outputDirs, ['OUT.NiO_DZP_scf']);

  // A task with no output directory keeps an empty list, not [""].
  const noOut = parsed.tasks[2];
  assert.deepEqual(noOut.outputDirs, []);
});

test('parseManifest tolerates CRLF and trailing blank lines', () => {
  const crlf = SAMPLE.replace(/\n/g, '\r\n') + '\r\n\r\n';
  const parsed = parseManifest(crlf);
  assert.equal(parsed.tasks.length, 6);
  assert.equal(parsed.tasks[0].relPath, 'producer/DZP/01_scf');
});

test('classifyRemoteTask matches the local scanner rules', () => {
  assert.equal(classifyRemoteTask({ markers: ['INPUT', 'STRU', 'KPT'] }), 'abacus');
  // INPUT without STRU still counts as an ABACUS directory: it is what an aborted run
  // looks like, and hiding it would be worse than showing it.
  assert.equal(classifyRemoteTask({ markers: ['INPUT'] }), 'abacus');
  assert.equal(classifyRemoteTask({ markers: ['librpa.in'] }), 'librpa');
  assert.equal(classifyRemoteTask({ markers: ['INPUT', 'librpa.in'] }), 'coupled');
  assert.equal(classifyRemoteTask({ markers: ['STRU', 'KPT'] }), null, 'no INPUT, no librpa.in');
  assert.equal(classifyRemoteTask({ markers: [] }), null);
});

test('shellQuote neutralises quotes, spaces and metacharacters', () => {
  assert.equal(shellQuote('/plain/path'), "'/plain/path'");
  assert.equal(shellQuote("/has space/x"), "'/has space/x'");
  // A single quote must be closed, escaped, and reopened.
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  // Shell metacharacters stay inert inside the quotes.
  const hostile = '/tmp/x; rm -rf ~ && echo $(whoami) `id`';
  const quoted = shellQuote(hostile);
  assert.equal(quoted.startsWith("'"), true);
  assert.equal(quoted.endsWith("'"), true);
  // Every embedded quote is escaped, so the shell sees one argument.
  assert.equal(quoted, `'${hostile}'`);
});

test('parseManifest on an empty or failed listing yields no tasks', () => {
  assert.deepEqual(parseManifest(''), { run: null, tasks: [] });
  assert.deepEqual(parseManifest('ssh: connect to host x port 22: Connection refused'), {
    run: null,
    tasks: [],
  });
});
