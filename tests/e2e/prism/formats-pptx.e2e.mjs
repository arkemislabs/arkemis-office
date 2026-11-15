// Prism (PowerPoint) File > Save of a schema-2 presentation writes a real .pptx through
// core/prism/formats/pptx-write.mjs, and opening that file gives back the same presentation.
//   schema-2 deck -> Ctrl+S -> Save As (PowerPoint Presentation) -> the .pptx on disk is the
//   translated writer's (masters, layouts, theme, slides, notes, transitions in mc:AlternateContent,
//   the timing tree) and re-reads in the engine with the same slides -> the app opened with the path
//   shows a schema-2 copy with the same slides.
// Office: PowerPoint's Save writes a .pptx that reopens with the same content and formatting.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: File > Save writes the deck with deckcraft_pptx::export (write.rs); Open reads it with
//    import_checked (read.rs).
// 2. Ours: the format worker routes schema-2 Prism files to pptx-write.mjs / pptx-read.mjs (formats-v2).
// 3. This flow (bridge only: no pointer, keyboard or screen capture outside ui.capture).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import JSZip from 'jszip';
import {documentsFolder, exists, binding, run, script, show, start, vaultCopy, windowOf, now} from '../common/file-helpers.mjs';
import {importPptx} from '../../../core/prism/formats/pptx-read.mjs';
import {richDeck} from '../../prism/formats-pptx-fixtures.mjs';

const slideTexts = c => c.slides.map(s => s.shapes.map(sh => (sh.text?.paragraphs ?? []).map(p => (p.runs ?? []).map(r => r.text).join('')).join('\n')));

test('prism: File > Save writes a schema-2 deck with the translated .pptx writer, and it reopens the same', {timeout: 300_000}, async () => {
  const folder = await documentsFolder('prism-formats-pptx');
  const content = richDeck();
  const seed = {id: randomUUID(), schema: 2, kind: 'prism', title: 'Review', createdAt: now, updatedAt: now, revision: 0, starred: false, content, links: []};
  const target = path.join(folder, 'Review.pptx');
  let app = await start('prism', 'formats-pptx-save', {files: [seed]});
  await run(async () => {
    const doc = seed.id;
    await show(app, doc);
    await app.capture('before-save', {doc});
    await script(app, {type: 'save', path: target});
    const key = await app.rpc('ui.key', {doc, keys: 'Ctrl+S'});
    assert.equal(key.command, 'file.save');
    await app.until(() => exists(target), {timeout: 30_000});
    await app.until(async () => (await binding(app, doc))?.path === target || null, {timeout: 30_000});
    const bytes = new Uint8Array(await fs.readFile(target));
    const zip = await JSZip.loadAsync(bytes);
    const slide2 = await zip.file('ppt/slides/slide2.xml').async('string');
    assert.match(slide2, /<mc:AlternateContent[^>]*><mc:Choice[^>]*><p:transition spd="slow" p14:dur="1000" advTm="3000"><p:push dir="l"\/>/, 'transition written by pptx-write.mjs');
    assert.match(slide2, /<p:timing>.*nodeType="mainSeq"/s, 'the animation timing tree');
    assert.ok(zip.file('ppt/notesSlides/notesSlide1.xml'), 'speaker notes');
    assert.equal(await zip.file('docProps/app.xml').async('string').then(s => /<Application>Arkemis Prism<\/Application>/.test(s)), true);
    const back = await importPptx(bytes);
    assert.deepEqual(slideTexts(back), slideTexts(content));
    assert.equal((await windowOf(app, doc)).title, 'Review - Prism');
    await app.capture('saved', {doc});
  }, app);

  app = await start('prism', 'formats-pptx-reopen', {args: [target]});
  await run(async () => {
    const d = await app.until(async () => (await app.rpc('documents.list', {})).documents.find(x => x.path === target) || null, {timeout: 30_000});
    await app.until(async () => (await windowOf(app, d.id))?.title === 'Review - Prism' || null, {timeout: 30_000});
    const copy = await vaultCopy(app, d.id);
    assert.equal(copy.schema, 2, 'opened into the schema-2 model');
    assert.deepEqual(slideTexts(copy.content), slideTexts(content));
    assert.equal(copy.content.slides[1].transition.kind, 'push');
    await show(app, d.id);
    const opened = await app.rpc('documents.open', {doc: d.id, show: true});
    await new Promise(r => setTimeout(r, 1500)); // let the reopened page paint before the capture
    await app.capture('reopened', {window: opened.window});
  }, app);
  await fs.rm(folder, {recursive: true, force: true});
});
