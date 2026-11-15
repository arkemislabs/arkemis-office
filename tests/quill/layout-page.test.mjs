// U:quill/page and U:quill/objects/arrange — Layout › Page Setup and Arrange, and their dialogs.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: wordcraft crates/engine/src/cmd/page.rs (margins 492, size 549, columns 576,
//    selection_to_sections 643, breaks 702, line_numbers 102, validate_section 411, document_grid
//    334, MARGIN_PRESETS 372, margins_preset_at 383, columns_preset_at 394), objects/specs.rs
//    (arrange.rotate 165, arrange.wrap 190, arrange.wrapText 196, arrange.position 206,
//    bringForward/sendBackward 227, arrange.align 229), the ribbon in ui-egui/src/ribbon/layout.rs
//    (margins_items, orientation_items, columns_items, breaks and line-number menus) and the
//    dialogs in ui-egui/src/dialogs/dispatch.rs:552 + page_setup.rs, dialogs_insert/columns.rs and
//    dialogs_layout/text.rs:51. Word: Margins presets (Normal 1", Narrow 0.5", Moderate 1"/0.75",
//    Wide 1"/2", Mirrored, Office 2003) checked when they match; Orientation turns the page and its
//    margins; Size keeps the orientation; Columns presets and More Columns…; Breaks put page/column/
//    text-wrapping breaks at the caret and section breaks (next/continuous/even/odd) before the
//    selection; Line Numbers; Page Setup applies everything as one undo step.
// 2. Ours runs the same algorithms over the schema-2 sections (one op per command, the dialogs
//    as one batch), and the translated layout reflows: landscape pages are wider than tall, two
//    columns lay lines side by side, odd/even section starts insert a blank page, line numbers and
//    page borders are placed. Hyphenation and Text Direction stay hidden (the layout has no
//    automatic hyphenation or vertical sections); Arrange's Move with Text, Group, Selection Pane
//    and flips stay hidden (see the command files).
// 3. Proof: this file, tests/quill/upstream/page_tests.test.mjs and
//    tests/e2e/quill/layout-design.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {submitDialog, openDialogModel, changeDialogValues} from '../../core/kernel/dialog.mjs';
import {quill, blocks} from './format-fixture.mjs';
import {Document} from '../../core/quill/model/document.mjs';
import {layout} from '../../core/quill/layout/index.mjs';
import {DECOR_STORY} from '../../core/quill/layout/notes.mjs';
import {textWidth} from '../../core/quill/model/section.mjs';
import pageSetup, {pageLayoutCommands} from '../../core/quill/dialogs/pageSetup.mjs';
import columnsDialog, {applyPreset, currentPreset, editColumn, columnsParams} from '../../core/quill/dialogs/columns.mjs';
import lineNumbersDialog from '../../core/quill/dialogs/lineNumbers.mjs';

const para = 'The quick brown fox jumps over the lazy dog and keeps on running across the wide green field. ';
const long = n => Array.from({length: n}, (_, i) => `${i + 1}. ${para.repeat(3)}`).join('\n');
const sect = q => new Document(q.t.content).sections().at(-1)[1];
const pages = q => layout(q.t.content, {view: 'print'}).pages;
const bodyLines = page => page.items.filter(i => i.kind === 'lines' && i.story === 'body');

test('layout.margins: presets, numbers, mirror and the fit rule; one undo step; state checks the preset', async () => {
  const q = await quill('one\ntwo');
  await expectUndoRoundTrip(q.t, 'layout.margins', {preset: 'wide'}, after => {
    const x = after.content.lastSection;
    assert.deepEqual([x.marginTop, x.marginBottom, x.marginLeft, x.marginRight], [72, 72, 144, 144]);
  });
  await q.exec('layout.margins', {preset: 'narrow'});
  assert.equal(q.state('layout.margins', {preset: 'narrow'}).checked, true);
  assert.equal(q.state('layout.margins', {preset: 'normal'}).checked, false);
  await q.exec('layout.margins', {preset: 'mirrored'});
  assert.equal(q.t.content.settings.mirrorMargins, true, 'Mirrored turns mirror margins on');
  assert.equal(q.state('layout.margins', {preset: 'mirrored'}).checked, true);
  await q.exec('layout.margins', {preset: 'normal'});
  assert.equal(q.t.content.settings.mirrorMargins, false, 'another preset turns it off');
  await q.exec('layout.margins', {top: 90, left: 100});
  const x = sect(q);
  assert.deepEqual([x.marginTop, x.marginBottom, x.marginLeft, x.marginRight], [90, 72, 100, 72]);
  await assert.rejects(() => q.exec('layout.margins', {left: 400, right: 200}), /no room for text/);
  // Over the bridge it runs the same (an edit never asks).
  await q.t.bridge('layout.margins', {preset: 'moderate'});
  assert.equal(sect(q).marginLeft, 54);
});

test('layout.orientation turns the page and its margins; the layout pages are landscape; state follows', async () => {
  const q = await quill(long(3));
  await q.exec('layout.margins', {top: 50, bottom: 60, left: 70, right: 80});
  await expectUndoRoundTrip(q.t, 'layout.orientation', {value: 'landscape'}, after => {
    const x = after.content.lastSection;
    assert.deepEqual([x.pageW, x.pageH, x.landscape], [792, 612, true]);
    assert.deepEqual([x.marginTop, x.marginBottom, x.marginLeft, x.marginRight], [70, 80, 60, 50], 'the margins turn with the page');
  });
  await q.exec('layout.orientation', {value: 'landscape'});
  assert.equal(q.state('layout.orientation', {value: 'landscape'}).checked, true);
  const p = pages(q)[0];
  assert.ok(p.w > p.h, 'a landscape page is wider than tall');
  await q.exec('layout.orientation', {});
  assert.equal(sect(q).landscape, false, 'without a value it toggles');
});

test('layout.size: named papers keep the orientation; numbers clamp; a size the margins do not fit is refused', async () => {
  const q = await quill('x');
  await expectUndoRoundTrip(q.t, 'layout.size', {name: 'A4'}, after => {
    assert.deepEqual([after.content.lastSection.pageW, after.content.lastSection.pageH], [595.28, 841.89]);
  });
  await q.exec('layout.orientation', {value: 'landscape'});
  await q.exec('layout.size', {name: 'Legal'});
  assert.deepEqual([sect(q).pageW, sect(q).pageH], [1008, 612], 'landscape stays landscape');
  assert.equal(q.state('layout.size', {name: 'Legal'}).checked, true);
  await q.exec('layout.size', {width: 5000, height: 900});
  assert.deepEqual([sect(q).pageW, sect(q).pageH], [1584, 900], 'clamped to 22"');
  await assert.rejects(() => q.exec('layout.size', {width: 5000, height: 3}), /margins don't fit/, 'a 0.1" page leaves no room for 1" margins');
  const r = await quill('x');
  await assert.rejects(() => r.exec('layout.size', {width: 300}), /height/, 'width and height go together');
  await r.exec('layout.margins', {left: 200, right: 200});
  await assert.rejects(() => r.exec('layout.size', {name: 'Statement'}), /margins don't fit/);
  await assert.rejects(() => r.exec('layout.size', {name: 'Folio'}), /unknown paper/);
});

test('layout.columns: two columns lay text out side by side; a line between draws a rule; presets are checked', async () => {
  const q = await quill(long(8));
  await expectUndoRoundTrip(q.t, 'layout.columns', {count: 2, separator: true}, after => {
    assert.deepEqual(after.content.lastSection.columns, {count: 2, space: 36, separator: true, widths: []});
  });
  await q.exec('layout.columns', {count: 2, separator: true});
  assert.equal(q.state('layout.columns', {count: 2}).checked, true);
  const p = pages(q)[0];
  const xs = new Set(bodyLines(p).map(i => Math.round(i.x)));
  assert.ok(xs.size >= 2, `lines in two columns (x: ${[...xs]})`);
  const half = textWidth(sect(q)) / 2;
  assert.ok([...xs].some(x => x > 72 + half), 'the second column starts in the right half');
  assert.ok(p.items.some(i => i.kind === 'rule' && i.x0 === i.x1), 'Line between: a vertical rule');
  await q.exec('layout.columns', {preset: 'left'});
  assert.equal(q.state('layout.columns', {preset: 'left'}).checked, true);
  const w = sect(q).columns.widths;
  assert.ok(w[0][0] < w[1][0], 'Left: the narrow column on the left');
});

test('layout.break: page, column and text-wrapping characters; section breaks the layout honours', async () => {
  const q = await quill('alpha\nbeta');
  q.sel(1, 0);
  await expectUndoRoundTrip(q.t, 'layout.break', {kind: 'page'}, after => {
    assert.ok(after.content.body.chunks[0].some(b => b.text?.includes('\f')), 'a page break character');
  });
  assert.equal(pages(q).length, 2, 'the page break starts page 2');
  const c = await quill('alpha');
  c.sel(0, 5);
  await c.exec('layout.break', {kind: 'column'});
  assert.ok(c.para(0).text.includes('\u000E'));
  await c.exec('layout.break', {kind: 'textWrapping'});
  assert.ok(c.para(0).text.includes('\n'));
  // Next Page: a new section on a new page.
  const n = await quill('alpha\nbeta');
  n.sel(1, 0);
  await expectUndoRoundTrip(n.t, 'layout.break', {kind: 'nextPage'}, after => {
    const d = new Document(after.content);
    assert.equal(d.sections().length, 2);
    assert.equal(after.content.lastSection.start, 'nextPage');
    const ids = d.sections().map(([, x]) => x.id);
    assert.equal(new Set(ids).size, 2, 'each section has its own id');
  });
  assert.equal(pages(n).length, 2);
  // Odd Page after page 1: a blank page 2, the section on page 3; Even Page: straight on page 2.
  const o = await quill('alpha\nbeta');
  o.sel(1, 0);
  await o.exec('layout.break', {kind: 'oddPage'});
  assert.equal(pages(o).length, 3, 'odd page: a blank even page in between');
  const e = await quill('alpha\nbeta');
  e.sel(1, 0);
  await e.exec('layout.break', {kind: 'evenPage'});
  assert.equal(pages(e).length, 2);
  // Continuous: both sections on page 1.
  const k = await quill('alpha\nbeta');
  k.sel(1, 0);
  await k.exec('layout.break', {kind: 'continuous'});
  assert.equal(pages(k).length, 1);
  // Not in a table cell or a header.
  const t = await quill('x');
  await t.exec('insert.table', {rows: 1, cols: 2});
  await assert.rejects(() => t.exec('layout.break', {kind: 'nextPage'}), /main text/);
});

test('layout.lineNumbers puts numbers in the margin; options and restart modes; state checks the mode', async () => {
  const q = await quill('one\ntwo\nthree');
  await expectUndoRoundTrip(q.t, 'layout.lineNumbers', {value: 'continuous'}, after => {
    assert.equal(after.content.lastSection.lineNumbers.restart, 'continuous');
  });
  await q.exec('layout.lineNumbers', {value: 'restartPage', countBy: 1});
  assert.equal(q.state('layout.lineNumbers', {value: 'restartPage'}).checked, true);
  assert.equal(q.state('layout.lineNumbers', {value: 'none'}).checked, false);
  const nums = pages(q)[0].items.filter(i => i.kind === 'lines' && i.story === DECOR_STORY);
  assert.equal(nums.length, 3, 'one number per line');
  assert.ok(nums.every(i => i.x < 72), 'in the left margin');
  await q.exec('layout.lineNumbers', {value: 'none'});
  assert.equal(pages(q)[0].items.filter(i => i.story === DECOR_STORY).length, 0);
});

test('vertical alignment, section direction, first page / odd-even headers, document grid, section read', async () => {
  const q = await quill('one\ntwo');
  await expectUndoRoundTrip(q.t, 'layout.verticalAlign', {value: 'center'}, after => assert.equal(after.content.lastSection.valign, 'center'));
  await q.exec('layout.verticalAlign', {value: 'bottom'});
  assert.equal(q.state('layout.verticalAlign', {value: 'bottom'}).checked, true);
  const top = bodyLines(pages(q)[0])[0].y;
  assert.ok(top > 400, 'bottom alignment moves the text down the page');
  await expectUndoRoundTrip(q.t, 'layout.sectionRtl', {}, after => assert.equal(after.content.lastSection.rtl, true));
  await expectUndoRoundTrip(q.t, 'layout.differentFirstPage', {value: true}, after => assert.equal(after.content.lastSection.titlePage, true));
  await expectUndoRoundTrip(q.t, 'layout.differentOddEven', {}, after => assert.equal(after.content.settings.evenOddHeaders, true));
  await expectUndoRoundTrip(q.t, 'layout.documentGrid', {type: 'lines', linesPerPage: 30}, after => {
    const g = after.content.lastSection.docGrid;
    assert.equal(g.type, 'lines');
    assert.equal(Math.round(g.linePitch * 30), 648, 'the pitch fills the text height');
  });
  const grid = (await q.exec('layout.documentGrid', {})).result;
  assert.equal(grid.type, 'lines');
  assert.equal(grid.linesPerPage, 30);
  const s = (await q.exec('layout.section', {})).result;
  assert.equal(s.pageW, 612);
  const ps = (await q.exec('layout.pageSetup', {})).result;
  assert.equal(ps.section.pageH, 792, 'without a section it returns the caret section');
});

test('Page Setup dialog: landscape A4 with mirror margins as one undo step; margins that do not fit are refused', async () => {
  const q = await quill(long(2));
  const ctx = () => q.t.session.readContext(q.t.docId);
  let v = openDialogModel(q.t.session, q.t.docId, pageSetup);
  assert.deepEqual([v.top, v.left, v.width, v.height, v.paperSize, v.orientation], [1, 1, 8.5, 11, 'Letter', 'portrait']);
  v = changeDialogValues(pageSetup, v, 'paperSize', 'A4');
  assert.deepEqual([v.width, v.height], [8.27, 11.69]);
  v = changeDialogValues(pageSetup, v, 'orientation', 'landscape');
  assert.deepEqual([v.width, v.height], [11.69, 8.27], 'the paper turns with the orientation');
  v = changeDialogValues(pageSetup, v, 'left', 1.5);
  v = changeDialogValues(pageSetup, v, 'multiplePages', 'mirror');
  v = changeDialogValues(pageSetup, v, 'verticalAlignment', 'center');
  const before = q.t.version;
  await submitDialog(q.t.session, q.t.docId, pageSetup, v);
  assert.equal(q.t.version, before + 1, 'one undo step');
  const x = sect(q);
  assert.equal(x.landscape, true);
  assert.deepEqual([Math.round(x.pageW), Math.round(x.pageH)], [842, 595]);
  assert.equal(x.marginLeft, 108);
  assert.equal(x.valign, 'center');
  assert.equal(q.t.content.settings.mirrorMargins, true);
  await q.t.undo();
  assert.deepEqual([sect(q).pageW, sect(q).landscape, q.t.content.settings.mirrorMargins], [612, false, false], 'undo takes it all back');
  // Typed sizes pick the paper and the orientation.
  let w = openDialogModel(q.t.session, q.t.docId, pageSetup);
  w = changeDialogValues(pageSetup, w, 'width', 14);
  assert.equal(w.orientation, 'landscape');
  w = changeDialogValues(pageSetup, w, 'height', 8.5);
  assert.equal(w.paperSize, 'Legal');
  // Margins wider than the paper: a field error, nothing runs.
  let bad = openDialogModel(q.t.session, q.t.docId, pageSetup);
  bad = changeDialogValues(pageSetup, bad, 'left', 5);
  bad = changeDialogValues(pageSetup, bad, 'right', 5);
  await assert.rejects(() => submitDialog(q.t.session, q.t.docId, pageSetup, bad), /margins don't fit/);
  // Nothing changed: OK runs nothing.
  assert.deepEqual(pageSetup.toCommand(openDialogModel(q.t.session, q.t.docId, pageSetup)), {batch: []});
  void ctx;
});

test('page_layout_commands orders size, orientation and margins so none is refused on the way', () => {
  const cur = {pageW: 612, pageH: 792, landscape: false, marginTop: 72, marginBottom: 72, marginLeft: 250, marginRight: 250, gutter: 0};
  // Statement (396 wide) can't take 500 pt of side margins: margins first.
  const r = pageLayoutCommands(cur, [396, 612], [612, 792], false, [72, 72, 36, 36], 0);
  assert.deepEqual(r.commands.map(c => c.command), ['layout.orientation', 'layout.margins', 'layout.size']);
  const same = pageLayoutCommands({...cur, marginLeft: 72, marginRight: 72}, [612, 792], [612, 792], true, [72, 72, 72, 72], 0);
  assert.deepEqual(same.commands.map(c => c.command), ['layout.orientation', 'layout.margins'], 'the same paper: no layout.size');
  assert.ok(pageLayoutCommands(cur, [300, 300], [612, 792], false, [200, 200, 200, 200], 0).error);
});

test('Columns dialog: presets, count, rebalanced widths, Apply to; OK runs layout.columns', async () => {
  const q = await quill(long(4));
  let v = openDialogModel(q.t.session, q.t.docId, columnsDialog);
  assert.deepEqual([v.count, v.presets, v.applyTo], [1, 'one', 'document']);
  v = changeDialogValues(columnsDialog, v, 'presets', 'left');
  assert.deepEqual([v.count, v.equal, v.presets], [2, false, 'left']);
  const f = {count: v.count, equal: v.equal, cols: v.cols, separator: false, applyTo: 'document', textWidth: v._textWidth};
  const edited = editColumn(f, 0, 2.5);
  assert.equal(edited.cols[0][0], 2.5);
  assert.ok(Math.abs(edited.cols.reduce((a, [w, s]) => a + w + s, 0) - f.textWidth) < 0.01, 'the next column takes up the difference');
  assert.equal(currentPreset(applyPreset(f, 'three')), 'three');
  assert.deepEqual(columnsParams(applyPreset(f, 'two')), {count: 2, space: 36, separator: false, apply: 'document'});
  v = changeDialogValues(columnsDialog, v, 'count', 3);
  v = changeDialogValues(columnsDialog, v, 'separator', true);
  await submitDialog(q.t.session, q.t.docId, columnsDialog, v);
  assert.deepEqual([sect(q).columns.count, sect(q).columns.separator], [3, true]);
  // With text selected, Selected text is offered and chosen.
  q.sel(0, 0, 4);
  const s = openDialogModel(q.t.session, q.t.docId, columnsDialog);
  assert.equal(s.applyTo, 'selection');
  assert.ok(s._applyChoices.includes('selection'));
});

test('Line Numbers dialog: on with options, off; Auto distance is 0', async () => {
  const q = await quill('one\ntwo');
  let v = openDialogModel(q.t.session, q.t.docId, lineNumbersDialog);
  assert.deepEqual([v.on, v.start, v.countBy, v.restart, v.auto], [false, 1, 1, 'restartPage', true]);
  v = {...v, on: true, start: 3, countBy: 2, restart: 'continuous', auto: false, fromText: 0.5};
  await submitDialog(q.t.session, q.t.docId, lineNumbersDialog, v);
  assert.deepEqual(sect(q).lineNumbers, {countBy: 2, start: 3, distance: 36, restart: 'continuous'});
  await submitDialog(q.t.session, q.t.docId, lineNumbersDialog, {...v, on: false});
  assert.equal(sect(q).lineNumbers, null);
  await assert.rejects(() => submitDialog(q.t.session, q.t.docId, lineNumbersDialog, {...v, start: 0}), /1 to 32767/);
});

// ---------------------------------------------------------------------------------------------
// Arrange

async function withShape() {
  const q = await quill('Some text around a shape that will wrap.');
  q.sel(0, 4);
  await q.exec('insert.shape', {kind: 'rectangle', width: 72, height: 36});
  return q;
}
const shapeOf = q => blocks(q.t).flatMap(b => b.objects ?? []).find(o => o.type === 'shape');

test('Arrange: wrap, wrap sides, position, align, bring forward / send backward, rotate; disabled with no object', async () => {
  const none = await quill('plain');
  const st = none.state('arrange.wrap', {wrap: 'square'});
  assert.equal(st.enabled, false);
  assert.match(st.reason, /select a picture or shape/);
  await assert.rejects(() => none.exec('arrange.wrap', {wrap: 'square'}), /select a picture or shape/);
  const q = await withShape();
  await expectUndoRoundTrip(q.t, 'arrange.wrap', {wrap: 'square'}, after => {
    const o = after.content.body.chunks[0].flatMap(b => b.objects ?? []).find(x => x.type === 'shape');
    assert.equal(o.float.wrap, 'square');
    assert.equal(o.float.dist, 9, 'Word\'s 0.125" side distance for a newly wrapped object');
  });
  await q.exec('arrange.wrap', {wrap: 'topAndBottom'});
  assert.equal(q.state('arrange.wrap', {wrap: 'topAndBottom'}).checked, true);
  await expectUndoRoundTrip(q.t, 'arrange.wrapText', {side: 'left'}, after => {
    assert.equal(after.content.body.chunks[0].flatMap(b => b.objects ?? []).find(x => x.type === 'shape').float.wrapText, 'left');
  });
  await expectUndoRoundTrip(q.t, 'arrange.position', {preset: 'bottomRight'}, () => {});
  await q.exec('arrange.position', {preset: 'bottomRight'});
  const tw = textWidth(sect(q));
  let f = shapeOf(q).float;
  assert.deepEqual([f.hRel, f.vRel, f.x, f.y], ['margin', 'margin', tw - 72, 648 - 36]);
  await q.exec('arrange.align', {value: 'center'});
  f = shapeOf(q).float;
  assert.equal(f.x, (tw - 72) / 2);
  await q.exec('arrange.align', {value: 'top'});
  assert.equal(shapeOf(q).float.y, 0, 'Align Top: the top margin');
  await expectUndoRoundTrip(q.t, 'arrange.bringForward', {}, after => {
    assert.equal(after.content.body.chunks[0].flatMap(b => b.objects ?? []).find(x => x.type === 'shape').float.wrap, 'inFrontOfText');
  });
  await expectUndoRoundTrip(q.t, 'arrange.sendBackward', {}, after => {
    assert.equal(after.content.body.chunks[0].flatMap(b => b.objects ?? []).find(x => x.type === 'shape').float.wrap, 'behindText');
  });
  await expectUndoRoundTrip(q.t, 'arrange.rotate', {direction: 'right'}, after => {
    assert.equal(after.content.body.chunks[0].flatMap(b => b.objects ?? []).find(x => x.type === 'shape').float.rot, 90);
  });
  await q.exec('arrange.rotate', {direction: 'left'});
  assert.equal(shapeOf(q).float.rot ?? 0, 0, 'right then left turns it back');
  await q.exec('arrange.rotate', {direction: 'left'});
  assert.equal(shapeOf(q).float.rot, 270);
  await q.exec('arrange.rotation', {degrees: 405});
  assert.equal(shapeOf(q).float.rot, 45);
  assert.equal(q.state('arrange.rotation').value, 45);
  await q.exec('arrange.rotate', {direction: 'flipHorizontal'});
  assert.equal(shapeOf(q).float.flipH, true);
  // The layout floats it: a floating object item with the wrap.
  const objs = pages(q)[0].items.filter(i => i.kind === 'object');
  assert.ok(objs.some(i => i.wrap === 'behindText'));
});
