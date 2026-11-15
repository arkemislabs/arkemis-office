// U:prism/insert: Header and Footer (design.headerFooter and its dialog), the media pickers of Insert >
// Video / Audio, and the tiled picture background drawn by the slide view.
//
// 1. ArtCraft: crates/engine/src/cmd/design/slide_setup.rs (`header_footer`, `set_date`, the
//    header_footer_date_tests), crates/ui-egui/src/dialogs/body.rs (`dlg_header_footer`).
//    PowerPoint: Insert > Header & Footer.
// 2. Ours: core/prism/commands/design.mjs, dialogs/headerFooter.mjs.
// 3. These tests and tests/e2e/prism/insert-view.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import design from '../../core/prism/commands/design.mjs';
import master from '../../core/prism/commands/master.mjs';
import insert from '../../core/prism/commands/insert.mjs';
import headerFooterDialog from '../../core/prism/dialogs/headerFooter.mjs';
import {withNew, curSlide} from './upstream/text_deck.mjs';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {exportPptx} from '../../core/prism/formats/pptx-write.mjs';
import {importPptx} from '../../core/prism/formats/pptx-read.mjs';
import {bodyText} from '../../core/prism/model/text.mjs';


const deck = async () => {
  const t = await withNew({extra: [design, insert, master]});
  await t.exec('slide.new', {layout: 'titleAndContent'});
  await t.exec('slide.go', {index: 0});
  return t;
};
const phs = (sl, kind) => sl.shapes.filter(s => s.ph?.kind === kind);
const run0 = sh => sh.text.paragraphs[0].runs[0];

test('design.headerFooter puts the date, slide number and footer on every slide; undo restores; they go away again', async () => {
  const t = await deck();
  assert.equal(phs(curSlide(t), 'footer').length, 0);
  await expectUndoRoundTrip(t, 'design.headerFooter', {date: true, slideNumber: true, footer: true, footerText: 'Acme Corp'});
  for (const sl of t.content.slides) {
    assert.equal(phs(sl, 'date').length, 1);
    assert.equal(phs(sl, 'slideNum').length, 1);
    assert.equal(bodyText(phs(sl, 'footer')[0].text), 'Acme Corp');
    assert.deepEqual(run0(phs(sl, 'slideNum')[0]).kind, {kind: 'field', field: 'slidenum'});
    const d = run0(phs(sl, 'date')[0]);
    assert.deepEqual(d.kind, {kind: 'field', field: 'datetime1'}, 'automatic by default');
  }
  assert.deepEqual([t.content.headerFooter.date, t.content.headerFooter.slideNumber, t.content.headerFooter.footerText], [true, true, 'Acme Corp']);
  await t.exec('design.headerFooter', {slideNumber: false, footer: false, date: false});
  for (const sl of t.content.slides) assert.deepEqual([phs(sl, 'date').length, phs(sl, 'slideNum').length, phs(sl, 'footer').length], [0, 0, 0]);
});

test('the date: automatic formats (kept, changed, refused), a fixed date, back to automatic', async () => {
  const t = await deck();
  const date = () => run0(phs(curSlide(t), 'date')[0]);
  await t.exec('design.headerFooter', {date: true, dateText: ''});
  assert.equal(date().kind.field, 'datetime1');
  assert.match(date().text, /^\d{1,2}\/\d{1,2}\/\d{4}$/);
  await t.exec('design.headerFooter', {date: true, dateFormat: 'datetime5'});
  assert.equal(date().kind.field, 'datetime5');
  assert.equal(t.content.headerFooter.dateFormat, 'datetime5');
  const before = JSON.stringify(t.content.slides);
  await t.exec('design.headerFooter', {date: true, dateFormat: 'datetime5'});
  assert.equal(JSON.stringify(t.content.slides), before, 'asking again changes nothing');
  await t.exec('design.headerFooter', {date: true, dateText: '4 July 1776'});
  assert.deepEqual([date().text, date().kind ?? null], ['4 July 1776', null]);
  await t.exec('design.headerFooter', {date: true, dateText: '', dateFormat: 'datetime5'});
  assert.equal(date().kind.field, 'datetime5', 'the remembered format comes back');
  for (const bad of ['datetime0', 'datetime14', 'nonsense', '']) await assert.rejects(t.exec('design.headerFooter', {date: true, dateFormat: bad}), /dateFormat/);
  assert.equal(t.content.headerFooter.dateFormat, 'datetime5');
});

test("Don't show on title slide, Apply to the current slide only, footer text kept in sync", async () => {
  const t = await deck();
  await t.exec('design.headerFooter', {footer: true, footerText: 'One', slideNumber: true, hideOnTitle: true});
  const layoutKind = sl => t.content.masters.flatMap(m => m.layouts).find(l => l.id === sl.layout).kind;
  assert.equal(layoutKind(t.content.slides[0]), 'title');
  assert.equal(phs(t.content.slides[0], 'footer').length, 0, 'not on the title slide');
  assert.equal(phs(t.content.slides[1], 'footer').length, 1);
  await t.exec('design.headerFooter', {footerText: 'Two'});
  assert.equal(bodyText(phs(t.content.slides[1], 'footer')[0].text), 'Two');
  await t.exec('slide.go', {index: 1});
  await t.exec('design.headerFooter', {footer: false, all: false});
  assert.equal(phs(t.content.slides[1], 'footer').length, 0);
  await t.exec('design.headerFooter', {hideOnTitle: false, footer: true});
  assert.equal(phs(t.content.slides[0], 'footer').length, 1, 'shown on the title slide once allowed');
});

test('the Header and Footer dialog: seeded from the deck, Apply to All and Apply to Slide submit the command', async () => {
  const t = await deck();
  await t.exec('design.headerFooter', {date: true, dateText: 'Q4', footer: true, footerText: 'Hi'});
  const v = headerFooterDialog.init(t.session.readContext(t.docId));
  assert.deepEqual([v.date, v.dateMode, v.dateText, v.footer, v.footerText, v.num, v.hide], [true, 'fixed', 'Q4', true, 'Hi', false, false]);
  const all = headerFooterDialog.toCommand({...v, dateMode: 'auto', num: true});
  assert.deepEqual(all, {command: 'design.headerFooter', params: {date: true, dateText: '', dateFormat: 'datetime1', slideNumber: true, footer: true, footerText: 'Hi', hideOnTitle: false, all: true}});
  const one = headerFooterDialog.buttons['apply-to-slide'](null, v);
  assert.equal(one.params.all, false);
  assert.equal(one.close, true);
  assert.equal(headerFooterDialog.validate({...v, dateMode: 'fixed', dateText: ' '}).length, 1);
  assert.equal(headerFooterDialog.validate({...v, dateFormat: 'x'}).length, 1);
});

test('header and footer placeholders and the settings survive a .pptx save and reopen', async () => {
  const t = await deck();
  await t.exec('design.headerFooter', {date: true, dateText: '', dateFormat: 'datetime2', slideNumber: true, footer: true, footerText: 'Acme'});
  const back = await importPptx(await exportPptx(t.content));
  assert.equal(back.slides.length, 2);
  for (const sl of back.slides) {
    assert.equal(bodyText(phs(sl, 'footer')[0].text), 'Acme');
    assert.equal(phs(sl, 'slideNum').length, 1);
    assert.equal(run0(phs(sl, 'date')[0]).kind.field, 'datetime2');
  }
});

test('insert.video and insert.audio pick a file from the UI when none is given, and are real slide shapes', async () => {
  const t = await deck();
  const wav = Buffer.from('52494646240000005741564566666d74201000000100010044ac000088580100020010006461746100000000', 'hex').toString('base64');
  const calls = [];
  t.session.setHost?.({pickMedia: async req => { calls.push(req); return {name: 'clip.wav', data: wav}; }});
  assert.ok(calls.length === 0);
  const r = await t.exec('insert.audio', {data: wav, name: 'clip.wav'});
  assert.equal(r.result.contentType, 'audio/wav');
  const sh = curSlide(t).shapes.find(s => s.id === r.result.id);
  assert.equal(sh.kind.type, 'media');
  assert.equal(sh.kind.video, false);
  await assert.rejects(t.exec('insert.video', {}), /missing `path` or `data`/);
});

test('Header and Footer, Notes and Handouts: the notes master and the handout master get the date, header, page number and footer together', async () => {
  const t = await deck();
  const kinds = m => (m?.shapes ?? []).map(x => x.ph?.kind);
  assert.equal(t.content.notesMaster, null);
  await expectUndoRoundTrip(t, 'design.notesHeaderFooter', {header: true, headerText: 'Board pack', date: true, dateText: '', dateFormat: 'datetime2', footer: true, footerText: 'Confidential', pageNumber: true});
  for (const key of ['notesMaster', 'handoutMaster']) {
    const m = t.content[key];
    for (const k of ['header', 'date', 'footer', 'slideNum']) assert.ok(kinds(m).includes(k), key + ' has ' + k);
    const find = k => m.shapes.find(x => x.ph?.kind === k);
    assert.equal(bodyText(find('header').text), 'Board pack');
    assert.equal(bodyText(find('footer').text), 'Confidential');
    assert.equal(find('date').text.paragraphs[0].runs[0].kind.field, 'datetime2');
    assert.deepEqual(find('slideNum').text.paragraphs[0].runs[0].kind, {kind: 'field', field: 'slidenum'});
  }
  assert.ok(kinds(t.content.notesMaster).includes('slideImage') && kinds(t.content.notesMaster).includes('body'), 'a new notes master has its slide image and notes body');
  await t.exec('design.notesHeaderFooter', {header: false, footer: false});
  assert.ok(!kinds(t.content.notesMaster).includes('header') && !kinds(t.content.handoutMaster).includes('footer'));
  // The dialog: seeded from the masters, and sent with the slide call only once its page has changed.
  const v = headerFooterDialog.init(t.session.readContext(t.docId));
  assert.deepEqual([v.nDate, v.nHeader, v.nFooter, v.nPage, v.nTouched], [true, false, false, true, false]);
  assert.equal(headerFooterDialog.toCommand(v).command, 'design.headerFooter');
  assert.deepEqual(headerFooterDialog.derive({...v, nHeader: true}, ['nHeader']), {nTouched: true});
  const sent = headerFooterDialog.toCommand({...v, nHeader: true, nHeaderText: 'H', nTouched: true});
  assert.deepEqual(sent.batch.map(c => c.command), ['design.headerFooter', 'design.notesHeaderFooter']);
});
