import test from 'node:test';
import assert from 'node:assert/strict';
import {createTransaction, applyOps, invertOps, normPath, getIn, contentOp} from '../../core/kernel/change.mjs';

const tree = () => ({id: 'd1', title: 'T', content: {
  sheets: [{id: 's1', blocks: [{A1: {v: 1}, A2: {v: 2}}, {A257: {v: 3}}]}, {id: 's2', blocks: []}],
  styles: {normal: {size: 11}},
}});

test('writes copy only the objects along the path (structural sharing)', () => {
  const before = tree();
  const tx = createTransaction(before);
  tx.api.set('sheets/0/blocks/0/A1', {v: 10});
  const after = tx.tree;
  assert.notEqual(after, before);
  assert.notEqual(after.content.sheets[0].blocks[0], before.content.sheets[0].blocks[0]);
  assert.equal(after.content.sheets[0].blocks[1], before.content.sheets[0].blocks[1], 'sibling block shared');
  assert.equal(after.content.sheets[1], before.content.sheets[1], 'other sheet shared');
  assert.equal(after.content.styles, before.content.styles, 'styles shared');
  assert.deepEqual(before.content.sheets[0].blocks[0].A1, {v: 1}, 'original untouched');
});

test('many writes in one block copy it once and keep the original intact', () => {
  const before = tree();
  const tx = createTransaction(before);
  tx.api.set(['sheets', 0, 'blocks', 0, 'B1'], {v: 'x'});
  const first = tx.tree.content.sheets[0].blocks[0];
  tx.api.set(['sheets', 0, 'blocks', 0, 'B2'], {v: 'y'});
  assert.equal(tx.tree.content.sheets[0].blocks[0], first, 'copied block reused within the transaction');
  assert.equal(Object.keys(before.content.sheets[0].blocks[0]).length, 2);
  assert.equal(tx.ops.length, 2);
});

test('inverse ops restore the exact previous tree', () => {
  const before = tree();
  const snapshot = structuredClone(before);
  const tx = createTransaction(before);
  tx.api.set('sheets/0/blocks/0/A1', {v: 99});
  tx.api.delete('sheets/0/blocks/0/A2');
  tx.api.splice('sheets', 1, 1);
  tx.api.splice('sheets', 0, 0, {id: 's0', blocks: []});
  tx.api.set('styles/heading', {size: 16});
  tx.api.set('sheets/1/blocks/2', {C3: {v: 1}});
  tx.api.setMeta('title', 'Renamed');
  tx.api.setMeta('properties', {author: 'Me'});
  const after = tx.tree;
  const undone = applyOps(after, invertOps(tx.ops));
  assert.deepEqual(undone, snapshot);
  const redone = applyOps(undone, tx.ops);
  assert.deepEqual(redone, structuredClone(after));
  assert.deepEqual(before, snapshot, 'the committed tree was never mutated');
});

test('setting an array index at its length appends through splice', () => {
  const tx = createTransaction(tree());
  tx.api.set('sheets/2', {id: 's3', blocks: []});
  assert.equal(tx.ops[0].op, 'splice');
  assert.equal(tx.tree.content.sheets.length, 3);
});

test('no-op writes record nothing; locked metadata is refused', () => {
  const t = tree();
  const tx = createTransaction(t);
  tx.api.set('styles/normal', t.content.styles.normal);
  tx.api.delete('styles/missing');
  tx.api.splice('sheets', 0, 0);
  assert.equal(tx.ops.length, 0);
  assert.throws(() => tx.api.setMeta('id', 'x'), /cannot be changed/);
  assert.throws(() => tx.api.set('nope/deeper', 1), /Nothing to change/);
  assert.throws(() => tx.api.splice('styles', 0, 0, 1), /Not an array/);
});

test('app ops apply through the app hook and invert', () => {
  const appApply = (content, op) => ({content: {...content, n: content.n + op.add}, inverse: {add: -op.add}});
  const t = {id: 'x', content: {n: 1}};
  const tx = createTransaction(t, {appApply});
  tx.api.apply({add: 5});
  assert.equal(tx.tree.content.n, 6);
  assert.deepEqual(applyOps(tx.tree, invertOps(tx.ops), {appApply}), t);
});

test('paths: arrays, slash and dot strings, JSON-pointer escapes', () => {
  assert.deepEqual(normPath('/a/b~1c/0'), ['a', 'b/c', '0']);
  assert.deepEqual(normPath('a.b.0'), ['a', 'b', '0']);
  assert.deepEqual(normPath(['a', 1]), ['a', 1]);
  assert.equal(getIn({a: [{b: 2}]}, '/a/0/b'), 2);
  assert.equal(contentOp({op: 'set', path: ['title']}), null);
  assert.deepEqual(contentOp({op: 'set', path: ['content', 'a']}).path, ['a']);
});
