/**
 * Layout regressions in the panel stylesheet.
 *
 * These pin fixes for defects that were visible in a real screenshot:
 *   - the tab row wrapped, putting LibRPA alone on a second line;
 *   - the path input was truncated because five buttons shared its row;
 *   - the "which default is in force" hint rendered as three wrapped lines and pushed the
 *     task tree off screen;
 *   - group headers were uppercased, so `producer/DZP` read as `PRODUCER/DZP`.
 *
 * The stylesheet lives inside `lib/client.js` as a template string, because the DSH client
 * loader takes one pre-bundled file. These tests read it from there so they cannot drift.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

const cssMatch = /const CSS = `([\s\S]*?)`;\n/.exec(source);
assert.ok(cssMatch, 'CSS template found in lib/client.js');
const css = cssMatch[1];

/** Extract one rule body by selector. */
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return m ? m[1] : null;
}

test('the tab row scrolls instead of wrapping', () => {
  const body = rule('.af-tabs');
  assert.ok(body, '.af-tabs rule exists');
  assert.match(body, /overflow-x:\s*auto/, 'tabs scroll horizontally');
  assert.doesNotMatch(body, /flex-wrap:\s*wrap/, 'tabs must not wrap onto a second line');
});

test('the path field gets a full toolbar row of its own', () => {
  const row = rule('.af-toolbar-row');
  assert.ok(row, '.af-toolbar-row rule exists');
  assert.match(row, /flex:\s*1 1 100%/, 'each row spans the toolbar width');

  const input = rule('.af-input');
  assert.match(input, /min-width:\s*0/, 'the input may shrink rather than overflow');
  assert.match(input, /flex:\s*1 1 auto/, 'the input fills the row');
});

test('the default-path hint is one ellipsised line', () => {
  const path = rule('.af-defroot-path');
  assert.ok(path, '.af-defroot-path rule exists');
  assert.match(path, /text-overflow:\s*ellipsis/);
  assert.match(path, /white-space:\s*nowrap/);
  assert.match(path, /overflow:\s*hidden/);
});

test('group headers keep the real directory case', () => {
  const group = rule('.af-group');
  assert.ok(group, '.af-group rule exists');
  // Uppercasing a real path segment misrepresents it.
  assert.doesNotMatch(group, /text-transform:\s*uppercase/);
});

test('task rows are compact enough to scan a long list', () => {
  const task = rule('.af-task');
  assert.ok(task, '.af-task rule exists');
  const m = /line-height:\s*(\d+)px/.exec(task);
  assert.ok(m, 'an explicit line-height keeps rows uniform');
  assert.ok(Number(m[1]) <= 22, `row line-height ${m[1]}px is too tall`);
});

test('the selected task is marked with an accent, not only weight', () => {
  const active = /\.af-task\[data-active\]\s*\{([^}]*)\}/.exec(css);
  assert.ok(active, '.af-task[data-active] rule exists');
  assert.match(active[1], /border-left-color/, 'an accent bar marks the selection');
});

test('markup uses the toolbar rows and the single-line default hint', () => {
  // Structural assertions: the CSS is only effective if the JSX actually uses it.
  assert.match(source, /className: 'af-toolbar-row'/, 'toolbar rows are rendered');
  assert.match(source, /className: 'af-defroot'/, 'default-root hint is rendered');
  assert.match(source, /className: 'af-defroot-path'/, 'its path element is rendered');
  assert.match(source, /className: 'af-group-count'/, 'group counts are rendered');
});

test('the default-root hint is not rendered as a bare hint paragraph', () => {
  // The earlier version used `.af-hint` with inline padding and produced three wrapped
  // lines. Guard against reintroducing that: take the text from the `rootHint` assignment
  // through to the next top-level `const`.
  const start = source.indexOf('const rootHint =');
  assert.ok(start > 0, 'rootHint assignment found');
  const rest = source.slice(start);
  const end = rest.indexOf('\n      const ', 1);
  assert.ok(end > 0, 'rootHint block is delimited');
  const block = rest.slice(0, end);
  assert.match(block, /className: 'af-defroot'/, 'rootHint uses the .af-defroot row');
  assert.doesNotMatch(block, /className: 'af-hint'/, 'rootHint must not be a bare hint');
});
