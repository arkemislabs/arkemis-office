// core/folio/lib/standards.mjs: PDF/A verify and convert, the declared standards, removing the identification, the PDF/UA and PDF/X checks.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. printcraft 0.16.0 (8f16855) crates/preflight: verify reports XMP identification, encryption, output intent for device colour, actions, annotations, fonts,
//    LZW and external streams, images and embedded files, one message per kind; convert fixes what it can without changing how pages look (XMP, an sRGB output
//    intent, actions, annotation flags, Interpolate, NeedAppearances) and returns what remains (fonts that are not embedded).
// 2. Ours runs both on PDFs made with pdf-lib and reads the converted file back.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, PDFString, StandardFonts, rgb} from 'pdf-lib';
import * as S from '../../core/folio/lib/standards.mjs';
import * as A from '../../core/folio/lib/a11y.mjs';

const N = s => PDFName.of(s);
async function sample() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 300]);
  page.drawText('Hello', {x: 20, y: 200, size: 12, font, color: rgb(1, 0, 0)});
  const ctx = doc.context;
  const link = ctx.register(ctx.obj({Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 60, 30], F: 0, A: {S: 'JavaScript', JS: PDFString.of('app.alert(1)')}}));
  const sound = ctx.register(ctx.obj({Type: 'Annot', Subtype: 'Sound', Rect: [10, 40, 60, 60], F: 4}));
  page.node.set(N('Annots'), ctx.obj([link, sound]));
  doc.catalog.set(N('OpenAction'), ctx.obj({S: 'Launch', F: PDFString.of('x.exe')}));
  doc.setTitle('Quarterly figures');
  return PDFDocument.load(await doc.save({useObjectStreams: false}));
}
const messages = list => list.map(i => i.message);

test('an unprepared document fails the identification, the output intent, the actions and the annotations, and the fonts', async () => {
  const doc = await sample();
  const issues = S.verify(doc, 'A2b');
  const m = messages(issues);
  assert.ok(m.includes('The document has no XMP metadata'));
  assert.ok(m.includes('Device colour is used, but there is no PDF/A output intent'));
  assert.ok(m.includes("A Launch action isn't allowed"));
  assert.ok(m.includes("A JavaScript action isn't allowed"));
  assert.ok(m.includes("Sound annotations aren't allowed"));
  assert.ok(m.includes("A Link annotation isn't set to print, or is hidden"));
  assert.ok(m.includes("The font Helvetica isn't embedded"));
  assert.equal(issues.find(i => i.message.startsWith('The font')).fixable, false);
  assert.equal(issues.find(i => i.message === 'The document has no XMP metadata').clause, '6.6.2.1');
  assert.equal(S.verify(doc, 'A2b', {encrypted: true}).some(i => i.message === 'The document is encrypted'), true);
});

test('convert fixes what it can and leaves what it cannot: fonts that are not embedded remain, nothing else does', async () => {
  const doc = await sample();
  const r = S.convert(doc, 'A3b');
  assert.ok(r.fixed.includes('Added an sRGB output intent'));
  assert.ok(r.fixed.includes('Identified the file as PDF/A-3b in its XMP metadata'));
  assert.deepEqual(messages(r.remaining), ["The font Helvetica isn't embedded"]);
  const again = await PDFDocument.load(await doc.save({useObjectStreams: false}));
  const d = S.declared(again);
  assert.deepEqual(d.pdfa, {part: 3, conformance: 'B'});
  assert.deepEqual(S.declaredNames(d), ['PDF/A-3b']);
  assert.deepEqual(d.outputIntents, ['sRGB IEC61966-2.1']);
  assert.equal(again.catalog.has(N('OpenAction')), false);
  assert.deepEqual(messages(S.verify(again, 'A3b')), ["The font Helvetica isn't embedded"]);
  assert.ok(messages(S.verify(again, 'A2b')).includes("The metadata doesn't identify the file as PDF/A-2b"), 'a 3b file is not a 2b file');
});

test('the XMP packet keeps the title, and the sRGB profile is a valid ICC header', async () => {
  const doc = await sample();
  const x = S.xmpPacket(doc, 'A2b');
  assert.match(x, /<pdfaid:part>2<\/pdfaid:part>/);
  assert.equal(S.xmpValue(x, 'dc:title'), 'Quarterly figures');
  assert.equal(S.xmpIdentifier(x, S.PDFA_ID, 'conformance'), 'B');
  const icc = S.srgbProfile();
  assert.equal(String.fromCharCode(...icc.slice(36, 40)), 'acsp');
  assert.equal(String.fromCharCode(...icc.slice(16, 20)), 'RGB ');
  assert.equal(new DataView(icc.buffer).getUint32(0), icc.length);
  assert.equal(S.isoDate("D:20261031120000+02'00'"), '2026-10-31T12:00:00+02:00');
  assert.equal(S.levelOf('PDF/A-2b'), 'A2b');
  assert.equal(S.levelOf('PDF/A-1b'), null);
});

test('a title that differs between the XMP and the information is reported; Remove standard id takes the identification out', async () => {
  const doc = await sample();
  S.convert(doc, 'A2b');
  doc.setTitle('Another title');
  doc.context.trailerInfo.Info && doc.context.lookup(doc.context.trailerInfo.Info);
  const again = await PDFDocument.load(await doc.save({useObjectStreams: false}));
  assert.ok(messages(S.verify(again, 'A2b')).includes('The title in the metadata and the document information differ'));
  assert.equal(S.removeStandardId(again, 'pdfa'), true);
  assert.equal(S.declared(again).pdfa, null);
  assert.match(S.metadataText(again), /<dc:title>/, 'the rest of the packet stays');
});

test('what verify checks and what it does not is stated, so a pass cannot be read as conformance', () => {
  assert.ok(S.PDFA_CHECKED.length >= 8 && S.PDFA_NOT_VERIFIED.length >= 5);
  assert.ok(S.PDFA_NOT_VERIFIED.some(x => /ICC profiles are valid/.test(x)));
  assert.ok(S.PDFUA_NOT_VERIFIED.some(x => /reading order/.test(x)));
  assert.ok(S.PDFX_NOT_VERIFIED.length >= 3);
});

test('the PDF/UA check lists what failed, what passed and what it did not check; it never passes an untagged document', async () => {
  const doc = await sample();
  const report = A.check(doc);
  const r = S.pdfuaCheck(doc, report);
  const by = Object.fromEntries(r.items.map(i => [i.label, i]));
  assert.equal(by['The XMP metadata identifies the file as PDF/UA (pdfuaid:part)'].status, 'failed');
  assert.equal(by['Tagged PDF, marked as tagged'].status, 'failed');
  assert.equal(by['Figures have alternate text'].status, 'passed', 'no figures, nothing to fail');
  assert.ok(r.notVerified.length >= 5);
  assert.ok(r.items.every(i => i.status !== 'passed' || !i.details.length));
});

test('the PDF/X check reads the version, the output intent, the boxes, the fonts and the actions', async () => {
  const doc = await sample();
  const r = S.pdfxCheck(doc);
  const by = Object.fromEntries(r.items.map(i => [i.clause, i]));
  assert.equal(by['6.7'].status, 'failed');
  assert.equal(by['6.2'].status, 'failed');
  assert.equal(by['6.1.2'].status, 'failed');
  assert.equal(by['6.3'].status, 'failed');
  assert.equal(by['6.9'].status, 'failed');
  assert.match(by['6.9'].details[0], /Launch|JavaScript|Sound/);
});
