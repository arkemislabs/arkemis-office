// F:quill model: schema-2 content through the kernel (app ops, undo/redo, structural sharing,
// sticky anchors), the 100k-paragraph benchmark, and the model API commands use (ctx.model).
//
// Fidelity (docs/behaviour-fidelity.md):
// 1. Upstream: wordcraft crates/doc/src/lib.rs + document.rs keep the document as Arc-shared blocks
//    and edits copy what they touch (Arc::make_mut); the engine snapshots it per undo step
//    (crates/engine/src/history.rs). Word's undo restores exactly the previous document.
// 2. Ours: the Document copies only the chunk, part or field it writes and emits one app op with
//    the replaced values; the kernel's undo restores those exact objects (pointer-equal), so undo
//    is exact and cheap, and anchors move with the text as Word's bookmarks/selection do.
// 3. Proved below with session round trips (expectUndoRoundTrip), pointer-equality checks and
//    anchor mapping through insert/split/join/delete.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {defineCommands} from '../../core/kernel/command.mjs';
import {s} from '../../core/kernel/schema.mjs';
import * as model from '../../core/quill/model/index.mjs';
import {Document, BODY} from '../../core/quill/model/document.mjs';
import {createContent, contentFromText} from '../../core/quill/model/content.mjs';
import {paragraphWithText} from '../../core/quill/model/para.mjs';
import {bodyFromBlocks, CHUNK_SIZE} from '../../core/quill/model/body.mjs';
import {validateContent, apply as schemaApply} from '../../core/quill/schema.mjs';
import * as address from '../../core/quill/address.mjs';
import {setIdSource, sequentialIds} from '../../core/quill/model/ids.mjs';

// Test-only commands that write through ctx.model, the way command families do.
const testCommands = defineCommands({
  family: 'modeltest', app: 'quill',
  upstream: {repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/doc/src/edit.rs']},
  commands: [
    {id: 'test.type', label: 'Type', risk: 'edit', params: s.object({text: s.string()}),
      run(ctx, p) {
        const [from, to] = ctx.model.selectionRange(ctx);
        let end;
        ctx.model.edit(ctx, d => { const at = d.deleteRange(from, to); end = d.insertText(at, p.text); });
        ctx.model.setSelection(ctx, [{anchor: end, focus: end}]);
        return {ok: true};
      }},
    {id: 'test.enter', label: 'Enter', risk: 'edit', params: s.object({}),
      run(ctx) {
        const [from] = ctx.model.selectionRange(ctx);
        let at;
        ctx.model.edit(ctx, d => { at = d.splitParagraph(from); });
        ctx.model.setSelection(ctx, [{anchor: at, focus: at}]);
        return {};
      }},
    {id: 'test.bold', label: 'Bold', risk: 'edit', params: s.object({}),
      run(ctx) {
        const [from, to] = ctx.model.selectionRange(ctx);
        ctx.model.edit(ctx, d => d.formatRange(from, to, c => ({...c, bold: true})));
        return {};
      }},
    {id: 'test.fail', label: 'Fail', risk: 'edit', params: s.object({}),
      run(ctx) {
        ctx.model.edit(ctx, d => d.insertText(d.startOf(BODY), 'half'));
        throw new Error('boom');
      }},
  ],
});

async function session(content, selection) {
  const t = await createTestSession('quill', {modules: [testCommands], content});
  if (selection) t.session.setSelection(t.docId, selection);
  return t;
}
const caret = a => ({ranges: [{anchor: a, focus: a}], primary: 0});
const ids = c => new Document(c).story(BODY).toArray().map(b => b.id);

test('a blank document is valid schema 2 with one empty Normal paragraph (Document::new)', () => {
  const c = createContent();
  validateContent(c);
  const d = new Document(c);
  assert.equal(d.story(BODY).len(), 1);
  assert.equal(d.plainText(BODY), '');
  assert.equal(d.sections().length, 1);
  assert.ok(c.styles.styles.some(st => st.id === 'Normal'));
});

test('typing through ctx.model: one app op, undo restores the exact content, redo replays it', async () => {
  const c = contentFromText('Hello world\nSecond');
  const [p0] = ids(c);
  const t = await session(c, caret(`/body/b:${p0}/t:5`));
  const before = t.content;
  await expectUndoRoundTrip(t, 'test.type', {text: ','}, after => {
    assert.equal(after.read('/body', 'text'), 'Hello, world\nSecond');
  });
  // Structural sharing: after undo the very same objects are back.
  await t.undo();
  assert.equal(t.content.body, before.body);
  assert.equal(t.content.styles, before.styles);
  // The op names the paragraph that changed and how its text moved.
  await t.exec('test.type', {text: '!'});
  assert.deepEqual(t.doc.selection.ranges[0].anchor, `/body/b:${p0}/t:6`);
  validateContent(t.content);
});

test('an edit copies one chunk: every other chunk and every untouched block stays shared', async () => {
  const blocks = Array.from({length: CHUNK_SIZE * 3}, (_, i) => paragraphWithText(`p${i}`));
  const c = createContent(blocks);
  const target = blocks[CHUNK_SIZE + 7].id;
  const t = await session(c, caret(`/body/b:${target}/t:0`));
  const base = t.content;
  await t.exec('test.type', {text: 'x'});
  const after = t.content;
  assert.notEqual(after.body.chunks[1], base.body.chunks[1]);
  assert.equal(after.body.chunks[0], base.body.chunks[0]);
  assert.equal(after.body.chunks[2], base.body.chunks[2]);
  assert.equal(after.body.chunks[1][6], base.body.chunks[1][6]);
  assert.equal(after.styles, base.styles);
  assert.equal(new Document(after).para(BODY, [CHUNK_SIZE + 7]).text, 'xp' + (CHUNK_SIZE + 7));
});

test('a split keeps the id on the first half and gives the second a new one; anchors follow the text', async () => {
  const c = contentFromText('abcdef');
  const [p0] = ids(c);
  const t = await session(c, caret(`/body/b:${p0}/t:3`));
  const before = t.anchor(`/body/b:${p0}/t:1`);
  const after = t.anchor(`/body/b:${p0}/t:5`);
  const span = t.anchor(`/body/b:${p0}/t:2-4`);
  await t.exec('test.enter');
  const [q0, q1] = ids(t.content);
  assert.equal(q0, p0);
  assert.notEqual(q1, p0);
  assert.equal(t.where(before).address ?? t.where(before), `/body/b:${p0}/t:1`);
  const w = x => { const r = t.where(x); return typeof r === 'string' ? r : r.address; };
  assert.equal(w(after), `/body/b:${q1}/t:2`);
  assert.equal(w(span), `/body/b:${p0}/t:2-3`);
  assert.equal(t.read(`/body/b:${q1}`, 'text'), 'def');
  // Undo joins them again: the anchor in the tail comes back to the first paragraph.
  await t.undo();
  assert.equal(w(after), `/body/b:${p0}/t:5`);
});

test('anchors shift with insertions before them and survive edits elsewhere', async () => {
  const c = contentFromText('one two\nthree');
  const [p0, p1] = ids(c);
  const t = await session(c, caret(`/body/b:${p0}/t:0`));
  const a = t.anchor(`/body/b:${p0}/t:4-7`);
  const b = t.anchor(`/body/b:${p1}/t:2`);
  await t.exec('test.type', {text: 'zero '});
  const w = x => { const r = t.where(x); return typeof r === 'string' ? r : r.address; };
  assert.equal(w(a), `/body/b:${p0}/t:9-12`);
  assert.equal(w(b), `/body/b:${p1}/t:2`);
  assert.equal(t.read(w(a), 'text'), 'two');
});

test('a command that throws commits nothing (upstream: a failed command leaves the document unchanged)', async () => {
  const c = contentFromText('keep');
  const t = await session(c);
  const v = t.version, base = t.content;
  await assert.rejects(t.exec('test.fail'));
  assert.equal(t.content, base);
  assert.equal(t.read('/body', 'text'), 'keep');
  assert.equal(t.version, v);
});

test('formatting runs: bold over a range splits runs and the props read back resolved', async () => {
  const c = contentFromText('Hello world');
  const [p0] = ids(c);
  const t = await session(c, {ranges: [{anchor: `/body/b:${p0}/t:0`, focus: `/body/b:${p0}/t:5`}], primary: 0});
  await expectUndoRoundTrip(t, 'test.bold', {}, after => {
    const runs = after.read(`/body/b:${p0}`, 'runs');
    assert.deepEqual(runs.map(r => [r.text, !!r.props.bold]), [['Hello', true], [' world', false]]);
    assert.equal(after.read(`/body/b:${p0}/t:1-2`, 'props').resolved.bold, true);
  });
});

test('the kernel app-op hook inverts exactly (schema.apply)', () => {
  const c = contentFromText('a\nb');
  const d = new Document(c);
  d.insertText({story: BODY, path: [1], off: 1}, 'c');
  d.addPart('header', [paragraphWithText('H')]);
  const op = d.takeOp();
  const {content, inverse} = schemaApply(c, op);
  assert.equal(new Document(content).plainText(BODY), 'a\nbc');
  const back = schemaApply(content, inverse).content;
  assert.equal(back.body, c.body);
  assert.deepEqual(back.parts, c.parts);
  assert.equal(op.steps.some(st => st.k === 'text'), true);
});

test('ctx.model refuses schema-1 content instead of guessing', async () => {
  const t = await createTestSession('quill', {modules: [testCommands], content: {doc: {type: 'doc', content: [{type: 'paragraph'}]}}});
  await assert.rejects(t.exec('test.type', {text: 'x'}), e => e.code === 'disabled');
  assert.equal(model.ready({doc: t.content}), false);
});

test('benchmark: 100k paragraphs load, validate, resolve and take one edit commit under budget', async () => {
  // Measured (a Windows development machine, 2026-10-30, Node 24.21, 100,000 paragraphs in 196
  // chunks): build 72 ms, validate 49 ms, open 208 ms (the test helper's structuredClone of the
  // whole content, not the model), one typed character committed through the kernel with its undo
  // entry and selection mapping 4.8 ms, resolve /body/b:<id>/t:0-10 0.09 ms, undo 0.1 ms.
  // Budgets below leave headroom for loaded CI machines; the run prints the current numbers.
  const prev = setIdSource(sequentialIds('b'));
  try {
    const N = 100_000;
    let t0 = performance.now();
    const blocks = new Array(N);
    for (let i = 0; i < N; i++) blocks[i] = paragraphWithText(`Paragraph ${i} of the long document, with some words in it.`);
    const c = createContent(blocks);
    const build = performance.now() - t0;
    t0 = performance.now();
    validateContent(c);
    const validate = performance.now() - t0;
    const mid = blocks[N / 2].id;
    t0 = performance.now();
    const t = await session(c, caret(`/body/b:${mid}/t:9`));
    const base = t.content;
    const open = performance.now() - t0;
    t0 = performance.now();
    await t.exec('test.type', {text: 'X'});
    const edit = performance.now() - t0;
    t0 = performance.now();
    const r = address.resolve(t.content, address.parse(`/body/b:${mid}/t:0-10`));
    const resolve = performance.now() - t0;
    assert.equal(r.node.text.slice(0, 10), 'ParagraphX');
    t0 = performance.now();
    await t.undo();
    const undo = performance.now() - t0;
    assert.equal(t.content.body, base.body);
    const shared = t.content.body.chunks.length;
    // eslint-disable-next-line no-console
    console.log(`[quill model benchmark] ${N} paragraphs in ${shared} chunks: build ${build.toFixed(0)} ms, validate ${validate.toFixed(0)} ms, ` +
      `open ${open.toFixed(1)} ms, edit commit ${edit.toFixed(1)} ms, resolve ${resolve.toFixed(2)} ms, undo ${undo.toFixed(1)} ms`);
    assert.ok(build < 3000, `build ${build}`);
    assert.ok(validate < 3000, `validate ${validate}`);
    assert.ok(edit < 250, `one edit commit took ${edit} ms`);
    assert.ok(resolve < 50, `resolve took ${resolve} ms`);
    assert.ok(undo < 250, `undo took ${undo} ms`);
  } finally {
    setIdSource(prev);
  }
});
