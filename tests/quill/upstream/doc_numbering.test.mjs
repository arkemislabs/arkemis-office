// Ported from wordcraft crates/doc/src/numbering.rs (mod tests) at aadb077e072b7de05f724e359d8db82e151f125c.
// Each test names the Rust test. Numbering values are immutable here: helpers return new objects.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as N from '../../../core/quill/model/numbering.mjs';

const U32_MAX = 4294967295;
const list = kind => { const r = N.addList(N.emptyNumbering(), kind); return [r.numbering, r.num]; };
const withNum = (n, id, f) => ({...n, nums: n.nums.map(x => (x.id === id ? f({...x}) : x))});
const withAbstract = (n, f) => ({...n, abstracts: n.abstracts.map((a, i) => (i === 0 ? f({...a, levels: a.levels.slice()}) : a))});
const labeler = n => { const c = new N.Counters(); return (num, lvl) => c.nextLabel(n, num, lvl)?.[0]; };

test('a_huge_level_text_gives_a_bounded_label', () => {
  let [n, id] = list('numbered');
  n = withNum(n, id, x => ({...x, levelOverrides: [[0, N.level({format: 'upperRoman', text: '%1'.repeat(30_000), start: U32_MAX})]]}));
  const label = labeler(n)(id, 0);
  assert.ok(new TextEncoder().encode(label).length <= 512, `label is ${label.length}`);
  assert.ok(label.startsWith('MMMM'));
});

test('a_list_s_own_level_definitions_win', () => {
  let [n, id] = list('numbered');
  n = withNum(n, id, x => ({...x, levelOverrides: [[1, N.level({format: 'decimal', text: ''})], [2, N.level({format: 'decimalZero', text: '%2.%3'})]]}));
  const l = labeler(n);
  assert.equal(l(id, 1), '');
  assert.equal(l(id, 2), '1.01');
  assert.equal(l(id, 2), '1.02');
  assert.equal(l(id, 1), '');
  assert.equal(l(id, 2), '2.01');
  assert.equal(l(id, 0), '1.');
  assert.equal(N.levelOf(n, id, 2).format, 'decimalZero');
});

test('a_start_override_restarts_only_its_own_level_of_a_shared_list', () => {
  let [n, chapters] = list('legal');
  const abs = N.abstractOf(n, chapters).id;
  const deep = chapters + 1;
  n = {...n, nums: [...n.nums, {id: deep, abstractId: abs, startOverrides: Array.from({length: 9}, (_, l) => [l, 1])}]};
  const l = labeler(n);
  assert.equal(l(chapters, 0), '1.');
  assert.equal(l(chapters, 0), '2.');
  assert.equal(l(chapters, 1), '2.1.');
  assert.equal(l(chapters, 2), '2.1.1.');
  assert.equal(l(chapters, 3), '2.1.1.1.');
  assert.equal(l(deep, 4), '2.1.1.1.1.', 'the deep num restarts only level 5');
  assert.equal(l(deep, 4), '2.1.1.1.2.');
  assert.equal(l(chapters, 0), '3.', 'and not the chapter count');
  assert.equal(l(chapters, 1), '3.1.');
});

test('levels_restart_only_after_their_restart_level', () => {
  let [n, id] = list('legal');
  n = withAbstract(n, a => {
    a.levels[2] = {...a.levels[2], restartAfter: 1, text: '(%3)'};
    a.levels[1] = {...a.levels[1], restart: false};
    return a;
  });
  const l = labeler(n);
  assert.equal(l(id, 0), '1.');
  assert.equal(l(id, 1), '1.1.');
  assert.equal(l(id, 2), '(1)');
  assert.equal(l(id, 1), '1.2.');
  assert.equal(l(id, 2), '(2)', "level 2 doesn't restart level 3");
  assert.equal(l(id, 0), '2.');
  assert.equal(l(id, 1), '2.3.', 'level 2 never restarts');
  assert.equal(l(id, 2), '(1)', 'level 1 restarts level 3');
});

test('a_level_starting_at_zero_counts_up', () => {
  let [n, id] = list('numbered');
  n = withAbstract(n, a => { a.levels[0] = {...a.levels[0], start: 0}; return a; });
  const l = labeler(n);
  assert.deepEqual([0, 1, 2, 3].map(() => l(id, 0)), ['0.', '1.', '2.', '3.']);
});

test('a_start_override_of_one_or_zero_is_honoured', () => {
  let [n, id] = list('numbered');
  n = withAbstract(n, a => { a.levels[0] = {...a.levels[0], start: 5}; return a; });
  let m = withNum(n, id, x => ({...x, startOverrides: [[0, 1]]}));
  let l = labeler(m);
  assert.deepEqual([l(id, 0), l(id, 0)], ['1.', '2.']);
  m = withNum(n, id, x => ({...x, startOverrides: [[0, 0]]}));
  l = labeler(m);
  assert.deepEqual([l(id, 0), l(id, 0), l(id, 0)], ['0.', '1.', '2.']);
});

test('numbered_labels', () => {
  const [n, id] = list('numbered');
  const c = new N.Counters();
  const l = (num, lvl) => c.nextLabel(n, num, lvl)?.[0];
  assert.equal(l(id, 0), '1.');
  assert.equal(l(id, 0), '2.');
  assert.equal(l(id, 1), 'a.');
  assert.equal(l(id, 1), 'b.');
  assert.equal(l(id, 0), '3.');
  assert.equal(l(id, 1), 'a.');
  assert.equal(c.nextLabel(n, 999, 0) ?? null, null);
});

test('east_asian_labels_and_legal_numbering', () => {
  let [n, id] = list('numbered');
  n = withAbstract(n, a => {
    a.levels[0] = N.level({format: 'chineseCounting', text: '第%1章'});
    a.levels[1] = N.level({format: 'chineseCounting', text: '%2、'});
    a.levels[2] = N.level({format: 'chineseCounting', text: '%1.%2.%3', legal: true});
    a.levels[3] = N.level({format: 'chineseCounting', text: '（%4）'});
    return a;
  });
  const l = labeler(n);
  assert.equal(l(id, 0), '第一章');
  assert.equal(l(id, 1), '一、');
  assert.equal(l(id, 1), '二、');
  assert.equal(l(id, 1), '三、');
  assert.equal(l(id, 2), '1.3.1', 'legal numbering is decimal on every level');
  assert.equal(l(id, 3), '（一）');
  for (let i = 0; i < 9; i++) l(id, 3);
  assert.equal(l(id, 3), '（十一）');
  assert.equal(l(id, 0), '第二章');
});

test('legal_labels', () => {
  const [n, id] = list('legal');
  const l = labeler(n);
  assert.equal(l(id, 0), '1.');
  assert.equal(l(id, 1), '1.1.');
  assert.equal(l(id, 2), '1.1.1.');
  assert.equal(l(id, 1), '1.2.');
});

test('restart_and_bullets', () => {
  let [n, id] = list('numbered');
  const c = new N.Counters();
  c.nextLabel(n, id, 0); c.nextLabel(n, id, 0);
  const r = N.restartList(n, id);
  n = r.numbering;
  assert.equal(c.nextLabel(n, r.num, 0)[0], '1.');
  const b = N.addList(n, 'bullet');
  n = b.numbering;
  assert.equal(c.nextLabel(n, b.num, 0)[0], '•');
  assert.equal(N.findKind(n, 'bullet'), b.num);
});

test('restart_keeps_the_list_s_own_level_definitions', () => {
  let [n, id] = list('numbered');
  const own = N.level({format: 'upperRoman', text: 'Part %1', indent: 90, hanging: 40, start: 5});
  n = withNum(n, id, x => ({...x, levelOverrides: [...(x.levelOverrides || []), [0, own]]}));
  const r = N.restartList(n, id);
  assert.deepEqual(N.numOf(r.numbering, r.num).levelOverrides, [[0, own]]);
  assert.deepEqual(N.levelOf(r.numbering, r.num, 0), own);
  assert.equal(new N.Counters().nextLabel(r.numbering, r.num, 0)[0], 'Part V');
});
