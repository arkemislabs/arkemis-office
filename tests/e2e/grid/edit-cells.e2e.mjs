// U:grid/edit bridge E2E: typing into cells, the fill handle, Delete, copy and paste through the
// keyboard, the Home › Clipboard and Home › Editing ribbon groups, and the family's dialogs
// (Paste Special, Series, Find and Replace, Go To, Go To Special), each undone.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft cmd/edit/cell.rs `cell_set` (typing commits on Enter and the selection
//    moves down), cmd/edit/fill.rs `auto_fill` (the fill handle continues 1, 2 as 3, 4...), edit.rs
//    `clear` (Delete keeps formats), clipboard.rs (Ctrl+C / Ctrl+V move relative references),
//    the dialogs in ui-egui/src/dialogs/{paste,find}.rs and dialogs.rs. Excel does the same.
// 2. Ours: the same commands run from the surface's own handlers (ui.pointer / ui.type / ui.keys,
//    the handlers a click, drag or keystroke runs), from KeyRouter (ui.key) and from the ribbon
//    and dialogs (ui.activate, ui.dialog.*), and the document read back over the bridge matches.
// 3. This flow; captures in artifacts/e2e/grid/edit-cells/*.png were looked at by the author.
//
// Driven only through the bridge: no OS mouse or keyboard, no screen capture (ui.capture).

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {validateContent} from '../../../core/grid/schema.mjs';

const NOW = '2026-10-30T09:00:00.000Z';

function seed() {
  const content = {
    sheets: [{id: 's1', name: 'Sheet1', blocks: {0: {
      A1: {v: 1}, A2: {v: 2}, B1: {v: 'Qty'}, B2: {v: 10}, B3: {v: 20}, B4: {v: 30}, B5: {v: 40},
      D1: {v: 'John Smith'}, D2: {v: 'Ada Lovelace'}, D3: {v: 'Alan Turing'}, E1: {v: 'Smith, John'},
      G1: {v: 'apple'}, G2: {v: 'banana'}, G3: {v: 'apple pie'},
    }}, cols: {3: {size: 110}, 4: {size: 110}}}],
    activeSheetId: 's1', styles: [{}], names: [{name: 'Quantities', formula: 'Sheet1!$B$2:$B$5'}],
  };
  return {id: 'grid-edit', schema: 2, kind: 'grid', title: 'Edit flow', revision: 0, createdAt: NOW, updatedAt: NOW, starred: false, links: [],
    content: validateContent(content)};
}

test('grid edit: typing, the fill handle, clipboard, Delete, ribbon and dialogs, with undo', {timeout: 300_000}, async () => {
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'grid', flow: 'grid/edit-cells', renderer, files: [seed()]});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const doc = 'grid-edit';
  const read = async (address, as = 'values') => (await app.rpc('document.read', {doc, address, as})).value;
  const settle = () => new Promise(r => setTimeout(r, 250));
  const sel = async () => (await app.rpc('selection.get', {doc})).selection.ranges[0];
  const undo = async () => { await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'}); await settle(); };
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000})
      .catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 60_000})
      .catch(e => { throw new Error(e.message + log()); });
    await settle();
    await app.capture('01-opened');

    // Typing into a cell: click, type, Enter commits (cell.set) and moves down.
    await app.rpc('ui.pointer', {doc, action: 'click', cell: 'C2'});
    await app.rpc('ui.type', {doc, text: '12%'});
    await settle();
    await app.capture('02-typing');
    await app.rpc('ui.keys', {doc, key: 'Enter'});
    assert.equal(await read('/sh:s1/C2'), 0.12);
    assert.equal(await read('/sh:s1/C2', 'display'), '12%');
    assert.equal((await sel()).anchor, '/sh:s1/C3', 'Enter moves down');
    // A formula typed without its closing parenthesis.
    await app.rpc('ui.type', {doc, text: '=SUM(B2:B5'});
    await app.rpc('ui.keys', {doc, key: 'Enter'});
    assert.equal(await read('/sh:s1/C3', 'formulas'), '=SUM(B2:B5)');
    assert.equal(await read('/sh:s1/C3'), 100);
    await settle();
    await app.capture('03-formula-entered');

    // The fill handle: select A1:A2 (1, 2) and drag the handle down to A6.
    await app.rpc('ui.pointer', {doc, action: 'drag', cell: 'A1', to: {cell: 'A2'}});
    await app.rpc('ui.pointer', {doc, action: 'drag', target: 'fillHandle', to: {cell: 'A6'}});
    await settle();
    assert.deepEqual(await read('/sh:s1/A1:A6'), [[1], [2], [3], [4], [5], [6]]);
    await app.capture('04-fill-handle-drag');
    await undo();
    assert.equal(await read('/sh:s1/A6'), null, 'the fill is one undo step');

    // Double-clicking the fill handle fills down as far as the column beside it (B2:B5).
    await app.rpc('selection.set', {doc, ranges: [{anchor: '/sh:s1/C2', focus: '/sh:s1/C2'}]});
    await app.rpc('ui.pointer', {doc, action: 'doubleClick', target: 'fillHandle'});
    await settle();
    assert.deepEqual(await read('/sh:s1/C4:C5'), [[0.12], [0.12]]);
    await app.capture('05-fill-handle-double-click');
    await undo();

    // Copy (Ctrl+C) and paste (Ctrl+V): the relative reference moves.
    await app.rpc('selection.set', {doc, ranges: [{anchor: '/sh:s1/C3', focus: '/sh:s1/C3'}]});
    const copy = await app.rpc('ui.key', {doc, keys: 'Ctrl+C'});
    assert.equal(copy.command, 'edit.copy');
    await settle();
    await app.capture('06-copied');
    await app.rpc('selection.set', {doc, ranges: [{anchor: '/sh:s1/F2', focus: '/sh:s1/F2'}]});
    const paste = await app.rpc('ui.key', {doc, keys: 'Ctrl+V'});
    assert.equal(paste.command, 'edit.paste');
    await app.until(async () => (await read('/sh:s1/F2', 'formulas')) === '=SUM(E1:E4)' || null, {timeout: 10_000});
    await settle();
    await app.capture('07-pasted');

    // Delete clears the contents (edit.clearContents), Ctrl+Z brings them back.
    const del = await app.rpc('ui.key', {doc, keys: 'Delete'});
    assert.ok(del.handled, 'Delete reaches the grid (the surface runs edit.clearContents)');
    assert.equal(await read('/sh:s1/F2', 'formulas'), null);
    await undo();
    assert.equal(await read('/sh:s1/F2', 'formulas'), '=SUM(E1:E4)');

    // Home › Clipboard: Cut through the ribbon, Paste through the ribbon (a move).
    await app.rpc('ui.tab', {doc, id: 'home'});
    await app.rpc('selection.set', {doc, ranges: [{anchor: '/sh:s1/A1', focus: '/sh:s1/A2'}]});
    await app.rpc('ui.activate', {doc, control: 'home.clipboard.cut'});
    await app.rpc('selection.set', {doc, ranges: [{anchor: '/sh:s1/A10', focus: '/sh:s1/A10'}]});
    await app.rpc('ui.activate', {doc, control: 'home.clipboard.paste'});
    assert.deepEqual(await read('/sh:s1/A10:A11'), [[1], [2]]);
    assert.equal(await read('/sh:s1/A1'), null);
    await settle();
    await app.capture('08-ribbon-cut-paste');
    await undo();
    assert.equal(await read('/sh:s1/A1'), 1);

    // Paste Special: copy B2:B3, then values transposed with Add.
    await app.rpc('selection.set', {doc, ranges: [{anchor: '/sh:s1/B2', focus: '/sh:s1/B3'}]});
    await app.rpc('ui.key', {doc, keys: 'Ctrl+C'});
    await app.rpc('selection.set', {doc, ranges: [{anchor: '/sh:s1/H5', focus: '/sh:s1/H5'}]});
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.pasteSpecial'});
    await app.rpc('ui.dialog.set', {doc, values: {what: 'values', operation: 'add', transpose: true}});
    await settle();
    await app.capture('09-paste-special');
    await app.rpc('ui.dialog.submit', {doc});
    assert.deepEqual(await read('/sh:s1/H5:I5'), [[10, 20]]);
    await undo();

    // Series: 5 in J1, then a growth series down J1:J5.
    await app.rpc('engine.execute', {doc, command: 'cell.set', params: {cell: '/sh:s1/J1', input: '5'}});
    await app.rpc('selection.set', {doc, ranges: [{anchor: '/sh:s1/J1', focus: '/sh:s1/J5'}]});
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.series'});
    await app.rpc('ui.dialog.set', {doc, values: {type: 'growth', step: 2}});
    await settle();
    await app.capture('10-series');
    await app.rpc('ui.dialog.submit', {doc});
    assert.deepEqual(await read('/sh:s1/J1:J5'), [[5], [10], [20], [40], [80]]);

    // Flash Fill (Ctrl+E) learns "Smith, John".
    await app.rpc('selection.set', {doc, ranges: [{anchor: '/sh:s1/E2', focus: '/sh:s1/E2'}]});
    const flash = await app.rpc('ui.key', {doc, keys: 'Ctrl+E'});
    assert.equal(flash.command, 'edit.flashFill');
    await app.until(async () => (await read('/sh:s1/E3')) === 'Turing, Alan' || null, {timeout: 10_000});
    await settle();
    await app.capture('11-flash-fill');

    // Find and Replace: Find All lists both apples, Replace All on the Replace tab.
    await app.rpc('selection.set', {doc, ranges: [{anchor: '/sh:s1/A1', focus: '/sh:s1/A1'}]});
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.find'});
    await app.rpc('ui.dialog.set', {doc, values: {what: 'apple'}});
    await app.rpc('ui.dialog.submit', {doc, field: 'findAll'});
    const found = (await app.rpc('ui.dialog.get', {doc})).values.results;
    assert.deepEqual(found.map(h => h.cell), ['G1', 'G3'], 'Find All lists every match');
    await settle();
    await app.capture('12-find-all');
    await app.rpc('ui.dialog.set', {doc, tab: 1, values: {with: 'pear'}});
    await app.rpc('ui.dialog.submit', {doc, field: 'replaceAll'});
    assert.equal(await read('/sh:s1/G1'), 'pear');
    assert.equal(await read('/sh:s1/G3'), 'pear pie');
    await settle();
    await app.capture('13-replace-all');
    await app.rpc('ui.dialog.cancel', {doc}).catch(() => {});
    await undo();
    assert.equal(await read('/sh:s1/G1'), 'apple');

    // Go To (F5) a reference, then Go To Special › Formulas.
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.goTo'});
    assert.ok((await app.rpc('ui.dialog.get', {doc})).values.entries.includes('Quantities'), 'Go To lists the defined names');
    await app.rpc('ui.dialog.set', {doc, values: {reference: 'D2:E3'}});
    await settle();
    await app.capture('14-go-to');
    await app.rpc('ui.dialog.submit', {doc});
    assert.deepEqual(await sel(), {anchor: '/sh:s1/D2', focus: '/sh:s1/E3'});
    await app.rpc('selection.set', {doc, ranges: [{anchor: '/sh:s1/A1', focus: '/sh:s1/A1'}]});
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.goToSpecial'});
    await app.rpc('ui.dialog.set', {doc, values: {kind: 'formulas'}});
    await settle();
    await app.capture('15-go-to-special');
    await app.rpc('ui.dialog.submit', {doc});
    const formulas = (await app.rpc('selection.get', {doc})).selection.ranges.map(r => r.anchor);
    assert.ok(formulas.includes('/sh:s1/C3') && formulas.includes('/sh:s1/F2'), `formulas selected: ${formulas.join(', ')}`);
    await settle();
    await app.capture('16-formulas-selected');
  } finally {
    await app.close();
  }
});
