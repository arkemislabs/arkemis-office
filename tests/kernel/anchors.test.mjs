import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {AnchorTable} from '../../core/kernel/anchors.mjs';
import {parse, genericResolver} from '../../core/kernel/address.mjs';
import {listFamily, listContent, appInfo} from './helpers.mjs';
import edit from '../../core/common/commands/edit.mjs';

const make = () => createTestSession('quill', {modules: [edit, listFamily], foundation: {spec: appInfo}, content: listContent()});

test('anchors follow their target through inserts and removals before it', async () => {
  const t = await make();
  const a = t.anchor('/items/2');
  assert.match(a, /^@a\d+$/);
  await t.exec('list.remove', {index: 0});
  assert.deepEqual(t.where(a), {address: '/items/1'});
  await t.exec('list.push', {value: 'e'});
  assert.deepEqual(t.where(a), {address: '/items/1'}, 'an insert after the target leaves it alone');
  await t.batch([{command: 'list.remove', params: {index: 0}}, {command: 'list.push', params: {value: 'f'}}]);
  assert.deepEqual(t.where(a), {address: '/items/0'});
  assert.equal(t.read(a), 'c', 'reading through the anchor reaches the same item');
});

test('anchors map back through undo and redo', async () => {
  const t = await make();
  const a = t.anchor('/items/3');
  await t.exec('list.remove', {index: 1});
  assert.deepEqual(t.where(a), {address: '/items/2'});
  await t.undo();
  assert.deepEqual(t.where(a), {address: '/items/3'});
  await t.redo();
  assert.deepEqual(t.where(a), {address: '/items/2'});
});

test('a deleted target reports deleted with the nearest address', async () => {
  const t = await make();
  const a = t.anchor('/items/1');
  const b = t.anchor('/meta/title');
  await t.exec('list.remove', {index: 1});
  assert.deepEqual(t.where(a), {deleted: true, nearest: '/items'});
  assert.throws(() => t.read(a), e => e.code === 'not_found' && e.data.deleted === true);
  await t.exec('list.title', {title: 'Renamed'});
  assert.deepEqual(t.where(b), {address: '/meta/title'}, 'replacing the value keeps the anchor');
});

test('anchoring needs an existing target; anchors are capped per document', async () => {
  const t = await make();
  assert.throws(() => t.anchor('/items/99'), e => e.code === 'not_found');
  assert.throws(() => t.anchor('items/1'), e => e.code === 'invalid_address');
  const table = new AnchorTable({limit: 2});
  table.create(parse('/a'));
  table.create(parse('/b'));
  assert.throws(() => table.create(parse('/c')), e => e.code === 'too_large');
});

test('anchor tables map through raw ops with any resolver', () => {
  const table = new AnchorTable();
  const id = table.create(parse('/rows/5/cells/2'));
  table.mapThrough([{op: 'splice', path: ['content', 'rows'], index: 0, remove: 0, items: [{}, {}], removed: []}], genericResolver.mapThrough);
  assert.deepEqual(table.toJSON(genericResolver.format)[id], {address: '/rows/7/cells/2'});
  table.mapThrough([{op: 'title', path: ['title']}], genericResolver.mapThrough);
  table.mapThrough([{op: 'delete', path: ['content', 'rows'], old: []}], genericResolver.mapThrough);
  assert.equal(table.get(id).deleted, true);
});
