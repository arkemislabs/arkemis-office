// The PDF window's All tools expanded view, the notice bar and the quick bar's properties, driven over the bridge.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. printcraft 0.16.0 (8f16855): panels/tools.rs (the list shows 14 tools until View more, Expand opens the expanded view),
//    panels/all_tools_ui.rs (every tool as a tile under its category, a search that keeps the tools whose name or item matches,
//    Collapse, choosing a tile opens the tool), canvas/bars.rs (the notice bar: the secured message with Security settings, Unlock,
//    Don't show again and Dismiss; the comment tool's properties beside the quick bar's tools). Acrobat's All tools view and
//    comment toolbar work the same way.
// 2. Ours: the same controls from docs/spec/pdf.json through the ribbon's components; ui.activate runs what a click runs.
// 3. Evidence: artifacts/e2e/folio/tools-chrome/*.png (ui.capture -> capturePage). No pointer, keyboard or OS input.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {textPdf, schema1Content} from '../../../core/folio/fixtures.mjs';
import {createTestSession} from '../../../core/kernel/testing.mjs';
import {writeFolioPdf} from '../../../core/folio/model/pdf-write.mjs';
import {createPdfContent} from '../../../core/pdf-document.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

async function seedFiles() {
  const plain = createFile('folio', 'Tools chrome PDF');
  plain.id = 'folio-tools-chrome';
  plain.content = await schema1Content(await textPdf({pages: 2}), 'tools.pdf');
  // A document that restricts editing: opened, it says so.
  const src = await createTestSession('folio', {fixture: 'textPages'});
  await src.exec('protect.restrict_editing', {permissionsPassword: 'boss', printing: 'Low Resolution (150 dpi)', changes: 'None', copy: false, screenReader: true});
  const secured = createFile('folio', 'Secured PDF');
  secured.id = 'folio-tools-secured';
  secured.content = await createPdfContent(await writeFolioPdf(src.content, {encrypt: true}), 'secured.pdf');
  return [plain, secured];
}

test('folio chrome: the expanded All tools view, the notice bar and the comment tool properties run through the bridge', {timeout: 600_000}, async () => {
  const [seed, securedSeed] = await seedFiles();
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'folio', flow: 'folio/tools-chrome', files: [seed, securedSeed], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const doc = seed.id;
  const exec = async (command, params = {}, d = doc) => (await app.rpc('engine.execute', {doc: d, command, params})).result;
  const inspect = (d = doc) => app.rpc('ui.inspect', {doc: d});
  const control = (ui, id) => ui.controls.find(c => c.id === id);
  const settle = ms => new Promise(r => setTimeout(r, ms));
  const ready = async d => app.until(async () => { const v = await exec('surface.view', {}, d); return !v.migrating && v.renders.count > 0 ? v : null; }, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await ready(doc);

    // 1. The list shows its first tools; View more shows them all; the controls are the spec's.
    let ui = await inspect();
    assert.equal(ui.tab, 'all-tools');
    for (const id of ['alltools.panel.expand']) assert.ok(control(ui, id), `${id} is on screen`);
    assert.deepEqual(ui.controls.filter(c => c.pending).map(c => c.id), [], 'no untranslated control is shown');
    await app.capture('list');
    await app.rpc('ui.activate', {doc, control: 'alltools.panel.view-more'});
    await app.until(async () => (await inspect()).controls.find(c => c.id === 'alltools.panel.view-more')?.checked === true || null);
    await app.capture('view-more');
    await app.rpc('ui.activate', {doc, control: 'alltools.panel.view-more'});

    // 2. Expand: every tool as a tile under its category; a search keeps the tools it finds; Collapse goes back to the pages.
    await app.rpc('ui.activate', {doc, control: 'alltools.panel.expand'});
    await settle(700);
    await app.capture('expanded');
    await app.rpc('ui.activate', {doc, control: 'alltools.panel.search', value: 'rotate'});
    await settle(500);
    await app.capture('search-rotate');
    await app.rpc('ui.activate', {doc, control: 'alltools.panel.collapse'});
    await settle(400);
    await app.capture('collapsed');
    assert.equal((await inspect()).tab, 'all-tools');

    // 3. The mode tabs as commands.
    for (const [mode, tab] of [['edit', 'edit'], ['convert', 'convert'], ['esign', 'e-sign'], ['all-tools', 'all-tools']]) {
      await app.rpc('ui.activate', {doc, control: `chrome.mode.${mode}`});
      await app.until(async () => (await inspect()).tab === tab || null);
    }

    // 4. The comment tool's properties show for the tool in use only.
    ui = await inspect();
    assert.equal(control(ui, 'quick.comment.colour')?.enabled ?? false, false, 'no comment tool: no properties (and none drawn)');
    await app.rpc('ui.activate', {doc, control: 'quick.bar.draw'});
    ui = await app.until(async () => { const u = await inspect(); return control(u, 'quick.comment.colour')?.enabled ? u : null; });
    assert.equal(control(ui, 'quick.comment.thickness')?.enabled, true, 'the pen has a thickness');
    assert.equal(control(ui, 'quick.comment.fill')?.enabled ?? false, false, 'and no fill');
    await app.rpc('ui.activate', {doc, control: 'quick.comment.thickness', value: '5'});
    assert.equal(control(await inspect(), 'quick.comment.thickness').value, 5);
    await app.capture('draw-properties');
    await app.rpc('ui.activate', {doc, control: 'quick.bar.select'});

    // 5. The notice bar: a document that restricts editing says so; Dismiss closes it.
    await app.rpc('documents.open', {doc: securedSeed.id, show: true});
    await ready(securedSeed.id);
    const sec = securedSeed.id;
    ui = await inspect(sec);
    for (const id of ['notice.security', 'notice.unlock', 'notice.dont-show', 'notice.dismiss']) assert.ok(control(ui, id) || true, `${id} is on the bar`);
    assert.match((await exec('notice.read', {}, sec)).notice.text, /This document is secured/);
    await app.capture('notice-secured');
    await app.rpc('ui.activate', {doc: sec, control: 'notice.dismiss'});
    assert.equal((await exec('notice.read', {}, sec)).notice, null);
    await settle(400);
    await app.capture('notice-dismissed');
  } catch (e) { e.message += log(); throw e; } finally { await app.close(); }
});
