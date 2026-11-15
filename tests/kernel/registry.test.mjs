import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRegistry, findDuplicates} from '../../core/kernel/registry.mjs';
import {defineCommands, validateFamily, parseShortcut, formatShortcut, parseChord} from '../../core/kernel/command.mjs';
import {s} from '../../core/kernel/schema.mjs';

const fam = (family, app, ids, extra = {}) => defineCommands({family, app, upstream: {repo: 'office', files: []},
  commands: ids.map(id => ({id, label: id, risk: 'edit', params: s.object({}), run() {}, ...extra}))});

test('duplicate ids across families fail, naming both files', () => {
  const a = fam('format', 'grid', ['home.bold', 'home.italic']);
  const b = fam('format/font', 'grid', ['home.bold']);
  assert.deepEqual(findDuplicates([a, b], ['core/grid/commands/format.mjs', 'core/grid/commands/format/font.mjs']),
    [{id: 'home.bold', files: ['core/grid/commands/format.mjs', 'core/grid/commands/format/font.mjs']}]);
  assert.throws(() => buildRegistry([a, b], {app: 'grid', sources: ['core/grid/commands/format.mjs', 'core/grid/commands/format/font.mjs']}),
    /Duplicate command id "home\.bold" defined in core\/grid\/commands\/format\.mjs and core\/grid\/commands\/format\/font\.mjs/);
});

test('registries only take families for their app and list/search commands', () => {
  const common = fam('edit', '*', ['edit.undo']);
  const grid = fam('data', 'grid', ['data.sort']);
  const quill = fam('data', 'quill', ['data.sort']);
  const r = buildRegistry([common, grid, quill], {app: 'grid', sources: ['c', 'g', 'q']});
  assert.deepEqual(r.ids(), ['data.sort', 'edit.undo']);
  assert.equal(r.get('data.sort').source, 'g');
  assert.equal(r.get('data.sort').undo, 'auto');
  assert.equal(r.get('data.sort').needs, 'model');
  assert.deepEqual(r.list({search: 'UNDO'}).map(c => c.id), ['edit.undo']);
  assert.deepEqual(r.list({family: 'data'}).map(c => c.id), ['data.sort']);
  assert.equal(r.families().length, 2);
});

test('validateFamily catches contract violations', () => {
  const bad = {family: 'x', app: 'grid', upstream: {repo: 'gridcraft', files: []}, commands: [
    {id: 'Bad Id', label: '', risk: 'maybe', params: {}, run: 1},
    {id: 'a.b', label: 'A', risk: 'destructive', params: s.object({}), run() {}},
    {id: 'a.c', label: 'C', risk: 'edit', needs: 'view', params: s.object({}), run() {}, shortcut: 'Ctrl+Nope+Q'},
    {id: 'a.d', label: 'D', risk: 'edit', undo: 'none', params: s.object({}), run() {}},
  ]};
  const errors = validateFamily(bad).join('\n');
  for (const m of ['`id` must look like', '`label` is required', '`risk` must be', '`params` must be', '`run` must be', 'define summary',
    "needs:'view'", 'does not parse', "must declare effect"]) assert.ok(errors.includes(m), m);
  assert.throws(() => defineCommands({...bad, commands: [bad.commands[1]]}), /summary/);
  assert.deepEqual(validateFamily({family: 'x', app: 'nope', upstream: {repo: 'x'}, commands: []}).length, 2);
});

test('shortcuts: alternatives, sequences, notes and platform formatting', () => {
  const p = parseShortcut('Ctrl+Y / Ctrl+Shift+Z');
  assert.deepEqual(p.map(e => formatShortcut(e, 'win')), ['Ctrl+Y', 'Ctrl+Shift+Z']);
  assert.equal(formatShortcut(parseShortcut('Alt, V, P')[0], 'win'), 'Alt, V, P');
  assert.equal(parseShortcut('Alt, V, P')[0].sequence, true);
  assert.equal(formatShortcut(parseShortcut('Mod+B')[0], 'mac'), 'Meta+B');
  assert.equal(formatShortcut(parseShortcut('Mod+B')[0], 'win'), 'Ctrl+B');
  assert.equal(formatShortcut(parseShortcut('Ctrl+Shift+F (Mac Cmd+Shift+F)')[0], 'win'), 'Ctrl+Shift+F');
  assert.equal(parseChord('Ctrl++').key, '+');
  assert.equal(parseChord('Ctrl+,').key, ',');
  assert.equal(parseChord('Ctrl+Page Down').key, 'PageDown');
  assert.equal(parseChord('Arrow keys'), null);
  assert.equal(parseShortcut('Double-click')[0].steps, null);
});
