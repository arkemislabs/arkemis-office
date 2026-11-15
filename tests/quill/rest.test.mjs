// U:quill/rest: Remove Page Numbers, Remove Current Cover Page, Delete All Ink, Hide White Space, Interface Theme, Line Focus,
// Read Aloud's text, and the page geometry that hides white space.
//
// Behaviour fidelity (docs/behaviour-fidelity.md): not checked against upstream (wordcraft has no commands for these); each follows
// what Word does, as the spec notes say.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill, blocks} from './format-fixture.mjs';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {viewOf} from '../../core/quill/lib/view-layout.mjs';
import {readText} from '../../core/quill/commands/rest.mjs';
import {geometry} from '../../src/apps/quill/surface/geometry.mjs';

const TEXT = 'The quick brown fox jumps over the lazy dog.\nA second paragraph of text.\nAnd a third one to anchor ink to.';
const footerPara = t => {
  const parts = t.content.parts;
  const id = Object.keys(parts).find(k => parts[k].kind === 'footer');
  return id === undefined ? null : parts[id].blocks[0];
};

test('insert.removePageNumbers: the page number fields leave every footer, one undo step', async () => {
  const q = await quill(TEXT);
  await q.exec('insert.pageNumber', {position: 'bottom', align: 'center'});
  assert.ok(footerPara(q.t).objects.some(o => o.type === 'field' && /PAGE/.test(o.instr)), 'the footer has a page number');
  await expectUndoRoundTrip(q.t, 'insert.removePageNumbers', {}, () => {});
  assert.equal((footerPara(q.t).objects ?? []).length, 0, 'no field left');
  await q.exec('insert.pageNumber', {position: 'bottom', align: 'right', format: 'Page X of Y'});
  await q.exec('insert.removePageNumbers', {});
  assert.equal(footerPara(q.t).text.trim(), '', 'the Page and of words go with the fields');
});

test('insert.removeCoverPage: only a cover page goes, the rest of the text stays', async () => {
  const q = await quill(TEXT);
  assert.equal((await q.state('insert.removeCoverPage')).enabled, false, 'no cover page, no command');
  await assert.rejects(() => q.exec('insert.removeCoverPage', {}));
  const before = q.texts().length;
  await q.exec('insert.coverPage', {title: 'Annual Report'});
  assert.ok(q.texts().includes('Annual Report'));
  assert.equal((await q.state('insert.removeCoverPage')).enabled, true);
  await expectUndoRoundTrip(q.t, 'insert.removeCoverPage', {}, () => {});
  assert.ok(!q.texts().includes('Annual Report'), 'the cover page is gone');
  assert.ok(q.texts().includes('A second paragraph of text.'), 'the document stays');
  assert.equal(q.texts().length, before, 'as many paragraphs as before the cover page');
});

test('review.deleteAllInk: every stroke is deleted, other shapes stay', async () => {
  const q = await quill(TEXT);
  await q.exec('draw.pen', {});
  await q.exec('draw.stroke', {page: 0, points: Array.from({length: 12}, (_, i) => [100 + i * 4, 200 + Math.sin(i) * 10])});
  await q.exec('draw.stroke', {page: 0, points: Array.from({length: 12}, (_, i) => [100 + i * 4, 300 + Math.cos(i) * 10])});
  const ink = () => blocks(q.t).flatMap(b => b.objects ?? []).filter(o => o.type === 'shape' && o.freeform?.ink).length;
  assert.equal(ink(), 2);
  await expectUndoRoundTrip(q.t, 'review.deleteAllInk', {}, () => {});
  assert.equal(ink(), 0);
  await assert.rejects(() => q.exec('review.deleteAllInk', {}), /no ink/);
});

test('view.hideWhiteSpace, view.lineFocus and view.interfaceTheme are view and person settings, never edits', async () => {
  const q = await quill(TEXT);
  assert.equal(viewOf(q.t.doc.view).hideWhiteSpace, false);
  const r = await q.exec('view.hideWhiteSpace', {});
  assert.equal(r.result.value, true);
  assert.equal(viewOf(q.t.doc.view).hideWhiteSpace, true);
  await q.exec('view.hideWhiteSpace', {value: false});
  assert.equal(viewOf(q.t.doc.view).hideWhiteSpace, false);

  assert.equal((await q.state('view.lineFocus')).enabled, false, 'Line Focus is the Immersive Reader\'s');
  await q.exec('view.immersive', {});
  assert.equal((await q.state('view.lineFocus')).enabled, true);
  await q.exec('view.lineFocus', {value: 'three'});
  assert.equal(viewOf(q.t.doc.view).lineFocus, 3);
  await q.exec('view.lineFocus', {value: 'none'});
  assert.equal(viewOf(q.t.doc.view).lineFocus, 0);

  await q.exec('view.interfaceTheme', {value: 'light'});
  assert.equal((await q.state('view.interfaceTheme')).value, 'light');
  await assert.rejects(() => q.exec('view.interfaceTheme', {value: 'purple'}));
});

test('Read Aloud reads the selection, or from the caret on, and needs a local voice', async () => {
  const q = await quill(TEXT);
  const d = q.doc(), at = (n, off) => ({story: 'body', path: [n], off});
  assert.equal(readText(d, at(0, 4), at(0, 9)), 'quick', 'the selection');
  assert.equal(readText(d, at(0, 40), at(0, 40)), ['dog.', 'A second paragraph of text.', 'And a third one to anchor ink to.'].join(String.fromCharCode(10)), 'from the caret on');
  assert.equal(readText(d, at(2, 4), at(1, 2)), ['second paragraph of text.', 'And'].join(String.fromCharCode(10)), 'a backwards selection across paragraphs');
  const st = await q.state('review.readAloud');
  assert.equal(st.enabled, false, 'no speech engine here');
  assert.match(st.reason, /speech|voice/);
});

test('geometry: hiding white space shrinks the page column and keeps the first top and last bottom margin', () => {
  const q = {w: 612, h: 792, body: {x: 72, y: 72, w: 468, h: 648}};
  const pages = [q, q, q];
  const full = geometry(pages, {zoom: 100}, {w: 900, h: 700});
  const hidden = geometry(pages, {zoom: 100, hideWhiteSpace: true}, {w: 900, h: 700});
  assert.equal(hidden.rects[0].ct ?? 0, 0, 'the first page keeps its top margin');
  assert.equal(hidden.rects[0].cb, 72 * hidden.scale, 'its bottom margin is hidden');
  assert.equal(hidden.rects[1].ct, 72 * hidden.scale);
  assert.equal(hidden.rects[2].cb ?? 0, 0, 'the last page keeps its bottom margin');
  assert.ok(hidden.size.h < full.size.h - 2 * 144 * hidden.scale + 30, 'two joins save two margins each');
  const mid = hidden.rects[1];
  assert.equal(hidden.rects[1].y + hidden.rects[1].ct, hidden.rects[0].y + hidden.rects[0].h - hidden.rects[0].cb + 3, 'a 3 px divider between the bands');
});

test('format.textGradientLight and Dark: eight linear gradients of the text colour set as the text fill; No Gradient takes it off', async () => {
  const q = await quill('Gradient text here.');
  q.sel(0, 0, 8);
  await q.exec('format.color', {color: 'C00000'});
  for (const id of ['format.textGradientLight', 'format.textGradientDark']) {
    const st = await q.state(id);
    assert.equal(st.value.length, 8, 'the eight directions');
    assert.ok(st.value.every(v => v.value.gradient.length === 3 && v.art.kind === 'gradient'));
  }
  await q.exec('format.textGradientDark', {});
  const fill = () => q.para(0).runs.map(r => r.props?.textEffects?.fill).find(Boolean);
  assert.equal(fill().type, 'gradient');
  assert.equal(fill().stops.length, 3);
  await q.exec('format.textGradientLight', {gradient: ['FFFFFF', '336699'], angle: 45});
  assert.equal(fill().angle, 45);
  await q.exec('format.textEffects', {fill: null});
  assert.equal(fill(), undefined, 'No Gradient');
});

test('review.lockTracking: Track Changes on and editing restricted to tracked changes, then released; a password guards it', async () => {
  const q = await quill('Contract text.');
  assert.equal((await q.state('review.lockTracking')).checked, false);
  await q.exec('review.lockTracking', {});
  assert.equal(q.t.content.settings.trackChanges, true);
  assert.equal(q.t.content.settings.protection, 'trackedChanges');
  assert.equal((await q.state('review.lockTracking')).checked, true);
  await q.exec('review.lockTracking', {});
  assert.equal(q.t.content.settings.protection ?? null, null, 'used again it stops the protection');
  await q.exec('review.restrict', {mode: 'trackedChanges', password: 'pw1', spinCount: 50});
  await assert.rejects(() => q.exec('review.lockTracking', {password: 'wrong'}));
  assert.equal(q.t.content.settings.protection, 'trackedChanges', 'the wrong password leaves it locked');
  await q.exec('review.lockTracking', {password: 'pw1'});
  assert.equal(q.t.content.settings.protection ?? null, null);
});
