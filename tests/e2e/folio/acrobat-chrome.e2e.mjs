// The PDF window's Acrobat layout (src/apps/folio/chrome/AcrobatChrome.tsx), driven over the bridge:
// the mode bar's tabs (All tools, Edit, Convert, E-Sign), the All tools list and a tool's panel, the
// floating quick bar, the right rail (panel toggles, page box, zoom) and Organize pages' panel and bar.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. printcraft: the mode bar (crates/ui-egui/src/chrome.rs mode_bar) switches the left panel
//    between All tools, Edit, Convert and E-Sign; a tool row opens the tool's panel with Back
//    (panels/tools.rs tool_detail); the quick bar floats at the document's top-left (canvas/bars.rs
//    quick_bar: Select, Hand, Comment ▸, Highlight ▸, Draw ▸); the right rail toggles one right panel
//    at a time and keeps the page box and zoom at its foot (chrome.rs right_rail); Organize pages
//    takes the left panel and puts its bar over the grid (organize_panel.rs, canvas/organize.rs).
//    Acrobat's new UI is laid out the same way.
// 2. Ours: the same controls from docs/spec/pdf.json, rendered through the ribbon's control
//    components, so ui.activate runs the same commands a click does; untranslated controls are not
//    shown (no control in ui.inspect is pending).
// 3. Evidence: artifacts/e2e/folio/acrobat-chrome/*.png (ui.capture → capturePage).
// No pointer, keyboard or OS input: everything goes through the bridge (ui.tab, ui.activate, ui.inspect).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {textPdf, schema1Content} from '../../../core/folio/fixtures.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

async function seedFile() {
  const file = createFile('folio', 'Acrobat chrome PDF');
  file.id = 'folio-acrobat-chrome';
  file.content = await schema1Content(await textPdf({pages: 3, foreignHighlight: true}), 'chrome.pdf');
  return file;
}

test('folio chrome: Acrobat\'s mode bar, tool panel, quick bar and right rail run through the bridge', {timeout: 240_000}, async () => {
  const seed = await seedFile();
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'folio', flow: 'folio/acrobat-chrome', files: [seed], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const doc = seed.id;
  const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const inspect = () => app.rpc('ui.inspect', {doc});
  const control = (ui, id) => ui.controls.find(c => c.id === id);
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => {
      const v = await exec('surface.view');
      return !v.migrating && v.renders.count > 0 ? v : null;
    }, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });

    // 1. The default view: All tools mode, its tool list (rows: collapsed groups), the quick bar, the rail.
    let ui = await inspect();
    assert.equal(ui.tab, 'all-tools');
    for (const t of ['all-tools', 'edit', 'convert', 'e-sign']) assert.ok(ui.tabs.includes(t), `mode tab ${t}: ${ui.tabs}`);
    for (const t of ['quick-tools', 'title-bar', 'right-rail']) assert.ok(!ui.tabs.includes(t), `${t} is chrome, not a tab`);
    assert.equal(ui.panel, null);
    for (const id of ['quick.bar.select', 'quick.bar.hand', 'quick.bar.comment', 'quick.bar.highlight', 'quick.bar.draw',
      'rail.panels.comments', 'rail.panels.pages', 'rail.panels.bookmarks', 'rail.nav.zoom-in', 'rail.nav.zoom-out', 'rail.nav.next-page',
      'rail.nav.page-input', 'chrome.mode.save', 'chrome.mode.properties']) {
      const c = control(ui, id);
      assert.ok(c, `${id} is on screen`);
      assert.equal(c.collapsed, false, `${id} is drawn`);
    }
    assert.equal(control(ui, 'quick.bar.select').tab, 'quick-tools');
    assert.equal(control(ui, 'alltools.comment.sticky-note').collapsed, true, 'tools sit in their row until the tool is opened');
    assert.deepEqual(ui.controls.filter(c => c.pending).map(c => c.id), [], 'no untranslated control is shown');
    assert.equal(control(ui, 'quick.bar.select').checked, true, 'Select is the tool when the document opens');
    await app.capture('default');

    // 2. All tools ▸ Add comments: the tool's panel (tool_detail) with its tools drawn.
    const opened = await app.rpc('ui.tab', {doc, id: 'all-tools/comment'});
    assert.deepEqual(opened, {tab: 'all-tools', panel: 'all-tools/comment'});
    ui = await inspect();
    assert.equal(ui.panel, 'all-tools/comment');
    assert.equal(control(ui, 'alltools.comment.highlight-text').collapsed, false);
    assert.equal(control(ui, 'alltools.organize.rotate').collapsed, true);
    await app.capture('all-tools-comment');
    await assert.rejects(app.rpc('ui.tab', {doc, id: 'all-tools/no-such-tool'}), /No visible group/);

    // 3. Edit mode: the Edit panel's sections; the tool panel closes with the mode change.
    assert.equal((await app.rpc('ui.tab', {doc, id: 'edit'})).tab, 'edit');
    ui = await inspect();
    assert.equal(ui.tab, 'edit');
    assert.equal(ui.panel, null);
    for (const id of ['edit.modify.page-rotate', 'edit.add.watermark']) assert.equal(control(ui, id)?.collapsed, false, id);
    assert.ok(control(ui, 'rail.panels.comments'), 'the rail stays in every mode');
    await app.capture('edit-mode');

    // 4. The right rail: Comments opens the Comments panel, one right panel at a time.
    await app.rpc('ui.activate', {doc, control: 'rail.panels.comments'});
    ui = await app.until(async () => { const u = await inspect(); return u.panes.some(p => p.id === 'comments' && p.open) ? u : null; });
    assert.equal(control(ui, 'rail.panels.comments').checked, true);
    assert.equal(control(ui, 'rail.panels.pages').checked, false);
    await app.capture('comments-panel');
    // Page thumbnails replaces it (view.panel), and a second click closes the thumbnails again.
    await app.rpc('ui.activate', {doc, control: 'rail.panels.pages'});
    ui = await app.until(async () => { const u = await inspect(); return u.panes.some(p => p.id === 'comments' && !p.open) ? u : null; });
    assert.equal(control(ui, 'rail.panels.pages').checked, true);
    assert.equal(control(ui, 'rail.panels.comments').checked, false);
    assert.equal((await app.until(async () => { const v = await exec('surface.view'); return v.panel === 'pages' ? v : null; })).panel, 'pages');
    await app.capture('pages-panel');
    await app.rpc('ui.activate', {doc, control: 'rail.panels.pages'});
    await app.until(async () => (await exec('surface.view')).panel === null || null);
    assert.equal(control(await inspect(), 'rail.panels.pages').checked, false);

    // 5. A quick tool: Draw (comment.ink) from the quick bar is the tool and shows checked; Hand likewise; Select drops it.
    await app.rpc('ui.activate', {doc, control: 'quick.bar.draw'});
    ui = await inspect();
    assert.equal(control(ui, 'quick.bar.draw').checked, true);
    assert.equal(control(ui, 'quick.bar.select').checked, false);
    await app.capture('quick-tool-draw');
    await app.rpc('ui.activate', {doc, control: 'quick.bar.hand'});
    ui = await inspect();
    assert.equal(control(ui, 'quick.bar.hand').checked, true);
    assert.equal(control(ui, 'quick.bar.draw').checked, false);
    await app.rpc('ui.activate', {doc, control: 'quick.bar.select'});
    assert.equal(control(await inspect(), 'quick.bar.select').checked, true);

    // 6. Page navigation and zoom at the foot of the rail.
    await app.rpc('ui.activate', {doc, control: 'rail.nav.next-page'});
    await app.until(async () => (await exec('surface.view')).current === 1 || null);
    await app.rpc('ui.activate', {doc, control: 'rail.nav.page-input', value: '3'});
    await app.until(async () => (await exec('surface.view')).current === 2 || null);
    await app.rpc('ui.activate', {doc, control: 'rail.nav.previous-page'});
    await app.until(async () => (await exec('surface.view')).current === 1 || null);
    await assert.rejects(app.rpc('ui.activate', {doc, control: 'rail.nav.page-input', value: '9'}), /no page 9/);
    const zoom = (await inspect()).doc.zoom;
    await app.rpc('ui.activate', {doc, control: 'rail.nav.zoom-in'});
    assert.ok((await inspect()).doc.zoom > zoom, 'Zoom in steps up');
    await app.rpc('ui.activate', {doc, control: 'rail.nav.zoom-input', value: '75'});
    assert.equal((await inspect()).doc.zoom, 75);
    await app.capture('zoomed');
    await app.rpc('ui.activate', {doc, control: 'rail.nav.zoom-input', value: '100'});

    // 7. Organize pages: its panel replaces the mode's, its bar sits over the grid, Close goes back.
    await app.rpc('ui.activate', {doc, control: 'edit.modify.organize'});
    ui = await app.until(async () => { const u = await inspect(); return u.tab === 'organize-pages' ? u : null; });
    for (const id of ['organize.page.rotate-cw', 'organize.page.delete', 'organize.grid.close', 'organize.grid.save-pages']) assert.equal(control(ui, id)?.collapsed, false, id);
    assert.ok(control(ui, 'rail.panels.comments'), 'the rail stays while Organize is open');
    await app.capture('organize-pages');
    await app.rpc('ui.activate', {doc, control: 'organize.grid.close'});
    ui = await app.until(async () => { const u = await inspect(); return u.tab === 'edit' ? u : null; });
    assert.ok(!ui.tabs.includes('organize-pages'));

    // 8. The mode switch over the bridge: Convert and E-Sign, then back to All tools.
    for (const t of ['convert', 'e-sign', 'all-tools']) {
      assert.equal((await app.rpc('ui.tab', {doc, id: t})).tab, t);
      if (t === 'e-sign') await app.capture('e-sign-mode');
    }
    assert.equal((await inspect()).tab, 'all-tools');
  } finally {
    await app.close();
  }
});
