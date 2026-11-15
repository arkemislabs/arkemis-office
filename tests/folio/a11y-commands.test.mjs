// core/folio/commands/a11y.mjs: Check for accessibility, the report, Automatically tag PDF, reading options, alternate text, Make accessible, tag editing.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. printcraft 0.16.0 (8f16855) crates/ui-egui/src/workflows/a11y_ui.rs: the check keeps its results for the panel, rules skipped by hand stay skipped, the report is
//    "<name> Accessibility Report.html", Fix sets the language/title/tab order. Acrobat's Accessibility Checker works the same way.
// 2. Ours runs the commands in a session on real PDFs and reads the written source back with pdf-lib.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, StandardFonts} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createPdfContent} from '../../core/pdf-document.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';
import {itemsOf} from '../../core/folio/dialogs/alt-text.mjs';
import accessibilityOptions from '../../core/folio/dialogs/accessibility-options.mjs';

const N = s => PDFName.of(s);
async function pdf({tagged = false} = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 300]);
  page.drawText('Hello accessible world', {x: 20, y: 250, size: 12, font});
  page.drawText('Second paragraph', {x: 20, y: 200, size: 12, font});
  if (tagged) {
    const ctx = doc.context;
    const root = ctx.nextRef(), docEl = ctx.nextRef();
    const fig = ctx.register(ctx.obj({Type: 'StructElem', S: 'Figure', P: docEl, Pg: page.ref, K: 0}));
    ctx.assign(docEl, ctx.obj({Type: 'StructElem', S: 'Document', P: root, K: [fig]}));
    ctx.assign(root, ctx.obj({Type: 'StructTreeRoot', K: docEl}));
    doc.catalog.set(N('StructTreeRoot'), root);
  }
  return doc.save({useObjectStreams: false});
}
const session = async opts => createTestSession('folio', {content: await migrateContent(await createPdfContent(await pdf(opts), 'Annual report.pdf'))});
const source = async t => PDFDocument.load(Buffer.from(t.content.sourceBase64, 'base64'));

test('a11y.check runs the rules, keeps the results for the panel, opens the panel and says which rules need a person', async () => {
  const t = await session();
  const r = (await t.exec('a11y.check', {})).result;
  assert.ok(r.failed >= 3 && r.manual === 5, JSON.stringify({failed: r.failed, manual: r.manual}));
  assert.equal(r.skipped, 1, 'colour contrast is off by default');
  assert.equal(r.rules.length, 32);
  const read = (await t.exec('a11y.read', {})).result;
  assert.equal(read.checked, true);
  assert.equal(read.rules.find(x => x.rule === 'tagged-pdf').status, 'failed');
  assert.equal(t.session.get(t.docId).view.rightPanel, 'accessibility');
  assert.equal((await t.exec('a11y.read', {})).result.failed, r.failed);
});

test('a11y.check with chosen rules and pages skips the others; a rule skipped by hand stays skipped when checking again', async () => {
  const t = await session();
  const r = (await t.exec('a11y.check', {rules: ['title', 'primary-language'], pages: [0]})).result;
  assert.equal(r.skipped, 30);
  assert.equal(r.failed, 2);
  await t.exec('a11y.skip', {rule: 'title'});
  const again = (await t.exec('a11y.check', {rules: ['title', 'primary-language']})).result;
  assert.equal(again.rules.find(x => x.rule === 'title').status, 'skipped');
  assert.equal(again.failed, 1);
  const read = (await t.exec('a11y.read', {})).result;
  assert.ok(read.checked);
});

test('a11y.fix: Title and Tab order fix themselves, Primary language needs a language; the checker runs again', async () => {
  const t = await session();
  await t.exec('a11y.check', {rules: ['title', 'primary-language', 'tab-order']});
  await assert.rejects(() => t.exec('a11y.fix', {rule: 'primary-language'}), /language/);
  await t.exec('a11y.fix', {rule: 'primary-language', language: 'en-GB'});
  await t.exec('a11y.fix', {rule: 'title'});
  const doc = await source(t);
  assert.equal(doc.catalog.lookup(N('Lang')).decodeText(), 'en-GB');
  assert.equal(doc.getTitle(), 'Annual report', 'the title is the file name when the document has none');
  const read = (await t.exec('a11y.read', {})).result;
  assert.equal(read.rules.find(x => x.rule === 'primary-language').status, 'passed');
  assert.equal(read.rules.find(x => x.rule === 'title').status, 'passed');
});

test('a11y.report writes "<name> Accessibility Report.html" for the last check, checking first when there is none', async () => {
  const t = await session();
  const r = (await t.exec('a11y.report', {})).result;
  assert.equal(r.name, 'Annual report Accessibility Report.html');
  const html = Buffer.from(r.base64, 'base64').toString('utf8');
  assert.match(html, /Annual report\.pdf/);
  assert.match(html, /Tagged PDF/);
  assert.equal((await t.exec('a11y.read', {})).result.checked, true);
});

test('a11y.autotag then Tagged PDF passes; a second run refuses; undo takes the tags away', async () => {
  const t = await session();
  const r = (await t.exec('a11y.autotag', {})).result;
  assert.equal(r.paragraphs, 2);
  assert.match(r.message, /Tagged 2 paragraphs on 1 pages/);
  assert.equal((await source(t)).catalog.has(N('StructTreeRoot')), true);
  await assert.rejects(() => t.exec('a11y.autotag', {}), /already has a structure tree/);
  const check = (await t.exec('a11y.check', {rules: ['tagged-pdf', 'tagged-content']})).result;
  assert.equal(check.failed, 0, 'tagged and all content tagged');
  assert.equal(check.rules.find(x => x.rule === 'tagged-content').status, 'passed');
  await t.undo();
  assert.equal((await source(t)).catalog.has(N('StructTreeRoot')), false);
});

test('alternate text: the figure list, items set the text and mark decorative, a blank list changes nothing', async () => {
  const t = await session({tagged: true});
  const list = (await t.exec('a11y.alt_text', {})).result.figures;
  assert.equal(list.length, 1);
  assert.equal(list[0].alt, null);
  const r = (await t.exec('a11y.alt_text', {items: [{object: list[0].object, alt: 'A chart of sales'}]})).result;
  assert.equal(r.alts, 1);
  assert.equal((await t.exec('a11y.alt_text', {})).result.figures[0].alt, 'A chart of sales');
  const tags = (await t.exec('tags.list', {})).result.tags;
  assert.deepEqual(tags.map(x => x.kind), ['Document', 'Figure']);
  assert.equal((await t.exec('a11y.alt_text', {items: []})).result.alts, 0);
});

test('the Set Alternate Text dialog keeps edits between figures and sends only what changed', async () => {
  const figures = [{object: '5 0', page: 0, alt: 'old'}, {object: '6 0', page: 1, alt: ''}, {object: '7 0', page: 1, alt: 'same'}];
  const v = {figures, index: 0, text: 'new', decorative: false, edits: {}};
  assert.deepEqual(itemsOf({...v}), [{object: '5 0', alt: 'new'}]);
  assert.deepEqual(itemsOf({...v, index: 1, text: '', decorative: true}), [{object: '6 0', decorative: true}]);
  assert.deepEqual(itemsOf({...v, text: 'old', index: 0}), []);
});

test('the options dialog turns its fields into rules and a page range', async () => {
  const t = await session();
  const v = accessibilityOptions.init(t.session.readContext(t.docId));
  assert.equal(v['r-color-contrast'], false);
  assert.match(v.checking, /31 of 32/);
  const off = {...v, 'r-title': false, pages: 'Range', from: 1, to: 1};
  const cmd = accessibilityOptions.toCommand(off);
  assert.equal(cmd.params.rules.includes('title'), false);
  assert.deepEqual(cmd.params.pages, [0]);
  assert.deepEqual(accessibilityOptions.validate({...v, pages: 'Range', from: 3, to: 2, __count: 3}).map(p => p.field), ['to']);
  const cleared = accessibilityOptions.derive({...v, category: 'document'}, ['clearAll']);
  assert.equal(cleared['r-title'], false);
  assert.match(cleared.checking, /24 of 32/);
});

test('Make accessible runs the steps it can, reports the ones it cannot, and never calls the document accessible', async () => {
  const t = await session();
  const r = (await t.exec('a11y.make_accessible', {language: 'fr-FR'})).result;
  const by = Object.fromEntries(r.steps.map(s => [s.step, s]));
  assert.equal(by['Set the document language'].done, true);
  assert.equal(by['Automatically tag PDF'].done, true);
  assert.equal(by['Tag form fields'].done, false);
  assert.match(by['Tag form fields'].reason, /no AcroForm/);
  assert.equal(r.manual, 5, 'the reading order, colour contrast... still need a person');
  assert.match(r.message, /still yours to do/);
  const doc = await source(t);
  assert.equal(doc.catalog.lookup(N('Lang')).decodeText(), 'fr-FR');
});

test('tag editing: tags.set changes a property, tags.move reorders, tags.artifact refuses a tag with children', async () => {
  const t = await session();
  await t.exec('a11y.autotag', {});
  const tags = (await t.exec('tags.list', {})).result.tags;
  const [p1, p2] = tags.filter(x => x.kind === 'P');
  await t.exec('tags.set', {object: p1.object, property: 'title', value: 'Greeting'});
  assert.equal((await t.exec('tags.list', {})).result.tags.find(x => x.object === p1.object).title, 'Greeting');
  await t.exec('tags.move', {object: p2.object, anchor: p1.object, placement: 'before'});
  assert.deepEqual((await t.exec('tags.list', {})).result.tags.filter(x => x.kind === 'P').map(x => x.object), [p2.object, p1.object]);
  const doc = tags.find(x => x.kind === 'Document');
  await assert.rejects(() => t.exec('tags.artifact', {object: doc.object}), /child structure elements|no direct marked content/);
  await t.exec('tags.artifact', {object: p1.object});
  assert.equal((await t.exec('tags.list', {})).result.tags.filter(x => x.kind === 'P').length, 1, 'the artifact left the tags');
});
