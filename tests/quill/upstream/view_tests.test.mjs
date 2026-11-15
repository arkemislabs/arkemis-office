// Ported from wordcraft crates/engine/src/tests.rs (the View and Outline tests) and
// crates/layout/src/outline.rs (tests) at aadb077e072b7de05f724e359d8db82e151f125c (MIT, see
// assets/third-party-licenses/artcraft-reference.txt). Each test names the Rust test it ports.
// Upstream reads the session's ViewState fields directly; here they are the document view
// (`session.get(doc).view`, normalized by core/quill/lib/view-layout.mjs viewOf). The window sizes
// upstream keeps as `read_width` / `read_height` / `web_width` are the page view's metrics, passed
// to viewLayoutOptions. Not ported: the caret leaving collapsed text (after_command's caret half),
// full_screen_view (upstream-only) and the numeral and theme tests (not View tab controls).

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill, blocks} from '../format-fixture.mjs';
import {createTestSession} from '../../../core/kernel/testing.mjs';
import {layout} from '../../../core/quill/layout/index.mjs';
import {BODY, hidden, hasChildren, subtreeEnd, indent, LEVEL_INDENT} from '../../../core/quill/layout/outline.mjs';
import {viewLayoutOptions, viewOf} from '../../../core/quill/lib/view-layout.mjs';
import {fileForSave} from '../../../core/quill/lib/view-file.mjs';
import {read as readDocx} from '../../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../../core/quill/formats/docx-write.mjs';

const view = q => q.t.session.get(q.t.docId).view;
const v = q => viewOf(view(q));
const text = q => blocks(q.t).map(b => b.text).join('\n');
const undoLabels = q => q.t.session.get(q.t.docId).undo.labels();

/** Outline view of: Heading 1 "One", body "a", Heading 2 "Two", body "b", Heading 1 "Three", body "c" (outline_doc). */
async function outlineDoc() {
  const q = await quill('One\na\nTwo\nb\nThree\nc');
  for (const [i, style] of [[0, 'Heading1'], [2, 'Heading2'], [4, 'Heading1']]) { q.sel(i, 0); await q.exec('para.style', {style}); }
  await q.exec('view.outline');
  return q;
}
const outlineShown = async q => (await q.exec('outline.state')).result.shown;
/** The body blocks the outline layout draws (laid_out_blocks). */
const laidOutBlocks = q => [...new Set(layout(q.t.content, viewLayoutOptions(view(q))).pages[0].items.filter(i => i.kind === 'lines' && i.story === 'body').map(i => i.path[0]))];

test('show_level_and_collapse_hide_what_is_under_a_heading (layout outline.rs)', () => {
  const lv = [1, BODY, 2, BODY, 1, BODY];
  assert.deepEqual(hidden(lv, {}), Array(6).fill(false));
  assert.deepEqual(hidden(lv, {showLevel: 1}), [false, true, true, true, false, true]);
  assert.deepEqual(hidden(lv, {showLevel: 2}), [false, true, false, true, false, true]);
  assert.deepEqual(hidden(lv, {collapsed: [0]}), [false, true, true, true, false, false]);
  assert.deepEqual(hidden(lv, {collapsed: [1]}), Array(6).fill(false));
  assert.ok(hasChildren(lv, 0) && hasChildren(lv, 2) && !hasChildren(lv, 1));
  assert.equal(subtreeEnd(lv, 0), 4);
  assert.equal(subtreeEnd(lv, 99), 99);
  assert.equal(indent(lv, 3), 2 * LEVEL_INDENT);
  assert.equal(indent(lv, 0), 0);
});

test('focus_and_full_screen_replace_each_other (tests.rs:5823), the Focus and Immersive Reader half', async () => {
  const q = await quill('');
  q.sel(0, 0);
  await q.exec('text.insert', {text: 'Hello'});
  const undo = undoLabels(q);
  assert.equal((await q.exec('view.focus')).result.value, true);
  assert.ok(v(q).focusMode);
  assert.equal((await q.exec('view.focus', {value: true})).result.value, true);
  assert.equal((await q.exec('view.focus')).result.value, false);
  assert.ok(!v(q).focusMode);
  // Immersive Reader is a reading view, not Focus.
  await q.exec('view.immersive');
  assert.ok(v(q).immersive && !v(q).focusMode);
  assert.equal(text(q), 'Hello');
  assert.deepEqual(undoLabels(q), undo);
});

test('zoom_after_one_page_keeps_single_column (tests.rs:5857, #768)', async () => {
  const q = await quill('Hello');
  await q.exec('view.onePage');
  assert.ok(v(q).singleColumn);
  await q.exec('view.zoomOut');
  assert.ok(v(q).fit === null && v(q).singleColumn);
  await q.exec('view.zoom', {value: 50});
  assert.ok(v(q).singleColumn);
  await q.exec('view.multiplePages');
  assert.ok(!v(q).singleColumn);
  await q.exec('view.zoomIn');
  assert.ok(!v(q).singleColumn);
  await q.exec('view.pageWidth');
  await q.exec('view.sideToSide');
  assert.ok(!v(q).singleColumn);
});

test('one_page_is_restored_when_the_document_is_reopened (tests.rs:5879, #995)', async () => {
  const q = await quill('Hello');
  await q.exec('view.onePage');
  assert.equal(q.t.session.get(q.t.docId).dirty, false, 'a zoom isn\'t an edit');
  const bytes = await writeDocx(fileForSave(q.t.file, view(q)).content);
  const other = await createTestSession('quill', {content: await readDocx(bytes)});
  assert.equal(other.doc.view.fit, 'onePage');
  assert.ok(other.doc.view.singleColumn && !other.doc.view.multiPage);
  assert.equal(other.doc.dirty, false);
  // A percentage is restored as a percentage, the fit mode dropped.
  await other.exec('view.zoom', {value: 80});
  const again = await createTestSession('quill', {content: await readDocx(await writeDocx(fileForSave(other.file, other.doc.view).content))});
  assert.deepEqual([again.doc.view.zoom, again.doc.view.fit], [80, null]);
});

test('navigation_pane_opens_without_changing_view_mode (tests.rs:5908)', async () => {
  const q = await quill('Hello');
  for (const command of ['view.printLayout', 'view.webLayout', 'view.readMode']) {
    await q.exec(command);
    const before = [v(q).mode, v(q).readMode];
    await q.exec('view.navigationPane', {value: false});
    await q.exec('view.navigationPane', {value: true});
    assert.ok(v(q).navPane);
    assert.deepEqual([v(q).mode, v(q).readMode], before, command);
  }
});

test('reading_mode_reflows_per_viewport_without_changing_document_or_export (tests.rs:5942)', async () => {
  const q = await quill('');
  q.sel(0, 0);
  await q.exec('text.insert', {text: 'A long paragraph for reading. '.repeat(200)});
  const original = q.t.content;
  const print = layout(q.t.content, {view: 'print'});
  const dirty = q.t.session.get(q.t.docId).dirty;
  await q.exec('view.readMode');
  assert.ok(v(q).readMode);
  const columns = layout(q.t.content, viewLayoutOptions(view(q), {readWidth: 240, readHeight: 420}));
  assert.ok(columns.pages.length > print.pages.length);
  assert.ok(columns.pages.every(p => p.w === 240 && p.h === 420));
  assert.ok(layout(q.t.content, viewLayoutOptions(view(q), {readWidth: 240, readHeight: 260})).pages.length > columns.pages.length, 'height is part of the layout');
  assert.equal(layout(q.t.content, viewLayoutOptions(view(q), {readWidth: 300, readHeight: 260})).pages[0].w, 300, 'width is part of the layout');
  assert.ok(!('readWidth' in view(q)) && !('readHeight' in view(q)), 'window sizes are not view state');
  await q.exec('view.readColumnWidth', {value: 'page'});
  await q.exec('view.readTextSize', {value: 125});
  const defaultSpacing = layout(q.t.content, viewLayoutOptions(view(q), {readWidth: 240, readHeight: 420})).pages.length;
  await q.exec('view.readLineSpacing', {value: 2});
  assert.deepEqual([v(q).readColumnWidth, v(q).readZoom, v(q).readLineSpacing], [612, 1.25, 2]);
  assert.ok(layout(q.t.content, viewLayoutOptions(view(q), {readWidth: 240, readHeight: 420})).pages.length > defaultSpacing, 'line spacing reflows');
  await assert.rejects(q.exec('view.readTextSize', {value: -10}));
  await assert.rejects(q.exec('view.readLineSpacing', {value: 0.01}));
  await assert.rejects(q.exec('view.readColumnWidth', {value: 'giant'}));
  await q.exec('view.printLayout');
  assert.ok(!v(q).readMode);
  assert.equal(layout(q.t.content, viewLayoutOptions(view(q))).pages[0].w, print.pages[0].w);
  assert.equal(q.t.content, original);
  assert.equal(q.t.session.get(q.t.docId).dirty, dirty);
  await q.exec('view.readMode');
  assert.deepEqual([v(q).readColumnWidth, v(q).readZoom, v(q).readLineSpacing], [null, 1, null]);
});

test('reading_page_color_is_a_transient_view_setting (tests.rs:5994)', async () => {
  const q = await quill('Hello');
  const original = q.t.content;
  await q.exec('view.readMode');
  assert.equal(v(q).readPageColor, 'none');
  assert.deepEqual((await q.exec('view.readPageColor', {value: 'sepia'})).result, {pageColor: 'sepia'});
  await q.exec('view.readPageColor', {value: 'inverse'});
  assert.equal(v(q).readPageColor, 'inverse');
  for (const bad of [{value: 'black'}, {value: 1}, {}]) await assert.rejects(q.exec('view.readPageColor', bad), JSON.stringify(bad));
  assert.equal(v(q).readPageColor, 'inverse', 'rejected values keep the color');
  assert.equal(q.t.content, original);
  await q.exec('view.printLayout');
  await q.exec('view.readMode');
  assert.equal(v(q).readPageColor, 'none');
});

test('outline_level_changes_are_undoable (tests.rs:8882)', async () => {
  const q = await outlineDoc();
  const level = async i => (await q.exec('outline.state')).result.levels[i];
  q.sel(1, 0);
  await q.exec('outline.level', {level: 3});
  assert.equal(await level(1), 3);
  await q.t.session.undo(q.t.docId);
  assert.equal(await level(1), 10, 'body text again');
  q.sel(2, 0);
  await q.exec('outline.promoteToHeading1');
  assert.equal(await level(2), 1);
  await q.exec('outline.demoteToBody');
  assert.equal(await level(2), 10);
  await assert.rejects(q.exec('outline.level', {level: 12}));
  await assert.rejects(q.exec('outline.level', {}));
  // Every outline command survives junk parameters in Outline view.
  const ids = [...q.t.registry.list({family: 'outline'})].map(c => c.id);
  for (const id of ids) {
    for (const j of [null, {block: 99999, level: 'x', value: 5}, {block: -1, level: 0}]) {
      const r = await outlineDoc();
      await r.exec(id, j ?? {}).catch(() => null);
      layout(r.t.content, viewLayoutOptions(view(r)));
    }
  }
});

test('outline_show_level_filters_paragraphs (tests.rs:8908)', async () => {
  const q = await outlineDoc();
  assert.deepEqual(await outlineShown(q), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(laidOutBlocks(q), [0, 1, 2, 3, 4, 5]);
  await q.exec('outline.showLevel', {level: 1});
  assert.deepEqual(await outlineShown(q), [0, 4]);
  assert.deepEqual(laidOutBlocks(q), [0, 4]);
  await q.exec('outline.showLevel2');
  assert.deepEqual(await outlineShown(q), [0, 2, 4]);
  await q.exec('outline.showAll');
  assert.deepEqual(await outlineShown(q), [0, 1, 2, 3, 4, 5]);
  // Word's keys, and only in Outline view.
  const byKey = k => q.t.registry.list({}).find(c => [c.shortcut].flat().includes(k))?.id;
  assert.equal(byKey('Alt+Shift+1'), 'outline.showLevel1');
  assert.equal(byKey('Alt+Shift+A'), 'outline.showAll');
  assert.equal(byKey('Alt+Shift+='), 'outline.expand');
  assert.equal(byKey('Alt+Shift+-'), 'outline.collapse');
  await q.exec('outline.close');
  await assert.rejects(q.exec('outline.showLevel1'));
});

test('outline_collapse_hides_descendants_and_expand_restores (tests.rs:8930)', async () => {
  const q = await outlineDoc();
  q.sel(0, 0);
  // The deepest open level closes first, then the heading itself.
  await q.exec('outline.collapse');
  assert.deepEqual(await outlineShown(q), [0, 1, 2, 4, 5]);
  await q.exec('outline.collapse');
  assert.deepEqual(await outlineShown(q), [0, 4, 5]);
  assert.deepEqual(laidOutBlocks(q), [0, 4, 5]);
  // Moving "Three" and "c" up passes "One" with everything collapsed under it, in one undo step.
  q.sel([4, 0], [5, 1]);
  await q.exec('outline.moveUp');
  assert.equal(text(q), 'Three\nc\nOne\na\nTwo\nb');
  assert.deepEqual(await outlineShown(q), [0, 1, 2], 'the collapsed heading moved and stays collapsed');
  await q.t.session.undo(q.t.docId);
  assert.equal(text(q), 'One\na\nTwo\nb\nThree\nc');
  assert.deepEqual(await outlineShown(q), [0, 4, 5]);
  // Expand opens one level at a time; double-clicking the symbol (toggle) opens it all.
  q.sel(0, 0);
  await q.exec('outline.expand');
  assert.deepEqual(await outlineShown(q), [0, 1, 2, 4, 5]);
  await q.exec('outline.expand');
  assert.deepEqual(await outlineShown(q), [0, 1, 2, 3, 4, 5]);
  await q.exec('outline.toggle', {block: 0});
  assert.deepEqual(await outlineShown(q), [0, 4, 5]);
  await q.exec('outline.toggle', {block: 0});
  assert.deepEqual(await outlineShown(q), [0, 1, 2, 3, 4, 5]);
  // Clicking a symbol selects the heading with what is under it.
  await q.exec('outline.selectSubtree', {block: 0});
  const r = q.t.session.get(q.t.docId).selection.ranges[0];
  assert.ok(r.anchor.endsWith(`b:${q.id(0)}/t:0`) && r.focus.endsWith(`b:${q.id(3)}/t:1`), JSON.stringify(r));
});

test('outline_aliases_add_one_undo_step (tests.rs:9545)', async () => {
  const q = await quill('one\ntwo');
  q.sel(1, 0);
  for (const id of ['outline.promote', 'outline.demote', 'outline.moveUp', 'outline.moveDown']) {
    const doc = q.t.content, depth = q.t.session.get(q.t.docId).undo.size;
    await q.exec(id);
    assert.notEqual(q.t.content, doc, `${id} changed nothing`);
    assert.equal(q.t.session.get(q.t.docId).undo.size, depth + 1, id);
    await q.t.session.undo(q.t.docId);
    assert.deepEqual(q.t.content.body, doc.body, `${id}: one undo restores the document`);
    await q.t.session.redo(q.t.docId);
  }
});

test('draft_keeps_its_column_after_web_layout (tests.rs:10539, #1876)', async () => {
  const q = await quill('Draft text wraps in a fixed column. '.repeat(80));
  await q.exec('view.draft');
  assert.equal(layout(q.t.content, viewLayoutOptions(view(q))).pages[0].w, 800);
  await q.exec('view.webLayout');
  assert.equal(layout(q.t.content, viewLayoutOptions(view(q), {webWidth: 1400})).pages[0].w, 1400, 'Web Layout follows the window');
  await q.exec('view.draft');
  assert.equal(layout(q.t.content, viewLayoutOptions(view(q), {webWidth: 1400})).pages[0].w, 800, 'Draft never sees Web Layout\'s window width');
  await q.exec('view.outline');
  assert.equal(layout(q.t.content, viewLayoutOptions(view(q), {webWidth: 1400})).pages[0].w, 800, 'nor does Outline');
  assert.ok(!('webWidth' in view(q)), 'a window width is not view state to keep');
});

test('web_view_is_one_page (layout tests.rs:2942)', async () => {
  const q = await quill(Array.from({length: 40}, (_, i) => `Paragraph ${i} `.repeat(20)).join('\n'));
  assert.ok(layout(q.t.content, {view: 'print'}).pages.length > 1);
  assert.equal(layout(q.t.content, {view: 'web', webWidth: 600}).pages.length, 1);
});
