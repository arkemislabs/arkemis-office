// U:slate/links and U:slate/nav: Copy Link, Remove Link and Select All (the right-click menus), the Back
// button, and what the bridge lists of a page (tags, equations, protection).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. Upstream: Slate has no ArtCraft source; docs/spec/slate.json `link.copy`, `link.remove`,
//    `edit.selectAll` and `nav.back` name the commands. OneNote's behaviour: Copy Link to Paragraph / Page /
//    Section puts a link on the clipboard that opens that place; Remove Link takes the link off the text;
//    Select All selects the note's text; Back returns to the page you were on before.
// 2. Ours does the same on the notebook, the links being the `slate:` addresses link.insert writes.
// 3. Proof: these tests and tests/e2e/slate/home-view.e2e.mjs, gate.e2e.mjs (menus, read-backs).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {watchNavigation, backPages} from '../../core/slate/lib/nav-history.mjs';
import {textSession, textSel} from './format-helpers.mjs';

const sel = t => t.doc.selection.ranges[0];

test('Copy Link puts a link to the paragraph, page, section or notebook on the clipboard; for a link it copies its address', async () => {
  const t = await textSession(['Hello world', {text: 'see the site', marks: [{type: 'link', attrs: {href: 'https://a.test/x', title: null}, from: 4, to: 12}]}], {selection: p => textSel(p, 'b1', 3)});
  const para = await t.exec('link.copy', {scope: 'paragraph'});
  assert.equal(para.result.href, `slate:page/${t.pageId}#b1`);
  assert.deepEqual(await t.host.clipboardRead(), {text: para.result.href, html: `<a href="${para.result.href}">${para.result.label}</a>`});
  assert.equal((await t.exec('link.copy', {scope: 'page'})).result.href, `slate:page/${t.pageId}`);
  assert.equal((await t.exec('link.copy', {scope: 'section'})).result.href, `slate:section/${t.sectionId}`);
  assert.match((await t.exec('link.copy', {scope: 'notebook'})).result.href, /^slate:notebook\//);
  await assert.rejects(t.exec('link.copy', {scope: 'link'}), /not in a link/);
  t.session.setSelection(t.docId, textSel(t.pageId, 'b2', 6), {origin: 'test'});
  assert.equal((await t.exec('link.copy', {scope: 'link'})).result.href, 'https://a.test/x');
  assert.equal(t.state('link.remove').enabled, true);
  await expectUndoRoundTrip(t, 'link.remove', {}, () => assert.equal(t.blocks[1].content.some(r => r.marks?.some(m => m.type === 'link')), false));
  assert.equal(t.state('link.remove').enabled, false, 'removed: nothing more to remove');
});

test('Select All selects the text of the note the caret is in', async () => {
  const t = await textSession(['First line', 'Second line'], {selection: p => textSel(p, 'b1', 3)});
  const r = await t.exec('edit.selectAll');
  assert.equal(r.result.blocks, 2);
  assert.deepEqual([sel(t).anchor, sel(t).focus], [`/pg:${t.pageId}/b:b1/t:0`, `/pg:${t.pageId}/b:b2/t:11`]);
  assert.equal(t.session.read(t.docId, `/pg:${t.pageId}/b:b2`, 'text').length, 11);
});

test('Back returns through the pages visited, nearest first, skipping pages that are gone', async () => {
  const t = await textSession(['x'], {notebook: {sections: [{name: 'S', pages: ['One', 'Two', 'Three']}]}});
  const ids = t.content.sections[Object.keys(t.content.sections)[0]].pages.map(e => e.id);
  const go = id => t.session.setSelection(t.docId, {ranges: [{anchor: `/pg:${id}`, focus: `/pg:${id}`}], primary: 0}, {origin: 'test'});
  const off = watchNavigation(t.session, t.docId);
  go(ids[0]);
  assert.equal(t.state('nav.back').enabled, false, 'nothing visited before');
  go(ids[1]); go(ids[2]);
  assert.deepEqual(backPages(t.content), [ids[1], ids[0]]);
  assert.equal(t.state('nav.back').enabled, true);
  const back = await t.exec('nav.back');
  assert.equal(back.result.page, `/pg:${ids[1]}`);
  assert.equal(sel(t).anchor, `/pg:${ids[1]}`);
  await t.exec('nav.back');
  assert.equal(sel(t).anchor, `/pg:${ids[0]}`);
  assert.equal(t.state('nav.back').enabled, false, 'at the start');
  await assert.rejects(t.exec('nav.back'));
  // A deleted page is skipped.
  go(ids[1]); go(ids[2]);
  await t.exec('page.delete', {pageIds: [ids[1]]});
  go(ids[0]);
  assert.ok(!backPages(t.content).includes(ids[1]));
  off();
});

test('the bridge lists a page\'s tags and equations and a section\'s protection', async () => {
  const t = await textSession(['Tagged'], {selection: p => textSel(p, 'b1', 2)});
  await t.exec('tag.toggle', {tagId: 'to-do'});
  await t.exec('insert.equation', {preset: 'area-of-circle'});
  const props = t.session.read(t.docId, `/pg:${t.pageId}`, 'props');
  assert.deepEqual(props.tags.map(x => [x.block, x.id, x.checked]), [['b1', 'to-do', false]]);
  assert.equal(t.session.read(t.docId, props.tags[0].address, 'json').id, 'to-do');
  assert.deepEqual(props.equations.map(x => [x.linear, x.format]), [['A=πr^2', 'professional']]);
  assert.equal(t.session.read(t.docId, props.equations[0].address, 'props').linear, 'A=πr^2');
  const sec = t.session.read(t.docId, `/sec:${t.sectionId}`, 'json');
  assert.deepEqual([sec.protected, sec.locked], [false, false]);
  await t.exec('password.set', {sectionId: t.sectionId, password: 'x'});
  await t.exec('password.lock', {sectionId: t.sectionId});
  const locked = t.session.read(t.docId, `/sec:${t.sectionId}`, 'json');
  assert.deepEqual([locked.protected, locked.locked, locked.pages.length], [true, true, 0]);
  const root = t.session.read(t.docId, '/', 'json');
  assert.deepEqual(root.items.map(i => [i.protected, i.locked]), [[true, true]]);
});
