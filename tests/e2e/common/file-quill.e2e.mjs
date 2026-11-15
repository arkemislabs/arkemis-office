// Quill (Word): a document is a real .docx file.
//   new document -> Ctrl+S -> the system Save As dialog (Word Document first) -> the file exists on
//   disk with the document's text -> the title shows the file name -> Recent lists the real path ->
//   a change -> closing asks "Do you want to save changes to ...?" -> Cancel keeps the window ->
//   Save writes the file and closes -> the app opened with the path on its command line shows the
//   same text. Also: a blank document is Document1 and Save As suggests Document1.docx.
// Office: Word's first save of a document opens Save As with "Word Document (*.docx)"; Ctrl+S then
// writes the same file; closing with changes asks Save / Don't Save / Cancel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {asked, binding, documentsFolder, edit, exists, fileOf, press, run, savePrompt, script, show, start, state, vaultCopy, windowOf} from './file-helpers.mjs';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const texts = node => (node?.text ? [node.text] : []).concat(...(node?.content ?? []).map(texts));
/** Paragraph text of a Quill document in either schema: 1 (ProseMirror `doc`) or 2 (`body.chunks`, which a file is migrated to when it opens). */
const docTexts = content => content?.body?.chunks
  ? content.body.chunks.flat().filter(b => b.kind === 'para').map(p => p.text).filter(Boolean)
  : texts(content?.doc);

test('quill: save a new document to a .docx through the Save As dialog, close with changes, reopen from the path', {timeout: 300_000}, async () => {
  const folder = await documentsFolder('quill');
  const seed = fileOf('quill', 'Letter', {doc: {type: 'doc', content: [
    {type: 'paragraph', content: [{type: 'text', text: 'Typed in Quill and saved to a real file.'}]}]}});
  const target = path.join(folder, 'Letter.docx');
  let app = await start('quill', 'file-quill', {files: [seed]});
  await run(async () => {
    const doc = seed.id;
    await show(app, doc);
    assert.equal((await binding(app, doc)).path, null, 'not saved yet: no file');

    // Ctrl+S on a document without a file: the Save As dialog, Word Document first.
    await script(app, {type: 'save', path: target});
    const key = await app.rpc('ui.key', {doc, keys: 'Ctrl+S'});
    assert.equal(key.command, 'file.save');
    await app.until(() => exists(target), {timeout: 30_000});
    const [dialog] = (await asked(app)).filter(a => a.type === 'save');
    assert.equal(dialog.options.title, 'Save As');
    assert.equal(dialog.options.filters[0].name, 'Word Document (*.docx)');
    assert.deepEqual(dialog.options.filters[0].extensions, ['docx']);
    assert.equal(path.basename(dialog.options.defaultPath), 'Letter.docx');
    const xml = await (await JSZip.loadAsync(await fs.readFile(target))).file('word/document.xml').async('string');
    assert.match(xml, /Typed in Quill and saved to a real file\./);
    await app.until(async () => (await binding(app, doc))?.path === target || null);
    assert.equal((await windowOf(app, doc)).title, 'Letter - Quill');
    const list = await app.rpc('documents.list', {});
    assert.equal(list.recent[0].path, target, 'Recent lists the real path');
    await app.capture('saved');
    // File > Open: Recent with the real file, Browse = the system Open dialog.
    await app.rpc('ui.activate', {doc, control: 'file.open'});
    await app.until(async () => (await app.rpc('ui.inspect', {doc})).backstage?.open !== false || null, {timeout: 5000}).catch(() => null);
    await app.capture('file-open');
    await app.rpc('ui.key', {doc, keys: 'Escape'});

    // Ctrl+S again writes the same file without asking.
    await edit(app, doc);
    await script(app);
    const before = (await fs.stat(target)).mtimeMs;
    await app.rpc('ui.key', {doc, keys: 'Ctrl+S'});
    await app.until(async () => (await fs.stat(target)).mtimeMs > before || null, {timeout: 20_000});
    assert.deepEqual((await asked(app)).filter(a => a.type === 'save'), [], 'no dialog the second time');

    // A blank document: Document1, Save As suggests Document1.docx; Cancel writes nothing.
    const made = await app.rpc('documents.create', {});
    assert.equal(made.name, 'Document1');
    await show(app, made.doc);
    assert.equal((await windowOf(app, made.doc)).title, 'Document1 - Quill');
    await script(app, {type: 'save', cancel: true});
    await app.rpc('ui.key', {doc: made.doc, keys: 'Ctrl+S'});
    await app.until(async () => (await asked(app)).some(a => a.type === 'save') || null);
    assert.equal(path.basename((await asked(app)).find(a => a.type === 'save').options.defaultPath), 'Document1.docx');
    assert.equal((await binding(app, made.doc)).path, null);

    // A change, then close: the Save Changes prompt. Cancel keeps the window; Save writes and closes.
    await edit(app, doc, 'before closing');
    await app.rpc('test.window.close', {doc});
    const prompt = await savePrompt(app, doc);
    assert.match(JSON.stringify(prompt.values ?? {}), /Do you want to save changes to “Letter”\?/);
    await app.capture('save-changes');
    await app.rpc('ui.dialog.cancel', {doc});
    await app.until(async () => !(await state(app)).windows.find(w => w.docs.includes(doc))?.asking || null);
    assert.ok(await windowOf(app, doc), 'Cancel keeps the window');
    const beforeClose = (await fs.stat(target)).mtimeMs;
    await app.rpc('test.window.close', {doc});
    await savePrompt(app, doc);
    await press(app, doc, 'save');
    await app.until(async () => !(await windowOf(app, doc)) || null, {timeout: 20_000});
    assert.ok((await fs.stat(target)).mtimeMs > beforeClose, 'Save wrote the file before closing');
  }, app);

  // Reopen: the path on the command line (as Explorer opens a .docx) opens it in its window.
  app = await start('quill', 'file-quill-reopen', {args: [target]});
  await run(async () => {
    const docs = await app.until(async () => (await app.rpc('documents.list', {})).documents.find(d => d.path === target) || null, {timeout: 30_000});
    await app.until(async () => (await windowOf(app, docs.id))?.title === 'Letter - Quill' || null, {timeout: 30_000});
    const copy = await vaultCopy(app, docs.id);
    assert.deepEqual(docTexts(copy.content), ['Typed in Quill and saved to a real file.']);
    await app.capture('reopened');
  }, app);
  await fs.rm(folder, {recursive: true, force: true});
});
