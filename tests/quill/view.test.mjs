// U:quill/view — the View tab: Views (Print Layout, Web Layout, Draft, Outline, Read Mode with its
// reading controls), Immersive (Focus, Immersive Reader, Text Spacing), Page Movement (Vertical,
// Side to Side), Show (Ruler, Gridlines, Navigation Pane), the fit zooms (One Page, Multiple Pages,
// Page Width, Text width), the Zoom dialog, Window (Split, New Window, Arrange All, View Side by
// Side, Synchronous Scrolling, Reset Window Position, Switch Windows), the Outlining tab, the
// Immersive Reader tab, the layouts each view draws, the page view's geometry, the view a .docx is
// saved with (w:view, w:zoom), and the kernel's mirror of a document in a second window.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: wordcraft crates/engine/src/cmd/view.rs (mode 159, read_column_width 185,
//    read_text_size 200, read_line_spacing 213, read_page_color 245, saved_zoom 259,
//    restore_zoom 272, zoom 286, switch_windows 310), cmd/tools/specs.rs:371 (view.immersive,
//    view.vertical, view.sideToSide), cmd/outline.rs (expand 260, collapse 289, show_level 323,
//    select_subtree 340, set_levels 362, hidden_subheadings 377, move_shown 405,
//    remap_collapsed_headings 474), cmd/para/outline.rs (move_paras, outline_step), layout
//    outline.rs (levels, hidden, indent, outline_para, symbol_items), flow.rs place_outline_para,
//    session/layout.rs layout_with (Read at the column, Web at the window, Draft/Outline 800 pt),
//    ui-egui canvas/geometry.rs geometry, canvas/reading.rs (reading_size, place_read_pages),
//    panes/nav.rs, ribbon/tabs.rs reading_toolbar, chrome.rs (Screen, status bar view buttons).
//    Word: the five views from View › Views and the status bar; Read Mode turns columns with the
//    arrows and Esc returns; Outline view opens the Outlining tab; Draft shows page breaks as dotted
//    lines; Focus hides everything but the page; Immersive Reader has its own tab; the Navigation
//    pane's Headings (drag to move a section), Pages (thumbnails) and Results; New Window opens the
//    same document in a second window (Report:1 / Report:2) and edits show in both; Arrange All,
//    View Side by Side with Synchronous Scrolling, Reset Window Position, Switch Windows; the
//    Zoom dialog's Zoom to options; the document keeps its zoom and view in settings.xml.
// 2. Ours: every View command is the document view (never an edit, never on the undo list, the
//    document not marked changed); outline level changes and moves are edits, one undo step each;
//    the layout draws Outline, Draft, Web and Read as upstream; the page view and the window
//    commands run the same commands (tests/e2e/quill/view.e2e.mjs). Hidden, not imitated: Hide
//    White Space, Dark Mode, Macros, Templates, Full Screen (upstream-only), Master Document, Line
//    Focus and Syllables (no upstream engine), Read Aloud (speech.rs not translated yet).
// 3. Proof: this file, tests/quill/upstream/view_tests.test.mjs and tests/e2e/quill/view.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill, blocks} from './format-fixture.mjs';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createTestHost, createMemoryFiles} from '../../core/kernel/host.mjs';
import {openDialogModel, changeDialogValues} from '../../core/kernel/dialog.mjs';
import zoomDialog from '../../core/common/dialogs/zoom.mjs';
import {layout} from '../../core/quill/layout/index.mjs';
import {BODY, levels, hidden, indent, subtreeEnd, symbolItems, outlineSymbolAt, LEVEL_INDENT, SYMBOL_W, remapPairs, textHashOf} from '../../core/quill/layout/outline.mjs';
import {viewLayoutOptions, viewOf, layoutView, DRAFT_WIDTH, IMMERSIVE_HEIGHT} from '../../core/quill/lib/view-layout.mjs';
import {savedZoom, savedView, fileForSave, initialView} from '../../core/quill/lib/view-file.mjs';
import {read as readDocx} from '../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../core/quill/formats/docx-write.mjs';
import {evaluate} from '../../core/quill/context.mjs';
import {Document} from '../../core/quill/model/document.mjs';
import * as G from '../../src/apps/quill/surface/geometry.mjs';

const view = q => q.t.session.get(q.t.docId).view;
const undoDepth = q => q.t.session.get(q.t.docId).undo.size;
const text = q => blocks(q.t).map(b => b.text).join('\n');

/** Heading 1 "One", body "a", Heading 2 "Two", body "b", Heading 1 "Three", body "c" (upstream outline_doc). */
async function outlineDoc() {
  const q = await quill('One\na\nTwo\nb\nThree\nc');
  for (const [i, style] of [[0, 'Heading1'], [2, 'Heading2'], [4, 'Heading1']]) { q.sel(i, 0); await q.exec('para.style', {style}); }
  await q.exec('view.outline');
  return q;
}
const shown = async q => (await q.exec('outline.state')).result.shown;

// ---- Views -------------------------------------------------------------------------------------

test('the five views switch the document view only: no edit, no undo step, not marked changed', async () => {
  const q = await quill('Hello world');
  const before = q.t.content, depth = undoDepth(q), dirty = q.t.session.get(q.t.docId).dirty;
  for (const [id, mode, read] of [['view.webLayout', 'web', false], ['view.draft', 'draft', false], ['view.outline', 'outline', false], ['view.readMode', 'outline', true], ['view.printLayout', 'print', false]]) {
    await q.exec(id);
    assert.equal(view(q).mode, mode, id);
    assert.equal(!!view(q).readMode, read, id);
    assert.equal(q.state(id).checked, true, `${id} is checked`);
  }
  assert.equal(q.state('view.webLayout').checked, false);
  assert.equal(q.t.content, before, 'the document is the same object');
  assert.equal(undoDepth(q), depth);
  assert.equal(q.t.session.get(q.t.docId).dirty, dirty);
  // Read Mode from Web Layout keeps the view to return to; Print Layout checks only outside Read Mode.
  await q.exec('view.webLayout');
  await q.exec('view.readMode');
  assert.equal(layoutView(view(q)), 'read');
  assert.equal(q.state('view.webLayout').checked, false, 'Read Mode is the checked view');
  assert.equal(q.state('view.readMode').checked, true);
});

test('Read Mode: column width, text size, line spacing and page color are view settings, reset on each entry (mode)', async () => {
  const q = await quill('Hello');
  await q.exec('view.readMode');
  assert.deepEqual((await q.exec('view.readColumnWidth', {value: 'page'})).result, {width: 612});
  assert.deepEqual((await q.exec('view.readTextSize', {value: 125})).result, {percent: 125});
  assert.deepEqual((await q.exec('view.readLineSpacing', {value: 2})).result, {spacing: 2});
  assert.deepEqual((await q.exec('view.readPageColor', {value: 'sepia'})).result, {pageColor: 'sepia'});
  const v = viewOf(view(q));
  assert.deepEqual([v.readColumnWidth, v.readZoom, v.readLineSpacing, v.readPageColor], [612, 1.25, 2, 'sepia']);
  assert.equal(q.state('view.readColumnWidth', {value: 'page'}).checked, true);
  assert.equal(q.state('view.readPageColor', {value: 'none'}).checked, false);
  for (const [id, p] of [['view.readTextSize', {value: -10}], ['view.readLineSpacing', {value: 1.1}], ['view.readColumnWidth', {value: 'giant'}], ['view.readPageColor', {value: 'black'}]]) {
    await assert.rejects(q.exec(id, p), e => e.code === 'invalid_params', `${id} ${JSON.stringify(p)}`);
  }
  await q.exec('view.readLineSpacing', {value: 'document'});
  assert.equal(viewOf(view(q)).readLineSpacing, null);
  await q.exec('view.printLayout');
  await q.exec('view.readMode');
  const w = viewOf(view(q));
  assert.deepEqual([w.readColumnWidth, w.readZoom, w.readLineSpacing, w.readPageColor], [null, 1, null, 'none'], 'reset on entry');
});

test('Read Mode lays the text out in reading columns of the window\'s size; Print Layout is unchanged', async () => {
  const q = await quill(Array.from({length: 12}, () => 'A long paragraph for reading. '.repeat(18)).join('\n'));
  const print = layout(q.t.content, {view: 'print'});
  await q.exec('view.readMode');
  const cols = layout(q.t.content, viewLayoutOptions(view(q), {readWidth: 240, readHeight: 420}));
  assert.ok(cols.pages.length > print.pages.length, `${cols.pages.length} columns > ${print.pages.length} pages`);
  assert.ok(cols.pages.every(p => p.w === 240 && p.h === 420));
  const shorter = layout(q.t.content, viewLayoutOptions(view(q), {readWidth: 240, readHeight: 260}));
  assert.ok(shorter.pages.length > cols.pages.length, 'the height counts');
  await q.exec('view.readLineSpacing', {value: 2});
  const spaced = layout(q.t.content, viewLayoutOptions(view(q), {readWidth: 240, readHeight: 420}));
  assert.ok(spaced.pages.length > cols.pages.length, 'line spacing reflows');
  assert.equal(layout(q.t.content, {view: 'print'}).pages.length, print.pages.length);
});

test('Web Layout wraps to the window; Draft and Outline keep an 800 pt column (layout_with, #1876)', async () => {
  const q = await quill('Draft text wraps in a fixed column. '.repeat(80));
  await q.exec('view.draft');
  assert.equal(layout(q.t.content, viewLayoutOptions(view(q), {webWidth: 1400})).pages[0].w, DRAFT_WIDTH);
  await q.exec('view.webLayout');
  const web = layout(q.t.content, viewLayoutOptions(view(q), {webWidth: 1400}));
  assert.equal(web.pages.length, 1, 'one long sheet');
  assert.equal(web.pages[0].w, 1400);
  await q.exec('view.outline');
  assert.equal(layout(q.t.content, viewLayoutOptions(view(q), {webWidth: 1400})).pages[0].w, DRAFT_WIDTH);
  // Headless (no window): Web Layout at upstream's default width.
  await q.exec('view.webLayout');
  assert.deepEqual(viewLayoutOptions(view(q)), {view: 'web', webWidth: DRAFT_WIDTH});
});

// ---- Immersive ---------------------------------------------------------------------------------

test('Focus toggles; Immersive Reader is a reading column with its own tab; Text Spacing widens its lines', async () => {
  const q = await quill('Hello');
  assert.deepEqual((await q.exec('view.focus')).result, {value: true});
  assert.equal(q.state('view.focus').checked, true);
  assert.deepEqual((await q.exec('view.focus', {value: false})).result, {value: false});
  await q.exec('view.focus');
  await q.exec('view.immersive');
  const v = view(q);
  assert.ok(v.immersive && !v.focusMode && !v.readMode, 'Immersive Reader is a reading view, not Focus');
  assert.equal(layoutView(v), 'read');
  assert.equal(viewLayoutOptions(v, {readWidth: 350}).readHeight, IMMERSIVE_HEIGHT, 'one long column');
  assert.equal(evaluate(q.t.content, q.t.session.get(q.t.docId).selection, {}, v)['immersive-reader'], true, 'the Immersive Reader tab shows');
  await q.exec('view.textSpacing');
  assert.equal(viewOf(view(q)).readLineSpacing, 1.5);
  assert.equal(q.state('view.textSpacing').checked, true);
  await q.exec('view.readColumnWidth', {value: 'narrow'});
  assert.equal(q.state('view.readColumnWidth', {value: 'narrow'}).checked, true);
  await q.exec('view.immersive', {value: false});
  assert.ok(!view(q).immersive);
  assert.equal(evaluate(q.t.content, q.t.session.get(q.t.docId).selection, {}, view(q))['immersive-reader'], false);
});

// ---- Page Movement, Show, fit zooms --------------------------------------------------------------

test('Page Movement: Side to Side shows pages in one row (upstream: multiple pages); Vertical goes back; only in Print Layout', async () => {
  const q = await quill('Hello');
  await q.exec('view.sideToSide');
  assert.deepEqual([view(q).multiPage, view(q).fit, view(q).pageMovement, view(q).singleColumn], [true, 'multiplePages', 'sideToSide', false]);
  assert.equal(q.state('view.sideToSide').checked, true);
  assert.equal(q.state('view.vertical').checked, false);
  await q.exec('view.vertical');
  assert.deepEqual([view(q).multiPage, view(q).fit, view(q).pageMovement], [false, null, 'vertical']);
  await q.exec('view.webLayout');
  assert.equal(q.state('view.sideToSide').enabled, false);
  assert.equal(q.state('view.onePage').enabled, false, 'fit zooms are Print Layout\'s');
  await q.exec('view.printLayout');
  await q.exec('view.sideToSide');
  await q.exec('view.draft');
  assert.equal(view(q).pageMovement, 'vertical', 'leaving Print Layout goes back to Vertical');
});

test('Show: Ruler (on by default), Gridlines (Print Layout), Navigation Pane; Ctrl+F opens the Navigation pane', async () => {
  const q = await quill('Hello');
  assert.equal(q.state('view.ruler').checked, true);
  assert.deepEqual((await q.exec('view.ruler')).result, {value: false});
  assert.equal(q.state('view.ruler').checked, false);
  assert.deepEqual((await q.exec('view.gridlines', {value: true})).result, {value: true});
  assert.equal(q.state('view.gridlines').checked, true);
  await q.exec('view.outline');
  assert.equal(q.state('view.ruler').enabled, false, 'no ruler in Outline view');
  assert.equal(q.state('view.gridlines').enabled, false);
  // Navigation Pane opens without changing the view (navigation_pane_opens_without_changing_view_mode).
  for (const id of ['view.printLayout', 'view.webLayout', 'view.readMode']) {
    await q.exec(id);
    const before = [view(q).mode, !!view(q).readMode];
    await q.exec('view.navigationPane', {value: false});
    await q.exec('view.navigationPane', {value: true});
    assert.equal(view(q).navPane, true);
    assert.deepEqual([view(q).mode, !!view(q).readMode], before, id);
  }
  await q.exec('view.navigationPane', {value: false});
  await q.exec('edit.find');
  assert.equal(viewOf(view(q)).navPane, true, 'Ctrl+F is the Navigation pane\'s search');
  assert.equal(q.state('view.navigationPane').checked, true);
  await q.exec('view.navigationPane');
  assert.equal(viewOf(view(q)).navPane, false, 'one switch closes it');
});

test('One Page and Page Width keep one page per row through a later zoom; Multiple Pages does not (#768)', async () => {
  const q = await quill('Hello');
  await q.exec('view.onePage');
  assert.ok(view(q).singleColumn && view(q).fit === 'onePage' && q.state('view.onePage').checked);
  await q.exec('view.zoomOut');
  assert.ok(view(q).fit === null && view(q).singleColumn);
  await q.exec('view.zoom', {value: 50});
  assert.ok(view(q).singleColumn);
  await q.exec('view.multiplePages');
  assert.ok(!view(q).singleColumn && view(q).multiPage && q.state('view.multiplePages').checked);
  await q.exec('view.zoomIn');
  assert.ok(!view(q).singleColumn && !view(q).multiPage);
  await q.exec('view.pageWidth');
  assert.ok(view(q).singleColumn && q.state('view.pageWidth').checked);
  await q.exec('view.zoom', {value: 'textWidth'});
  assert.equal(view(q).fit, 'textWidth');
});

test('the Zoom dialog: Word\'s Zoom to options, Percent and the preview', async () => {
  const q = await quill('Hello');
  const ctx = q.t.session.readContext(q.t.docId);
  const m = {values: openDialogModel(q.t.session, q.t.docId, zoomDialog)};
  assert.equal(m.values.preset, '100%');
  for (const [preset, cmd] of [['pageWidth', {value: 'pageWidth'}], ['textWidth', {value: 'textWidth'}], ['onePage', {value: 'onePage'}], ['multiplePages', {value: 'multiplePages'}]]) {
    const v = changeDialogValues(zoomDialog, m.values, 'preset', preset);
    assert.deepEqual(zoomDialog.validate(v), [], preset);
    assert.deepEqual(zoomDialog.toCommand(v), {command: 'view.zoom', params: cmd}, preset);
  }
  let v = changeDialogValues(zoomDialog, m.values, 'preset', '200%');
  assert.equal(v.percent, 200);
  assert.deepEqual(zoomDialog.toCommand(v), {command: 'view.zoom', params: {percent: 200}});
  v = changeDialogValues(zoomDialog, v, 'percent', 137);
  assert.equal(v.preset, null, 'a typed percent picks no option');
  assert.deepEqual(zoomDialog.validate({...v, percent: 600}).map(e => e.field), ['percent']);
  const p = zoomDialog.preview(ctx, {...v, preset: 'onePage'});
  assert.equal(p.fit, 'onePage');
  assert.ok(p.pageW > p.textW && p.pageH > 0);
  await q.exec('view.onePage');
  assert.equal(openDialogModel(q.t.session, q.t.docId, zoomDialog).preset, 'onePage', 'the fit in force is the chosen option');
});

// ---- Window ------------------------------------------------------------------------------------

test('Split: two panes on one document, a bar position, Remove Split; never an edit', async () => {
  const q = await quill('Hello');
  assert.deepEqual((await q.exec('view.split')).result, {value: true, at: 0.5});
  assert.equal(q.state('view.split').checked, true);
  assert.deepEqual((await q.exec('view.split', {at: 0.3})).result, {value: true, at: 0.3});
  assert.equal(view(q).splitAt, 0.3);
  assert.deepEqual((await q.exec('view.split')).result, {value: false, at: null});
  await assert.rejects(q.exec('view.split', {at: 0.95}), e => e.code === 'invalid_params');
  assert.equal(undoDepth(q), 0);
});

/** A renderer-like host whose window service records what it is asked. */
function windowsHost() {
  const calls = [];
  let st = {windows: [{id: 1, title: 'Report:1', doc: 'doc1', self: true}], sideBySide: false, syncScroll: false};
  const windows = {
    state: () => st,
    list: async () => st.windows,
    open: async req => { calls.push(['open', req]); st = {...st, windows: [...st.windows, {id: 2, title: 'Report:2', doc: req.doc, self: false}]}; return {window: 2, doc: req.doc}; },
    focus: async id => { calls.push(['focus', id]); return {window: id}; },
    arrange: async req => {
      calls.push(['arrange', req]);
      if (req.mode === 'sideBySide') st = {...st, sideBySide: true, syncScroll: true};
      if (req.mode === 'off') st = {...st, sideBySide: false, syncScroll: false};
      if (req.mode === 'syncScroll') st = {...st, syncScroll: req.value};
      return st;
    },
  };
  const saved = [];
  const host = createTestHost({windows, save: async file => { saved.push(file); return {revision: 1}; }});
  return {host, calls, saved, state: () => st};
}

test('Window commands go to the window service: New Window (after the working copy is written), Arrange All, Side by Side, Synchronous Scrolling, Reset, Switch Windows', async () => {
  const w = windowsHost();
  const t = await createTestSession('quill', {host: w.host, content: (await quill('Hello')).t.content});
  assert.equal(t.state('view.sideBySide').enabled, false, 'one window: nothing to view side by side with');
  assert.equal(t.state('view.syncScroll').enabled, false);
  assert.equal(t.state('view.resetWindowPosition').enabled, false);
  assert.deepEqual((await t.exec('view.newWindow')).result, {window: 2, doc: t.docId});
  assert.equal(w.saved.length, 1, 'the new window reads what this one has');
  assert.deepEqual(t.state('view.switchWindows').value.map(x => [x.label, x.checked]), [['1 Report:1', true], ['2 Report:2', false]]);
  await t.exec('view.arrangeAll');
  assert.equal(t.state('view.sideBySide').enabled, true);
  await t.exec('view.sideBySide');
  assert.equal(t.state('view.sideBySide').checked, true);
  assert.equal(t.state('view.syncScroll').checked, true, 'Synchronous Scrolling comes on with it (Word)');
  await t.exec('view.syncScroll');
  assert.equal(t.state('view.syncScroll').checked, false);
  await t.exec('view.resetWindowPosition');
  await t.exec('view.switchWindows', {value: 2});
  await t.exec('view.sideBySide');
  assert.deepEqual(w.calls.map(c => c[0] === 'arrange' ? `arrange:${c[1].mode}` : c[0]),
    ['open', 'arrange:all', 'arrange:sideBySide', 'arrange:syncScroll', 'arrange:reset', 'focus', 'arrange:off']);
  assert.equal(t.session.get(t.docId).undo.size, 0);
  // Headless there are no windows: the commands say so.
  const q = await quill('Hello');
  assert.equal(q.state('view.newWindow').enabled, false);
  await assert.rejects(q.exec('view.newWindow'), e => e.code === 'disabled' || e.code === 'unavailable');
});

test('a second window of the document: every commit, undo, redo and save is mirrored, with one undo history (session.mirror)', async () => {
  const a = await quill('Hello');
  const b = await createTestSession('quill', {content: a.t.content});
  const sent = [];
  a.t.session.onCommit(m => sent.push(m));
  const pump = async () => { while (sent.length) { const m = sent.shift(); await b.session.mirror(b.docId, {...m, doc: b.docId}); } };
  a.sel(0, 5);
  await a.exec('text.insert', {text: ' world'});
  await pump();
  assert.equal(b.content.body.chunks.flat()[0].text, 'Hello world');
  assert.equal(b.session.get(b.docId).undo.size, 1, 'the other window can undo it too');
  assert.equal(b.session.get(b.docId).dirty, true);
  await a.t.session.undo(a.t.docId);
  await pump();
  assert.equal(b.content.body.chunks.flat()[0].text, 'Hello');
  await a.t.session.redo(a.t.docId);
  await pump();
  assert.equal(b.content.body.chunks.flat()[0].text, 'Hello world');
  // An undo in the second window takes back the first window's edit there, and is mirrored back.
  const back = [];
  b.session.onCommit(m => back.push(m));
  await b.session.undo(b.docId);
  assert.deepEqual(back.map(m => m.history), ['undo']);
  await a.t.session.mirror(a.t.docId, {...back[0], doc: a.t.docId});
  assert.equal(blocks(a.t)[0].text, 'Hello');
  // A mirrored change is never sent on (no echo between windows).
  assert.equal(sent.length, 0);
});

// ---- Outline -----------------------------------------------------------------------------------

test('Outline layout: levels, what Show Level and collapsing hide, indents, symbols (layout outline.rs)', () => {
  const lv = [1, BODY, 2, BODY, 1, BODY];
  assert.deepEqual(hidden(lv, {}), Array(6).fill(false));
  assert.deepEqual(hidden(lv, {showLevel: 1}), [false, true, true, true, false, true]);
  assert.deepEqual(hidden(lv, {showLevel: 2}), [false, true, false, true, false, true]);
  assert.deepEqual(hidden(lv, {collapsed: [0]}), [false, true, true, true, false, false]);
  assert.deepEqual(hidden(lv, {collapsed: [1]}), Array(6).fill(false), 'collapsing body text does nothing');
  assert.equal(subtreeEnd(lv, 0), 4);
  assert.equal(subtreeEnd(lv, 99), 99);
  assert.equal(indent(lv, 3), 2 * LEVEL_INDENT);
  assert.equal(indent(lv, 0), 0);
  const pl = {lines: [{top: 0, baseline: 10, xs: [0, 30]}]};
  assert.equal(symbolItems(pl, 40, 0, BODY, false, false).length, 1, 'a dot for body text');
  const heading = symbolItems(pl, 40, 0, 1, true, true);
  assert.deepEqual(heading.map(i => i.kind), ['shape', 'rule', 'rule', 'rule'], 'a circled plus and the wavy line of a collapsed heading');
  assert.equal(heading[3].border.style, 'wave');
  assert.equal(symbolItems(pl, 40, 0, 2, false, false).length, 2, 'a circled minus');
  // Collapsed headings are found again by their text after an edit moved them.
  assert.deepEqual(remapPairs([BODY, 1, BODY], ['x', 'One', 'y'], [[0, textHashOf('One')]]), [[1, textHashOf('One')]]);
});

test('Outline view lays out each paragraph behind its symbol and indented by level; a click on a symbol names its block', async () => {
  const q = await outlineDoc();
  const lay = layout(q.t.content, viewLayoutOptions(view(q)));
  const lines = lay.pages[0].items.filter(i => i.kind === 'lines');
  assert.deepEqual(lines.map(i => i.path[0]), [0, 1, 2, 3, 4, 5]);
  const x0 = lines[0].x;
  assert.equal(lines[2].x - x0, LEVEL_INDENT, 'Heading 2 one level in');
  assert.equal(lines[3].x - x0, 2 * LEVEL_INDENT, 'its body text one deeper');
  assert.ok(lay.pages[0].items.some(i => i.kind === 'shape' && i.outlineSymbol));
  assert.equal(outlineSymbolAt(lay, 0, x0 - SYMBOL_W / 2, lines[2].y + 2), null, 'not the symbol of block 2 at block 0\'s x');
  assert.equal(outlineSymbolAt(lay, 0, lines[2].x - SYMBOL_W / 2, lines[2].y + 2), 2);
  // Show Text Formatting off draws every paragraph in the Normal style.
  await q.exec('outline.showFormatting', {value: false});
  const plain = layout(q.t.content, viewLayoutOptions(view(q)));
  const h = l => l.pages[0].items.find(i => i.kind === 'lines' && i.path[0] === 0).para.height;
  assert.ok(h(plain) < h(lay), 'the heading in the Normal style is smaller');
  assert.equal(q.state('outline.showFormatting').checked, false);
});

test('Outlining: Show Level, Collapse (deepest open level first), Expand, toggle, select a heading with its content', async () => {
  const q = await outlineDoc();
  assert.deepEqual(await shown(q), [0, 1, 2, 3, 4, 5]);
  await q.exec('outline.showLevel', {level: 1});
  assert.deepEqual(await shown(q), [0, 4]);
  await q.exec('outline.showLevel', {level: 'Level 2'});
  assert.deepEqual(await shown(q), [0, 2, 4]);
  await q.exec('outline.showLevel', {level: 'All Levels'});
  assert.deepEqual(await shown(q), [0, 1, 2, 3, 4, 5]);
  // Alt+Shift+1…9 (only two heading levels here: 3 and deeper show everything but body text).
  for (const id of ['outline.showLevel3', 'outline.showLevel4', 'outline.showLevel5', 'outline.showLevel6', 'outline.showLevel7', 'outline.showLevel8', 'outline.showLevel9']) {
    await q.exec(id);
    assert.deepEqual(await shown(q), [0, 2, 4], id);
  }
  await q.exec('outline.showAll');
  // Show First Line Only cuts body text to its first line; headings keep theirs.
  await q.exec('outline.firstLineOnly');
  assert.equal(q.state('outline.firstLineOnly').checked, true);
  await q.exec('outline.firstLineOnly', {value: false});
  assert.equal(q.state('outline.firstLineOnly').checked, false);
  q.sel(0, 0);
  await q.exec('outline.collapse');
  assert.deepEqual(await shown(q), [0, 1, 2, 4, 5]);
  await q.exec('outline.collapse');
  assert.deepEqual(await shown(q), [0, 4, 5]);
  const lay = layout(q.t.content, viewLayoutOptions(view(q)));
  assert.deepEqual([...new Set(lay.pages[0].items.filter(i => i.kind === 'lines').map(i => i.path[0]))], [0, 4, 5]);
  assert.ok(lay.pages[0].items.some(i => i.kind === 'rule' && i.border.style === 'wave'), 'the collapsed heading is marked');
  await q.exec('outline.expand');
  assert.deepEqual(await shown(q), [0, 1, 2, 4, 5]);
  await q.exec('outline.expand');
  assert.deepEqual(await shown(q), [0, 1, 2, 3, 4, 5]);
  await q.exec('outline.toggle', {block: 0});
  assert.deepEqual(await shown(q), [0, 4, 5]);
  await q.exec('outline.toggle', {block: 0});
  assert.deepEqual(await shown(q), [0, 1, 2, 3, 4, 5]);
  await q.exec('outline.selectSubtree', {block: 0});
  const sel = q.t.session.get(q.t.docId).selection.ranges[0];
  assert.match(sel.anchor, new RegExp(`b:${q.id(0)}/t:0$`));
  assert.match(sel.focus, new RegExp(`b:${q.id(3)}/t:1$`));
  assert.equal(undoDepth(q), 3, 'only the three heading styles are on the undo list');
  // Only in Outline view.
  await q.exec('outline.close');
  assert.equal(view(q).mode, 'print');
  await assert.rejects(q.exec('outline.showLevel1'), e => e.code === 'disabled');
});

test('Outlining: Move Up carries what a collapsed heading hides, one undo step, the heading stays collapsed (move_shown)', async () => {
  const q = await outlineDoc();
  q.sel(0, 0);
  await q.exec('outline.collapse');
  await q.exec('outline.collapse');
  q.sel([4, 0], [5, 1]);
  const depth = undoDepth(q);
  await q.exec('outline.moveUp');
  assert.equal(text(q), 'Three\nc\nOne\na\nTwo\nb');
  assert.equal(undoDepth(q), depth + 1);
  assert.deepEqual(await shown(q), [0, 1, 2], 'the collapsed heading moved and stays collapsed');
  await q.t.session.undo(q.t.docId);
  assert.equal(text(q), 'One\na\nTwo\nb\nThree\nc');
  assert.deepEqual(await shown(q), [0, 4, 5], 'found again after the undo');
  q.sel(0, 0);
  await q.exec('outline.moveDown');
  assert.equal(text(q), 'Three\nOne\na\nTwo\nb\nc', 'One and what it hides pass the next shown paragraph, Three');
});

test('Outlining: level changes are undoable; Promote / Demote carry hidden subheadings; junk is refused', async () => {
  const q = await outlineDoc();
  const level = async i => (await q.exec('outline.state')).result.levels[i];
  q.sel(1, 0);
  await q.exec('outline.level', {level: 3});
  assert.equal(await level(1), 3);
  await q.t.session.undo(q.t.docId);
  assert.equal(await level(1), BODY);
  await q.exec('outline.level', {level: 'Level 4'});
  assert.equal(await level(1), 4);
  await q.exec('outline.level', {level: 'Body Text'});
  assert.equal(await level(1), BODY);
  q.sel(2, 0);
  await q.exec('outline.promoteToHeading1');
  assert.equal(await level(2), 1);
  await q.exec('outline.demoteToBody');
  assert.equal(await level(2), BODY);
  await assert.rejects(q.exec('outline.level', {level: 12}), e => e.code === 'invalid_params');
  await assert.rejects(q.exec('outline.level', {level: 'x'}), e => e.code === 'invalid_params');
  // A collapsed Heading 1 demoted takes its hidden Heading 2 one level down too.
  const r = await outlineDoc();
  r.sel(0, 0);
  await r.exec('outline.collapse');
  await r.exec('outline.collapse');
  r.sel(0, 0);
  await r.exec('outline.demote');
  const lv = (await r.exec('outline.state')).result.levels;
  assert.deepEqual([lv[0], lv[2]], [2, 3]);
  assert.equal(q.state('outline.level').value, 'Body Text');
});

test('the Navigation pane\'s drag moves a heading with everything under it (outline.moveSection), one undo step', async () => {
  const q = await outlineDoc();
  await q.exec('outline.moveSection', {from: 4, to: 0});
  assert.equal(text(q), 'Three\nc\nOne\na\nTwo\nb');
  await q.t.session.undo(q.t.docId);
  assert.equal(text(q), 'One\na\nTwo\nb\nThree\nc');
  await q.exec('outline.moveSection', {from: 2, to: 6});
  assert.equal(text(q), 'One\na\nThree\nc\nTwo\nb', 'to the end');
  await q.exec('outline.moveSection', {from: 0, to: 1});
  assert.equal(text(q), 'One\na\nThree\nc\nTwo\nb', 'into its own section: nothing moves');
  await assert.rejects(q.exec('outline.moveSection', {from: 1, to: 0}), e => e.code === 'failed', 'body text is not a heading');
});

// ---- The page view's geometry --------------------------------------------------------------------

test('geometry: Read Mode\'s columns in one row, Web Layout edge to edge, Side to Side in one row, Text width (canvas/geometry.rs, reading.rs)', () => {
  const pages = Array.from({length: 4}, () => ({w: 612, h: 792, body: {x: 72, y: 72, w: 468, h: 648}}));
  const read = G.geometry(pages.map(() => ({w: 240, h: 420})), {readMode: true, readZoom: 1}, {w: 1200, h: 800});
  assert.ok(read.rects.every(r => r.y === G.GAP), 'one row');
  assert.ok(read.rects[1].x > read.rects[0].x + read.rects[0].w);
  assert.equal(G.readStep(read.rects), read.rects[1].x - read.rects[0].x);
  const web = G.geometry([{w: 900, h: 2000}], {mode: 'web', zoom: 100}, {w: 1200, h: 800});
  assert.equal(web.rects[0].x, 0, 'no grey margin');
  const side = G.geometry(pages, {pageMovement: 'sideToSide', fit: 'multiplePages', multiPage: true, zoom: 100}, {w: 1200, h: 800});
  assert.equal(new Set(side.rects.map(r => r.y)).size, 1, 'every page in one row');
  const draft = G.geometry([{w: 800, h: 3000}], {mode: 'draft', zoom: 100, fit: 'onePage'}, {w: 1200, h: 800});
  assert.equal(draft.scale, G.PX_PER_PT, 'a fit has no meaning without pages');
  const tw = G.geometry(pages, {fit: 'textWidth', zoom: 100}, {w: 1000, h: 800});
  assert.ok(Math.abs(468 * tw.scale - (1000 - 2 * G.GAP - 20)) < 0.01, 'the text column fills the window');
  const [w, h] = G.readingSize({w: 1200, h: 800}, G.PX_PER_PT, undefined);
  assert.ok(w > 144 && h > 144);
  assert.equal(G.readingSize({w: 1200, h: 800}, G.PX_PER_PT, 612)[0], 612);
  assert.equal(G.webLayoutWidth(1500, G.PX_PER_PT), 1125);
});

// ---- The view a document is saved with ----------------------------------------------------------

test('w:zoom and w:view: the zoom and view go into settings.xml when saved, and an opened document starts there', async () => {
  assert.equal(savedZoom({zoom: 100, fit: null}), null);
  assert.deepEqual(savedZoom({zoom: 80}), {percent: 80, fit: null});
  assert.deepEqual(savedZoom({zoom: 100, fit: 'onePage'}), {percent: 100, fit: 'onePage'});
  assert.equal(savedView({mode: 'print'}), null);
  assert.equal(savedView({mode: 'draft', readMode: true}), 'draft');
  const q = await quill('Hello');
  const file = fileForSave(q.t.file, {zoom: 120, mode: 'web'});
  assert.deepEqual([file.content.settings.zoom, file.content.settings.view], [{percent: 120, fit: null}, 'web']);
  assert.notEqual(file.content, q.t.content, 'the document itself is untouched');
  const back = await readDocx(await writeDocx(file.content));
  assert.deepEqual([back.settings.zoom, back.settings.view], [{percent: 120, fit: null}, 'web']);
  for (const [mode, w] of [['outline', 'outline'], ['draft', 'draft']]) {
    const x = await readDocx(await writeDocx(fileForSave(q.t.file, {zoom: 100, fit: 'pageWidth', mode}).content));
    assert.deepEqual([x.settings.view, x.settings.zoom], [w, {percent: 100, fit: 'pageWidth'}]);
  }
  assert.deepEqual(initialView({content: back}), {zoom: 120, fit: null, multiPage: false, singleColumn: false, mode: 'web'});
  // Opening the file starts in that view; File › Save writes the view the document is shown in.
  const t = await createTestSession('quill', {content: back});
  assert.deepEqual([t.doc.view.mode, t.doc.view.zoom], ['web', 120]);
  const files = createMemoryFiles();
  const s = await createTestSession('quill', {host: createTestHost({files}), content: q.t.content});
  files.bind(s.docId, {kind: 'quill', name: 'Report'});
  await s.exec('view.onePage');
  await s.exec('view.draft');
  assert.equal(s.doc.dirty, false, 'a view is not an edit');
  await s.exec('file.save', {path: 'C:\\Docs\\Report.docx'});
  const disk = files.disk.get('C:\\Docs\\Report.docx').file;
  assert.deepEqual([disk.content.settings.zoom, disk.content.settings.view], [{percent: 100, fit: 'onePage'}, 'draft']);
  assert.equal(s.content.settings.view, null, 'the open document is unchanged');
});

test('Outline view starts on the Outlining tab; Read Mode and Immersive Reader do not show it', async () => {
  const q = await outlineDoc();
  const flags = () => evaluate(q.t.content, q.t.session.get(q.t.docId).selection, {}, view(q));
  assert.equal(flags().outlining, true);
  await q.exec('view.readMode');
  assert.equal(flags().outlining, false);
  await q.exec('view.printLayout');
  assert.equal(flags().outlining, false);
  assert.ok(new Document(q.t.content));
});
