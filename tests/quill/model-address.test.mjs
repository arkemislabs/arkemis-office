// F:quill address.mjs: the Quill address grammar (docs/architecture.md 14.1, 14.2) and the
// resolver contract (14.7): parse, format, resolve, canonical, enumerate, read, find, mapThrough,
// plus the schema-1 compatibility grammar core/quill/commands/format.mjs uses.
//
// Fidelity: upstream addresses by index paths (Pos {story, path, off}); the ids are the Arkemis
// addition so references survive edits. Proved here: every read returns canonical addresses,
// index paths and friendly forms canonicalize to ids, and addresses move with the text.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../../core/quill/address.mjs';
import {Document, BODY} from '../../core/quill/model/document.mjs';
import {contentFromText} from '../../core/quill/model/content.mjs';
import {paragraphWithText, insertObject, defaultFloat} from '../../core/quill/model/para.mjs';
import {newTable} from '../../core/quill/model/table.mjs';
import {applyOp} from '../../core/quill/model/ops.mjs';
import {addList} from '../../core/quill/model/numbering.mjs';

/** A document with a table (holding a nested table), a header, footer, footnote, comment, text box, bookmark and list. */
function sample() {
  const d = Document.fromText('First paragraph\nSecond one\nLast');
  const t = newTable(2, 2, 200);
  t.rows[1].cells[1].blocks = [paragraphWithText('cell text'), newTable(1, 1, 100), paragraphWithText('')];
  d.insertBlock(BODY, [2], t);
  const hdr = d.addPart('header', [paragraphWithText('Header')]);
  const ftr = d.addPart('footer', [paragraphWithText('Footer')]);
  const fn = d.addPart('footnote', [paragraphWithText('A note')]);
  const cmtPart = d.addPart('comment', [paragraphWithText('Looks good')]);
  d.updateField('comments', c => { c[4] = {author: 'Mira', initials: 'M', date: '', parent: null, resolved: false, part: cmtPart}; });
  const tbx = d.addPart('textBox', [paragraphWithText('Boxed')]);
  d.insertObject({story: BODY, path: [0], off: 5}, {type: 'shape', kind: 'textBox', w: 100, h: 50, fill: null, stroke: null, strokeWidth: 0, float: defaultFloat(), story: tbx, freeform: null, effects: {}, extra: {}});
  d.insertObject({story: BODY, path: [1], off: 0}, {type: 'bookmarkStart', name: 'here'});
  d.insertObject({story: BODY, path: [1], off: 1}, {type: 'noteRef', kind: 'footnote', id: fn, custom: ''});
  d.updateSection(0, s => { s.headers = {default: hdr, first: null, even: null}; s.footers = {default: ftr, first: null, even: null}; });
  const r = addList(d.numbering, 'numbered');
  d.setField('numbering', r.numbering);
  d.paraMut(BODY, [3]).props = {numbering: {num: r.num, level: 0}};
  d.takeOp();
  return {c: d.content, d: new Document(d.content), hdr, ftr, fn, tbx, num: r.num};
}
const ids = c => new Document(c).story(BODY).toArray().map(b => b.id);

test('parse and format round trip; bad addresses are invalid_address', () => {
  for (const s of ['/body', '/body/b:abcd1234', '/body/b:abcd1234/t:4-9', '/body/b:t0000001/r:r0000001/c:c0000001/b:p0000001/t:0', '/hdr:s0000001.first',
    '/sec:s0000001', '/style:Heading1', '/list:3', '/bm:here', '/rev:0', '/page:2', '/body/b:1.0.1.0', '@a12']) {
    assert.equal(A.format(A.parse(s)), s);
  }
  for (const bad of ['', 'body', '/body/t:1', '/body/b:x/c:y', '/body/b:x/t:5-2', '/body/b:x/t:1/o:y', '/body/b:x/zz:1']) {
    assert.throws(() => A.parse(bad), e => e.code === 'invalid_address', bad);
  }
});

test('blocks resolve by id, by index path and inside table cells', () => {
  const {c} = sample();
  const [p0, p1, t] = ids(c);
  const table = new Document(c).story(BODY).get(2);
  const r = A.resolve(c, A.parse(`/body/b:${p0}`));
  assert.equal(r.kind, 'paragraph');
  assert.equal(r.address, `/body/b:${p0}`);
  // An index path canonicalizes to ids.
  assert.equal(A.canonical(c, '/body/b:1'), `/body/b:${p1}`);
  const row = table.rows[1], cell = row.cells[1], inner = cell.blocks[0];
  const deep = `/body/b:${t}/r:${row.id}/c:${cell.id}/b:${inner.id}`;
  assert.equal(A.canonical(c, '/body/b:2.1.1.0'), deep);
  assert.equal(A.resolve(c, A.parse(deep)).node.text, 'cell text');
  // A nested id alone finds the block.
  assert.equal(A.canonical(c, `/body/b:${inner.id}`), deep);
  assert.equal(A.resolve(c, A.parse(`/body/b:${t}/r:${row.id}`)).kind, 'row');
  assert.equal(A.resolve(c, A.parse(`/body/b:${t}/r:${row.id}/c:${cell.id}`)).kind, 'cell');
  assert.throws(() => A.resolve(c, A.parse('/body/b:zzzzzzzz')), e => e.code === 'not_found');
});

test('text ranges and objects; offsets may not split a surrogate pair', () => {
  const {c} = sample();
  const [p0] = ids(c);
  const r = A.resolve(c, A.parse(`/body/b:${p0}/t:0-5`));
  assert.equal(r.kind, 'text');
  assert.equal(A.read(c, A.parse(`/body/b:${p0}/t:0-5`), 'text'), 'First');
  const shape = new Document(c).para(BODY, [0]).objects[0];
  const o = A.resolve(c, A.parse(`/body/b:${p0}/o:${shape.oid}`));
  assert.equal(o.kind, 'object');
  assert.equal(o.from, 5);
  const d = Document.fromText('a\u{1F600}b');
  assert.throws(() => A.resolve(d.content, A.parse(`/body/b:${d.story(BODY).get(0).id}/t:2`)), e => e.code === 'invalid_address');
});

test('stories: headers/footers by section, footnotes, comments, text boxes', () => {
  const {c, hdr, ftr, fn, tbx} = sample();
  const sec = c.lastSection.id;
  assert.equal(A.read(c, A.parse(`/hdr:${sec}.default`), 'text'), 'Header');
  assert.equal(A.read(c, A.parse(`/ftr:${sec}.default`), 'text'), 'Footer');
  assert.throws(() => A.resolve(c, A.parse(`/hdr:${sec}.first`)), e => e.code === 'not_found');
  assert.equal(A.read(c, A.parse(`/fn:${fn}`), 'text'), 'A note');
  assert.equal(A.read(c, A.parse('/cmt:4'), 'text'), 'Looks good');
  const shape = new Document(c).para(BODY, [0]).objects[0];
  assert.equal(A.read(c, A.parse(`/tbx:${shape.oid}`), 'text'), 'Boxed');
  // Canonical story segments: a part id becomes the kind's own address.
  assert.equal(A.format({segments: [A.storySegment(c, hdr)]}), `/hdr:${sec}.default`);
  assert.equal(A.format({segments: [A.storySegment(c, ftr)]}), `/ftr:${sec}.default`);
  assert.equal(A.format({segments: [A.storySegment(c, tbx)]}), `/tbx:${shape.oid}`);
});

test('non-flow objects: section, style, list, bookmark, revision; friendly forms', () => {
  const {c, num} = sample();
  assert.equal(A.resolve(c, A.parse(`/sec:${c.lastSection.id}`)).kind, 'section');
  assert.equal(A.resolve(c, A.parse('/style:Heading1')).node.name, 'Heading 1');
  assert.equal(A.canonical(c, 'style heading 1'), '/style:Heading1');
  assert.equal(A.resolve(c, A.parse(`/list:${num}`)).kind, 'list');
  const bm = A.resolve(c, A.parse('/bm:here'));
  assert.equal(bm.kind, 'bookmark');
  assert.equal(A.canonical(c, 'paragraph 2'), `/body/b:${ids(c)[1]}`);
  assert.equal(A.canonical(c, 'table 1'), `/body/b:${ids(c)[2]}`);
  assert.equal(A.canonical(c, 'section 1'), `/sec:${c.lastSection.id}`);
  assert.throws(() => A.resolve(c, A.parse('/page:1')), e => e.code === 'not_found', 'pages come from the layout');
});

test('enumerate lists children with canonical addresses and pages with a cursor', () => {
  const {c} = sample();
  const top = A.enumerate(c, A.parse('/'), {depth: 1, limit: 100});
  assert.ok(top.nodes.some(n => n.address === '/body'));
  assert.ok(top.nodes.some(n => n.kind === 'footnote'));
  const body = A.enumerate(c, A.parse('/body'), {depth: 1, limit: 2});
  assert.equal(body.nodes.length, 2);
  assert.equal(body.cursor, '2');
  const rest = A.enumerate(c, A.parse('/body'), {depth: 1, limit: 100, cursor: body.cursor});
  assert.equal(rest.nodes[0].kind, 'table');
  for (const n of [...body.nodes, ...rest.nodes]) assert.equal(A.canonical(c, n.address), n.address);
  const runs = A.enumerate(c, A.parse(`/body/b:${ids(c)[0]}`), {depth: 1, limit: 100});
  assert.ok(runs.nodes.some(n => n.kind === 'run') && runs.nodes.some(n => n.kind === 'shape'));
});

test('read as text, runs, props and json', () => {
  const {c} = sample();
  const [p0] = ids(c);
  assert.ok(A.read(c, A.parse('/body'), 'text').startsWith('First'));
  const runs = A.read(c, A.parse(`/body/b:${p0}`), 'runs');
  assert.ok(runs.length >= 1 && runs.every(r => typeof r.from === 'number'));
  const props = A.read(c, A.parse(`/body/b:${p0}`), 'props');
  assert.ok(props.resolved && typeof props.resolved === 'object');
  assert.deepEqual(A.read(c, A.parse(`/body/b:${p0}/t:0-5`), 'json').text, 'First');
  assert.throws(() => A.read(c, A.parse('/body'), 'formulas'), e => e.code === 'invalid_params');
});

test('find returns canonical text addresses', () => {
  const {c} = sample();
  const r = A.find(c, {query: 'one'});
  assert.equal(r.matches.length, 1);
  assert.equal(A.read(c, A.parse(r.matches[0].address), 'text'), 'one');
  assert.equal(A.find(c, {query: 'cell'}).matches.length, 1, 'table cells are searched');
  assert.equal(A.find(c, {query: 'NOTE', matchCase: false}).matches.length, 1, 'footnotes are searched');
  assert.throws(() => A.find(c, {query: '(', regex: true}), e => e.code === 'invalid_params');
});

test('mapThrough: insertions shift, splits move tails, joins move to the survivor, removals give the nearest', () => {
  const c = contentFromText('abcdef\nxyz');
  const [p0, p1] = ids(c);
  const d = new Document(c);
  d.insertText({story: BODY, path: [0], off: 2}, '12');
  let op = {op: 'app', path: ['content'], forward: d.takeOp()};
  const map = s => A.format(A.mapThrough(op, A.parse(s)));
  assert.equal(map(`/body/b:${p0}/t:4`), `/body/b:${p0}/t:6`);
  assert.equal(map(`/body/b:${p0}/t:1`), `/body/b:${p0}/t:1`);
  assert.equal(map(`/body/b:${p0}/t:1-3`), `/body/b:${p0}/t:1-5`);
  assert.equal(map(`/body/b:${p1}/t:1`), `/body/b:${p1}/t:1`);
  const c2 = applyOp(c, op.forward).content;
  const d2 = new Document(c2);
  const at = d2.splitParagraph({story: BODY, path: [0], off: 3});
  const tail = d2.story(BODY).get(at.path[0]).id;
  op = {op: 'app', path: ['content'], forward: d2.takeOp()};
  assert.equal(map(`/body/b:${p0}/t:5`), `/body/b:${tail}/t:2`);
  assert.equal(map(`/body/b:${p0}/t:1`), `/body/b:${p0}/t:1`);
  const c3 = applyOp(c2, op.forward).content;
  const d3 = new Document(c3);
  d3.deleteRange({story: BODY, path: [1], off: 0}, {story: BODY, path: [2], off: 3});
  op = {op: 'app', path: ['content'], forward: d3.takeOp()};
  // Text deleted under an address collapses it to where the deletion closed (a joined paragraph).
  assert.equal(map(`/body/b:${p1}/t:1`), `/body/b:${tail}/t:0`);
  // A paragraph removed whole: the address is gone; the nearest is its story.
  const c4 = applyOp(c3, op.forward).content;
  const e = Document.fromText('one\ntwo\nthree');
  const [q0, q1, q2] = e.story(BODY).toArray().map(b => b.id);
  e.deleteRange({story: BODY, path: [0], off: 3}, {story: BODY, path: [2], off: 0});
  op = {op: 'app', path: ['content'], forward: e.takeOp()};
  const gone = A.mapThrough(op, A.parse(`/body/b:${q1}/t:1`));
  assert.equal(gone.deleted, true);
  assert.equal(A.format(gone.nearest), '/body');
  assert.equal(map(`/body/b:${q2}/t:2`), `/body/b:${q0}/t:5`);
  void c4;
});

test('changed() names the blocks and stories an op touched', () => {
  const {c} = sample();
  const d = new Document(c);
  d.insertText({story: BODY, path: [1], off: 0}, 'x');
  d.insertText(d.startOf(Number(Object.keys(c.parts)[0])), 'y');
  const op = d.takeOp();
  const after = applyOp(c, op).content;
  const out = A.changed([{op: 'app', path: ['content'], forward: op}], after);
  assert.ok(out.includes(`/body/b:${ids(c)[1]}`));
  assert.ok(out.some(a => a.startsWith('/hdr:')));
});

test('schema-1 content keeps the interim /body/b:<index path> grammar format.mjs uses', () => {
  const c = {doc: {type: 'doc', content: [{type: 'paragraph', content: [{type: 'text', text: 'Hello'}]},
    {type: 'bulletList', content: [{type: 'listItem', content: [{type: 'paragraph', content: [{type: 'text', text: 'item'}]}]}]}]}};
  const r = A.resolve(c, A.parse('/body/b:0/t:1-3'));
  assert.equal(r.kind, 'text');
  assert.deepEqual([r.from, r.to, r.text], [1, 3, 'Hello']);
  assert.equal(A.read(c, A.parse('/body/b:1.0.0'), 'text'), 'item');
  assert.equal(A.find(c, {query: 'item'}).matches[0].address, '/body/b:1.0.0/t:0-4');
  assert.throws(() => A.resolve(c, A.parse('/body/b:5')), e => e.code === 'not_found');
});
