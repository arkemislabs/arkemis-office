// Prism's gate (docs/architecture.md 17.5), the flows the other Prism suites don't already cover:
// a title typed into the first slide's placeholder (a click, then typing), Save As (F12, the system
// Save dialog answered by the test-mode script) to .pptx, reopened from its path with its slide and
// text (PDF joins once its writer has a slide renderer in the save path), Print, and every address the deck
// lists read back over the bridge. Slides, text, shapes, formatting, Find, the Selection Pane and
// .pptx fidelity are in the other prism suites, the file flow and the dialog sweep.
//
//   npm run build && node --test tests/e2e/prism/gate.e2e.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {documentsFolder, exists, script, asked, show, start, run} from '../common/file-helpers.mjs';

const TITLE = 'Gate check deck';
const textOf = body => (body?.paragraphs ?? []).map(p => (p.runs ?? []).map(r => r.text ?? '').join('')).join('\n');

test('prism gate: type a title, Save As .pptx, reopen it, Print, read back every address', {timeout: 600_000}, async () => {
  const folder = await documentsFolder('prism-gate');
  const app = await start('prism', 'prism-gate');
  await run(async () => {
    const {doc} = await app.rpc('documents.create', {});
    await show(app, doc);
    const slide = (await app.rpc('document.inspect', {doc})).nodes.find(n => n.address.startsWith('/sl:')).address;
    const shapes = (await app.rpc('document.read', {doc, address: slide, as: 'json'})).value.shapes;
    const title = `${slide}/sp:${shapes[0].id}`;
    // A click in the empty title placeholder places the caret (as in prism/text-editing), then typing.
    await app.rpc('ui.pointer', {doc, events: [{kind: 'down', x: 480, y: 200}, {kind: 'up', x: 480, y: 200}]});
    await app.rpc('ui.type', {doc, text: TITLE});
    await app.until(async () => textOf((await app.rpc('document.read', {doc, address: title, as: 'json'})).value.text) === TITLE || null, {timeout: 10_000});
    await app.rpc('ui.key', {doc, keys: 'Escape'});

    const saved = {};
    for (const ext of ['pptx']) {
      const target = path.join(folder, `Gate.${ext}`);
      await fs.rm(target, {force: true});
      await script(app, {type: 'save', path: target});
      const key = await app.rpc('ui.key', {doc, keys: 'F12'});
      assert.equal(key.command, 'file.saveAs', 'F12 is Save As');
      await app.until(() => exists(target), {timeout: 30_000});
      assert.ok((await asked(app)).some(a => a.type === 'save'), `${ext}: the system Save As dialog was asked`);
      saved[ext] = target;
    }

    // Reopen the .pptx from its path: the slide and its title come back.
    const r = await app.rpc('documents.open', {path: saved.pptx, show: false});
    const id = r.doc ?? r.id;
    const slides = (await app.rpc('document.inspect', {doc: id})).nodes.filter(n => n.address.startsWith('/sl:'));
    assert.equal(slides.length, 1, 'one slide');
    const back = (await app.rpc('document.read', {doc: id, address: slides[0].address, as: 'json'})).value;
    assert.ok(back.shapes.some(sh => textOf(sh.text) === TITLE), 'the title survives the round trip');

    // Print: File > Print's command, through the print path (the test-mode script answers it).
    await script(app);
    await app.rpc('engine.execute', {doc, command: 'file.print', params: {copies: 1}}).catch(e => { if (e.code !== 'approval_required') throw e; });
    await app.capture('after-print');

    // Bridge read-back: every address the deck lists reads back.
    const tree = await app.rpc('document.inspect', {doc});
    const addresses = [];
    const walk = n => { if (n?.address) addresses.push(n.address); for (const k of n?.nodes ?? []) walk(k); };
    walk(tree);
    assert.ok(addresses.length > 1, 'the deck lists its parts');
    for (const address of addresses) {
      const res = await app.rpc('document.read', {doc, address});
      assert.ok(res && 'value' in res, `${address} reads back`);
    }
  }, app);
});
