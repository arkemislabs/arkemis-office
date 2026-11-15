// Every Insert tab command (U:quill/insert): an undo round trip on a schema-2 document through the
// kernel, the picture probe, and the Insert dialogs' models (Link, Bookmark, Symbol, Field, Date and
// Time, Drop Cap).
//
// Behaviour fidelity:
// 1. ArtCraft: crates/engine/src/cmd/insert.rs + insert/{objects,items,links,header_footer}.rs (the
//    commands) and crates/ui-egui/src/dialogs/{dispatch.rs link_dialog, bookmarks.rs,
//    dialogs_insert/{symbol,field,columns}.rs} (the dialogs). Word's Insert tab and its dialogs do
//    the same: page breaks and blank pages, cover pages, tables, pictures, shapes and text boxes,
//    links and bookmarks, headers, footers and page numbers, date and time, symbols, fields, drop caps.
// 2. Each edit command is one undo step (undo restores content and selection, redo reproduces it);
//    each dialog's OK runs the command upstream's dialog runs.
// 3. This file (engine), tests/quill/upstream/insert_tests.test.mjs (upstream's own tests) and
//    tests/e2e/quill/insert-tab.e2e.mjs (the Insert tab through the bridge, with captures).
// Not translated (hidden): insert.icon (needs upstream's icon library artwork and rasterizer,
// crates/render icon_lib), insert.textFromFile (needs a host file read + the docx reader in the
// command; the host has no such service yet).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {openDialogModel, submitDialog, changeDialogValues} from '../../core/kernel/dialog.mjs';
import {doc, blocks, firstTable, ready, selectBody} from './table-helpers.mjs';
import {base64Encode, probe} from '../../core/quill/lib/insert-objects.mjs';
import * as P from '../../core/quill/model/para.mjs';
import {instruction} from '../../core/quill/dialogs/field.mjs';

await ready();
const dialogs = (await import('../../core/generated/quill.dialogs.mjs')).dialogs;

/** A 1×1 PNG. */
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));

/** "Hello world" with the caret after "Hello". */
async function hello() {
  const t = await doc('Hello world\nSecond paragraph');
  selectBody(t, [0, 5], [0, 5]);
  return t;
}

const cases = [
  ['insert.pageBreak', {}], ['insert.blankPage', {}], ['insert.coverPage', {title: 'Report', subtitle: 'Q4', author: 'Ann'}],
  ['insert.table', {rows: 2, cols: 3}], ['insert.picture', {data: base64Encode(PNG), width: 72, alt: 'dot'}],
  ['insert.shape', {kind: 'rectangle'}], ['insert.textBox', {text: 'Boxed'}], ['insert.link', {url: 'https://example.com', text: 'Example'}],
  ['insert.bookmark', {name: 'Here'}], ['insert.header', {text: 'Head'}], ['insert.footer', {preset: 'pageNumber'}],
  ['insert.pageNumber', {position: 'bottom', align: 'center'}], ['insert.createHeader', {}], ['insert.createFooter', {}],
  ['insert.dateTime', {format: 'yyyy-MM-dd'}], ['insert.symbol', {char: '©'}], ['insert.field', {instr: 'PAGE'}],
  ['insert.dateField', {}], ['insert.timeField', {}], ['insert.pageField', {}], ['insert.dropCap', {position: 'dropped', lines: 3}],
  ['insert.horizontalLine', {}], ['insert.editHeader', {}], ['insert.editFooter', {}],
];
for (const [id, params] of cases) {
  test(`${id}: one undo step`, async () => {
    const t = await hello();
    await expectUndoRoundTrip(t, id, params);
  });
}

test('insert.removeLink, insert.deleteBookmark, insert.removeHeader / Footer, removeEmptyHeaders: one undo step each', async () => {
  let t = await hello();
  selectBody(t, [0, 0], [0, 5]);
  await t.exec('insert.link', {url: 'https://example.com'});
  selectBody(t, [0, 0], [0, 5]);
  await expectUndoRoundTrip(t, 'insert.removeLink', {});
  await t.exec('insert.bookmark', {name: 'Mark'});
  await expectUndoRoundTrip(t, 'insert.deleteBookmark', {name: 'Mark'});
  t = await hello();
  await t.exec('insert.header', {text: 'Head'});
  await t.exec('insert.footer', {text: 'Foot'});
  await t.exec('insert.closeHeader');
  await expectUndoRoundTrip(t, 'insert.removeHeader', {});
  await expectUndoRoundTrip(t, 'insert.removeFooter', {});
  t = await hello();
  await t.exec('insert.editHeader', {page: 0});
  await expectUndoRoundTrip(t, 'insert.removeEmptyHeaders', {});
});

test('insert.closeHeader returns to the body; link.targets lists the top, headings and bookmarks', async () => {
  const t = await hello();
  await t.exec('insert.bookmark', {name: 'Spot'});
  const r = await t.exec('link.targets');
  assert.equal(r.result.top, true);
  assert.deepEqual(r.result.bookmarks, ['Spot']);
  await t.exec('insert.editHeader');
  await t.exec('text.insert', {text: 'H'});
  await t.exec('insert.closeHeader');
  assert.match(t.doc.selection.ranges[0].focus, /^\/body\//);
});

test('insert.textBox is disabled inside a text box (upstream `when`)', async () => {
  const t = await hello();
  await t.exec('insert.textBox', {text: 'In'});
  const st = t.state('insert.textBox');
  assert.equal(st.enabled, false);
  assert.match(st.reason, /text box/);
});

test('the picture probe refuses TIFFs with JPEG strips (#3645) and reads PNG sizes', () => {
  const tiff = new Uint8Array(8 + 2 + 12 * 3 + 4);
  const dv = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49, 0x2a, 0x00]);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, 3, true);
  const entry = (i, tag, val) => { const o = 10 + 12 * i; dv.setUint16(o, tag, true); dv.setUint16(o + 2, 3, true); dv.setUint32(o + 4, 1, true); dv.setUint16(o + 8, val, true); };
  entry(0, 256, 4); entry(1, 257, 4); entry(2, 259, 7);
  assert.match(probe(tiff).refused ?? '', /TIFF/);
  entry(2, 259, 1);
  assert.equal(probe(tiff).refused, undefined);
  const p = probe(PNG);
  assert.deepEqual([p.width, p.height], [1, 1]);
});

// ---- dialogs ------------------------------------------------------------------------------------

async function open(t, id, set = {}) {
  const d = dialogs[id];
  assert.ok(d, `dialog model ${id}`);
  let v = openDialogModel(t.session, t.docId, d);
  for (const [k, x] of Object.entries(set)) v = changeDialogValues(d, v, k, x);
  return [d, v];
}

test('dialog.link: an address, and a place in this document', async () => {
  const t = await hello();
  selectBody(t, [0, 0], [0, 5]);
  let [d, v] = await open(t, 'dialog.link', {address: 'https://example.com'});
  assert.equal(v.text, 'Hello');
  await submitDialog(t.session, t.docId, d, v);
  assert.equal(P.propsAt(blocks(t)[0], 0).link, 'https://example.com');
  await t.exec('insert.bookmark', {name: 'Target'});
  selectBody(t, [1, 0], [1, 6]);
  [d, v] = await open(t, 'dialog.link', {linkTo: 'place'});
  const target = v.places.find(o => o.label === 'Target');
  assert.ok(target, JSON.stringify(v.places));
  v = changeDialogValues(d, v, 'place', target.value);
  await submitDialog(t.session, t.docId, d, v);
  assert.equal(P.propsAt(blocks(t)[1], 0).link, '#Target');
  assert.ok(d.validate({linkTo: 'file', address: ''}).length);
});

test('dialog.bookmark: Add, then Go To and Delete through its buttons', async () => {
  const t = await hello();
  selectBody(t, [0, 6], [0, 11]);
  let [d, v] = await open(t, 'dialog.bookmark', {name: 'World'});
  await submitDialog(t.session, t.docId, d, v);
  [d, v] = await open(t, 'dialog.bookmark');
  assert.equal(v.name, 'World', 'opens on the bookmark around the caret');
  assert.deepEqual(d.buttons.goTo(null, v), {command: 'edit.goto', params: {bookmark: 'World'}});
  const del = d.buttons.delete(null, v);
  await t.exec(del.command, del.params);
  assert.equal(P.objectsWithOffsets(blocks(t)[0]).length, 0);
  assert.ok(d.validate({name: '1bad'}).length, 'invalid names are refused');
});

test('dialog.symbol: a symbol in its font, a typed code, and a special character', async () => {
  const t = await hello();
  let [d, v] = await open(t, 'dialog.symbol', {code: '2665', font: 'Segoe UI Symbol'});
  assert.equal(v.grid, 0x2665);
  assert.equal(v.subset, 'Miscellaneous Symbols');
  await submitDialog(t.session, t.docId, d, v);
  assert.ok(blocks(t)[0].text.includes('♥'));
  [d, v] = await open(t, 'dialog.symbol', {list: 'Em Dash'});
  await submitDialog(t.session, t.docId, d, v);
  assert.ok(blocks(t)[0].text.includes('—'));
  [d, v] = await open(t, 'dialog.symbol', {subset: 'Arrows'});
  assert.equal(v.grid, 0x2190);
});

test('dialog.field: field codes from the options (FieldForm::instruction)', async () => {
  const t = await hello();
  let [d, v] = await open(t, 'dialog.field');
  assert.equal(v.names, 'DATE');
  assert.equal(instruction(v), 'DATE \\@ "M/d/yyyy" \\* MERGEFORMAT');
  v = changeDialogValues(d, v, 'names', 'PAGE');
  v = changeDialogValues(d, v, 'numberFormat', 'roman');
  assert.equal(v.codes, 'PAGE \\* roman \\* MERGEFORMAT');
  await submitDialog(t.session, t.docId, d, v);
  const obj = P.objectsWithOffsets(blocks(t)[0]).find(([, o]) => o.type === 'field');
  assert.equal(obj[1].instr, 'PAGE \\* roman \\* MERGEFORMAT');
  [d, v] = await open(t, 'dialog.field', {names: 'TOC'});
  assert.equal(v.codes, 'TOC \\o "1-3" \\h \\z \\u');
  v = changeDialogValues(d, v, 'categories', 'Mail Merge');
  assert.equal(v.names, 'MERGEFIELD');
});

test('dialog.dateTime: a format, as text or as a DATE field', async () => {
  const t = await hello();
  let [d, v] = await open(t, 'dialog.dateTime', {formats: 'yyyy-MM-dd'});
  assert.ok(v.formatOptions.length > 10);
  await submitDialog(t.session, t.docId, d, v);
  assert.match(blocks(t)[0].text, /\d{4}-\d{2}-\d{2}/);
  [d, v] = await open(t, 'dialog.dateTime', {formats: 'MMMM d, yyyy', updateAuto: true});
  await submitDialog(t.session, t.docId, d, v);
  assert.ok(P.objectsWithOffsets(blocks(t)[0]).some(([, o]) => o.type === 'field' && /^DATE/.test(o.instr)));
});

test('dialog.dropCap: Dropped, 2 lines; None takes it off', async () => {
  const t = await hello();
  let [d, v] = await open(t, 'dialog.dropCap', {position: 'dropped', lines: 2});
  await submitDialog(t.session, t.docId, d, v);
  assert.equal(blocks(t)[0].props.dropCap, 2);
  [d, v] = await open(t, 'dialog.dropCap');
  assert.equal(v.position, 'dropped');
  v = changeDialogValues(d, v, 'position', 'none');
  await submitDialog(t.session, t.docId, d, v);
  assert.equal(blocks(t)[0].props?.dropCap, undefined);
  void firstTable;
});
