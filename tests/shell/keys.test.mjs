// Key routing (src/shell/keys/KeyRouter.ts) and keytips (src/shell/keys/keytipTable.ts):
// scope order, Mod by platform, sequences, Alt taps, ui.key feeding, and prefix-free keytips.
import test from 'node:test';
import assert from 'node:assert/strict';
import {KeyRouter, chordFromEvent, chordText, fieldOwns, bindingSteps} from '../../src/shell/keys/KeyRouter.ts';
import {assignKeytips, prefixFree, qatKeytips, matchKeytip} from '../../src/shell/keys/keytipTable.ts';

function router(bindings, {platform = 'win', flags = {}, dialog, keytips} = {}) {
  const ran = [];
  const r = new KeyRouter({platform, bindings, scopeActive: s => s === 'app' || !!flags[s], dialog, keytips, run: b => ran.push(b.command ?? b.dialog)});
  return {r, ran};
}
const key = (k, mods = {}) => ({key: k, code: /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : undefined, ...mods});

test('chords from keyboard events: letters, named keys, Option on macOS, modifiers alone', () => {
  assert.equal(chordText(chordFromEvent(key('b', {ctrlKey: true})), 'win'), 'Ctrl+B');
  assert.equal(chordText(chordFromEvent({key: 'ArrowUp', shiftKey: true}), 'win'), 'Shift+Up');
  assert.equal(chordText(chordFromEvent({key: '∫', code: 'KeyB', altKey: true}), 'mac'), 'Alt+B');
  assert.equal(chordText(chordFromEvent({key: 'F4'}), 'win'), 'F4');
  assert.equal(chordFromEvent({key: 'Control', ctrlKey: true}).key, 'Ctrl');
  assert.equal(chordFromEvent({key: 'Dead'}), null);
});

test('Mod is Ctrl on Windows and Cmd on macOS', () => {
  const win = router([{keys: 'Mod+B', command: 'format.bold', scope: 'app', source: 'command'}]);
  assert.equal(win.r.keydown(key('b', {ctrlKey: true})).handled, true);
  assert.deepEqual(win.ran, ['format.bold']);
  assert.equal(win.r.keydown(key('b', {metaKey: true})).handled, false);
  const mac = router([{keys: 'Mod+B', command: 'format.bold', scope: 'app', source: 'command'}], {platform: 'mac'});
  assert.equal(mac.r.keydown(key('b', {metaKey: true})).handled, true);
  assert.equal(mac.r.keydown(key('b', {ctrlKey: true})).handled, false);
});

test('scope order: dialog, then keytips, then surface flags, then app', () => {
  const bindings = [
    {keys: 'Tab', command: 'table.nextCell', scope: 'table', source: 'spec'},
    {keys: 'Tab', command: 'text.indent', scope: 'app', source: 'spec'},
  ];
  const flags = {};
  const t = router(bindings, {flags});
  assert.equal(t.r.keydown({key: 'Tab'}).scope, 'app');
  flags.table = true;
  assert.equal(t.r.keydown({key: 'Tab'}).scope, 'surface');
  assert.deepEqual(t.ran, ['text.indent', 'table.nextCell']);
  // A modal dialog owns the keyboard: app shortcuts never run behind it, keys still reach its fields.
  const d = router([{keys: 'Mod+B', command: 'format.bold', scope: 'app', source: 'command'}], {dialog: () => 'pass'});
  const r = d.r.keydown(key('b', {ctrlKey: true}));
  assert.equal(r.handled, false);
  assert.equal(r.scope, 'dialog');
  assert.deepEqual(d.ran, []);
  // Keytip mode swallows everything.
  let typed = '';
  const k = router([{keys: 'H', command: 'x', scope: 'app', source: 'spec'}], {keytips: {active: () => true, key: (c, text) => { typed += text; return true; }, toggle() {}}});
  assert.equal(k.r.keydown(key('h')).scope, 'keytips');
  assert.equal(typed, 'H');
  assert.deepEqual(k.ran, []);
});

test('the router only claims keys that have a binding', () => {
  const t = router([{keys: 'Mod+B', command: 'format.bold', scope: 'app', source: 'command'}]);
  assert.equal(t.r.keydown(key('a')).handled, false);
  assert.equal(t.r.keydown({key: 'Enter'}).handled, false);
});

test('spec shortcuts win over control shortcuts, which win over command defaults; conflicts are reported', () => {
  const t = router([
    {keys: 'Ctrl+E', command: 'command.default', scope: 'app', source: 'command'},
    {keys: 'Ctrl+E', command: 'para.center', scope: 'app', source: 'spec'},
    {keys: 'Ctrl+E', command: 'control.one', scope: 'app', source: 'control'},
  ]);
  t.r.keydown(key('e', {ctrlKey: true}));
  assert.deepEqual(t.ran, ['para.center']);
  const c = router([{keys: 'Ctrl+J', command: 'a', scope: 'app', source: 'spec'}, {keys: 'Ctrl+J', command: 'b', scope: 'app', source: 'spec'}]);
  assert.equal(c.r.conflicts.length, 1);
});

test('alternatives and key sequences', () => {
  const t = router([
    {keys: 'Ctrl+Y / Ctrl+Shift+Z', command: 'edit.redo', scope: 'app', source: 'command'},
    {keys: 'Ctrl+K, Ctrl+B', command: 'view.toggle', scope: 'app', source: 'spec'},
  ]);
  t.r.keydown(key('z', {ctrlKey: true, shiftKey: true}));
  t.r.keydown(key('y', {ctrlKey: true}));
  assert.deepEqual(t.ran, ['edit.redo', 'edit.redo']);
  assert.equal(t.r.keydown(key('k', {ctrlKey: true})).scope, 'sequence');
  assert.equal(t.r.keydown(key('b', {ctrlKey: true})).binding.command, 'view.toggle');
  assert.deepEqual(bindingSteps('Alt, H, F, F', 'win'), [['Alt', 'H', 'F', 'F']]);
});

test('a sequence times out between steps', () => {
  let now = 0;
  const ran = [];
  const r = new KeyRouter({platform: 'win', bindings: [{keys: 'Ctrl+K, Ctrl+B', command: 'seq', scope: 'app', source: 'spec'}, {keys: 'Ctrl+B', command: 'bold', scope: 'app', source: 'spec'}],
    run: b => ran.push(b.command), now: () => now, sequenceMs: 1000});
  r.keydown(key('k', {ctrlKey: true}));
  now = 5000;
  r.keydown(key('b', {ctrlKey: true}));
  assert.deepEqual(ran, ['bold']);
});

test('Alt tapped alone toggles keytips; Alt with another key does not; F10 does', () => {
  let toggles = 0;
  const kt = {active: () => false, key: () => true, toggle: () => { toggles++; }};
  const t = router([{keys: 'Alt+F', command: 'x', scope: 'app', source: 'spec'}], {keytips: kt});
  t.r.keydown({key: 'Alt', altKey: true});
  t.r.keyup({key: 'Alt'});
  assert.equal(toggles, 1);
  t.r.keydown({key: 'Alt', altKey: true});
  t.r.keydown(key('f', {altKey: true}));
  t.r.keyup({key: 'Alt'});
  assert.equal(toggles, 1);
  assert.deepEqual(t.ran, ['x']);
  t.r.keydown({key: 'F10'});
  assert.equal(toggles, 2);
});

test('ui.key feeds chords without DOM events, Mod resolved per platform', () => {
  const t = router([{keys: 'Mod+B', command: 'format.bold', scope: 'app', source: 'command'}], {platform: 'mac'});
  const results = t.r.feed('Mod+B');
  assert.equal(results[0].handled, true);
  assert.deepEqual(t.ran, ['format.bold']);
  let toggled = false;
  const k = router([], {keytips: {active: () => false, key: () => true, toggle: () => { toggled = true; }}});
  k.r.feed('Alt');
  assert.equal(toggled, true);
  assert.throws(() => t.r.feed('Ctrl+'));
});

test('text fields keep their own typing and caret keys', () => {
  assert.equal(fieldOwns('B', false), true);
  assert.equal(fieldOwns('Ctrl+C', false), true);
  assert.equal(fieldOwns('Ctrl+B', false), false);
  assert.equal(fieldOwns('Enter', true), true);
  assert.equal(fieldOwns('Enter', false), false);
});

test('keytips: overlay letters win, the rest are assigned prefix-free', () => {
  const items = [
    {id: 'paste', label: 'Paste', preferred: 'V'}, {id: 'cut', label: 'Cut', preferred: 'X'}, {id: 'copy', label: 'Copy', preferred: 'C'},
    {id: 'painter', label: 'Format Painter'}, {id: 'font', label: 'Font'}, {id: 'size', label: 'Font Size'}, {id: 'bold', label: 'Bold', preferred: '1'},
    {id: 'find', label: 'Find'}, {id: 'replace', label: 'Replace'}, {id: 'select', label: 'Select'},
  ];
  const tips = assignKeytips(items);
  assert.equal(tips.get('paste'), 'V');
  assert.equal(tips.get('bold'), '1');
  assert.equal(tips.size, items.length);
  assert.ok(prefixFree(tips.values()), [...tips.values()].join(' '));
  assert.equal(new Set(tips.values()).size, items.length);
});

test('keytips: many items with one initial still get unique prefix-free letters', () => {
  const items = Array.from({length: 40}, (_, i) => ({id: `c${i}`, label: `Command ${i}`}));
  const tips = assignKeytips(items);
  assert.equal(tips.size, 40);
  assert.ok(prefixFree(tips.values()));
});

test('keytip matching and QAT numbers', () => {
  const table = new Map([['font', 'FF'], ['size', 'FS'], ['bold', '1']]);
  assert.deepEqual(matchKeytip(table, 'F'), {kind: 'wait'});
  assert.deepEqual(matchKeytip(table, 'fs'), {kind: 'match', id: 'size'});
  assert.deepEqual(matchKeytip(table, 'Q'), {kind: 'miss'});
  const q = qatKeytips(12);
  assert.deepEqual(q.slice(0, 3), ['1', '2', '3']);
  assert.equal(q[9], '09');
  assert.ok(prefixFree(q));
});
