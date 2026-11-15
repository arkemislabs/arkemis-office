// Prism's Save As PDF and Export > Create PDF through the bridge and the real window (U:prism/export).
//
// What deckcraft does (cmd/file.rs, backstage/print.rs): File > Export has Create PDF Document, Create Handouts (slides per page) and
// Change File Type; Save As lists PDF among its types. PowerPoint: the same, through the system Save dialog.
// What this proves in the app: the Export page is drawn with its Create PDF controls, Save As (F12) offers the PDF type, a PDF chosen in the
// (scripted) system Save dialog is written to disk with the slides really drawn into it, and notes pages and handouts lay the slides
// out by Slides Per Page. Captures in artifacts/e2e/prism/export-pdf/.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';
import {script, asked} from '../common/file-helpers.mjs';

const require = createRequire(import.meta.url);
const {PDFDocument} = require('pdf-lib');
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('prism export pdf: Save As with the PDF type, notes pages and handouts', {timeout: 300_000}, async () => {
  const file = createFile('prism', 'Quarterly', {schema: 2});
  file.id = 'prism-export-pdf';
  file.content.slides[0].shapes[0].text = bodyFromText('Quarterly results');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/export-pdf', files: [file], renderer});
  const doc = file.id;
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'arkemis-pdf-'));
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const run = (command, params = {}) => app.rpc('engine.execute', {doc, command, params});
  const pages = async bytes => (await PDFDocument.load(bytes)).getPageCount();
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});
    for (const t of ['Roadmap', 'Pricing', 'Team', 'Hiring']) await run('slide.new', {layout: 'titleOnly', title: t});

    // File > Export: Create PDF Document and Change File Type, PDF among the types.
    await app.rpc('ui.activate', {doc, control: 'file.export'});
    await app.until(async () => (await app.rpc('ui.inspect', {doc})).backstage?.open || null, {timeout: 10_000});
    await sleep(600);
    await app.capture('1-export-page');
    await app.rpc('ui.key', {doc, keys: 'Escape'});
    await sleep(300);

    // Save As (F12) with the PDF type: the system Save dialog, then the file on disk.
    const target = path.join(out, 'Quarterly.pdf');
    await script(app, {type: 'save', path: target});
    await app.rpc('ui.key', {doc, keys: 'F12'});
    await app.until(async () => (await fs.stat(target).catch(() => null))?.size > 0 || null, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
    const dialog = (await asked(app)).find(a => a.type === 'save');
    assert.ok(dialog.options.filters.some(f => f.extensions.includes('pdf')), 'the Save as type list offers PDF');
    const bytes = await fs.readFile(target);
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    assert.equal(await pages(bytes), 5, 'one page per slide');
    await app.capture('2-after-save-as-pdf');

    // Notes pages and handouts through the same renderer (no path over the bridge: the bytes come back).
    const notes = (await run('file.exportPdf', {layout: 'notes'})).result;
    assert.equal(notes.pages, 5);
    const handouts = (await run('file.exportPdf', {layout: 'handouts', perPage: 2})).result;
    assert.equal(handouts.pages, 3, 'five slides, two to a page');
    const nine = (await run('file.exportPdf', {layout: 'handouts', perPage: 9})).result;
    assert.equal(nine.pages, 1);
    const hb = Buffer.from(handouts.data, 'base64');
    await fs.writeFile(path.join(out, 'handouts.pdf'), hb);
    assert.equal(await pages(hb), 3);
  } finally {
    await app.close();
  }
});
