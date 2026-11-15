// Quill (Word) File > Save of a schema-2 document writes a real .docx through
// core/quill/formats/docx-write.mjs, and opening that file gives back the same document.
//   schema-2 document -> Ctrl+S -> Save As (Word Document) -> the .docx on disk is the translated
//   writer's (w14:paraId on every paragraph, the document's styles) and re-reads in the engine with
//   the same paragraphs, list, table and link -> the app opened with the path shows a schema-2 copy
//   with the same text.
// Office: Word's Save writes a .docx that reopens with the same content and formatting.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: File > Save writes the document with wordcraft_docx::write; opening reads it back.
// 2. Ours: the format worker routes schema-2 files to docx-write.mjs / docx-read.mjs (formats-v2).
// 3. This flow (bridge only: no pointer, keyboard or screen capture outside ui.capture).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {documentsFolder, exists, binding, run, script, show, start, vaultCopy, windowOf, now} from '../common/file-helpers.mjs';
import {createContent} from '../../../core/quill/model/content.mjs';
import * as P from '../../../core/quill/model/para.mjs';
import {newTable} from '../../../core/quill/model/table.mjs';
import {addList} from '../../../core/quill/model/numbering.mjs';
import {read as readDocx} from '../../../core/quill/formats/docx-read.mjs';
import JSZip from 'jszip';

function richContent() {
  const c = createContent();
  const h = P.paragraphWithText('Quarterly report'); h.props = {style: 'Heading1'};
  const p = P.paragraphWithText('Revenue grew ');
  P.insertText(p, p.text.length, '12%', {bold: true});
  P.insertText(p, p.text.length, ' — see ', {});
  P.insertText(p, p.text.length, 'the site', {link: 'https://example.com/q3', style: 'Hyperlink'});
  const r = addList(c.numbering, 'bullet'); c.numbering = r.numbering;
  const items = ['North', 'South'].map(t => { const q = P.paragraphWithText(t); q.props = {style: 'ListParagraph', numbering: {num: r.num, level: 0}}; return q; });
  const t = newTable(2, 2, 300);
  [['Region', 'Sales'], ['North', '42']].forEach((row, i) => row.forEach((s, j) => { t.rows[i].cells[j].blocks = [P.paragraphWithText(s)]; }));
  c.body = createContent([h, p, ...items, t, P.paragraphWithText('End.')]).body;
  return c;
}
const parasText = c => c.body.chunks.flat().filter(b => b.kind === 'para').map(P.plainText);

test('quill: File > Save writes a schema-2 document with the translated .docx writer, and it reopens the same', {timeout: 300_000}, async () => {
  const folder = await documentsFolder('quill-formats-docx');
  const content = richContent();
  const seed = {id: randomUUID(), schema: 2, kind: 'quill', title: 'Report', createdAt: now, updatedAt: now, revision: 0, starred: false, content, links: []};
  const target = path.join(folder, 'Report.docx');
  let app = await start('quill', 'formats-docx-save', {files: [seed]});
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
    const xml = await (await JSZip.loadAsync(bytes)).file('word/document.xml').async('string');
    assert.match(xml, /w14:paraId="[0-9A-F]{8}"/, 'written by docx-write.mjs (every paragraph carries its id)');
    const back = await readDocx(bytes);
    assert.deepEqual(parasText(back), parasText(content));
    const bl = back.body.chunks.flat();
    assert.equal(bl[0].props.style, 'Heading1');
    assert.ok(bl[2].props.numbering && bl[3].props.numbering, 'list items keep their list');
    assert.equal(bl[4].kind, 'table');
    assert.equal(P.propsOfChar(bl[1], bl[1].text.indexOf('the site')).link, 'https://example.com/q3');
    assert.equal((await windowOf(app, doc)).title, 'Report - Quill');
    await app.capture('saved', {doc});
  }, app);

  app = await start('quill', 'formats-docx-reopen', {args: [target]});
  await run(async () => {
    const d = await app.until(async () => (await app.rpc('documents.list', {})).documents.find(x => x.path === target) || null, {timeout: 30_000});
    await app.until(async () => (await windowOf(app, d.id))?.title === 'Report - Quill' || null, {timeout: 30_000});
    const copy = await vaultCopy(app, d.id);
    assert.equal(copy.schema, 2, 'opened into the schema-2 model');
    assert.deepEqual(parasText(copy.content), parasText(content));
    await show(app, d.id);
    const opened = await app.rpc('documents.open', {doc: d.id, show: true});
    await new Promise(r => setTimeout(r, 1500)); // let the reopened page paint before the capture
    await app.capture('reopened', {window: opened.window});
  }, app);
  await fs.rm(folder, {recursive: true, force: true});
});
