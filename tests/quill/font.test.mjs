// Home › Font › Added Fonts (`font.list`, core/quill/commands/font.mjs).
//
// Behaviour fidelity:
// 1. ArtCraft: wordcraft crates/engine/src/cmd/font.rs `list` returns the fonts the person added
//    (`font_json`: file, families, faces, path) and the store folder; Word lists every installed
//    family in the Font box. `font.add` / `font.remove` need a font store the host does not offer
//    yet (design note quill-format--integrator--font-store), so they stay unregistered and
//    their controls hidden; `font.loadSystem` is the web build's prompt and has no desktop role.
// 2. Ours: no added fonts (an empty list, no folder) and, with `all`, the installed families from
//    the host, deduplicated and sorted, as the Font box lists them.
// 3. This test.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill} from './format-fixture.mjs';

test('font.list: no added fonts yet; `all` lists the installed families sorted and once each', async () => {
  const q = await quill('Text');
  const r = await q.exec('font.list');
  assert.deepEqual(r.result, {fonts: [], folder: null});
  q.t.session.host.fonts = async () => [{family: 'Georgia'}, 'Aptos', {family: 'aptos display'}, {family: 'Georgia'}, '', null];
  const all = await q.exec('font.list', {all: true});
  assert.deepEqual(all.result.families, ['Aptos', 'aptos display', 'Georgia']);
  const reg = q.t.session.registry;
  for (const id of ['font.add', 'font.remove', 'font.loadSystem']) assert.equal(reg.get?.(id) ?? reg[id] ?? null, null, `${id} stays hidden`);
});
