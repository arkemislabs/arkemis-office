// Prism (PowerPoint): Presentation1 saves to a .pptx through Save As ("PowerPoint Presentation"
// first); AutoSave then writes the file a few seconds after each change, without a dialog.
// Office: AutoSave is off for a presentation that was never saved; once it has a file in the
// PowerPoint format, turning AutoSave on saves every change to that file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {asked, binding, documentsFolder, exists, run, script, show, start, windowOf} from './file-helpers.mjs';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const slideCount = async file => Object.keys((await JSZip.loadAsync(await fs.readFile(file))).files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;

test('prism: Presentation1 to .pptx, then AutoSave writes the file after an edit', {timeout: 300_000}, async () => {
  const folder = await documentsFolder('prism');
  const app = await start('prism', 'file-prism');
  await run(async () => {
    const made = await app.rpc('documents.create', {});
    assert.equal(made.name, 'Presentation1');
    const doc = made.doc;
    await show(app, doc);
    assert.equal((await windowOf(app, doc)).title, 'Presentation1 - Prism');
    // AutoSave can't cover a presentation without a file: the bridge gets Office's reason.
    await assert.rejects(app.rpc('engine.execute', {doc, command: 'file.autosave', params: {value: true}}),
      e => e.code === 'failed' && /Save the document to turn on AutoSave/.test(e.message));

    const target = path.join(folder, 'Presentation1.pptx');
    await script(app, {type: 'save', path: target});
    await app.rpc('ui.key', {doc, keys: 'Ctrl+S'});
    await app.until(() => exists(target), {timeout: 30_000});
    const dialog = (await asked(app)).find(a => a.type === 'save');
    assert.equal(dialog.options.filters[0].name, 'PowerPoint Presentation (*.pptx)');
    const slidesBefore = await slideCount(target);

    await app.rpc('engine.execute', {doc, command: 'file.autosave', params: {value: true}});
    await app.until(async () => (await binding(app, doc))?.autosave === true || null);
    const stamp = (await fs.stat(target)).mtimeMs;
    await script(app);
    await app.rpc('engine.execute', {doc, command: 'slide.new', params: {}});
    // AutoSave waits a moment after the last change, then writes the presentation's own file.
    await app.until(async () => (await fs.stat(target)).mtimeMs > stamp || null, {timeout: 20_000});
    await app.until(async () => (await slideCount(target)) === slidesBefore + 1 || null, {timeout: 10_000});
    assert.deepEqual((await asked(app)).filter(a => a.type === 'save'), [], 'AutoSave never asks');
    const ui = await app.rpc('ui.inspect', {doc});
    assert.equal(ui.doc.dirty, false, 'everything is in the file');
    await app.capture('autosaved');
  }, app);
  await fs.rm(folder, {recursive: true, force: true});
});
