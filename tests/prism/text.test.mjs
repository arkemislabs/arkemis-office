// U:prism/text: in-place text editing on schema-2 presentations, as the surface drives it
// (design note F-prism--text--surface-text-editing): text.edit on shapes, group members,
// table cells and notes; typing (one undo step per word), Enter / Shift+Enter, Backspace outdent,
// word deletes, caret moves with the translated text layout (up/down, Home/End on wrapped lines),
// selections, IME commits, text.set/get, font.used/replace, the AutoCorrect list AutoFormat path,
// and the keyboard plans (core/prism/lib/keys.mjs) run through these commands.
//
// 1. What ArtCraft does: deckcraft crates/engine/src/cmd/text.rs and text/{editing,caret,ime,
//    autocorrect,formatting,layout}.rs (file:line in core/prism/commands/text.mjs); keys.rs for the
//    keys. PowerPoint: click into a placeholder and type; Enter new paragraph, Shift+Enter line
//    break, Backspace at a bullet's start outdents, Ctrl+Backspace deletes a word, Home/End by line.
// 2. Ours: the same edits through the kernel; the caret and selection are the kernel's text range
//    (UTF-16 offsets), drawn by the surface; every text change is undoable and refits the box.
// 3. Proved by these tests, tests/prism/upstream/text_tests.test.mjs and the bridge E2E
//    tests/e2e/prism/text-editing.e2e.mjs (click a placeholder, type, select, captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {defineCommands} from '../../core/kernel/command.mjs';
import {s} from '../../core/kernel/schema.mjs';
import {planKey, planTyping} from '../../core/prism/lib/keys.mjs';
import {bodyText, paraText} from '../../core/prism/model/text.mjs';
import {withNew, textBox, rect, textOf, shapeOf, selected, textSel, typeChars, curSlide} from './upstream/text_deck.mjs';

const titleId = t => curSlide(t).shapes[0].id;

/** Run a key the way the surface does: planKey → its steps through the registry. */
async function key(t, k, mods = {}) {
  const plan = planKey(t.content, t.doc.selection, k, mods);
  assert.ok(plan.handled, `${k} is handled`);
  if (plan.select) t.session.setSelection(t.docId, plan.select);
  for (const st of plan.steps ?? []) await t.exec(st.command, st.params);
}

test('text.edit: a shape without text gets an empty body (undoable); errors name the problem', async () => {
  const pic = {...rect('501', [300, 10, 50, 50]), kind: {type: 'picture'}, text: null};
  const plain = {...rect('500', [10, 10, 100, 50]), text: null};
  const t = await withNew({shapes: [pic, plain]});
  const r = await expectUndoRoundTrip(t, 'text.edit', {id: '500'}, after => {
    assert.deepEqual(after.content.slides[0].shapes.find(x => x.id === '500').text, {body: {}, paragraphs: []});
  });
  assert.deepEqual(r.result, {id: '500', at: [0, 0]});
  await assert.rejects(t.exec('text.edit', {id: '501'}), /doesn't hold text/);
  await assert.rejects(t.exec('text.edit', {id: '999'}), /no such shape/);
  await t.exec('text.exit', {});
  assert.deepEqual(selected(t), ['500']);
});

test('typing: one undo step per word; Enter and Shift+Enter; Backspace at a level outdents first', async () => {
  const t = await withNew({shapes: [textBox('500', [10, 10, 300, 40], '')]});
  await t.exec('text.edit', {id: '500'});
  await typeChars(t, 'Hello wide');
  assert.equal(textOf(t, '500'), 'Hello wide');
  await t.undo();
  assert.equal(textOf(t, '500'), 'Hello ', 'the last word goes in one step');
  await t.redo();
  await key(t, 'Enter');
  await key(t, 'Enter', {shift: true});
  await typeChars(t, 'x');
  const body = shapeOf(t, '500').text;
  assert.equal(body.paragraphs.length, 2);
  assert.equal(paraText(body.paragraphs[1]), '\u000bx');
  // A level-1 paragraph: Backspace at its start outdents instead of joining.
  await t.exec('text.set', {id: '500', text: 'a\n\tb'});
  await t.exec('text.edit', {id: '500', at: [1, 0]});
  await expectUndoRoundTrip(t, 'text.delete', {dir: 'backward'}, after => {
    const ps = after.content.slides[0].shapes.find(x => x.id === '500').text.paragraphs;
    assert.deepEqual(ps.map(p => [p.level, paraText(p)]), [[0, 'a'], [0, 'b']]);
  });
  await t.exec('text.delete', {dir: 'backward'});
  assert.equal(textOf(t, '500'), 'ab');
});

test('text.delete directions: forward, wordBackward and wordForward (smart spacing); undo', async () => {
  const t = await withNew({shapes: [textBox('500', [10, 10, 300, 40], 'one two three')]});
  await t.exec('text.edit', {id: '500', at: [0, 7]});
  await expectUndoRoundTrip(t, 'text.delete', {dir: 'wordBackward'}, after => assert.equal(bodyText(after.content.slides[0].shapes.at(-1).text), 'one  three'));
  await t.exec('text.edit', {id: '500', at: [0, 4]});
  await t.exec('text.delete', {dir: 'wordForward'});
  assert.equal(textOf(t, '500'), 'one three');
  await t.exec('text.edit', {id: '500', at: [0, 0]});
  await t.exec('text.delete', {dir: 'forward'});
  assert.equal(textOf(t, '500'), 'ne three');
});

test('text.move with the text layout: up/down by line, Home/End of a wrapped line (End stays on its line)', async () => {
  // 100 pt wide box at 18 pt: the default measure makes each character 9 pt, so lines wrap.
  const t = await withNew({shapes: [textBox('500', [10, 10, 100, 200], 'aaaa bbbb cccc dddd')]});
  await t.exec('text.edit', {id: '500', at: [0, 0]});
  // Lines: "aaaa bbbb " [0, 10) and "cccc dddd" [10, 19).
  const down = (await t.exec('text.move', {to: 'down'})).result.caret;
  assert.deepEqual(down, [0, 10], 'down moves to the next line under the caret');
  const end2 = (await t.exec('text.move', {to: 'lineEnd'})).result;
  assert.deepEqual(end2, {caret: [0, 19], lineEnd: false}, 'End of the last line is the paragraph end');
  await t.exec('text.move', {to: 'up'});
  assert.equal(textSel(t).caret[1] < 10, true);
  await t.exec('text.move', {to: 'lineStart'});
  assert.deepEqual(textSel(t).caret, [0, 0]);
  const end1 = (await t.exec('text.move', {to: 'lineEnd'})).result;
  assert.deepEqual(end1, {caret: [0, 10], lineEnd: true}, 'End before a soft wrap stays on its line (upstream affinity)');
  // From there Home goes to the start of that same line, not the next one.
  await t.exec('text.move', {to: 'lineStart'});
  assert.deepEqual(textSel(t).caret, [0, 0]);
  await t.exec('text.move', {to: 'end'});
  await t.exec('text.move', {to: 'start', extend: true});
  assert.deepEqual([textSel(t).anchor, textSel(t).caret], [[0, 19], [0, 0]]);
  // Left with a selection collapses to its start, right to its end.
  await t.exec('text.move', {to: 'right'});
  assert.deepEqual(textSel(t).caret, [0, 19]);
  await assert.rejects(t.exec('text.move', {to: 'sideways'}));
});

test('in a right-to-left paragraph Left goes forward in the text', async () => {
  const t = await withNew({shapes: [textBox('500', [10, 10, 300, 40], 'مرحبا')]});
  const c = structuredClone(t.content);
  c.slides[0].shapes.at(-1).text.paragraphs[0].props = {rtl: true};
  t.session.reload(t.docId, {...t.file, content: c});
  await t.exec('text.edit', {id: '500', at: [0, 1]});
  await t.exec('text.move', {to: 'left'});
  assert.deepEqual(textSel(t).caret, [0, 2]);
});

test('selection commands: select, selectWord (double-click), selectParagraph (triple-click), selectAll', async () => {
  const t = await withNew({shapes: [textBox('500', [10, 10, 300, 60], 'alpha beta\nsecond line')]});
  await t.exec('text.edit', {id: '500', at: [0, 7]});
  await t.exec('text.selectWord', {});
  assert.deepEqual([textSel(t).anchor, textSel(t).caret], [[0, 6], [0, 10]]);
  await t.exec('text.selectParagraph', {});
  assert.deepEqual([textSel(t).anchor, textSel(t).caret], [[0, 0], [1, 0]], 'the paragraph mark is included');
  await t.exec('text.select', {anchor: [1, 0], caret: [1, 6]});
  assert.deepEqual([textSel(t).anchor, textSel(t).caret], [[1, 0], [1, 6]]);
  await t.exec('text.selectAll', {});
  assert.deepEqual([textSel(t).anchor, textSel(t).caret], [[0, 0], [1, 11]]);
  // Typing replaces the selection.
  await expectUndoRoundTrip(t, 'text.insert', {text: 'Z'}, after => assert.equal(bodyText(after.content.slides[0].shapes.at(-1).text), 'Z'));
});

test('typing on a selected shape replaces its text (planTyping: text.edit, text.selectAll, text.insert)', async () => {
  const t = await withNew({shapes: [textBox('500', [10, 10, 300, 40], 'old text')]});
  const steps = planTyping(t.content, t.doc.selection, 'N');
  assert.deepEqual(steps.map(x => x.command), ['text.edit', 'text.selectAll', 'text.insert']);
  await t.batch(steps);
  assert.equal(textOf(t, '500'), 'N');
  await key(t, 'Escape');
  assert.equal(textSel(t), null);
  assert.deepEqual(selected(t), ['500']);
  await key(t, 'Enter');
  assert.ok(textSel(t), 'Enter on a selected shape starts editing');
});

test('editing a shape in a group, a table cell and the speaker notes', async () => {
  const child = textBox('502', [0, 0, 100, 40], 'inside');
  const group = {...rect('503', [10, 10, 100, 40]), text: null, geom: null, kind: {type: 'group', children: [child], child: {x: 0, y: 0, w: 100, h: 40}}};
  const cell = txt => ({text: {body: {}, paragraphs: [{level: 0, runs: txt ? [{text: txt}] : []}]}, fill: null, borders: [null, null, null, null], hMerge: false, vMerge: false});
  const table = {...rect('504', [10, 100, 200, 80]), text: null, kind: {type: 'table', cols: [100, 100], rows: [{height: 40, cells: [cell('a'), cell('b')]}, {height: 40, cells: [cell(''), cell('d')]}]}};
  const t = await withNew({shapes: [group, table]});
  await t.exec('text.edit', {id: '502'});
  await typeChars(t, 'X');
  assert.equal(textOf(t, '502'), 'insideX');
  assert.match(t.doc.selection.ranges[0].anchor, /\/sp:503\/sp:502\/t:7$/);
  await assert.rejects(t.exec('text.edit', {id: '504'}), /which `cell`/);
  await t.exec('text.edit', {id: '504', cell: [1, 0]});
  await expectUndoRoundTrip(t, 'text.insert', {text: 'c'}, after => {
    assert.equal(paraText(after.content.slides[0].shapes.find(x => x.id === '504').kind.rows[1].cells[0].text.paragraphs[0]), 'c');
  });
  // Tab in a cell moves to the next cell and selects its text (keys.rs next_cell).
  await key(t, 'Tab');
  assert.deepEqual(textSel(t).cell, [1, 1]);
  await t.exec('text.edit', {notes: true});
  await typeChars(t, 'Notes!');
  assert.equal(bodyText(curSlide(t).notes), 'Notes!');
  await t.exec('text.exit', {});
  assert.equal(textSel(t), null);
});

test('text.commit (input method): one undo step; empty commits change nothing', async () => {
  const t = await withNew({shapes: [textBox('500', [10, 10, 300, 40], 'ab')]});
  await t.exec('text.edit', {id: '500', at: [0, 1]});
  await expectUndoRoundTrip(t, 'text.commit', {text: '한국어'}, after => assert.equal(bodyText(after.content.slides[0].shapes.at(-1).text), 'a한국어b'));
  const v = t.version;
  assert.deepEqual((await t.exec('text.commit', {text: ''})).result.caret, [0, 4]);
  assert.equal(t.version, v);
});

test('text.set keeps the first run\'s formatting and paragraph levels; text.get; undo', async () => {
  const box = textBox('500', [10, 10, 300, 40], 'x');
  box.text.paragraphs = [{level: 1, props: {align: 'center'}, runs: [{text: 'x', props: {bold: true}}]}];
  const t = await withNew({shapes: [box]});
  await expectUndoRoundTrip(t, 'text.set', {id: '500', text: 'new\nsecond'}, after => {
    const ps = after.content.slides[0].shapes.at(-1).text.paragraphs;
    assert.equal(ps[0].level, 1);
    assert.deepEqual(ps[0].props, {align: 'center'});
    assert.deepEqual(ps[1].runs[0].props, {bold: true});
  });
  const g = (await t.exec('text.get', {id: '500'})).result;
  assert.deepEqual(g, {text: 'new\nsecond', paragraphs: [{level: 1, text: 'new'}, {level: 0, text: 'second'}]});
  await assert.rejects(t.exec('text.set', {text: 'x', id: '999'}));
});

test('a "Resize shape to fit text" box grows with its text; a shrink placeholder stores its scale', async () => {
  const t = await withNew({shapes: [textBox('500', [10, 10, 100, 20], '')]});
  await t.exec('text.edit', {id: '500'});
  const h0 = shapeOf(t, '500').xfrm.h;
  await t.exec('text.insert', {text: 'line one\nline two\nline three\nline four'});
  assert.ok(shapeOf(t, '500').xfrm.h > h0 + 40, `${h0} → ${shapeOf(t, '500').xfrm.h}`);
  // A body that shrinks on overflow with no saved scale: the edit stores the scale the layout computes.
  const t2 = await withNew({shapes: [{...textBox('501', [10, 10, 200, 40], ''), text: {body: {autofit: {kind: 'shrink'}}, paragraphs: []}}]});
  await t2.exec('text.edit', {id: '501'});
  await t2.exec('text.insert', {text: 'A very long text '.repeat(12)});
  const af = shapeOf(t2, '501').text.body.autofit;
  assert.equal(af.kind, 'shrink');
  assert.ok(af.fontScale < 1, JSON.stringify(af));
  void titleId;
});

test('font.used lists the families drawn; font.replace is undoable', async () => {
  const box = textBox('500', [10, 10, 300, 40], 'Hi');
  box.text.paragraphs[0].runs[0].props = {font: 'Georgia'};
  const t = await withNew({shapes: [box]});
  assert.ok((await t.exec('font.used', {})).result.includes('Georgia'));
  await expectUndoRoundTrip(t, 'font.replace', {from: 'Georgia', to: 'Inter'}, after => {
    assert.equal(after.content.slides[0].shapes.at(-1).text.paragraphs[0].runs[0].props.font, 'Inter');
  });
});

test('AutoFormat lists through format.bullets / format.numbering; Backspace right after undoes it', async () => {
  // A stand-in for U:prism/format's format.bullets / format.numbering (sets the paragraph bullet).
  const fmt = defineCommands({family: 'format', app: 'prism', upstream: {repo: 'deckcraft', files: []}, commands: ['format.bullets', 'format.numbering'].map(id => ({
    id, label: id, risk: 'edit', params: s.object({on: s.optional(s.boolean()), char: s.optional(s.string()), scheme: s.optional(s.string())}),
    run(ctx, p) {
      const ts = ctx.model.textSelection(ctx.doc, ctx.selection);
      const sl = ctx.doc.slides.find(x => x.id === ts.slide);
      const i = sl.shapes.findIndex(x => x.id === ts.shape);
      const path = ['slides', ctx.doc.slides.indexOf(sl), 'shapes', i, 'text', 'paragraphs', 0, 'props'];
      ctx.change.set(path, {bullet: id === 'format.bullets' ? {kind: 'char', char: p.char} : {kind: 'autoNum', scheme: p.scheme, startAt: 1}});
      return {};
    },
  }))});
  const t = await withNew({extra: [fmt], shapes: [textBox('500', [10, 10, 300, 40], '')]});
  await t.exec('text.edit', {id: '500'});
  await typeChars(t, '*');
  const r = await t.exec('text.insert', {text: ' '});
  assert.deepEqual(r.result.caret, [0, 0]);
  assert.equal(textOf(t, '500'), '');
  assert.deepEqual(shapeOf(t, '500').text.paragraphs[0].props.bullet, {kind: 'char', char: '•'});
  await t.exec('text.delete', {dir: 'backward'});
  assert.equal(textOf(t, '500'), '* ');
  assert.equal(shapeOf(t, '500').text.paragraphs[0].props, undefined);
  await t.exec('text.selectAll', {});
  await t.exec('text.delete', {});
  await typeChars(t, 'i. x');
  assert.equal(textOf(t, '500'), 'x');
  assert.equal(shapeOf(t, '500').text.paragraphs[0].props.bullet.scheme, 'romanLcPeriod');
});

test('text commands are disabled without a text insertion point (deckcraft has_text)', async () => {
  const t = await withNew();
  for (const id of ['text.insert', 'text.commit', 'text.delete', 'text.move', 'text.select', 'text.selectAll', 'text.selectWord', 'text.selectParagraph']) {
    assert.deepEqual(t.state(id), {enabled: false, reason: 'no text insertion point'}, id);
  }
  assert.equal(t.state('text.autocorrect').enabled, true);
  assert.equal(t.state('text.edit').enabled, true);
  void rect;
});
