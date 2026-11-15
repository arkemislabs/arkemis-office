// Links to a page of the document: edit.link with `gotoPage`, the Link Properties dialog's "Go to a page" action, and the file written for it.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. printcraft 0.16.0 (8f16855) crates/ui-egui/src/tools/link_ui.rs (the link's target: a web address or a page) and crates/annot/src/links.rs (a GoTo action whose
//    destination is the page): the link opens the page it names. Acrobat's Link Properties > Link Action > Go to a page view works the same way.
// 2. Ours writes the link, saves, and reads the destination back with pdf-lib; a page that is later deleted leaves a link with no action instead of a dangling one.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, PDFDict, PDFArray, PDFRef} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {writeFolioPdf} from '../../core/folio/model/pdf-write.mjs';
import linkDialog, {valuesToParams} from '../../core/folio/dialogs/link-properties.mjs';

const N = s => PDFName.of(s);
const linkOf = (doc, page) => {
  const annots = doc.getPage(page).node.lookup(N('Annots'), PDFArray);
  for (const r of annots.asArray()) { const d = doc.context.lookup(r); if (d instanceof PDFDict && d.get(N('Subtype'))?.decodeText?.() === 'Link') return d; }
  return null;
};

test('a link to page 2 is written as a GoTo action whose destination is that page, and lists as a page link', async () => {
  const t = await createTestSession('folio', {fixture: 'textPages'});
  const r = (await t.exec('edit.link', {page: t.content.pages[0].id, rect: [72, 100, 172, 120], gotoPage: 1})).result;
  assert.equal(r.goto, t.content.pages[1].id);
  const list = (await t.exec('edit.links', {page: t.content.pages[0].id})).result.links;
  assert.equal(list.length, 1);
  assert.equal(list[0].goto, t.content.pages[1].id);
  assert.equal(list[0].uri, null);
  const doc = await PDFDocument.load(await writeFolioPdf(t.content));
  const link = linkOf(doc, 0);
  const a = link.lookup(N('A'), PDFDict);
  assert.equal(a.get(N('S')).decodeText(), 'GoTo');
  const d = a.lookup(N('D'), PDFArray);
  const target = d.get(0);
  assert.ok(target instanceof PDFRef);
  assert.equal(`${target.objectNumber} ${target.generationNumber}`, `${doc.getPage(1).ref.objectNumber} ${doc.getPage(1).ref.generationNumber}`);
  assert.equal(d.lookup(1, PDFName).decodeText(), 'Fit');
});

test('edit.link refuses a page that is not there; edit.link_change turns a web link into a page link', async () => {
  const t = await createTestSession('folio', {fixture: 'textPages'});
  const page = t.content.pages[0].id;
  await assert.rejects(() => t.exec('edit.link', {page, rect: [72, 100, 172, 120], gotoPage: 7}), /page 8 does not exist/);
  const web = (await t.exec('edit.link', {page, rect: [72, 100, 172, 120], uri: 'https://example.com'})).result;
  await t.exec('edit.link_change', {page, id: web.id, change: 'set', gotoPage: 1});
  const link = (await t.exec('edit.links', {page})).result.links[0];
  assert.equal(link.goto, t.content.pages[1].id);
  assert.equal(link.uri, null);
});

test('deleting the page a link goes to leaves a link with no action, not a dangling one', async () => {
  const t = await createTestSession('folio', {fixture: 'textPages'});
  await t.exec('edit.link', {page: t.content.pages[0].id, rect: [72, 100, 172, 120], gotoPage: 1});
  await t.exec('page.delete', {pages: [1]});
  const doc = await PDFDocument.load(await writeFolioPdf(t.content));
  assert.equal(doc.getPageCount(), 1);
  assert.equal(linkOf(doc, 0).has(N('A')), false);
});

test('the Link Properties dialog: "Go to a page" takes a page from 1 to the page count and gives gotoPage; the web action still needs its address', () => {
  const v = linkDialog.init({doc: {pages: [{}, {}, {}]}});
  assert.equal(v.action, 'Open a web page');
  assert.equal(v.__count, 3);
  assert.deepEqual(linkDialog.validate(v).map(p => p.field), ['url']);
  const go = {...v, action: 'Go to a page', page: 3};
  assert.deepEqual(linkDialog.validate(go), []);
  assert.deepEqual(linkDialog.validate({...go, page: 4}).map(p => p.field), ['page']);
  assert.equal(valuesToParams(go).gotoPage, 2);
  assert.equal(valuesToParams(go).uri, undefined);
  assert.equal(valuesToParams({...v, url: ' https://a.b '}).uri, 'https://a.b');
});
