// U:slate/clipboard: OneNote's Home > Clipboard group (Cut, Copy, Paste and its modes, Format Painter)
// and the drawn Styles and Tags galleries.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. Upstream: Slate has no ArtCraft source; docs/spec/slate.json `clipboard.*` names the commands.
//    OneNote's behaviour: Copy puts the selection on the clipboard (a caret copies nothing), Cut also
//    removes it, Paste replaces the selection (Keep Source Formatting, Merge Formatting and Keep Text
//    Only differ in how much of the copied formatting comes with it), Format Painter takes the
//    formatting of the selection and gives it to the next one; the Styles and Tags galleries show every
//    style and tag drawn with its icon, those of the paragraph marked.
// 2. Ours does the same on the page: the system clipboard is the Host's (text and HTML), the page slice
//    stays in the session so a paste in the same app keeps tags, lists and formatting whole.
// 3. Proof: these tests and tests/e2e/slate/home-view.e2e.mjs (ribbon, galleries, captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {fragmentHtml, parseHtml, parseText} from '../../core/slate/lib/clipboard-html.mjs';
import {STYLE_TILES} from '../../core/slate/commands/paragraph.mjs';
import {DEFAULT_TAGS, tagIcon} from '../../core/slate/lib/tags-catalog.mjs';
import {textSession, textSel} from './format-helpers.mjs';

const icons = new Set(fs.readdirSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../assets/icons/ribbon')).map(f => f.replace(/\.svg$/, '')));
const runs = (t, i = 0) => t.blocks[i].content.map(r => [r.text, (r.marks ?? []).map(m => m.type).join(',')]);
const texts = t => t.blocks.map(b => (b.content ?? []).map(c => c.text ?? '￼').join(''));

test('HTML for the clipboard: written from a slice, read back into paragraphs of formatted runs', () => {
  const paras = parseHtml('<html><body><!--StartFragment--><h2>Head</h2><p>Plain <b>bold</b> <i>it</i> <a href="https://a.test/x">link</a><br>after &amp; &lt;b&gt;</p><ul><li>one</li><li>two</li></ul><script>alert(1)</script><!--EndFragment--></body></html>');
  assert.deepEqual(paras.map(p => p.style), ['h2', 'normal', 'normal', 'normal']);
  assert.deepEqual(paras[1].runs.map(r => [r.text, r.marks.map(m => m.type).join()]), [['Plain ', ''], ['bold', 'bold'], [' ', ''], ['it', 'italic'], [' ', ''], ['link', 'link'], ['\nafter & <b>', '']]);
  assert.equal(JSON.stringify(paras).includes('alert'), false, 'scripts are never read');
  const merged = parseHtml('<p>x <a href="https://a.test">y</a> <b>z</b></p>', {keep: 'emphasis'});
  assert.deepEqual(merged[0].runs.map(r => r.marks.map(m => m.type).join()), ['', 'bold'], 'merge keeps emphasis, not links');
  assert.deepEqual(parseText('a\r\n\nb').map(p => p.runs.map(r => r.text).join()), ['a', '', 'b']);
  assert.equal(parseHtml('<img src="https://x.test/p.png" alt="alt text">')[0].runs[0].text, 'alt text', 'a picture that is not data becomes its alt text');
  assert.ok(parseHtml('<img src="data:image/png;base64,AAAA">')[0].runs[0].image);
  assert.equal(fragmentHtml({forEach() {}}), '<html><body><!--StartFragment--><!--EndFragment--></body></html>');
});

test('Copy puts the selection on the clipboard as text and HTML and keeps the slice; a caret copies nothing', async () => {
  const t = await textSession([{text: 'Hello bold world', marks: [{type: 'bold', from: 6, to: 10}]}], {selection: p => textSel(p, 'b1', 0, 16)});
  const r = await t.exec('clipboard.copy');
  assert.equal(r.result.copied, true);
  assert.equal(r.result.text, 'Hello bold world');
  assert.match(r.result.html, /<p>Hello <strong>bold<\/strong> world<\/p>|Hello <strong>bold<\/strong> world/);
  assert.deepEqual(await t.host.clipboardRead(), {text: 'Hello bold world', html: r.result.html});
  assert.equal(t.session.clipboard.kind, 'slate.slice');
  assert.equal(t.session.clipboardItems.length, 1);
  t.session.setSelection(t.docId, textSel(t.pageId, 'b1', 3), {origin: 'test'});
  assert.equal((await t.exec('clipboard.copy')).result.copied, false);
  assert.equal((await t.host.clipboardRead()).text, 'Hello bold world', 'the clipboard keeps what it had');
  assert.equal(t.session.clipboardItems.length, 1);
});

test('Cut copies and removes the selection (one undo step); Paste puts it back with its formatting', async () => {
  const t = await textSession([{text: 'Alpha beta gamma', marks: [{type: 'bold', from: 6, to: 10}]}, 'Second'], {selection: p => textSel(p, 'b1', 6, 11)});
  await expectUndoRoundTrip(t, 'clipboard.cut', {}, () => assert.deepEqual(texts(t), ['Alpha gamma', 'Second']));
  assert.equal((await t.host.clipboardRead()).text, 'beta ');
  // Paste into the second paragraph, at its end.
  t.session.setSelection(t.docId, textSel(t.pageId, 'b2', 6), {origin: 'test'});
  const r = await expectUndoRoundTrip(t, 'clipboard.paste', {});
  assert.equal(r.result.pasted, 'slice');
  assert.deepEqual(runs(t, 1), [['Second', ''], ['beta', 'bold'], [' ', '']]);
  // The same slice over a selection replaces it.
  t.session.setSelection(t.docId, textSel(t.pageId, 'b1', 0, 5), {origin: 'test'});
  await t.exec('clipboard.paste');
  assert.deepEqual(texts(t)[0], 'beta  gamma');
  assert.equal(t.state('clipboard.cut').enabled, true);
});

test('pasting a copied tagged list keeps its tags and gives every block its own id', async () => {
  const t = await textSession([{text: 'Buy milk', tags: [{id: 'to-do', name: 'To Do', symbol: 'checkbox', fontColor: null, highlightColor: null, checkbox: true, checked: false, created: '2026-01-01T00:00:00.000Z'}]}, 'Next'],
    {selection: p => textSel(p, 'b1', 0, 8)});
  await t.exec('clipboard.copy');
  t.session.setSelection(t.docId, textSel(t.pageId, 'b2', 4), {origin: 'test'});
  await t.exec('clipboard.paste');
  assert.equal(texts(t).join('|').includes('Buy milk'), true);
  const ids = []; const walk = n => { if (n.attrs?.id) ids.push(n.attrs.id); (n.content ?? []).forEach(walk); };
  walk(t.content.pages[t.pageId].body);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique on the page');
});

test('Paste modes: Keep Source Formatting keeps the copied HTML formatting, Merge keeps its emphasis only, Keep Text Only the text', async () => {
  const html = '<p>See <b>bold</b> and <a href="https://a.test/x">the link</a></p><p>Second line</p>';
  const text = 'See bold and the link\nSecond line';
  const at = async () => { const t = await textSession(['Start: '], {selection: p => textSel(p, 'b1', 7)}); await t.host.clipboardWrite({text, html}); return t; };
  let t = await at();
  assert.equal((await t.exec('clipboard.paste', {mode: 'keep-source'})).result.pasted, 'html');
  assert.deepEqual(texts(t), ['Start: See bold and the link', 'Second line']);
  assert.ok(runs(t).some(r => r[1] === 'bold') && runs(t).some(r => r[1] === 'link'));
  t = await at();
  await t.exec('clipboard.paste', {mode: 'merge'});
  assert.ok(runs(t).some(r => r[1] === 'bold'));
  assert.equal(runs(t).some(r => r[1] === 'link'), false, 'links are not merged in');
  t = await at();
  assert.equal((await t.exec('clipboard.paste', {mode: 'text-only'})).result.pasted, 'text');
  assert.deepEqual(runs(t).map(r => r[1]), ['']);
  assert.deepEqual(texts(t), ['Start: See bold and the link', 'Second line']);
  // Default is Keep Source Formatting; `text` and `html` give the content directly.
  t = await at();
  await t.exec('clipboard.paste', {text: 'given', html: ''});
  assert.equal(texts(t)[0], 'Start: given');
  t = await textSession(['Empty'], {selection: p => textSel(p, 'b1', 0)});
  await assert.rejects(t.exec('clipboard.paste', {}), /clipboard is empty/);
});

test('with no caret on the page, Paste makes a note container holding the pasted text', async () => {
  const t = await textSession(['One'], {selection: p => ({ranges: [{anchor: `/pg:${p}`, focus: `/pg:${p}`}], primary: 0})});
  await t.host.clipboardWrite({text: 'Pasted\nlines', html: ''});
  const r = await expectUndoRoundTrip(t, 'clipboard.paste', {});
  assert.ok(r.result.container);
  const body = t.content.pages[t.pageId].body.content;
  assert.equal(body.length, 2);
  assert.deepEqual(body[1].content.map(p => p.content[0].text), ['Pasted', 'lines']);
});

test('Format Painter takes the formatting of the selection and gives it to the next one, then turns off', async () => {
  const t = await textSession([{text: 'Fancy words', style: 'h2', marks: [{type: 'bold'}, {type: 'italic'}]}, 'Plain words here'], {selection: p => textSel(p, 'b1', 0, 5)});
  assert.equal(t.state('clipboard.formatPainter').checked, false);
  assert.deepEqual((await t.exec('clipboard.formatPainter')).result, {active: true});
  assert.equal(t.state('clipboard.formatPainter').checked, true);
  t.session.setSelection(t.docId, textSel(t.pageId, 'b2', 6, 11), {origin: 'test'});
  const done = await expectUndoRoundTrip(t, 'clipboard.formatPainter', {}, () => assert.deepEqual(runs(t, 1), [['Plain ', ''], ['words', 'bold,italic'], [' here', '']]));
  assert.equal(done.result.applied, true);
  assert.equal(t.blocks[1].attrs.style, 'h2', 'the paragraph style comes too');
  assert.equal(t.state('clipboard.formatPainter').checked, false);
  // Picked up and put down on the same text: only off. Value false cancels.
  t.session.setSelection(t.docId, textSel(t.pageId, 'b2', 0, 5), {origin: 'test'});
  await t.exec('clipboard.formatPainter');
  assert.equal((await t.exec('clipboard.formatPainter')).result.applied, false);
  await t.exec('clipboard.formatPainter');
  assert.deepEqual((await t.exec('clipboard.formatPainter', {value: false})).result, {active: false});
  assert.equal(t.state('clipboard.formatPainter').checked, false);
});

test('the Styles gallery draws one tile per style with its icon, the paragraph\'s style selected; a tile\'s value applies it', async () => {
  const t = await textSession(['Title text'], {selection: p => textSel(p, 'b1', 2)});
  const st = t.state('style.apply');
  assert.equal(st.value.length, 11);
  assert.deepEqual(st.value.map(x => x.label), ['Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6', 'Page Title', 'Citation', 'Quote', 'Code', 'Normal']);
  assert.ok(st.value.every(x => icons.has(x.icon)), 'every tile has its icon');
  assert.deepEqual(st.value.filter(x => x.selected).map(x => x.value), ['normal']);
  await expectUndoRoundTrip(t, 'style.apply', {value: 'heading-2'});
  assert.equal(t.blocks[0].attrs.style, 'h2');
  assert.deepEqual(t.state('style.apply').value.filter(x => x.selected).map(x => x.value), ['heading-2']);
  assert.deepEqual(t.state('style.apply', {style: 'heading-2'}), {enabled: true, value: 'heading-2', checked: true});
  assert.equal(STYLE_TILES.length, 11);
  await assert.rejects(t.exec('style.apply', {}), /Give the style/);
});

test('the Tags gallery draws one tile per tag in the person\'s order with its icon; tagged ones are selected; a tile\'s value toggles the tag', async () => {
  const t = await textSession(['Remember this'], {selection: p => textSel(p, 'b1', 3)});
  const st = t.state('tag.toggle');
  assert.equal(st.value.length, DEFAULT_TAGS.length);
  assert.deepEqual(st.value.slice(0, 5).map(x => x.label), ['To Do', 'Important', 'Question', 'Remember for later', 'Definition']);
  assert.ok(st.value.every(x => icons.has(x.icon)), `every tile has its icon: ${st.value.filter(x => !icons.has(x.icon)).map(x => x.icon)}`);
  assert.deepEqual(st.value.slice(0, 5).map(x => x.icon), ['tag-checkbox', 'tag-star', 'tag-question-mark', 'tag-highlight-yellow', 'tag-highlight-green']);
  assert.equal(st.value.some(x => x.selected), false);
  await expectUndoRoundTrip(t, 'tag.toggle', {value: 'important'});
  assert.deepEqual(t.state('tag.toggle').value.filter(x => x.selected).map(x => x.value), ['important']);
  await assert.rejects(t.exec('tag.toggle', {}), /Give the tag/);
  await assert.rejects(t.exec('tag.toggle', {value: 'nope'}), /no tag nope/);
  // A customised list (a new tag with a symbol) draws too.
  await t.exec('tag.create', {displayName: 'Chase up', symbol: 'flag-green'});
  const mine = t.state('tag.toggle').value.find(x => x.label === 'Chase up');
  assert.equal(mine.label, 'Chase up');
  assert.ok(icons.has(mine.icon));
  assert.equal(tagIcon({symbol: 'none', highlightColor: '#00ff00'}), 'tag-highlight-green');
  assert.equal(tagIcon({symbol: 'checkbox-red'}), 'tag-checkbox');
});

// Type Text (text.insert): the automation layer's way to write on a page.
const caret = t => t.session.get(t.docId).selection?.ranges?.[0];

test('Type Text writes at the caret (one undo step), never touches the clipboard, and leaves the caret after the text', async () => {
  const t = await textSession(['Hello world'], {selection: p => textSel(p, 'b1', 5)});
  await t.host.clipboardWrite({text: 'kept', html: ''});
  const r = await expectUndoRoundTrip(t, 'text.insert', {text: ' brave\nnew'}, () => assert.deepEqual(texts(t), ['Hello brave', 'new world']));
  assert.equal(r.result.at, 'selection');
  assert.equal((await t.host.clipboardRead()).text, 'kept');
  await t.exec('text.insert', {text: ' bold'});
  assert.deepEqual(texts(t), ['Hello brave', 'new bold world'], 'the next write continues where the last ended');
  assert.equal(caret(t).anchor, caret(t).focus);
});

test('Type Text replaces the selection, and html keeps its emphasis', async () => {
  const t = await textSession(['Alpha beta gamma'], {selection: p => textSel(p, 'b1', 6, 10)});
  await t.exec('text.insert', {text: 'BETA', html: '<p><b>BETA</b></p>'});
  assert.deepEqual(runs(t), [['Alpha ', ''], ['BETA', 'bold'], [' gamma', '']]);
});

test('with no caret, Type Text continues the page\'s last note container, so repeated writes read down the page', async () => {
  const t = await textSession(['One'], {selection: p => ({ranges: [{anchor: `/pg:${p}`, focus: `/pg:${p}`}], primary: 0})});
  const r = await expectUndoRoundTrip(t, 'text.insert', {text: 'Two\nThree'}, () => assert.deepEqual(texts(t), ['One', 'Two', 'Three']));
  assert.equal(r.result.at, 'end');
  t.select({ranges: [{anchor: `/pg:${t.pageId}`, focus: `/pg:${t.pageId}`}], primary: 0});
  await t.exec('text.insert', {text: 'Four'});
  assert.equal(t.content.pages[t.pageId].body.content.length, 1, 'no second container stacked on the first');
  assert.deepEqual(texts(t), ['One', 'Two', 'Three', 'Four']);
});

test('Type Text fills an empty note, makes a container on a page with none, and refuses empty text', async () => {
  const empty = await textSession([''], {selection: p => ({ranges: [{anchor: `/pg:${p}`, focus: `/pg:${p}`}], primary: 0})});
  await empty.exec('text.insert', {text: 'First'});
  assert.deepEqual(texts(empty), ['First'], 'the empty paragraph is replaced, not left above');
  const bare = await textSession(['x'], {selection: p => ({ranges: [{anchor: `/pg:${p}`, focus: `/pg:${p}`}], primary: 0})});
  bare.content.pages[bare.pageId].body.content.length = 0;
  const made = await bare.exec('text.insert', {text: 'Fresh\npage'});
  assert.equal(made.result.at, 'new');
  const body = bare.content.pages[bare.pageId].body.content;
  assert.equal(body.length, 1);
  assert.deepEqual(body[0].content.map(p => p.content[0].text), ['Fresh', 'page']);
  await assert.rejects(empty.exec('text.insert', {text: ''}), /Give the text/);
});
