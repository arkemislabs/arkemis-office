// The accessibility commands the first test file reaches only through other commands: a11y.rules, a11y.find_untagged, a11y.reading_options, a11y.reading_options.apply,
// a11y.reading_order, a11y.alt_text.apply and a11y.autotag_fields, each run in a session on a real PDF and read back with pdf-lib.
//
// Behaviour fidelity (docs/behaviour-fidelity.md): printcraft 0.16.0 (8f16855) crates/ui-egui/src/workflows/a11y_ui.rs (find_untagged_content runs the three tagging rules; the
// Fix for language and title goes through the reading options; Save & Close sets the alternate text of the figures that changed) and crates/a11y (autotag_fields: a Form element
// for each untagged widget). Acrobat's Accessibility tool behaves the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, StandardFonts} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createPdfContent} from '../../core/pdf-document.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';

const N = s => PDFName.of(s);
async function build({form = false, figure = false} = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 300]);
  page.drawText('Hello accessible world', {x: 20, y: 250, size: 12, font});
  page.drawText('Second paragraph', {x: 20, y: 200, size: 12, font});
  if (form) {
    const f = doc.getForm();
    f.createTextField('name').addToPage(page, {x: 20, y: 150, width: 120, height: 20});
    f.createTextField('city').addToPage(page, {x: 20, y: 100, width: 120, height: 20});
  }
  if (figure) {
    const ctx = doc.context;
    const root = ctx.nextRef(), docEl = ctx.nextRef();
    const fig = ctx.register(ctx.obj({Type: 'StructElem', S: 'Figure', P: docEl, Pg: page.ref, K: 0}));
    ctx.assign(docEl, ctx.obj({Type: 'StructElem', S: 'Document', P: root, K: [fig]}));
    ctx.assign(root, ctx.obj({Type: 'StructTreeRoot', K: docEl}));
    doc.catalog.set(N('StructTreeRoot'), root);
  }
  return doc.save({useObjectStreams: false});
}
const session = async opts => createTestSession('folio', {content: await migrateContent(await createPdfContent(await build(opts), 'Annual report.pdf'))});
const source = async t => PDFDocument.load(Buffer.from(t.content.sourceBase64, 'base64'));

test('a11y.rules lists the 32 rules with their category, wording and explanation, the manual ones, and the rules that have a fix', async () => {
  const t = await session();
  const r = (await t.exec('a11y.rules', {})).result;
  assert.equal(r.rules.length, 32);
  assert.deepEqual([...new Set(r.rules.map(x => x.category))], ['Document', 'Page Content', 'Forms', 'Alternate Text', 'Tables', 'Lists', 'Headings']);
  assert.deepEqual(r.rules.filter(x => x.manual).map(x => x.id), ['logical-reading-order', 'color-contrast', 'screen-flicker', 'scripts', 'timed-responses', 'navigation-links']);
  assert.equal(r.rules.find(x => x.id === 'color-contrast').onByDefault, false);
  assert.ok(r.rules.every(x => x.name && x.description && x.explanation.length > 20));
  assert.deepEqual(r.fixable, ['primary-language', 'title', 'tab-order']);
});

test('a11y.find_untagged runs only the three tagging rules, opens the checker panel and says how many problems it found; after tagging it finds none', async () => {
  const t = await session();
  const r = (await t.exec('a11y.find_untagged', {})).result;
  assert.deepEqual(r.rules.map(x => x.rule), ['tagged-content', 'tagged-annotations', 'tagged-form-fields']);
  assert.equal(r.failed, 1);
  assert.equal(r.message, 'Found 1 untagged content problems.');
  assert.equal(t.session.get(t.docId).view.rightPanel, 'accessibility');
  assert.equal((await t.exec('a11y.read', {})).result.rules.filter(x => x.status !== 'skipped').length, 29 - 26, 'the other rules were not run');
  await t.exec('a11y.autotag', {});
  const again = (await t.exec('a11y.find_untagged', {})).result;
  assert.equal(again.failed, 0);
  assert.equal(again.message, 'No untagged content was found.');
});

test('a11y.reading_options: without params it reports the language, title and title bar; with params it sets them in one undo step and refuses a bad language', async () => {
  const t = await session();
  const before = (await t.exec('a11y.reading_options', {})).result.options;
  assert.deepEqual(before, {language: '', title: '', displayTitle: false, tabOrder: false});
  const r = (await t.exec('a11y.reading_options', {language: 'de-DE', title: 'Jahresbericht', displayTitle: true, tabOrder: true})).result;
  assert.deepEqual(r.changed.slice(0, 3), ['language', 'title', 'displayTitle']);
  const doc = await source(t);
  assert.equal(doc.catalog.lookup(N('Lang')).decodeText(), 'de-DE');
  assert.equal(doc.getTitle(), 'Jahresbericht');
  assert.equal((await t.exec('a11y.reading_options', {})).result.options.displayTitle, true);
  await assert.rejects(() => t.exec('a11y.reading_options', {language: 'not a language'}), /language/);
  await t.undo();
  assert.equal((await source(t)).catalog.has(N('Lang')), false);
});

test('a11y.reading_options.apply is the dialog\'s command: the same settings, blank values removing the language and the title', async () => {
  const t = await session();
  await t.exec('a11y.reading_options.apply', {language: 'fr-FR', title: 'Rapport', displayTitle: true, tabOrder: false});
  let doc = await source(t);
  assert.equal(doc.catalog.lookup(N('Lang')).decodeText(), 'fr-FR');
  assert.equal(doc.getTitle(), 'Rapport');
  const check = (await t.exec('a11y.check', {rules: ['primary-language', 'title']})).result;
  assert.equal(check.failed, 0);
  await t.exec('a11y.reading_options.apply', {language: '', title: ''});
  doc = await source(t);
  assert.equal(doc.catalog.has(N('Lang')), false);
  assert.equal(doc.getTitle(), undefined);
});

test('a11y.reading_order opens the Tags panel, where tags move', async () => {
  const t = await session();
  await t.exec('a11y.autotag', {});
  t.session.get(t.docId);
  const r = (await t.exec('a11y.reading_order', {})).result;
  assert.equal(r.panel, 'tags');
  assert.match(r.message, /Move up and Move down/);
  assert.equal(t.session.get(t.docId).view.rightPanel, 'tags');
  const tags = (await t.exec('tags.list', {})).result.tags.filter(x => x.kind === 'P');
  await t.exec('tags.move', {object: tags[1].object, anchor: tags[0].object, placement: 'before'});
});

test('a11y.alt_text.apply sets the text of the figures that changed and marks decorative ones in one undo step', async () => {
  const t = await session({figure: true});
  const figure = (await t.exec('a11y.alt_text', {})).result.figures[0];
  const r = (await t.exec('a11y.alt_text.apply', {items: [{object: figure.object, alt: 'A bar chart of sales'}]})).result;
  assert.equal(r.alts, 1);
  assert.equal(r.decorative, 0);
  assert.equal((await t.exec('a11y.alt_text', {})).result.figures[0].alt, 'A bar chart of sales');
  assert.equal((await t.exec('a11y.check', {rules: ['figures-alt-text']})).result.failed, 0);
  const none = (await t.exec('a11y.alt_text.apply', {items: []})).result;
  assert.equal(none.alts, 0);
  await t.undo();
  await t.undo();
  assert.equal((await t.exec('a11y.alt_text', {})).result.figures[0].alt, null);
});

test('a11y.autotag_fields makes a Form element for each untagged field, opens the Tags panel, and refuses a document with no form', async () => {
  const t = await session({form: true});
  assert.equal((await t.exec('a11y.check', {rules: ['tagged-form-fields']})).result.failed, 1);
  const r = (await t.exec('a11y.autotag_fields', {})).result;
  assert.equal(r.tagged, 2);
  assert.equal(r.message, 'Tagged 2 form fields.');
  assert.equal(t.session.get(t.docId).view.rightPanel, 'tags');
  assert.equal((await t.exec('tags.list', {})).result.tags.filter(x => x.kind === 'Form').length, 2);
  assert.equal((await t.exec('a11y.check', {rules: ['tagged-form-fields']})).result.failed, 0);
  await assert.rejects(() => t.exec('a11y.autotag_fields', {}), /no untagged page widgets/);
  const plain = await session();
  await assert.rejects(() => plain.exec('a11y.autotag_fields', {}), /no AcroForm fields/);
});
