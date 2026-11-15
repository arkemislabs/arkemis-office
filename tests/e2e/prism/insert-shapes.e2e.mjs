// Prism Insert tab and Home › Drawing through the bridge (U:prism/insert, tool).
//
// What deckcraft does (crates/engine/src/cmd/insert.rs, insert/{text_fields,links}.rs, tools.rs;
// ribbon insert.rs, home.rs, galleries.rs shapes_gallery): the Shapes gallery arms the drawing
// tool and the next drag on the slide draws the preset; Text Box inserts a box ready for typing;
// Icons inserts a stroked outline; Table… opens Insert Table; Date & Time opens its dialog and
// inserts a field at the caret; Symbol inserts at the caret; Action buttons link to slides.
// PowerPoint: the same Insert tab. What this proves end to end in the app: ui.activate on the real
// controls, a drawing drag through ui.pointer, the Insert Table, Date and Time and Symbol dialogs
// submitting, and Ctrl+Z through the KeyRouter. Captures in artifacts/e2e/prism/insert-shapes/.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';

test('prism insert: shapes gallery + draw, text box, icon, table dialog, date and symbol at the caret, action button, undo', {timeout: 240_000}, async () => {
  const file = createFile('prism', 'Insert deck', {schema: 2});
  file.id = 'prism-insert-shapes';
  file.content.slides[0].layout = file.content.masters[0].layouts.find(l => l.kind === 'blank').id;
  file.content.slides[0].shapes = [];
  const sid = file.content.slides[0].id;
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/insert-shapes', files: [file], renderer});
  const doc = file.id;
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const deck = async () => (await app.rpc('document.read', {doc, address: '/', as: 'json'})).value;
  const shapes = async () => (await deck()).slides[0].shapes;
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});
    await app.rpc('ui.tab', {doc, tab: 'insert'});

    // Shapes gallery › Star: 5 Points, then a drag on the slide draws it.
    await app.rpc('ui.activate', {doc, control: 'insert.illustrations.shapes', value: 'star5'});
    await app.rpc('ui.pointer', {doc, events: [{kind: 'down', x: 100, y: 100}, {kind: 'drag', x: 180, y: 160}, {kind: 'drag', x: 220, y: 200}, {kind: 'up', x: 220, y: 200}], tol: 4});
    let list = await shapes();
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].geom, {kind: 'preset', name: 'star5'});
    assert.ok(Math.abs(list[0].xfrm.w - 120) <= 7 && Math.abs(list[0].xfrm.h - 100) <= 7, JSON.stringify(list[0].xfrm));
    await app.capture('1-drawn-star');

    // Icons gallery › Check; Text Box.
    await app.rpc('ui.activate', {doc, control: 'insert.illustrations.icons', value: 'check'});
    list = await shapes();
    assert.equal(list.at(-1).name, 'Check');
    assert.equal(list.at(-1).geom.kind, 'custom');
    await app.rpc('ui.activate', {doc, control: 'insert.text.text-box'});
    list = await shapes();
    assert.equal(list.at(-1).textBox, true);
    const box = list.at(-1).id;
    // Typing goes into the new box; then Date & Time (dialog) and a symbol at the caret.
    await app.rpc('engine.execute', {doc, command: 'text.insert', params: {text: 'Today: '}});
    await app.rpc('ui.activate', {doc, control: 'insert.text.date-time'});
    let dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.dateTime');
    await app.rpc('ui.dialog.set', {field: 'format', value: 'datetime4'});
    await app.capture('2-date-time-dialog');
    await app.rpc('ui.dialog.submit', {});
    let runs = (await shapes()).find(s => s.id === box).text.paragraphs[0].runs;
    assert.ok(runs.some(r => r.kind?.kind === 'field' && r.kind.field === 'datetime4'), JSON.stringify(runs));
    await app.rpc('ui.dialog.open', {id: 'dialog.symbol'});
    await app.rpc('ui.dialog.set', {field: 'currency', value: '€'});
    await app.capture('3-symbol-dialog');
    await app.rpc('ui.dialog.submit', {});
    runs = (await shapes()).find(s => s.id === box).text.paragraphs[0].runs;
    assert.match(runs.map(r => r.text).join(''), /€$/);

    // Table › Insert Table…: 3 × 4.
    await app.rpc('engine.execute', {doc, command: 'text.exit', params: {}}).catch(() => {});
    await app.rpc('ui.activate', {doc, control: 'insert.tables.table.insert-table'});
    dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.table');
    await app.rpc('ui.dialog.set', {field: 'cols', value: 3});
    await app.rpc('ui.dialog.set', {field: 'rows', value: 4});
    await app.rpc('ui.dialog.submit', {});
    const table = (await shapes()).at(-1);
    assert.equal(table.kind.type, 'table');
    assert.deepEqual([table.kind.rows.length, table.kind.cols.length], [4, 3]);
    await app.capture('4-table');

    // Action › Action Button: forward; then Ctrl+Z removes it.
    await app.rpc('ui.activate', {doc, control: 'insert.links.action.action-button-forward'});
    list = await shapes();
    assert.deepEqual(list.at(-1).click.action, {kind: 'nextSlide'});
    const n = list.length;
    const k = await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    assert.equal(k.handled, true);
    assert.equal((await shapes()).length, n - 1);
    await app.capture('5-after-undo');
    void sid;
  } finally {
    await app.close();
  }
});
