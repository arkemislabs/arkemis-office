// Ported from wordcraft crates/doc/src/para.rs (mod tests) at aadb077e072b7de05f724e359d8db82e151f125c.
// Offsets are UTF-16 units; upstream's multi-byte edge cases use characters outside the BMP here.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../../core/quill/model/para.mjs';

const bold = () => ({bold: true});

test('sentence_at_sentence_start', () => {
  let p = P.paragraphWithText('Hello. World');
  assert.deepEqual(P.sentenceAt(p, 0), [0, 7]);
  assert.deepEqual(P.sentenceAt(p, 6), [0, 7]);
  assert.deepEqual(P.sentenceAt(p, 7), [7, 12]);
  assert.deepEqual(P.sentenceAt(p, 8), [7, 12]);
  assert.deepEqual(P.sentenceAt(p, 99), [7, 12]);
  p = P.paragraphWithText('Hello.World');
  assert.deepEqual(P.sentenceAt(p, 6), [6, 11]);
  assert.deepEqual(P.sentenceAt(p, 8), [6, 11]);
});

test('text_without_takes_ranges_in_any_order', () => {
  const p = P.paragraphWithText('añb€c');
  P.insertObject(p, 2, {type: 'field', instr: 'PAGE', result: '7', locked: false, dirty: false, code: false, form: ''});
  const text = p.text;
  const naive = dropped => {
    let out = '', k = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      const keep = !dropped.some(([a, b]) => i >= a && i < b);
      if (c === P.OBJ) { if (keep && p.objects[k]) out += P.objectPlainText(p.objects[k]); k++; } else if (keep) out += c;
    }
    return out;
  };
  const n = text.length;
  const cases = [[], [[1, 2]], [[3, n], [0, 1]], [[0, 3], [1, 2], [2, 4]], [[1, 5], [1, 2], [3, 3], [0, n]], [[4, 4], [5, n], [0, 0]], [[2, n + 10]]];
  for (const dropped of cases) assert.equal(P.textWithout(p, dropped), naive(dropped), JSON.stringify(dropped));
  assert.equal(P.textWithout(p, [[1, 2]]), 'a7b€c');
});

test('insert_and_runs', () => {
  const p = P.paragraphWithText('Hello world');
  P.insertText(p, 5, ',');
  assert.equal(p.text, 'Hello, world');
  assert.equal(p.runs.length, 1);
  P.insertText(p, 0, 'Oh ', bold());
  assert.equal(p.runs.length, 2);
  assert.equal(p.runs[0].len, 3);
  assert.throws(() => P.insertText(p, 100, 'x', bold()));
});

test('insert_rejects_mid_char', () => {
  const p = P.paragraphWithText('\u{1F600}');
  assert.throws(() => P.insertText(p, 1, 'x', bold()));
});

test('format_splits_runs', () => {
  const p = P.paragraphWithText('abcdef');
  P.formatRange(p, 2, 4, c => { c.bold = true; });
  assert.deepEqual(p.runs.map(r => r.len), [2, 2, 2]);
  assert.equal(P.propsOfChar(p, 2).bold, true);
  P.formatRange(p, 0, 6, c => { c.bold = true; });
  assert.equal(p.runs.length, 1);
});

test('delete_merges', () => {
  const p = P.paragraphWithText('abcdef');
  P.formatRange(p, 2, 4, c => { c.bold = true; });
  P.deleteRange(p, 2, 4);
  assert.equal(p.text, 'abef');
  assert.equal(p.runs.length, 1);
  P.deleteRange(p, 0, 4);
  assert.equal(p.runs.length, 0);
});

test('objects_track_text', () => {
  const p = P.paragraphWithText('ab');
  P.insertObject(p, 1, {type: 'field', instr: 'PAGE', result: '1', locked: false, dirty: false, code: false, form: ''});
  P.insertObject(p, 0, {type: 'bookmarkStart', name: 'x'});
  assert.equal(p.objects.length, 2);
  assert.equal(P.objectAt(p, 0).type, 'bookmarkStart');
  const off = P.objectOffsets(p)[1];
  assert.equal(P.objectAt(p, off).type, 'field');
  const onePass = P.objectsWithOffsets(p);
  const each = P.objectOffsets(p).map(o => [o, P.objectAt(p, o)]);
  assert.deepEqual(onePass, each);
  assert.equal(onePass.length, 2);
  assert.equal(P.plainText(p), 'a1b');
  P.deleteRange(p, 0, 2);
  assert.equal(p.objects.length, 1);
  const tail = P.splitOff(p, P.objectOffsets(p)[0]);
  assert.equal(p.objects, undefined);
  assert.equal(tail.objects.length, 1);
});

test('split_and_append', () => {
  const p = P.paragraphWithText('Hello world', bold());
  let t = P.splitOff(p, 5);
  assert.equal(p.text, 'Hello');
  assert.equal(t.text, ' world');
  assert.equal(t.runs[0].props.bold, true);
  P.append(p, t);
  assert.equal(p.text, 'Hello world');
  assert.equal(p.runs.length, 1);
  t = P.splitOff(p, p.text.length);
  assert.equal(t.text, '');
  assert.equal(P.markOf(t).bold, true);
});

test('emptying_a_paragraph_keeps_the_formatting_but_not_the_revisions_of_its_text', () => {
  let p = P.paragraphWithText('Hello', {...bold(), ins: 3, del: 4});
  p.mark = bold();
  P.deleteRange(p, 0, 5);
  assert.equal(p.text, '');
  assert.equal(P.markOf(p).bold, true);
  assert.deepEqual([P.markOf(p).ins, P.markOf(p).del], [undefined, undefined]);
  p = P.paragraphWithText('Hello', bold());
  p.mark = {...p.mark, del: 7};
  P.deleteRange(p, 0, 5);
  assert.deepEqual([P.markOf(p).ins, P.markOf(p).del], [undefined, 7]);
});

test('words', () => {
  const p = P.paragraphWithText('The quick  brown fox.');
  assert.equal(P.wordEnd(p, 0), 4);
  assert.equal(P.wordEnd(p, 4), 11);
  assert.equal(P.wordStart(p, 10), 4);
  assert.equal(P.wordStart(p, 11), 4);
  assert.deepEqual(P.wordAt(p, 5), [4, 11]);
  assert.deepEqual(P.sentenceAt(p, 3), [0, 21]);
  assert.equal(P.nextBoundary(p, 0), 1);
  assert.equal(P.prevBoundary(p, 0), 0);
});

test('edits_keep_runs_consistent (proptest, seeded random cases)', () => {
  let seed = 12345;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const alphabet = 'abcdefghijklmnopqrstuvwxyzé ';
  for (let round = 0; round < 300; round++) {
    const p = P.paragraphWithText('seed text');
    const ops = rnd(40);
    for (let i = 0; i < ops; i++) {
      const k = rnd(4), a = P.clampOff(p, rnd(40)), b = P.clampOff(p, rnd(40));
      const s = Array.from({length: rnd(6)}, () => alphabet[rnd(alphabet.length)]).join('');
      try {
        if (k === 0) P.insertText(p, a, s, bold());
        else if (k === 1) P.deleteRange(p, Math.min(a, b), Math.max(a, b));
        else if (k === 2) P.formatRange(p, a, b, c => { c.italic = true; });
        else P.append(p, P.splitOff(p, a));
      } catch { /* upstream ignores the error and checks the invariants */ }
      assert.equal(p.runs.reduce((n, r) => n + r.len, 0), p.text.length);
      assert.ok(p.runs.every(r => r.len > 0));
      assert.equal(p.text.split(P.OBJ).length - 1, (p.objects ?? []).length);
    }
  }
});
