// core/folio/commands/organize.mjs: the Organize grid's Move earlier / Move later, the page size in the grid, Page properties (tab
// order) and Page transitions.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft (printcraft 0.16.0 crates/ui-egui/src/canvas/organize.rs organize_toolbar, canvas/zoom.rs GRID_ZOOM_RANGE and STEP,
//    commands.rs and dialogs.rs for Page Properties, crates/forms/src/tab_order.rs, crates/organize/src/transition.rs and its tests):
//    Move earlier and Move later move the selected pages (else the current one) one place, off at either end; Larger pages and
//    Smaller pages scale the grid by 1.25 within 50 % to 300 % and the percentage resets it; Page properties sets /Tabs R, C or S
//    (unspecified removes it) and adds no undo step when every page already has the order; transitions write only the entries the style
//    reads and that differ from the defaults, refuse values out of range before any page changes, and remove /Trans and /Dur when left
//    out. Acrobat's Organize Pages, Page Properties and Set Transitions work the same way.
// 2. Ours does the same on real PDFs: the file is read back with pdf-lib after every edit.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, PDFDict} from 'pdf-lib';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {releaseTextSources} from '../../core/folio/model/page-text.mjs';
import dialog from '../../core/folio/dialogs/page-properties.mjs';
import {transEntries, checkTransition, GRID_ZOOM_STEP} from '../../core/folio/commands/organize.mjs';

after(() => releaseTextSources());
const open = () => createTestSession('folio', {fixture: 'textPages'});
const select = (t, ...ids) => t.session.setSelection(t.docId, {ranges: ids.map(id => ({anchor: `/pg:${id}`, focus: `/pg:${id}`})), primary: 0});
const file = async t => PDFDocument.load(Buffer.from(t.content.sourceBase64, 'base64'));
const entry = (doc, i, key) => doc.getPage(i).node.lookup(PDFName.of(key));

test('Move earlier and Move later move the selected pages one place; off at either end of the document', async () => {
  const t = await open();
  select(t, 'p2');
  assert.equal(t.state('organize.move', {by: 1}).enabled, false, 'the last page is already last');
  assert.match(t.state('organize.move', {by: 1}).reason, /last/);
  assert.equal(t.state('organize.move', {by: -1}).enabled, true);
  const r = await expectUndoRoundTrip(t, 'organize.move', {by: -1}, after => assert.deepEqual(after.content.pages.map(p => p.id), ['p2', 'p1']));
  assert.equal(r.undoLabel, 'Move page');
  assert.equal(t.state('organize.move', {by: -1}).enabled, false, 'the first page is already first');
  await assert.rejects(() => t.exec('organize.move', {by: -1}), /already first/);
  await t.exec('organize.move', {by: 1});
  assert.deepEqual(t.content.pages.map(p => p.id), ['p1', 'p2']);
  assert.equal(t.doc.selection.ranges[0].anchor, '/pg:p2', 'the moved page stays selected');
});

test('with nothing selected the current page moves', async () => {
  const t = await open();
  assert.equal(t.state('organize.move', {by: -1}).enabled, false, 'page 1 is current');
  assert.equal(t.state('organize.move', {by: 1}).enabled, true);
  await t.exec('organize.move', {by: 1});
  assert.deepEqual(t.content.pages.map(p => p.id), ['p2', 'p1']);
});

test('the grid size scales by 1.25 within 50 % to 300 %, resets to 100 % and reads as a percentage', async () => {
  const t = await open();
  assert.equal(t.state('organize.zoom', {mode: 'reset'}).value, '100%');
  await t.exec('organize.zoom', {mode: 'in'});
  assert.equal(t.doc.view.gridZoom, GRID_ZOOM_STEP);
  assert.equal(t.state('organize.zoom', {mode: 'reset'}).value, '125%');
  for (let i = 0; i < 12; i++) await t.exec('organize.zoom', {mode: 'in'}).catch(() => {});
  assert.equal(t.doc.view.gridZoom, 3, 'clamped at 300 %');
  assert.equal(t.state('organize.zoom', {mode: 'in'}).enabled, false);
  await t.exec('organize.zoom', {mode: 'reset'});
  assert.equal(t.doc.view.gridZoom, 1);
  for (let i = 0; i < 12; i++) await t.exec('organize.zoom', {mode: 'out'}).catch(() => {});
  assert.equal(t.doc.view.gridZoom, 0.5);
  assert.equal(t.state('organize.zoom', {mode: 'out'}).enabled, false);
  assert.equal((await t.exec('organize.zoom', {percent: 150})).result.zoom, 150);
});

test('Page properties writes /Tabs for the target pages; the orders they have come back without `order`; an order every page has adds no step', async () => {
  const t = await open();
  const read = (await t.exec('page.properties', {})).result;
  assert.deepEqual([read.orders, read.order], [['unspecified'], 'unspecified'], 'only the current page is the target');
  select(t, 'p1', 'p2');
  assert.equal((await t.exec('page.properties', {})).result.order, 'unspecified');
  const r = await expectUndoRoundTrip(t, 'page.properties', {order: 'row'}, after => assert.ok(after.content.sourceBase64));
  assert.equal(r.undoLabel, 'Set tab order');
  assert.equal(r.result.changed, 2);
  const doc = await file(t);
  assert.deepEqual([entry(doc, 0, 'Tabs').decodeText(), entry(doc, 1, 'Tabs').decodeText()], ['R', 'R']);
  assert.equal((await t.exec('page.properties', {})).result.order, 'row');
  const version = t.version;
  const same = await t.exec('page.properties', {order: 'row'});
  assert.equal(same.result.changed, 0);
  assert.equal(t.version, version, 'an order every page already has adds no undo step');
  await t.exec('page.properties', {order: 'column', pages: [1]});
  assert.deepEqual((await t.exec('page.properties', {pages: [0, 1]})).result.orders, ['row', 'column']);
  assert.equal((await t.exec('page.properties', {pages: [0, 1]})).result.order, null, 'the pages differ');
  await t.exec('page.properties', {order: 'structure'});
  assert.equal(entry(await file(t), 1, 'Tabs').decodeText(), 'S');
  await t.exec('page.properties', {order: 'unspecified'});
  assert.equal(entry(await file(t), 0, 'Tabs'), undefined, 'unspecified removes /Tabs');
  await assert.rejects(() => t.exec('page.properties', {order: 'diagonal'}), /order/);
  await assert.rejects(() => t.exec('page.properties', {order: 'row', pages: [9]}), /page 10/);
});

test('the Page Properties dialog offers Acrobat\'s four orders and submits the one chosen', () => {
  assert.deepEqual(dialog.init({}), {order: 'Unspecified'});
  for (const [label, order] of [['Use Row Order', 'row'], ['Use Column Order', 'column'], ['Use Document Structure', 'structure'], ['Unspecified', 'unspecified']]) {
    assert.deepEqual(dialog.toCommand({order: label}), {command: 'page.properties', params: {order}});
  }
  assert.equal(dialog.validate({order: 'nope'}).length, 1);
});

test('a transition writes only what differs from the defaults and what the style reads (trans_dict)', async () => {
  const d = o => Object.fromEntries(Object.entries(transEntries(o)).map(([k, v]) => [k, v?.decodeText?.() ?? v]));
  assert.deepEqual(d({style: 'Dissolve'}), {Type: 'Trans', S: 'Dissolve'});
  assert.deepEqual(d({style: 'Dissolve', duration: 2, dimension: 'vertical', direction: 90, scale: 3, opaque: true}), {Type: 'Trans', S: 'Dissolve', D: 2}, 'Dissolve reads only the duration');
  assert.deepEqual(d({style: 'Split', dimension: 'vertical', motion: 'outward', direction: 90}), {Type: 'Trans', S: 'Split', Dm: 'V', M: 'O'});
  assert.deepEqual(d({style: 'Blinds', dimension: 'vertical', motion: 'outward'}), {Type: 'Trans', S: 'Blinds', Dm: 'V'});
  assert.deepEqual(d({style: 'Wipe', direction: 270}), {Type: 'Trans', S: 'Wipe', Di: 270});
  assert.deepEqual(d({style: 'Wipe', direction: 0}), {Type: 'Trans', S: 'Wipe'});
  assert.deepEqual(d({style: 'Fly', direction: null, scale: 2, opaque: true, motion: 'outward'}), {Type: 'Trans', S: 'Fly', M: 'O', Di: 'None', SS: 2, B: true});
  assert.deepEqual(d({style: 'Box', motion: 'outward', scale: 4}), {Type: 'Trans', S: 'Box', M: 'O'});
});

test('Page transitions are set on the target pages, with a display time, and removed when left out', async () => {
  const t = await open();
  select(t, 'p1', 'p2');
  const r = await expectUndoRoundTrip(t, 'page.transitions', {style: 'Wipe', direction: 90, duration: 2, display: 5}, after => assert.ok(after.content.sourceBase64));
  assert.equal(r.undoLabel, 'Set page transitions');
  let doc = await file(t);
  for (const i of [0, 1]) {
    const trans = entry(doc, i, 'Trans');
    assert.ok(trans instanceof PDFDict);
    assert.deepEqual([trans.lookup(PDFName.of('S')).decodeText(), trans.lookup(PDFName.of('D')).asNumber(), trans.lookup(PDFName.of('Di')).asNumber()], ['Wipe', 2, 90]);
    assert.equal(entry(doc, i, 'Dur').asNumber(), 5);
  }
  await t.exec('page.transitions', {pages: [1], display: 3});
  doc = await file(t);
  assert.ok(entry(doc, 0, 'Trans'), 'the other page keeps its transition');
  assert.equal(entry(doc, 1, 'Trans'), undefined, 'left out: removed');
  assert.equal(entry(doc, 1, 'Dur').asNumber(), 3);
  await t.exec('page.transitions', {});
  doc = await file(t);
  assert.deepEqual([entry(doc, 0, 'Trans'), entry(doc, 0, 'Dur'), entry(doc, 1, 'Dur')], [undefined, undefined, undefined]);
});

test('transition values are checked before any page changes', async () => {
  const t = await open();
  const before = t.content.sourceBase64;
  for (const [bad, message] of [[{style: 'Zoom'}, /style/], [{style: 'Wipe', duration: -1}, /duration/], [{style: 'Wipe', direction: 45}, /direction/], [{style: 'Fly', scale: 0}, /scale|range|least/i], [{display: -3}, /display|range|least/i]]) {
    await assert.rejects(() => t.exec('page.transitions', bad), message, JSON.stringify(bad));
  }
  assert.equal(t.content.sourceBase64, before, 'nothing changed');
  assert.throws(() => checkTransition({style: 'Fly', direction: 45}), /direction must be one of 0, 90, 180, 270, 315/);
  assert.doesNotThrow(() => checkTransition({style: 'Fly', direction: null}));
  await assert.rejects(() => t.exec('page.transitions', {style: 'Wipe', pages: [7]}), /page 8/);
});
