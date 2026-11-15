// F:slate foundation: the schema-2 notebook, the page canvas commands and the outline the page and
// section families edit. Slate has no ArtCraft upstream: each test names the OneNote behaviour it
// checks.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. OneNote: a notebook holds section groups, sections and pages; a page is a free-form canvas
//    where clicking anywhere starts a note container, containers move by their top bar and resize
//    by their width handle, ink lies on top of the notes (pen and highlighter, erased by stroke),
//    Undo Typing undoes a burst of typing at once, and every change autosaves.
// 2. Ours: the same, as kernel commands over the notebook model (surface.* for the canvas), each
//    one undo entry; typing merges per page.
// 3. Proof: these tests (engine) and tests/e2e/slate/surface-*.e2e.mjs (bridge, window captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import {ReplaceStep, AttrStep} from '@tiptap/pm/transform';
import {Slice, Fragment} from '@tiptap/pm/model';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {createFile, validateFile} from '../../core/model.mjs';
import {buildNotebook, firstPage, model, notebookSession, probe, schema, NOW} from './foundation-helpers.mjs';

const insertText = (doc, pos, text) => new ReplaceStep(pos, pos, new Slice(Fragment.from(model.schema.text(text)), 0, 0)).toJSON();

test('createContent: a new notebook is OneNote\'s "New Section 1" with one untitled page; createFile makes schema-2 Slate files', () => {
  const c = schema.createContent('Physics');
  assert.equal(c.format, 'arkemis.slate-notebook');
  assert.equal(c.notebook.name, 'Physics');
  const [sid] = c.tree;
  assert.equal(c.sections[sid].name, 'New Section 1');
  assert.equal(c.sections[sid].pages.length, 1);
  const page = c.pages[c.sections[sid].pages[0].id];
  assert.equal(page.title, '');
  assert.deepEqual(page.body, {type: 'doc'});
  assert.deepEqual(page.rule, {pattern: 'none', color: '#9fbfe0'});
  schema.validateContent(c);
  const file = createFile('slate', 'Lab book', {schema: 2});
  assert.equal(file.schema, 2);
  assert.equal(file.content.notebook.name, 'Lab book');
  validateFile(file);
});

test('validateContent refuses broken notebooks: unknown pages, a page in two sections, bad levels, invalid bodies, bad ink', () => {
  const ok = buildNotebook({sections: [{name: 'A', pages: ['One', 'Two']}, {name: 'B', pages: ['Three']}]});
  const broken = mutate => { const c = structuredClone(ok); mutate(c); return () => schema.validateContent(c); };
  const [a, b] = ok.tree;
  assert.throws(broken(c => c.sections[a].pages.push({id: 'nope', level: 0})), /unknown page/);
  assert.throws(broken(c => c.sections[b].pages.push({...c.sections[a].pages[0]})), /two places/);
  assert.throws(broken(c => { c.sections[a].pages[0].level = 3; }), /level/);
  assert.throws(broken(c => { c.tree.push(a); }), /twice/);
  assert.throws(broken(c => { c.pages[c.sections[a].pages[0].id].body = {type: 'doc', content: [{type: 'paragraph'}]}; }), /not valid/);
  assert.throws(broken(c => { c.pages[c.sections[a].pages[0].id].ink = [{id: 'k1', tool: 'pen', color: '#000000', width: 2, points: [1, 2, 3]}]; }), /stroke/);
  assert.throws(broken(c => { delete c.sections[a]; }), /unknown item/);
});

test('OneNote click-and-type: surface.newContainer starts a note container at the point with the caret at the end of its text; undo removes it', async () => {
  const t = await notebookSession();
  const page = firstPage(t);
  const r = await expectUndoRoundTrip(t, 'surface.newContainer', {page, x: 120.4, y: 200, text: 'Ideas\nMore ideas'}, after => {
    const props = after.read(`/pg:${page}`, 'props');
    assert.equal(props.containers.length, 1);
  });
  await t.redo();
  const c = model.containersOf(model.nodeOf(t.content.pages[page].body))[0];
  assert.deepEqual([c.x, c.y, c.width], [120, 200, null]);
  assert.equal(c.node.childCount, 2);
  assert.equal(t.read(r.result.paragraph, 'text'), 'Ideas');
  assert.match(t.doc.selection.ranges[0].focus, /\/t:5$/);
  assert.equal(r.undoLabel, 'Note Container');
});

test('typing: surface.edit applies the editor\'s steps, sets the caret, and a burst of typing is one Undo Typing', async () => {
  const t = await notebookSession();
  const page = firstPage(t);
  const {result: {paragraph}} = await t.exec('surface.newContainer', {page, x: 48, y: 128});
  const bid = paragraph.split('/b:')[1];
  const posOf = () => model.pointToPos(model.nodeOf(t.content.pages[page].body), bid, model.textOf(model.blockIndex(model.nodeOf(t.content.pages[page].body)).get(bid).node).length);
  for (const ch of 'Hello') {
    const at = posOf();
    await t.exec('surface.edit', {page, steps: [insertText(null, at, ch)], typing: true, selection: {anchor: `/pg:${page}/b:${bid}/t:${at - posOf() + 1}`, focus: `/pg:${page}/b:${bid}/t:1`}});
  }
  assert.equal(t.read(`${paragraph}`, 'text'), 'Hello');
  assert.equal(t.doc.undo.size, 2, 'the container, then one merged typing entry');
  await t.undo();
  assert.equal(t.read(`${paragraph}`, 'text'), '');
  await t.redo();
  assert.equal(t.read(`${paragraph}`, 'text'), 'Hello');
  // Over the bridge the label says who did it.
  const r = await t.bridge('surface.edit', {page, steps: [insertText(null, posOf(), '!')]});
  assert.equal(r.undoLabel, 'Automation: Typing');
  assert.equal(t.content.pages[page].modified, new Date(t.host.now()).toISOString());
});

test('a step that does not apply, or a body with duplicate ids, leaves the page unchanged', async () => {
  const t = await notebookSession();
  const page = firstPage(t);
  await t.exec('surface.newContainer', {page, x: 48, y: 128, text: 'Keep me'});
  const before = structuredClone(t.content);
  await assert.rejects(t.exec('surface.edit', {page, steps: [insertText(null, 9999, 'x')]}), e => e.code === 'failed');
  const c = model.containersOf(model.nodeOf(t.content.pages[page].body))[0];
  const dup = new AttrStep(c.pos + 1, 'id', c.id).toJSON();
  await assert.rejects(t.exec('surface.edit', {page, steps: [dup]}), e => e.code === 'invalid_params' && /used twice/.test(e.message));
  await assert.rejects(t.exec('surface.edit', {page, steps: [{stepType: 'nonsense'}]}), e => e.code === 'invalid_params');
  await assert.rejects(t.exec('surface.edit', {page: 'missing', steps: [insertText(null, 0, 'x')]}), e => e.code === 'not_found');
  assert.equal(JSON.stringify(t.content), JSON.stringify(before));
});

test('note container handles: move by the top bar, resize the width (null = sized by its text), delete a selected container', async () => {
  const t = await notebookSession();
  const page = firstPage(t);
  const {result} = await t.exec('surface.newContainer', {page, x: 48, y: 128, text: 'Box'});
  const cid = result.container.split('/c:')[1];
  await expectUndoRoundTrip(t, 'surface.moveContainer', {page, container: cid, x: 300, y: 410});
  await t.redo();
  assert.deepEqual(t.read(`/pg:${page}/c:${cid}`, 'props'), {type: 'container', id: cid, x: 300, y: 410, width: null});
  await expectUndoRoundTrip(t, 'surface.resizeContainer', {page, container: cid, width: 260});
  await t.redo();
  assert.equal(t.read(`/pg:${page}/c:${cid}`, 'props').width, 260);
  const same = await t.exec('surface.moveContainer', {page, container: cid, x: 300, y: 410});
  assert.deepEqual(same.result, {moved: false});
  await assert.rejects(t.exec('surface.resizeContainer', {page, container: cid, width: 10}), e => e.code === 'invalid_params');
  await expectUndoRoundTrip(t, 'surface.deleteContainer', {page, container: cid});
  await t.redo();
  assert.equal(t.read(`/pg:${page}`, 'props').containers.length, 0);
  assert.deepEqual(t.doc.selection.ranges[0], {anchor: `/pg:${page}`, focus: `/pg:${page}`});
});

test('ink: a pen stroke and a highlighter stroke land on the ink layer; the stroke eraser removes touched strokes in one step', async () => {
  const t = await notebookSession();
  const page = firstPage(t);
  const pen = await expectUndoRoundTrip(t, 'surface.ink', {page, stroke: {tool: 'pen', color: '#1F1F1F', width: 1.9, points: [10, 10, 20.04, 22, 30, 30]}});
  await t.redo();
  await t.exec('surface.ink', {page, stroke: {tool: 'highlighter', color: '#ffff00', width: 22.7, points: [0, 100, 200, 100]}});
  const ink = t.read(`/pg:${page}/ink`);
  assert.equal(ink.length, 2);
  assert.deepEqual(ink[0], {id: pen.result.stroke.split('/ink:')[1], tool: 'pen', color: '#1f1f1f', width: 1.9, points: [10, 10, 20, 22, 30, 30]});
  assert.equal(model.strokeHit(ink[1], 100, 108, 2), true, 'the highlighter is 22.7 px wide');
  assert.equal(model.strokeHit(ink[1], 100, 140, 2), false);
  assert.match(model.strokePath(ink[0].points), /^M10 10Q20 22 25 26L30 30$/);
  await expectUndoRoundTrip(t, 'surface.erase', {page, strokes: ink.map(s => s.id)});
  await assert.rejects(t.exec('surface.ink', {page, stroke: {tool: 'marker', color: '#000000', width: 2, points: [1, 1]}}), e => e.code === 'invalid_params');
});

test('page title: surface.title retitles the page (newlines become spaces); typing in the title merges into one undo step', async () => {
  const t = await notebookSession();
  const page = firstPage(t);
  for (const title of ['M', 'Me', 'Mee', 'Meeting\nnotes']) await t.exec('surface.title', {page, title, typing: true});
  assert.equal(t.read(`/pg:${page}/title`), 'Meeting notes');
  assert.equal(t.doc.undo.size, 1);
  await t.undo();
  assert.equal(t.read(`/pg:${page}/title`), 'Lecture 1');
});

test('the current page is the selection: /pg:<id>, a section with no page, else the first page of the first section', async () => {
  const content = buildNotebook({sections: [{name: 'A', pages: ['One', 'Two']}, {name: 'Empty', pages: []}]});
  const [a, empty] = content.tree;
  const two = content.sections[a].pages[1].id;
  assert.deepEqual(model.currentLocation(content, {ranges: [], primary: 0}), {sectionId: a, pageId: content.sections[a].pages[0].id});
  assert.deepEqual(model.currentLocation(content, model.selectPage(two)), {sectionId: a, pageId: two});
  assert.deepEqual(model.currentLocation(content, {ranges: [{anchor: `/pg:${two}/b:x/t:3`, focus: `/pg:${two}/b:x/t:3`}], primary: 0}), {sectionId: a, pageId: two});
  assert.deepEqual(model.currentLocation(content, model.selectSection(empty)), {sectionId: empty, pageId: null});
});

test('model edits: sections after a given item or inside a group, pages at an index and level, removal', async () => {
  const content = buildNotebook({sections: [{name: 'A', pages: ['One']}], groups: [{name: 'Term 1', sections: [{name: 'G1', pages: []}]}]});
  const [a, g] = content.tree;
  const fam = await probe('probe.run', ctx => {
    const s1 = ctx.model.addSection(ctx, {name: 'B', after: a});
    const s2 = ctx.model.addSection(ctx, {groupId: g});
    const p = ctx.model.addPage(ctx, s1, {title: 'Fresh', level: 0});
    const sub = ctx.model.addPage(ctx, s1, {index: 1, level: 1});
    return {s1, s2, p, sub};
  });
  const t = await notebookSession(content, {extra: [fam]});
  const r = await expectUndoRoundTrip(t, 'probe.run', {});
  await t.redo();
  const {s1, s2, p, sub} = r.result;
  assert.deepEqual(t.content.tree, [a, s1, g]);
  assert.deepEqual(t.content.groups[g].items.slice(-1), [s2]);
  assert.equal(t.content.sections[s2].name, 'New Section 1');
  assert.deepEqual(t.content.sections[s1].pages, [{id: p, level: 0}, {id: sub, level: 1}]);
  assert.deepEqual(model.sectionOrder(t.content), [a, s1, t.content.groups[g].items[0], s2]);
  assert.equal(model.sectionOf(t.content, sub), s1);
  schema.validateContent(t.content);
});

test('the page and section families\' outline maps onto the notebook model: new pages and sections land in the tree, current becomes the selection', async () => {
  const {outlineOf, saveOutline, newPage} = await import('../../core/slate/lib/pages-outline.mjs');
  const content = buildNotebook({sections: [{name: 'A', pages: ['One', {title: 'Sub', level: 1}]}, {name: 'C', pages: ['Three']}]});
  const fam = await probe('probe.outline', ctx => {
    const o = outlineOf(ctx);
    const pg = newPage(ctx, 0);
    const sec = {id: `sec-${ctx.host.uid()}`, name: 'B', color: '#91ba6e', pages: [newPage(ctx, 0)]};
    const sections = [{...o.sections[0], pages: [...o.sections[0].pages, pg]}, sec, o.sections[1]];
    saveOutline(ctx, {...o, sections, current: {sectionId: sec.id, pageId: sec.pages[0].id}});
    return {pg: pg.id, sec: sec.id, secPage: sec.pages[0].id};
  });
  const t = await notebookSession(content, {extra: [fam]});
  const before = outlineOf({doc: t.content, selection: t.doc.selection, host: t.host});
  assert.deepEqual(before.sections.map(x => [x.name, x.pages.map(p => [p.title, p.level])]), [['A', [['One', 0], ['Sub', 1]]], ['C', [['Three', 0]]]]);
  const r = await expectUndoRoundTrip(t, 'probe.outline', {});
  await t.redo();
  const [a, b, c] = t.content.tree;
  assert.equal(b, r.result.sec);
  assert.equal(t.content.sections[a].pages.at(-1).id, r.result.pg);
  assert.equal(t.content.pages[r.result.secPage].title, '');
  assert.equal(t.content.sections[c].name, 'C');
  assert.deepEqual(t.doc.selection, model.selectPage(r.result.secPage));
  schema.validateContent(t.content);
});

test('schema-1 pages keep the interim outline: page.new still builds content.outline there', async () => {
  const {createTestSession} = await import('../../core/kernel/testing.mjs');
  const file = createFile('slate', 'Legacy');
  file.id = 'legacy1';
  const t = await createTestSession('slate', {file});
  await t.exec('page.new');
  assert.equal(t.content.outline.sections[0].pages.length, 2);
  assert.equal(t.read('/outline/sections/0/pages/0/id'), 'legacy1');
});

test('contextual flags: Table Layout inside a table, Equation on an equation, Audio & Video on a recording', async () => {
  const {evaluate, flags} = await import('../../core/slate/context.mjs');
  assert.deepEqual(flags, ['table', 'equation', 'media']);
  const content = buildNotebook();
  const pid = content.sections[content.tree[0]].pages[0].id;
  const p = id => ({type: 'paragraph', attrs: {id}, content: [{type: 'text', text: 'x'}]});
  content.pages[pid] = {...content.pages[pid], body: {type: 'doc', content: [{type: 'container', attrs: {id: 'c1', x: 48, y: 128, width: null}, content: [
    {type: 'table', attrs: {id: 't1'}, content: [{type: 'tableRow', attrs: {id: 'r1'}, content: [{type: 'tableCell', attrs: {id: 'td1'}, content: [p('in')]}]}]},
    {type: 'paragraph', attrs: {id: 'out'}, content: [{type: 'equation', attrs: {id: 'eq', linear: 'x^2'}}, {type: 'media', attrs: {id: 'au', kind: 'audio', name: 'Lecture'}}]},
  ]}]}};
  schema.validateContent(content);
  const at = a => ({ranges: [{anchor: a, focus: a}], primary: 0});
  assert.deepEqual(evaluate(content, at(`/pg:${pid}/b:in/t:1`)), {table: true, equation: false, media: false});
  assert.deepEqual(evaluate(content, at(`/pg:${pid}/b:out/t:0`)), {table: false, equation: false, media: false});
  assert.deepEqual(evaluate(content, at(`/pg:${pid}/media:eq`)), {table: false, equation: true, media: false});
  assert.deepEqual(evaluate(content, at(`/pg:${pid}/media:au`)), {table: false, equation: false, media: true});
  assert.deepEqual(evaluate({doc: {}}, at('/x')), {table: false, equation: false, media: false});
});

test('migrate: a schema-1 note becomes a notebook page with one note container; headings, quotes, lists, tables and marks map to OneNote\'s', async () => {
  const {migrateFile} = await import('../../core/slate/migrate.mjs');
  const file = createFile('slate', 'Week 1 lecture');
  file.id = 'note1';
  file.createdAt = NOW;
  Object.assign(file.content, {notebook: 'Physics', section: 'Mechanics', tags: ['exam'], doc: {type: 'doc', content: [
    {type: 'heading', attrs: {level: 2}, content: [{type: 'text', text: 'Forces'}]},
    {type: 'paragraph', attrs: {textAlign: 'center'}, content: [{type: 'text', text: 'F = ma', marks: [{type: 'bold'}, {type: 'textStyle', attrs: {color: '#ff0000', fontSize: '14pt'}}, {type: 'code'}]}]},
    {type: 'blockquote', content: [{type: 'paragraph', content: [{type: 'text', text: 'Newton'}]}]},
    {type: 'bulletList', content: [{type: 'listItem', content: [{type: 'paragraph', content: [{type: 'text', text: 'one'}]}]}]},
    {type: 'table', content: [{type: 'tableRow', content: [{type: 'tableHeader', content: [{type: 'paragraph', content: [{type: 'text', text: 'H'}]}]}]}]},
    {type: 'horizontalRule'}, {type: 'pageBreak'},
    {type: 'codeBlock', content: [{type: 'text', text: 'a\nb'}]},
  ]}});
  const out = migrateFile(file, {uid: (() => { let n = 0; return () => `m${n++}`; })()});
  assert.equal(out.schema, 2);
  validateFile(out);
  const c = out.content;
  assert.equal(c.notebook.name, 'Physics');
  assert.equal(c.sections[c.tree[0]].name, 'Mechanics');
  const page = c.pages.note1;
  assert.equal(page.title, 'Week 1 lecture');
  assert.equal(page.created, NOW);
  assert.deepEqual(page.tags, ['exam']);
  const container = page.body.content[0];
  assert.equal(container.type, 'container');
  const blocks = container.content;
  assert.deepEqual(blocks.map(b => b.type === 'paragraph' ? `p:${b.attrs.style}` : b.type), ['p:h2', 'p:normal', 'p:quote', 'bulletList', 'table', 'p:code', 'p:code']);
  assert.equal(blocks[1].attrs.align, 'center');
  assert.deepEqual(blocks[1].content[0].marks, [{type: 'bold'}, {type: 'textStyle', attrs: {color: '#ff0000', fontFamily: 'Consolas', fontSize: 14}}]);
  assert.equal(blocks[4].attrs.headerRow, true);
});

test('migrate: the interim outline becomes the notebook\'s sections and pages (with this page in place)', async () => {
  const {createTestSession} = await import('../../core/kernel/testing.mjs');
  const {migrateFile} = await import('../../core/slate/migrate.mjs');
  const file = createFile('slate', 'First');
  file.id = 'doc9';
  const t = await createTestSession('slate', {file});
  await t.exec('page.newSubpage');
  await t.exec('section.new', {name: 'Lab'});
  const out = migrateFile(t.file);
  validateFile(out);
  const c = out.content;
  assert.deepEqual(c.tree.map(id => c.sections[id].name), ['Quick Notes', 'Lab']);
  assert.deepEqual(c.sections[c.tree[0]].pages.map(e => [e.id === 'doc9' ? 'self' : 'other', e.level]), [['self', 0], ['other', 1]]);
  assert.equal(c.sections[c.tree[1]].pages.length, 1);
});
