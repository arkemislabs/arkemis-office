// F:slate foundation: Slate addresses (docs/architecture.md 14.6, 14.7) — canonical forms,
// friendly inputs, reads, inspection paging, find, and sticky anchors through edits.
// Slate has no ArtCraft upstream (no Rust tests to port).

import test from 'node:test';
import assert from 'node:assert/strict';
import {ReplaceStep} from '@tiptap/pm/transform';
import {Slice, Fragment} from '@tiptap/pm/model';
import * as address from '../../core/slate/address.mjs';
import {buildNotebook, model, notebookSession, probe, schema} from './foundation-helpers.mjs';

const body = () => ({type: 'doc', content: [{type: 'container', attrs: {id: 'c1', x: 48, y: 128, width: 400}, content: [
  {type: 'paragraph', attrs: {id: 'b1', style: 'h1', tags: [{id: 'todo', checked: false}]}, content: [{type: 'text', text: 'Agenda '}, {type: 'image', attrs: {id: 'img1', src: 'data:,'}}, {type: 'text', text: ' 😀 done', marks: [{type: 'bold'}]}]},
  {type: 'table', attrs: {id: 't1'}, content: [
    {type: 'tableRow', attrs: {id: 'r0'}, content: [{type: 'tableCell', attrs: {id: 'td00'}, content: [{type: 'paragraph', attrs: {id: 'p00'}, content: [{type: 'text', text: 'cell'}]}]},
      {type: 'tableCell', attrs: {id: 'td01'}, content: [{type: 'paragraph', attrs: {id: 'p01'}, content: [{type: 'text', text: 'agenda item'}]}]}]},
  ]},
]}]});

async function setup() {
  const content = buildNotebook({sections: [{name: 'Week 1', pages: ['Monday', 'Tuesday']}, {name: 'Week 2', pages: []}],
    groups: [{name: 'Archive', sections: [{name: 'Old', pages: ['Agenda archive']}]}]});
  const [w1, w2, g] = content.tree;
  const [mon, tue] = content.sections[w1].pages.map(e => e.id);
  content.pages[mon] = {...content.pages[mon], body: body(), ink: [{id: 'k1', tool: 'pen', color: '#000000', width: 2, points: [0, 0, 5, 5]}]};
  schema.validateContent(content);
  const t = await notebookSession(content);
  return {t, content, w1, w2, g, mon, tue, old: content.groups[g].items[0]};
}

test('canonical: friendly forms become /sec, /grp and /pg addresses; malformed and missing targets are refused', async () => {
  const {content, w1, mon, tue} = await setup();
  const c = input => address.canonical(content, input);
  assert.equal(c(`/nb:${content.notebook.id}/sec:${w1}`), `/sec:${w1}`);
  assert.equal(c('/sec:week 1'), `/sec:${w1}`, 'a section by name');
  assert.equal(c(`/sec:${w1}/page:2`), `/pg:${tue}`);
  assert.equal(c(`/sec:${w1}/pg:${mon}/b:b1/t:0-6`), `/pg:${mon}/b:b1/t:0-6`);
  assert.equal(c(`/pg:${mon}/c:c1/b:b1`), `/pg:${mon}/b:b1`);
  assert.equal(c(`/pg:${mon}/b:t1/r:0/c:1/b:p01/t:2`), `/pg:${mon}/b:p01/t:2`);
  assert.equal(c(`/pg:${mon}/b:t1/r:0/c:0`), `/pg:${mon}/b:td00`);
  assert.equal(c(`/pg:${mon}/b:img1`), `/pg:${mon}/media:img1`);
  assert.equal(c(`/pg:${mon}/title/t:0-3`), `/pg:${mon}/title/t:0-3`);
  const code = input => { try { c(input); return 'ok'; } catch (e) { return e.code; } };
  assert.equal(code(`/sec:${w1}/page:9`), 'not_found');
  assert.equal(code('/pg:nope'), 'not_found');
  assert.equal(code(`/pg:${mon}/b:t1/t:0`), 'invalid_address', 'a table has no text offsets');
  assert.equal(code(`/pg:${mon}/b:b1/t:10`), 'invalid_address', 'offset 10 splits the emoji');
  assert.equal(code(`/pg:${mon}/b:b1/t:99`), 'invalid_address');
  assert.equal(code(`/pg:${mon}/bogus:1`), 'invalid_address');
  assert.equal(code('/nb:other'), 'not_found');
  assert.equal(code(`/pg:${mon}/c:b1`), 'not_found', 'b1 is a paragraph, not a container');
});

test('read: notebook summary, sections, page props, text with objects as U+FFFC, runs, tags, ink', async () => {
  const {t, w1, g, mon} = await setup();
  const root = t.read('/');
  assert.deepEqual(root.items.map(i => [i.kind, i.name]), [['section', 'Week 1'], ['section', 'Week 2'], ['group', 'Archive']]);
  assert.equal(root.items[2].items[0].name, 'Old');
  assert.equal(root.pages, 3);
  assert.deepEqual(t.read(`/sec:${w1}`).pages.map(p => p.title), ['Monday', 'Tuesday']);
  assert.equal(t.read(`/grp:${g}`, 'text'), 'Archive');
  const props = t.read(`/pg:${mon}`, 'props');
  assert.deepEqual([props.title, props.level, props.section, props.containers, props.strokes], ['Monday', 0, `/sec:${w1}`, [`/pg:${mon}/c:c1`], 1]);
  assert.equal(t.read(`/pg:${mon}/b:b1`, 'text'), 'Agenda ￼ 😀 done');
  assert.equal(t.read(`/pg:${mon}/b:b1/t:9-13`, 'text'), '😀 d');
  assert.deepEqual(t.read(`/pg:${mon}/b:b1/t:6-9`, 'runs').map(r => [r.text, Object.keys(r.marks)]), [[' ', []], ['￼', []], [' ', ['bold']]]);
  assert.equal(t.read(`/pg:${mon}/b:b1/t:12-14`, 'props').marks.bold, true);
  assert.equal(t.read(`/pg:${mon}/b:b1`, 'props').style, 'h1');
  assert.deepEqual(t.read(`/pg:${mon}/tag:b1.todo`), {id: 'todo', checked: false, block: `/pg:${mon}/b:b1`});
  assert.equal(t.read(`/pg:${mon}/c:c1`, 'text'), 'Agenda ￼ 😀 done\ncell\nagenda item');
  assert.equal(t.read(`/pg:${mon}/ink:k1`).tool, 'pen');
  assert.equal(t.read(`/pg:${mon}`, 'text'), 'Monday\nAgenda ￼ 😀 done\ncell\nagenda item');
  await assert.rejects(async () => t.read(`/pg:${mon}`, 'formulas'), e => e.code === 'invalid_params');
});

test('document.inspect: children with canonical addresses, depth, and a cursor for long lists', async () => {
  const {t, w1, mon} = await setup();
  const all = address.enumerate(t.content, address.parse('/'), {depth: 2, limit: 100});
  assert.deepEqual(all.nodes.map(n => n.address).slice(0, 4), [`/sec:${w1}`, `/pg:${mon}`, `/pg:${t.content.sections[w1].pages[1].id}`, `/sec:${t.content.tree[1]}`]);
  const page = address.enumerate(t.content, address.parse(`/pg:${mon}`), {depth: 3, limit: 100});
  assert.deepEqual(page.nodes.map(n => n.kind), ['meta', 'title', 'container', 'paragraph', 'image', 'table', 'tableRow', 'ink', 'stroke']);
  const first = address.enumerate(t.content, address.parse('/'), {depth: 3, limit: 3});
  assert.equal(first.nodes.length, 3);
  const next = address.enumerate(t.content, address.parse('/'), {depth: 3, limit: 3, cursor: first.cursor});
  assert.notEqual(next.nodes[0].address, first.nodes[0].address);
});

test('document.find: titles and paragraphs across the notebook, scoped to a section or page, case and whole-word options', async () => {
  const {t, w1, mon, g} = await setup();
  const all = address.find(t.content, {query: 'agenda', limit: 10});
  assert.deepEqual(all.matches.map(m => m.address), [`/pg:${mon}/b:b1/t:0-6`, `/pg:${mon}/b:p01/t:0-6`, `/pg:${t.content.groups[g].items.length && t.content.sections[t.content.groups[g].items[0]].pages[0].id}/title/t:0-6`]);
  assert.equal(address.find(t.content, {query: 'agenda', scope: address.parse(`/sec:${w1}`), limit: 10}).matches.length, 2);
  assert.equal(address.find(t.content, {query: 'Agenda', matchCase: true, limit: 10}).matches.length, 2);
  assert.equal(address.find(t.content, {query: 'agend', wholeWord: true, limit: 10}).matches.length, 0);
  assert.throws(() => address.find(t.content, {query: '(', regex: true, limit: 10}), e => e.code === 'invalid_params');
});

test('anchors follow typing before them, survive undo, and report deletion with the nearest place', async () => {
  const {t, mon} = await setup();
  const a = t.anchor(`/pg:${mon}/b:p01/t:7-11`);
  const doc = model.nodeOf(t.content.pages[mon].body);
  const at = model.pointToPos(doc, 'p01', 0);
  await t.exec('surface.edit', {page: mon, steps: [new ReplaceStep(at, at, new Slice(Fragment.from(model.schema.text('next ')), 0, 0)).toJSON()]});
  assert.deepEqual(t.where(a), {address: `/pg:${mon}/b:p01/t:12-16`});
  assert.equal(t.read(a, 'text'), 'item');
  await t.undo();
  assert.deepEqual(t.where(a), {address: `/pg:${mon}/b:p01/t:7-11`});
  // Delete the whole note container: the anchor is gone.
  const c = model.containersOf(model.nodeOf(t.content.pages[mon].body))[0];
  await t.exec('surface.deleteContainer', {page: mon, container: c.id});
  assert.equal(t.where(a).deleted, true);
  // A stroke anchor goes when the eraser takes the stroke.
  await t.undo();
  const k = t.anchor(`/pg:${mon}/ink:k1`);
  await t.exec('surface.erase', {page: mon, strokes: ['k1']});
  assert.deepEqual(t.where(k), {deleted: true, nearest: `/pg:${mon}`});
});

test('the selection maps through other edits on its page, and a deleted page drops it', async () => {
  const {t, mon, tue} = await setup();
  t.session.setSelection(t.docId, {ranges: [{anchor: `/pg:${mon}/b:p00/t:2`, focus: `/pg:${mon}/b:p00/t:4`}], primary: 0});
  const doc = model.nodeOf(t.content.pages[mon].body);
  const at = model.pointToPos(doc, 'p00', 0);
  await t.exec('surface.edit', {page: mon, steps: [new ReplaceStep(at, at, new Slice(Fragment.from(model.schema.text('>>')), 0, 0)).toJSON()]});
  assert.deepEqual(t.doc.selection.ranges[0], {anchor: `/pg:${mon}/b:p00/t:4`, focus: `/pg:${mon}/b:p00/t:6`});
  const drop = await probe('probe.drop', ctx => { ctx.model.removePage(ctx, tue); });
  const t2 = await notebookSession(t.content, {extra: [drop]});
  t2.session.setSelection(t2.docId, {ranges: [{anchor: `/pg:${tue}`, focus: `/pg:${tue}`}], primary: 0});
  await t2.exec('probe.drop');
  assert.deepEqual(t2.doc.selection.ranges, []);
});

test('doc.changed names the pages, sections and notebook a change touched', async () => {
  const {t, mon} = await setup();
  const events = [];
  t.session.subscribe(e => { if (e.type === 'doc.changed') events.push(e.changed); });
  t.host.advance(60_000);
  await t.exec('surface.ink', {page: mon, stroke: {tool: 'pen', color: '#000000', width: 2, points: [1, 1, 2, 2]}});
  // A minute later (the same instant would leave `modified` as it is: no meta change).
  t.host.advance(60_000);
  await t.exec('surface.title', {page: mon, title: 'Mon'});
  await t.exec('surface.newContainer', {page: mon, x: 10, y: 10});
  assert.deepEqual(events, [[`/pg:${mon}/ink`, `/pg:${mon}/meta`], [`/pg:${mon}/title`, `/pg:${mon}/meta`], [`/pg:${mon}`]]);
});

test('schema-1 content keeps generic JSON addresses', () => {
  const legacy = {doc: {type: 'doc', content: []}, outline: {sections: [{id: 's', name: 'Quick Notes'}]}};
  const ast = address.parse('/outline/sections/0/name');
  assert.equal(address.read(legacy, ast), 'Quick Notes');
  assert.equal(address.canonical(legacy, '/outline/sections/0'), '/outline/sections/0');
  assert.throws(() => address.changed([], legacy));
});
