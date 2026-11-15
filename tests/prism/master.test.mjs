// U:prism/masters: the master views (view.slideMaster, handoutMaster, notesMaster, closeMaster), the
// layout commands (master.insertLayout, renameLayout, deleteLayout, insertPlaceholder, preserve,
// placeholders), the handout and notes placeholders, handout.perPage, Format Background and the
// design commands in master context, and the .pptx round trip of what they change.
//
// 1. ArtCraft: crates/engine/src/cmd/design/master_view.rs and its tests (design/tests.rs
//    preserve_and_placeholders_edit_the_open_master_or_layout, master_view_closed_rejects,
//    layout_placeholders_edit_one_undo_step, missing_title_placeholder_is_recreated).
//    PowerPoint: View > Slide Master, Handout Master, Notes Master.
// 2. Ours: core/prism/commands/master.mjs and the master branches of design.mjs.
// 3. These tests and tests/e2e/prism/masters.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import master from '../../core/prism/commands/master.mjs';
import design from '../../core/prism/commands/design.mjs';
import renameLayoutDialog from '../../core/prism/dialogs/renameLayout.mjs';
import {withNew} from './upstream/text_deck.mjs';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {exportPptx} from '../../core/prism/formats/pptx-write.mjs';
import {importPptx} from '../../core/prism/formats/pptx-read.mjs';
import {hex} from '../../core/prism/model/color.mjs';

const deck = async () => withNew({extra: [master, design]});
const layouts = t => t.content.masters[0].layouts;
const phKinds = shapes => shapes.filter(s => s.ph).map(s => s.ph.kind);

test('view.slideMaster opens on the current slide layout, a master thumbnail means the master itself; Close Master View leaves', async () => {
  const t = await deck();
  assert.equal(t.state('view.closeMaster').enabled, false);
  await t.exec('view.slideMaster', {});
  const lay = t.doc.view.master;
  assert.deepEqual([lay.kind, lay.master], ['slide', 0]);
  assert.equal(layouts(t)[lay.layout].id, t.content.slides[0].layout, 'the current slide layout');
  await t.exec('view.slideMaster', {master: 0});
  assert.equal(t.doc.view.master.layout, null, 'only `master`: the master itself');
  await t.exec('view.slideMaster', {master: 0, layout: 2});
  assert.equal(t.doc.view.master.layout, 2);
  await assert.rejects(t.exec('view.slideMaster', {master: 5}), /no such master/);
  await assert.rejects(t.exec('view.slideMaster', {master: 0, layout: 99}), /no such layout/);
  assert.equal(t.state('view.slideMaster').checked, true);
  await t.exec('view.closeMaster', {});
  assert.equal(t.doc.view.master, null);
  await assert.rejects(t.exec('master.preserve', {}), /open View/);
  await assert.rejects(t.exec('master.insertLayout', {}), /open View/);
});

test('Insert Layout, Rename, Delete: a custom layout with a title after the open one; layouts in use stay', async () => {
  const t = await deck();
  await t.exec('view.slideMaster', {master: 0, layout: 1});
  const n = layouts(t).length;
  await expectUndoRoundTrip(t, 'master.insertLayout', {});
  assert.equal(layouts(t).length, n + 1);
  const added = layouts(t)[2];
  assert.deepEqual([added.name, added.kind, added.preserve], ['Custom Layout', 'custom', true]);
  assert.deepEqual(phKinds(added.shapes), ['title']);
  assert.equal(t.doc.view.master.layout, 2, 'the new layout is open');
  await t.exec('master.renameLayout', {name: 'Brand title'});
  assert.equal(layouts(t)[2].name, 'Brand title');
  assert.equal(renameLayoutDialog.init(t.session.readContext(t.docId)).name, 'Brand title');
  assert.deepEqual(renameLayoutDialog.toCommand({name: ' New name '}), {command: 'master.renameLayout', params: {name: 'New name'}});
  assert.equal(renameLayoutDialog.validate({name: ' '}).length, 1);
  await expectUndoRoundTrip(t, 'master.deleteLayout', {});
  assert.equal(layouts(t).length, n, 'deleted');
  const inUse = layouts(t).findIndex(l => l.id === t.content.slides[0].layout);
  await t.exec('view.slideMaster', {master: 0, layout: inUse});
  await assert.rejects(t.exec('master.deleteLayout', {}), /slides use this layout/);
  await t.exec('view.slideMaster', {master: 0});
  assert.equal(t.state('master.deleteLayout').enabled, false, 'the master itself has no layout to delete');
});

test('Preserve, Title and Footers on a layout and the master; Insert Placeholder; one undo step each', async () => {
  const t = await deck();
  await t.exec('view.slideMaster', {master: 0, layout: 2});
  const kinds = () => phKinds(layouts(t)[2].shapes);
  assert.equal(t.state('master.preserve').checked, !!layouts(t)[2].preserve);
  await expectUndoRoundTrip(t, 'master.preserve', {preserve: !layouts(t)[2].preserve});
  await t.exec('master.preserve', {});
  await t.exec('master.placeholders', {footers: false});
  assert.ok(!kinds().some(k => ['date', 'footer', 'slideNum'].includes(k)));
  await expectUndoRoundTrip(t, 'master.placeholders', {footers: true});
  assert.ok(['date', 'footer', 'slideNum'].every(k => kinds().includes(k)));
  const num = layouts(t)[2].shapes.find(s => s.ph.kind === 'slideNum');
  assert.deepEqual(num.text.paragraphs[0].runs[0].kind, {kind: 'field', field: 'slidenum'}, 'a slide number keeps its field');
  assert.equal(num.text.paragraphs.length, 1);
  await t.exec('master.placeholders', {title: false});
  assert.ok(!kinds().includes('title'));
  assert.equal(t.state('master.placeholders', {field: 'title'}).checked, false);
  await t.exec('master.placeholders', {title: true});
  assert.ok(kinds().includes('title'), 'a missing title is brought back from the master');
  const ids = layouts(t)[2].shapes.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length, 'fresh unique ids');
  await assert.rejects(t.exec('master.placeholders', {}), /give title or footers/);
  const count = layouts(t)[2].shapes.length;
  await expectUndoRoundTrip(t, 'master.insertPlaceholder', {kind: 'picture'});
  assert.equal(layouts(t)[2].shapes.length, count + 1);
  const p = layouts(t)[2].shapes.at(-1);
  assert.equal(p.ph.kind, 'picture');
  assert.ok(p.ph.idx > 0);
  await t.exec('master.insertPlaceholder', {kind: 'content', rect: [10, 20, 300, 200]});
  assert.deepEqual([layouts(t)[2].shapes.at(-1).ph.kind, layouts(t)[2].shapes.at(-1).xfrm.w], ['obj', 300]);
  // On the master itself the same commands edit the master shapes; Insert Placeholder wants a layout.
  await t.exec('view.slideMaster', {master: 0});
  await t.exec('master.placeholders', {footers: false});
  assert.ok(!phKinds(t.content.masters[0].shapes).includes('footer'));
  await assert.rejects(t.exec('master.insertPlaceholder', {kind: 'text'}), /select a layout/);
  assert.equal(t.state('master.insertPlaceholder').enabled, false);
});

test('the handout master: created with its four placeholders, each toggled, slides per page; the notes master with its six', async () => {
  const t = await deck();
  assert.equal(t.content.handoutMaster, null);
  assert.equal((await t.exec('view.handoutMaster', {})).result.created, true);
  assert.equal(t.doc.view.master.kind, 'handout');
  assert.deepEqual(phKinds(t.content.handoutMaster.shapes).sort(), ['date', 'footer', 'header', 'slideNum']);
  assert.equal((await t.exec('view.handoutMaster', {})).result.created, false, 'opened again, not recreated');
  await t.exec('handout.placeholders', {header: false, pageNumber: false});
  assert.deepEqual(phKinds(t.content.handoutMaster.shapes).sort(), ['date', 'footer']);
  assert.equal(t.state('handout.placeholders', {field: 'header'}).checked, false);
  assert.equal(t.state('handout.placeholders', {field: 'date'}).checked, true);
  await expectUndoRoundTrip(t, 'handout.placeholders', {header: true});
  assert.ok(phKinds(t.content.handoutMaster.shapes).includes('header'));
  assert.equal((await t.exec('handout.perPage', {})).result.n, 6);
  await t.exec('handout.perPage', {n: 3});
  assert.equal(t.doc.view.handoutPerPage, 3);
  await assert.rejects(t.exec('handout.perPage', {n: 5}), /slides per page/);
  assert.deepEqual(t.state('handout.perPage').value.map(r => r.checked), [false, false, true, false, false, false]);
  await t.exec('view.closeMaster', {});
  await assert.rejects(t.exec('handout.placeholders', {date: false}), /open the master view/);
  assert.equal(t.state('handout.perPage').enabled, false);

  assert.equal((await t.exec('view.notesMaster', {})).result.created, true);
  assert.deepEqual(phKinds(t.content.notesMaster.shapes).sort(), ['body', 'date', 'footer', 'header', 'slideImage', 'slideNum']);
  const body = t.content.notesMaster.shapes.find(s => s.ph.kind === 'body');
  assert.equal(body.text.paragraphs[0].runs[0].text, 'Click to edit Master text styles');
  await t.exec('notes.placeholders', {slideImage: false, body: false});
  assert.ok(!phKinds(t.content.notesMaster.shapes).includes('slideImage'));
  await t.exec('notes.placeholders', {slideImage: true});
  const img = t.content.notesMaster.shapes.find(s => s.ph.kind === 'slideImage');
  assert.ok(Math.abs(img.xfrm.w - 540 * 0.75) < 1e-9 && img.line.width === 1);
  assert.equal(t.state('notes.placeholders', {field: 'body'}).checked, false);
});

test('design commands in a master view: Format Background sets the layout, the master, the handout or the notes page; themes follow the open master', async () => {
  const t = await deck();
  await t.exec('view.slideMaster', {master: 0, layout: 1});
  await t.exec('design.background', {color: '#223344'});
  assert.equal(hex(layouts(t)[1].background.fill.color.base.rgb), '223344');
  assert.equal(t.content.slides[0].background ?? null, null, 'no slide changed');
  await t.exec('design.background', {transparency: 0.5});
  assert.deepEqual(layouts(t)[1].background.fill.color.mods, [{op: 'alpha', val: 50000}]);
  await t.exec('design.background', {reset: true});
  assert.equal(layouts(t)[1].background, null);
  await assert.rejects(t.exec('design.background', {copy: true}), /copy applies to slides/);
  assert.equal(t.state('design.hideBackgroundGraphics').enabled, true);
  await t.exec('design.hideBackgroundGraphics', {hide: true});
  assert.equal(layouts(t)[1].showMasterShapes, false);
  await t.exec('view.slideMaster', {master: 0});
  await t.exec('design.background', {style: 7});
  assert.equal(t.content.masters[0].background.idx, 1002);
  assert.equal(t.state('design.hideBackgroundGraphics').enabled, false, 'the master itself has no master graphics to hide');
  await t.exec('design.theme', {name: 'Harbor'});
  assert.equal(t.content.masters[0].theme.name, 'Harbor');
  await t.exec('view.handoutMaster', {});
  await t.exec('design.background', {color: '#eeeeee'});
  assert.equal(hex(t.content.handoutMaster.background.fill.color.base.rgb), 'EEEEEE');
  await t.exec('view.notesMaster', {});
  await t.exec('design.background', {gradient: {stops: [[0, '#ffffff'], [1, '#cccccc']]}});
  assert.equal(t.content.notesMaster.background.fill.kind, 'gradient');
  await t.exec('view.closeMaster', {});
  await t.exec('design.background', {color: '#112233'});
  assert.equal(hex(t.content.slides[0].background.fill.color.base.rgb), '112233', 'back on the slides it is the slide that changes');
});

test('new layouts, handout and notes masters survive a .pptx save and reopen', async () => {
  const t = await deck();
  await t.exec('view.slideMaster', {master: 0, layout: 1});
  await t.exec('master.insertLayout', {name: 'Brand'});
  await t.exec('master.placeholders', {footers: true});
  await t.exec('master.insertPlaceholder', {kind: 'picture'});
  await t.exec('view.handoutMaster', {});
  await t.exec('handout.placeholders', {footer: false});
  await t.exec('view.notesMaster', {});
  await t.exec('design.background', {color: '#fafafa'});
  const back = await importPptx(await exportPptx(t.content));
  const brand = back.masters[0].layouts.find(l => l.name === 'Brand');
  assert.ok(brand, 'the new layout is in the file');
  assert.ok(phKinds(brand.shapes).includes('picture') && phKinds(brand.shapes).includes('slideNum'));
  assert.deepEqual(phKinds(back.handoutMaster.shapes).sort(), ['date', 'header', 'slideNum']);
  assert.ok(back.notesMaster.shapes.some(s => s.ph?.kind === 'slideImage'));
  assert.equal(hex(back.notesMaster.background.fill.color.base.rgb), 'FAFAFA');
});

test('a layout, the master and the notes master are edited like slides: select, move, format, add and type', async () => {
  const {default: insert} = await import('../../core/prism/commands/insert.mjs');
  const {default: shapeCmds} = await import('../../core/prism/commands/shape.mjs');
  const {default: arrange} = await import('../../core/prism/commands/arrange.mjs');
  const t = await withNew({extra: [master, design, insert, shapeCmds, arrange]});
  await t.exec('view.slideMaster', {master: 0, layout: 0});
  assert.match(t.doc.selection.ranges[0].anchor, /^\/sl:vl-0-0$/, 'the layout is the current slide');
  const lay = () => t.content.masters[0].layouts[0];
  const title = lay().shapes.find(s => s.ph?.kind === 'ctrTitle' || s.ph?.kind === 'title');
  await t.exec('edit.select', {ids: [title.id]});
  assert.deepEqual(t.doc.selection.ranges.map(r => r.anchor), [`/sl:vl-0-0/sp:${title.id}`]);
  await t.exec('shape.move', {dx: 30, dy: 10});
  const moved = lay().shapes.find(s => s.id === title.id);
  assert.ok(moved.xfrm, 'the placeholder has its own box now');
  await t.exec('shape.fill', {color: '#ffcc00'});
  assert.equal(lay().shapes.find(s => s.id === title.id).fill.kind, 'solid');
  assert.equal(t.content.slides[0].shapes.every(s => s.fill?.kind !== 'solid' || s.id !== title.id), true, 'no slide shape changed');
  const n = lay().shapes.length;
  const r = await t.exec('insert.textBox', {rect: [20, 20, 200, 40], text: 'Confidential'});
  assert.equal(lay().shapes.length, n + 1);
  assert.equal(lay().shapes.at(-1).text.paragraphs[0].runs[0].text, 'Confidential');
  await t.exec('edit.select', {ids: [r.result.id]});
  await expectUndoRoundTrip(t, 'edit.delete', {});
  // The master itself.
  await t.exec('view.slideMaster', {master: 0});
  assert.equal(t.doc.selection.ranges[0].anchor, '/sl:vm-0');
  const mt = t.content.masters[0].shapes.find(s => s.ph?.kind === 'title');
  await t.exec('edit.select', {ids: [mt.id]});
  await t.exec('shape.fill', {color: '#336699'});
  assert.equal(t.content.masters[0].shapes.find(s => s.id === mt.id).fill.kind, 'solid');
  // The notes master: shapes on a page.
  await t.exec('view.notesMaster', {});
  assert.equal(t.doc.selection.ranges[0].anchor, '/sl:vn');
  const body = t.content.notesMaster.shapes.find(s => s.ph?.kind === 'body');
  await t.exec('edit.select', {ids: [body.id]});
  await t.exec('shape.move', {dx: 5, dy: 0});
  assert.equal(t.content.notesMaster.shapes.find(s => s.id === body.id).xfrm.x, body.xfrm.x + 5);
  // Closing goes back to the slide the person came from.
  await t.exec('view.closeMaster', {});
  assert.match(t.doc.selection.ranges[0].anchor, new RegExp(`^/sl:${t.content.slides[0].id}`));
});
