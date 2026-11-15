// U:slate/pages: the page list, the Recycle Bin, page templates and View › Page Setup, on
// schema-2 notebooks.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. Upstream: Slate has no ArtCraft source; docs/spec/slate.json `page.*` (sourceRef
//    core/slate-pages.mjs) names the commands; OneNote's behaviour: Add Page / Ctrl+N at the end
//    of the section (or at an insertion point), Ctrl+Alt+N below the current page, Ctrl+Alt+Shift+N
//    a subpage (two levels deep at most); Delete to the Notebook Recycle Bin (undoable); Make /
//    Promote Subpage (Ctrl+Alt+] / [), Collapse / Expand Subpages, Ctrl+Shift+*; Move Up / Down;
//    Move or Copy (Ctrl+Alt+M) to the end of a section; Cut / Copy / Paste page tabs; Sort; page
//    templates (save, apply, section default); Page Color, Rule Lines (Ctrl+Shift+R), Rule Line
//    Color, Always Create Pages with Rule Lines, Hide Page Title (deletes the title), Paper Size,
//    page date and time.
// 2. Ours does the same over the notebook model; every page edit is one undo entry and leaves a
//    valid notebook (levels never jump more than one below the page above).
// 3. Proof: these tests (engine, undo round trips, dialog models) and
//    tests/e2e/slate/pages-sections.e2e.mjs (page list, ribbon, captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip, expectApprovalRequired} from '../../core/kernel/testing.mjs';
import {validateFile} from '../../core/model.mjs';
import {normalizeLevels, binOf} from '../../core/slate/lib/pages-recycle.mjs';
import templatesDialog, {NO_DEFAULT} from '../../core/slate/dialogs/page-templates.mjs';
import saveTemplateDialog from '../../core/slate/dialogs/save-as-template.mjs';
import paperDialog from '../../core/slate/dialogs/paper-size.mjs';
import moveCopyDialog from '../../core/slate/dialogs/move-copy-pages.mjs';
import {buildNotebook, model, notebookSession} from './foundation-helpers.mjs';

async function pagesSession() {
  const t = await notebookSession(buildNotebook({sections: [{name: 'Week 1', pages: ['A', {title: 'A1', level: 1}, 'B', 'C']}, {name: 'Week 2', pages: ['X']}]}));
  t.sec = model.sectionOrder(t.content);
  t.pid = title => Object.values(t.content.pages).find(p => p.title === title).id;
  t.go = title => t.session.setSelection(t.docId, model.selectPage(t.pid(title)), {origin: 'test'});
  t.list = (i = 0) => t.content.sections[t.sec[i]].pages.map(e => `${'-'.repeat(e.level)}${t.content.pages[e.id].title || '?'}`).join(' ');
  return t;
}

test('page.new adds an untitled page at the end of the current section (or after a page, past its subpages) and opens it', async () => {
  const t = await pagesSession();
  t.go('A');
  const r = await expectUndoRoundTrip(t, 'page.new', {});
  assert.equal(t.list(), 'A -A1 B C ?');
  assert.equal(t.doc.selection.ranges[0].anchor, `/pg:${r.result.page}`);
  await t.exec('page.new', {afterPageId: t.pid('A')});
  assert.equal(t.list(), 'A -A1 ? B C ?');
  await t.exec('page.new', {sectionId: t.sec[1]});
  assert.equal(t.list(1), 'X ?');
  await assert.rejects(t.exec('page.new', {sectionId: 'nope'}), e => e.code === 'not_found');
  await assert.rejects(t.exec('page.new', {afterPageId: 'nope'}), e => e.code === 'not_found');
  validateFile(t.file);
});

test('page.newBelow goes after the current page group at its level; page.newSubpage indents (two levels at most)', async () => {
  const t = await pagesSession();
  t.go('A');
  await expectUndoRoundTrip(t, 'page.newBelow', {});
  assert.equal(t.list(), 'A -A1 ? B C');
  t.go('A1');
  await expectUndoRoundTrip(t, 'page.newSubpage', {});
  assert.equal(t.list(), 'A -A1 --? ? B C');
  assert.deepEqual(t.state('page.newSubpage'), {enabled: false, reason: 'Subpages can only be two levels deep'});
  validateFile(t.file);
});

test('page.delete moves pages to the Notebook Recycle Bin; a collapsed group goes with its parent; the page below opens; undo restores', async () => {
  const t = await pagesSession();
  t.go('B');
  await expectUndoRoundTrip(t, 'page.delete', {}, after => assert.equal(binOf(after.content).length, 1));
  assert.equal(t.list(), 'A -A1 C');
  assert.equal(t.doc.selection.ranges[0].anchor, `/pg:${t.pid('C')}`);
  const bin = binOf(t.content)[0];
  assert.equal(bin.kind, 'page');
  assert.equal(bin.page.title, 'B');
  assert.deepEqual(bin.from, {sectionId: t.sec[0], sectionName: 'Week 1', index: 2});
  // Expanded: only the parent goes, its subpage moves up a level.
  t.go('A');
  await t.exec('page.delete');
  assert.equal(t.list(), 'A1 C');
  await t.undo();
  await expectUndoRoundTrip(t, 'page.collapseSubpages', {});
  assert.deepEqual(t.state('page.collapseSubpages'), {enabled: false, reason: 'The subpages are already collapsed'});
  await t.exec('page.delete');
  assert.equal(t.list(), 'C');
  assert.equal(binOf(t.content).length, 3);
  validateFile(t.file);
});

test('page.makeSubpage / page.promoteSubpage move a page with its subpages one level; OneNote\'s limits apply', async () => {
  const t = await pagesSession();
  t.go('B');
  await expectUndoRoundTrip(t, 'page.makeSubpage', {});
  assert.equal(t.list(), 'A -A1 -B C');
  await t.exec('page.makeSubpage');
  assert.equal(t.list(), 'A -A1 --B C');
  assert.equal(t.state('page.makeSubpage').enabled, false);
  t.go('A');
  assert.deepEqual(t.state('page.makeSubpage'), {enabled: false, reason: 'The first page in a section cannot be a subpage'});
  t.go('A1');
  await expectUndoRoundTrip(t, 'page.promoteSubpage', {});
  assert.equal(t.list(), 'A A1 -B C');
  t.go('C');
  assert.deepEqual(t.state('page.promoteSubpage'), {enabled: false, reason: 'This page is not a subpage'});
  assert.deepEqual(normalizeLevels([{id: 'a', level: 1}, {id: 'b', level: 2}, {id: 'c', level: 2}]).map(e => e.level), [0, 1, 2]);
});

test('page.expandSubpages, page.toggleGroup (Ctrl+Shift+*) fold the group of the current page', async () => {
  const t = await pagesSession();
  t.go('A1');
  await expectUndoRoundTrip(t, 'page.toggleGroup', {});
  assert.equal(t.content.pages[t.pid('A')].collapsed, true);
  assert.equal(t.doc.selection.ranges[0].anchor, `/pg:${t.pid('A')}`);
  await expectUndoRoundTrip(t, 'page.expandSubpages', {});
  assert.equal(t.content.pages[t.pid('A')].collapsed, undefined);
  t.go('C');
  assert.deepEqual(t.state('page.toggleGroup'), {enabled: false, reason: 'This page is not in a page group'});
});

test('page.moveUp / page.moveDown move a page with its subpages past the neighbouring group', async () => {
  const t = await pagesSession();
  t.go('B');
  await expectUndoRoundTrip(t, 'page.moveUp', {});
  assert.equal(t.list(), 'B A -A1 C');
  t.go('A');
  await expectUndoRoundTrip(t, 'page.moveDown', {});
  assert.equal(t.list(), 'B C A -A1');
  assert.deepEqual((await t.exec('page.moveDown')).result, {moved: false});
});

test('page.moveOrCopy moves or copies pages with their subpages to the end of another section; the dialog lists the tree', async () => {
  const t = await pagesSession();
  t.go('A');
  await expectUndoRoundTrip(t, 'page.moveOrCopy', {targetSectionId: t.sec[1], mode: 'copy'});
  assert.equal(t.list(1), 'X A -A1');
  assert.equal(t.list(), 'A -A1 B C');
  await expectUndoRoundTrip(t, 'page.moveOrCopy', {targetSectionId: t.sec[1], mode: 'move'});
  assert.equal(t.list(), 'B C');
  assert.equal(t.list(1), 'X A -A1 A -A1');
  validateFile(t.file);
  t.go('B');
  const ctx = t.session.readContext(t.docId);
  const v = moveCopyDialog.init(ctx);
  assert.deepEqual(v.tree.map(x => [x.kind, x.label, x.depth]), [['notebook', 'Course notes', 0], ['section', 'Week 1', 1], ['section', 'Week 2', 1]]);
  assert.equal(moveCopyDialog.validate({...v, target: v.tree[0].value})[0].field, 'target');
  assert.deepEqual(moveCopyDialog.toCommand({...v, target: t.sec[1]}), {command: 'page.moveOrCopy', params: {pageIds: [t.pid('B')], targetSectionId: t.sec[1], mode: 'move'}});
  assert.equal(moveCopyDialog.buttons.copy(ctx, {...v, target: t.sec[1]}).params.mode, 'copy');
});

test('page.copy / page.cut / page.paste go through the clipboard; pasted copies get new ids', async () => {
  const t = await pagesSession();
  t.go('C');
  assert.deepEqual(t.state('page.paste'), {enabled: false, reason: 'The clipboard holds no pages'});
  await t.exec('page.copy');
  assert.equal(t.host.clipboard?.text ?? t.session.clipboard.text, 'C');
  await expectUndoRoundTrip(t, 'page.paste', {targetSectionId: t.sec[1]});
  assert.equal(t.list(1), 'X C');
  assert.notEqual(t.content.sections[t.sec[1]].pages[1].id, t.pid('C'));
  t.go('B');
  await expectUndoRoundTrip(t, 'page.cut', {});
  assert.equal(t.list(), 'A -A1 C');
  await t.exec('page.paste', {targetSectionId: t.sec[0], afterPageId: t.pid('A')});
  assert.equal(t.list(), 'A -A1 B C');
  validateFile(t.file);
});

test('page.rename, page.sort, page.select, page.focusTitle', async () => {
  const t = await pagesSession();
  t.go('C');
  await expectUndoRoundTrip(t, 'page.rename', {title: 'Alpha'});
  await expectUndoRoundTrip(t, 'page.sort', {by: 'alphabetical'});
  assert.equal(t.list(), 'A -A1 Alpha B');
  await t.exec('page.sort', {by: 'alphabetical', order: 'desc'});
  assert.equal(t.list(), 'B Alpha A -A1');
  await t.exec('page.sort', {by: 'created'});
  await t.exec('page.select');
  assert.equal(t.doc.selection.ranges[0].anchor, `/pg:${t.pid('Alpha')}`);
  await t.exec('page.focusTitle');
  assert.equal(t.doc.selection.ranges[0].anchor, `/pg:${t.pid('Alpha')}/title/t:0-5`);
});

test('page setup: page.setColor, page.ruleLines (toggle), page.ruleLineColor, page.alwaysCreateWithRuleLines', async () => {
  const t = await pagesSession();
  t.go('A');
  await expectUndoRoundTrip(t, 'page.setColor', {color: '#FFF2CC'});
  assert.deepEqual(t.state('page.setColor', {color: '#fff2cc'}), {enabled: true, value: '#fff2cc', checked: true});
  assert.deepEqual(t.state('page.ruleLineColor'), {enabled: false, reason: 'Turn on rule lines first'});
  await expectUndoRoundTrip(t, 'page.ruleLines', {pattern: 'toggle'});
  assert.equal(t.content.pages[t.pid('A')].rule.pattern, 'college-ruled');
  await t.exec('page.ruleLines', {pattern: 'small-grid'});
  await t.exec('page.ruleLines', {pattern: 'toggle'});
  assert.equal(t.content.pages[t.pid('A')].rule.pattern, 'none');
  await t.exec('page.ruleLines', {pattern: 'toggle'});
  assert.equal(t.content.pages[t.pid('A')].rule.pattern, 'small-grid');
  await expectUndoRoundTrip(t, 'page.ruleLineColor', {color: '#A9D18E'});
  assert.equal(t.content.pages[t.pid('A')].rule.color, '#a9d18e');
  await t.exec('page.alwaysCreateWithRuleLines', {});
  assert.equal(t.state('page.alwaysCreateWithRuleLines').checked, true);
  await t.exec('page.new');
  const fresh = t.content.sections[t.sec[0]].pages.at(-1).id;
  assert.deepEqual(t.content.pages[fresh].rule, {pattern: 'small-grid', color: '#a9d18e'});
  await t.exec('page.alwaysCreateWithRuleLines', {enabled: false});
  assert.equal(t.session.prefs['slate.newPageRule'], null);
});

test('page.hideTitle deletes the title (asking first when it has text) and shows an empty one again', async () => {
  const t = await pagesSession();
  t.go('A');
  await expectApprovalRequired(t, 'page.hideTitle', {});
  await expectUndoRoundTrip(t, 'page.hideTitle', {});
  assert.equal(t.content.pages[t.pid('A1')] && t.content.pages[t.content.sections[t.sec[0]].pages[0].id].title, '');
  const first = t.content.sections[t.sec[0]].pages[0].id;
  assert.equal(t.content.pages[first].titleHidden, true);
  assert.deepEqual(t.state('page.focusTitle'), {enabled: false, reason: 'The page title is hidden'});
  await t.bridge('page.hideTitle', {});
  assert.equal(t.content.pages[first].titleHidden, false);
});

test('page.paperSize and the Paper Size pane; page.setDate / page.setTime keep the other half', async () => {
  const t = await pagesSession();
  t.go('A');
  await expectUndoRoundTrip(t, 'page.paperSize', {size: 'A4', orientation: 'landscape'});
  assert.deepEqual(t.content.pages[t.pid('A')].paperSize, {size: 'A4', orientation: 'landscape', width: 11.69, height: 8.27, margins: {top: 0.5, bottom: 0.5, left: 0.5, right: 0.5}});
  await assert.rejects(t.exec('page.paperSize', {size: 'Letter', margins: {left: 6, right: 6}}), e => e.code === 'invalid_params');
  const ctx = t.session.readContext(t.docId);
  const v = paperDialog.init(ctx);
  assert.deepEqual([v.size, v.orientation, v.width], ['A4', 'Landscape', 11.69]);
  assert.deepEqual(paperDialog.derive({...v, size: 'Letter', orientation: 'Portrait'}, ['size']), {width: 8.5, height: 11});
  assert.deepEqual(paperDialog.toCommand({...v, size: 'Auto'}), {command: 'page.paperSize', params: {size: 'Auto'}});
  await t.exec('page.paperSize', {size: 'Auto'});
  assert.equal(t.content.pages[t.pid('A')].paperSize, null);
  await expectUndoRoundTrip(t, 'page.setDate', {date: '2026-01-15'});
  await expectUndoRoundTrip(t, 'page.setTime', {time: '3:30 PM'});
  const d = new Date(t.content.pages[t.pid('A')].created);
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [2026, 0, 15, 15, 30]);
  await assert.rejects(t.exec('page.setDate', {date: '2026-02-30'}), e => e.code === 'invalid_params');
  await assert.rejects(t.exec('page.setTime', {time: '25:00'}), e => e.code === 'invalid_params');
});

test('page templates: save the page, make it the section default, new pages and page.applyTemplate start from it', async () => {
  const t = await pagesSession();
  t.go('A');
  await t.exec('page.setColor', {color: '#e2f0d9'});
  await t.exec('page.ruleLines', {pattern: 'wide-ruled'});
  const ctx0 = t.session.readContext(t.docId);
  assert.deepEqual(saveTemplateDialog.init(ctx0), {name: 'A', setDefault: false});
  const saved = await t.exec('page.saveAsTemplate', {name: 'Lab', setDefault: true});
  const id = saved.result.template;
  assert.equal(t.content.sections[t.sec[0]].defaultTemplate, id);
  await assert.rejects(t.exec('page.saveAsTemplate', {name: 'lab'}), e => e.code === 'invalid_params');
  const r = await t.exec('page.new');
  const p = t.content.pages[r.result.page];
  assert.deepEqual([p.title, p.color, p.rule.pattern], ['', '#e2f0d9', 'wide-ruled']);
  assert.deepEqual((await t.exec('page.templates')).result, {templates: [{id, name: 'Lab', category: 'My Templates'}], recent: [], defaultTemplate: id});
  await expectUndoRoundTrip(t, 'page.setDefaultTemplate', {templateId: null});
  assert.equal(t.content.sections[t.sec[0]].defaultTemplate, undefined);
  assert.deepEqual(t.state('page.applyTemplate', {templateId: 'recent'}), {enabled: false, reason: 'No template has been used yet'});
  await expectUndoRoundTrip(t, 'page.applyTemplate', {templateId: id});
  assert.equal(t.state('page.applyTemplate', {templateId: 'recent'}).enabled, true);
  await t.exec('page.applyTemplate', {templateId: 'recent'});
  const ctx = t.session.readContext(t.docId);
  const v = templatesDialog.init(ctx);
  assert.deepEqual([v.templates, v.defaultTemplate], [[{id, name: 'Lab'}], NO_DEFAULT]);
  assert.deepEqual(templatesDialog.buttons.setDefault(ctx, {...v, defaultTemplate: id}).command, 'page.setDefaultTemplate');
  assert.deepEqual(templatesDialog.toCommand({...v, template: id}), {command: 'page.applyTemplate', params: {templateId: id}});
  validateFile(t.file);
});

test('a schema-1 page (legacy editor) keeps New Page on its outline; the notebook-only commands are disabled', async () => {
  const {createTestSession} = await import('../../core/kernel/testing.mjs');
  const {createFile} = await import('../../core/model.mjs');
  const file = createFile('slate', 'Old page');
  file.id = 'doc1';
  const t = await createTestSession('slate', {file});
  assert.equal(t.state('page.new').enabled, true);
  assert.deepEqual(t.state('page.delete'), {enabled: false, reason: 'No notebook is open'});
  assert.deepEqual(t.state('page.sort'), {enabled: false, reason: 'No notebook is open'});
  await t.exec('page.newSubpage');
  await t.exec('page.newBelow');
  assert.deepEqual(t.content.outline.sections[0].pages.map(p => p.level), [0, 1, 1]);
});
