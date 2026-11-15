// core/folio/commands/standards.mjs: Verify PDF/A, Save as PDF/A, the PDF/UA and PDF/X checks, Preflight, Output Preview.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. printcraft 0.16.0 (8f16855) crates/ui-egui/src/dialogs/standards_ui.rs: Verify lists the problems with their clause, Save as PDF/A converts then verifies and reports
//    "Fixed what could be fixed; {n} problems remain" or that it conforms; the levels are PDF/A-2b and PDF/A-3b. Acrobat's Save as PDF/A and Preflight work the same way.
// 2. Ours: a document with an embedded font (so only fixable problems remain), verified, converted, and read back with pdf-lib; a pass never says "conforms".
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, PDFString, rgb} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createPdfContent} from '../../core/pdf-document.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';

const N = s => PDFName.of(s);
const FONT = true;

async function pdf({embed = true} = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont('Helvetica');
  const page = doc.addPage([300, 300]);
  page.drawText('Hello', {x: 20, y: 200, size: 12, font, color: rgb(0, 0, 1)});
  const ctx = doc.context;
  page.node.set(N('Annots'), ctx.obj([ctx.register(ctx.obj({Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 60, 30], F: 0, A: {S: 'JavaScript', JS: PDFString.of('app.alert(1)')}}))]));
  doc.setTitle('Report');
  const loaded = await PDFDocument.load(await doc.save({useObjectStreams: false}));
  // A font program stands in for an embedded font: verify reads whether there is one, not what is in it.
  if (embed) for (const [, o] of loaded.context.enumerateIndirectObjects()) if (o.get?.(N('Type'))?.decodeText?.() === 'Font') o.set(N('FontDescriptor'), loaded.context.register(loaded.context.obj({Type: 'FontDescriptor', FontName: 'Helvetica', FontFile2: loaded.context.register(loaded.context.stream(new Uint8Array(16)))})));
  return loaded.save({useObjectStreams: false});
}
const session = async opts => createTestSession('folio', {content: await migrateContent(await createPdfContent(await pdf(opts), 'Report.pdf'))});

test('standards.pdfa.verify lists the problems with their clause and never says the document conforms', async t0 => {
  const t = await session();
  const r = (await t.exec('standards.pdfa.verify', {})).result;
  assert.equal(r.level, 'PDF/A-2b');
  assert.equal(r.ok, false);
  assert.ok(r.issues.some(i => i.clause === '6.6.2.1'));
  assert.ok(r.issues.some(i => /JavaScript action/.test(i.message)));
  assert.match(r.message, /problems found/);
  assert.ok(r.checked.length >= 8 && r.notVerified.length >= 5);
  const three = (await t.exec('standards.pdfa.verify', {level: 'PDF/A-3b'})).result;
  assert.equal(three.level, 'PDF/A-3b');
  await assert.rejects(() => t.exec('standards.pdfa.verify', {level: 'PDF/A-1b'}), /level/);
  void t0;
});

test('standards.pdfa.convert fixes what it can; a passed verify says what was not checked, not that the file conforms; undo restores the file', async t0 => {
  if (!FONT) return t0.skip('no TrueType font to embed here');
  const t = await session();
  const before = t.content.sourceBase64;
  const r = (await t.exec('standards.pdfa.convert', {level: 'PDF/A-2b'})).result;
  assert.equal(r.remaining.length, 0, JSON.stringify(r.remaining));
  assert.match(r.message, /not a statement that it conforms to PDF\/A-2b/);
  assert.ok(r.fixed.some(f => /sRGB output intent/.test(f)));
  const doc = await PDFDocument.load(Buffer.from(t.content.sourceBase64, 'base64'));
  assert.ok(doc.catalog.has(N('OutputIntents')) && doc.catalog.has(N('Metadata')));
  const v = (await t.exec('standards.pdfa.verify', {})).result;
  assert.equal(v.ok, true);
  assert.match(v.message, /not a statement that the document conforms to PDF\/A-2b/);
  assert.deepEqual((await t.exec('standards.read', {})).result.declared, ['PDF/A-2b']);
  await t.exec('standards.pdfa.remove_id', {});
  assert.deepEqual((await t.exec('standards.read', {})).result.declared, []);
  await t.undo(); await t.undo();
  assert.equal(t.content.sourceBase64, before);
});

test('an embedded-font failure stays after Save as PDF/A and is reported as not fixable', async () => {
  const t = await session({embed: false});
  const r = (await t.exec('standards.pdfa.convert', {})).result;
  assert.deepEqual(r.remaining.map(i => i.message), ["The font Helvetica isn't embedded"]);
  assert.equal(r.remaining[0].fixable, false);
  assert.match(r.message, /1 problem remains/);
});

test('preflight profiles: the two PDF/A profiles, the PDF/UA and PDF/X checks, fonts and colour; each says what it did not check', async () => {
  const t = await session({embed: false});
  const profiles = (await t.exec('standards.preflight.profiles', {})).result.profiles.map(p => p.id);
  assert.deepEqual(profiles, ['pdfa-2b', 'pdfa-3b', 'pdfua-1', 'pdfx-4', 'fonts', 'colour']);
  for (const profile of profiles) {
    const r = (await t.exec('standards.preflight', {profile})).result;
    assert.equal(r.profile, profile);
    assert.equal(typeof r.summary, 'string');
    assert.ok(Array.isArray(r.items));
    assert.ok(profile === 'fonts' || profile === 'colour' || r.notVerified.length > 0, profile);
  }
  const fonts = (await t.exec('standards.preflight', {profile: 'fonts'})).result;
  assert.equal(fonts.ok, false);
  assert.match(fonts.items[0].label, /Helvetica/);
  const ua = (await t.exec('standards.pdfua.check', {})).result;
  assert.ok(ua.failed >= 2);
  assert.ok(ua.items.some(i => i.label === 'Tagged PDF, marked as tagged' && i.status === 'failed'));
  assert.ok(ua.notVerified.length >= 5);
  const x = (await t.exec('standards.pdfx.check', {})).result;
  assert.ok(x.failed >= 3);
});

test('output preview: the output intent as the simulation profile, the inks and the colour spaces in use, the warnings', async () => {
  const t = await session({embed: false});
  const before = (await t.exec('standards.output_preview', {})).result;
  assert.equal(before.simulationProfile, 'None (no output intent)');
  assert.ok(before.colorSpaces.some(c => c.name === 'DeviceRGB'));
  assert.ok(before.warnings.some(w => /no output intent/.test(w.message)));
  assert.match(before.note, /not simulated/);
  await t.exec('standards.pdfa.convert', {});
  const after = (await t.exec('standards.output_preview', {})).result;
  assert.equal(after.simulationProfile, 'sRGB IEC61966-2.1');
  assert.equal(after.warnings.some(w => /no output intent/.test(w.message)), false);
  assert.deepEqual(after.declared, ['PDF/A-2b']);
});
