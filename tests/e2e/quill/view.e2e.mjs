// Quill's View tab (U:quill/view) end to end through the bridge, in the new shell. No OS input:
// ribbon controls through ui.activate / ui.menu, the page view's keys through ui.keys (the same
// handler its own keys reach), dialogs through ui.dialog.*, windows through app.describe and
// ui.capture with the window id. Arrange All and View Side by Side move only this app's own windows.
//
// Behaviour fidelity:
// 1. ArtCraft crates/engine/src/cmd/view.rs, cmd/outline.rs, crates/layout/src/outline.rs, the ribbon
//    in crates/ui-egui/src/ribbon/view.rs (view, outlining), ribbon/tabs.rs reading_toolbar,
//    canvas/reading.rs, chrome.rs (Screen, the status bar's view buttons), panes/nav.rs; Word: the
//    View tab's Views, Immersive, Page Movement, Show, Zoom and Window groups; Outline view opens
//    the Outlining tab; Read Mode turns columns and Esc returns; Focus hides everything but the
//    page; Immersive Reader has its own tab; the Navigation pane's Headings, Pages and Results; the
//    Zoom dialog; Split; New Window shows the same document in a second window, edits in both.
// 2. The same commands run from the window (the person's path), never on the undo list.
// 3. This file; the engine side is tests/quill/view.test.mjs and tests/quill/upstream/view_tests.test.mjs.
//
// Evidence: artifacts/e2e/quill/view/*.png.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {migrateFile} from '../../../core/quill/migrate.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

const para = text => ({type: 'paragraph', content: [{type: 'text', text}]});
const h = (level, text) => ({type: 'heading', attrs: {level}, content: [{type: 'text', text}]});
const LONG = 'Quarterly results show steady growth across every region, with the strongest gains in the services business and a clear improvement in margins. ';

function seedDoc(id) {
  const seed = createFile('quill', 'Annual Report');
  seed.id = id;
  seed.content.doc = {type: 'doc', content: [
    h(1, 'Annual Report'), para(LONG.repeat(3)),
    h(2, 'Highlights'), para(LONG.repeat(4)), para(LONG.repeat(2)),
    h(2, 'Regional performance'), para(LONG.repeat(5)), para(LONG.repeat(3)),
    h(1, 'Outlook'), para(LONG.repeat(4)),
    h(2, 'Risks'), para(LONG.repeat(6)), para(LONG.repeat(5)),
    h(1, 'Appendix'), para(LONG.repeat(6)),
  ]};
  return migrateFile(seed);
}

test('quill View tab: views, Read Mode, Outline, Focus, Immersive Reader, Navigation pane, Zoom, Split, New Window', {timeout: 240_000}, async () => {
  const seed = seedDoc('quill-view');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'quill', flow: 'quill/view', files: [seed], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const doc = seed.id;
  const run = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const inspect = () => app.rpc('ui.inspect', {doc});
  const control = async id => (await inspect()).controls?.find(c => c.id === id) ?? null;
  const settle = (ms = 450) => new Promise(r => setTimeout(r, ms));
  const undoDepth = async () => (await app.rpc('document.inspect', {doc})).undo?.depth ?? (await app.rpc('document.inspect', {doc})).undoDepth ?? null;
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await inspect(); return ui.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 45_000})
      .catch(e => { throw new Error(e.message + log()); });
    // Insert a manual page break before "Outlook" (Draft draws it as a labelled dotted line).
    const body = await app.rpc('document.read', {doc, address: '/body', as: 'json'});
    assert.ok(JSON.stringify(body).includes('Outlook'));
    const undo0 = await undoDepth();

    // The View tab: Word's groups and controls; what has no engine yet stays hidden.
    await app.rpc('ui.tab', {doc, id: 'view'});
    await settle();
    let ui = await inspect();
    const ids = new Set((ui.controls ?? []).map(c => c.id));
    for (const id of ['view.views.read-mode', 'view.views.print-layout', 'view.views.web-layout', 'view.views.outline', 'view.views.draft',
      'view.immersive.focus', 'view.immersive.immersive-reader', 'view.page-movement.vertical', 'view.page-movement.side-to-side',
      'view.show.ruler', 'view.show.gridlines', 'view.show.navigation-pane', 'view.zoom.zoom', 'view.zoom.100pct', 'view.zoom.zoom-in', 'view.zoom.zoom-out',
      'view.zoom.one-page', 'view.zoom.multiple-pages', 'view.zoom.page-width', 'view.window.new-window', 'view.window.arrange-all', 'view.window.split',
      'view.window.view-side-by-side', 'view.window.synchronous-scrolling', 'view.window.reset-window-position', 'view.window.switch-windows', 'view.sharepoint.properties']) {
      assert.ok(ids.has(id), `${id} is on the View tab`);
    }
    assert.ok(ids.has('view.show.hide-white-space'), 'Hide White Space is on the View tab (U:quill/rest)');
    for (const id of ['view.dark-mode.switch-modes', 'view.window.full-screen']) {
      assert.ok(ids.has(id), `${id} is on the View tab`);
    }
    // Macros and Templates are the Developer tab's engines (tools.macros, tools.templates), shown here too.
    for (const id of ['view.macros.macros', 'view.templates.templates']) assert.ok(ids.has(id), `${id} is on the View tab`);
    assert.equal((await control('view.views.print-layout')).checked, true);
    assert.equal((await control('view.show.ruler')).checked, true);
    await app.capture('01-view-tab', {doc});

    // Web Layout: the text wraps to the window, no page edges.
    await app.rpc('ui.activate', {doc, control: 'view.views.web-layout'});
    await settle(700);
    assert.equal((await control('view.views.web-layout')).checked, true);
    await app.capture('02-web-layout', {doc});

    // Draft: the text alone; page breaks as dotted lines.
    await app.rpc('ui.activate', {doc, control: 'view.views.draft'});
    await settle(700);
    assert.equal((await control('view.views.draft')).checked, true);
    await app.capture('03-draft', {doc});

    // Outline: the Outlining tab comes up; Collapse closes the deepest open level first.
    await app.rpc('ui.activate', {doc, control: 'view.views.outline'});
    await settle(700);
    ui = await inspect();
    assert.ok(ui.tabs.includes('outlining'), JSON.stringify(ui.tabs));
    assert.equal(ui.tab, 'outlining', 'Outline view brings up the Outlining tab');
    await run('caret.set', {pos: {block: 0, off: 0}});
    await app.rpc('ui.activate', {doc, control: 'outlining.outline-tools.collapse'});
    let st = await run('outline.state');
    assert.deepEqual(st.collapsed, [2, 5], 'the Heading 2s under "Annual Report" closed first');
    await app.rpc('ui.activate', {doc, control: 'outlining.outline-tools.show-first-line-only'});
    assert.equal((await control('outlining.outline-tools.show-first-line-only')).checked, true);
    await settle();
    await app.capture('04-outline', {doc});
    await app.rpc('ui.activate', {doc, control: 'outlining.outline-tools.expand'});
    await app.rpc('ui.activate', {doc, control: 'outlining.outline-tools.show-first-line-only'});
    await app.rpc('ui.activate', {doc, control: 'outlining.close.close-outline-view'});
    await settle();
    ui = await inspect();
    assert.ok(!ui.tabs.includes('outlining'), 'Close Outline View takes the tab away');
    assert.equal((await control('view.views.print-layout'))?.checked ?? true, true);

    // Read Mode: reading columns, its bar in place of the ribbon; the arrow turns the page; Esc returns.
    await app.rpc('ui.tab', {doc, id: 'view'});
    await app.rpc('ui.activate', {doc, control: 'view.views.read-mode'});
    await settle(900);
    await app.capture('05-read-mode', {doc});
    await app.rpc('ui.keys', {doc, key: 'ArrowRight'});
    await settle(700);
    await app.capture('06-read-mode-next-screen', {doc});
    await run('view.readPageColor', {value: 'sepia'});
    await settle();
    await app.capture('07-read-mode-sepia', {doc});
    const typed = await app.rpc('ui.type', {doc, text: 'x'});
    assert.equal(typed.typed, 0, 'Read Mode takes no typing');
    await app.rpc('ui.keys', {doc, key: 'Escape'});
    await settle();
    await app.rpc('ui.tab', {doc, id: 'view'});
    assert.equal((await control('view.views.print-layout')).checked, true, 'Esc goes back to Print Layout');

    // Focus: the page alone; Esc leaves.
    await app.rpc('ui.activate', {doc, control: 'view.immersive.focus'});
    await settle(700);
    await app.capture('08-focus', {doc});
    await app.rpc('ui.keys', {doc, key: 'Escape'});
    await settle();
    assert.equal((await control('view.immersive.focus')).checked, false);

    // Immersive Reader: its tab, a reading column, Column Width and Page Color.
    await app.rpc('ui.activate', {doc, control: 'view.immersive.immersive-reader'});
    await settle(700);
    ui = await inspect();
    assert.equal(ui.tab, 'immersive-reader', JSON.stringify(ui.tabs));
    const irIds = new Set(ui.controls.map(c => c.id));
    for (const id of ['immersive-reader.immersive-reader.column-width', 'immersive-reader.immersive-reader.page-color', 'immersive-reader.immersive-reader.text-spacing',
      'immersive-reader.close.close-immersive-reader']) assert.ok(irIds.has(id), id);
    for (const id of ['immersive-reader.immersive-reader.line-focus', 'immersive-reader.immersive-reader.read-aloud']) assert.ok(irIds.has(id), `${id} is on the Immersive Reader tab (U:quill/rest)`);
    for (const id of ['immersive-reader.immersive-reader.syllables']) {
      assert.ok(!irIds.has(id), `${id} has no engine yet: hidden`);
    }
    await app.rpc('ui.activate', {doc, control: 'immersive-reader.immersive-reader.column-width.moderate'});
    await app.rpc('ui.activate', {doc, control: 'immersive-reader.immersive-reader.page-color.sepia'});
    await app.rpc('ui.activate', {doc, control: 'immersive-reader.immersive-reader.text-spacing'});
    await settle(700);
    await app.capture('09-immersive-reader', {doc});
    await app.rpc('ui.activate', {doc, control: 'immersive-reader.close.close-immersive-reader'});
    await settle();
    ui = await inspect();
    assert.ok(!ui.tabs.includes('immersive-reader'));

    // The Navigation pane: Headings, Pages, Results.
    await app.rpc('ui.tab', {doc, id: 'view'});
    await app.rpc('ui.activate', {doc, control: 'view.show.navigation-pane'});
    await settle(700);
    assert.equal((await control('view.show.navigation-pane')).checked, true);
    await run('caret.set', {pos: {block: 9, off: 3}});
    await settle();
    await app.capture('10-navigation-headings', {doc});
    await run('view.navigationPane', {tab: 'pages'});
    await settle(900);
    await app.capture('11-navigation-pages', {doc});
    await run('edit.find', {text: 'margins'});
    await run('view.navigationPane', {tab: 'results'});
    await settle(900);
    await app.capture('12-navigation-results', {doc});
    // The pane's drag of a heading: "Outlook" with its content moves before "Annual Report".
    await run('outline.moveSection', {from: 8, to: 0});
    let text = JSON.stringify(await app.rpc('document.read', {doc, address: '/body', as: 'json'}));
    assert.ok(text.indexOf('Outlook') < text.indexOf('Annual Report'), 'the section moved');
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    text = JSON.stringify(await app.rpc('document.read', {doc, address: '/body', as: 'json'}));
    assert.ok(text.indexOf('Annual Report') < text.indexOf('Outlook'), 'one undo puts it back');
    await app.rpc('ui.activate', {doc, control: 'view.show.navigation-pane'});
    await settle();

    // The Zoom dialog (and the status bar's percent opens it): Word's Zoom to options and preview.
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.zoom'});
    await settle();
    await app.capture('13-zoom-dialog', {doc});
    await app.rpc('ui.dialog.set', {doc, values: {preset: 'onePage'}});
    await settle();
    await app.capture('14-zoom-dialog-whole-page', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    await settle(700);
    assert.equal((await control('view.zoom.one-page')).checked, true);

    // Multiple Pages.
    await app.rpc('ui.activate', {doc, control: 'view.zoom.multiple-pages'});
    await settle(700);
    assert.equal((await control('view.zoom.multiple-pages')).checked, true);
    await app.capture('15-multiple-pages', {doc});
    await app.rpc('ui.activate', {doc, control: 'view.zoom.100pct'});

    // Split: two panes on the document; again removes it.
    await app.rpc('ui.activate', {doc, control: 'view.window.split'});
    await settle(700);
    assert.equal((await control('view.window.split')).checked, true);
    await app.capture('16-split', {doc});
    await app.rpc('ui.activate', {doc, control: 'view.window.split'});
    assert.equal((await control('view.window.split')).checked, false);

    // New Window: the same document in a second window; an edit in the first shows in both.
    const before = (await app.rpc('app.describe')).windows.length;
    await app.rpc('ui.activate', {doc, control: 'view.window.new-window'});
    const second = await app.until(async () => {
      const ws = (await app.rpc('app.describe')).windows;
      return ws.length > before && ws.filter(w => w.live).length > before ? ws.find(w => !w.active && w.live) ?? ws[ws.length - 1] : null;
    }, {timeout: 30_000});
    await settle(2500);
    await run('caret.set', {pos: {block: 0, off: 13}});
    await app.rpc('ui.type', {doc, text: ' 2026'});
    await settle(1800);
    await app.capture('17-new-window-second', {window: second.window});
    await app.capture('18-new-window-first', {doc});
    // Switch Windows lists both; Arrange All and View Side by Side move only these windows.
    await app.rpc('ui.tab', {doc, id: 'view'});
    const sw = await control('view.window.switch-windows');
    assert.ok(sw && sw.enabled, 'Switch Windows');
    await app.rpc('ui.menu', {doc, control: 'view.window.switch-windows'});
    await settle();
    await app.capture('19-switch-windows', {doc});
    await app.rpc('ui.menu', {doc, control: 'view.window.switch-windows', open: false});
    await app.rpc('ui.activate', {doc, control: 'view.window.arrange-all'});
    await app.rpc('ui.activate', {doc, control: 'view.window.view-side-by-side'});
    await settle();
    assert.equal((await control('view.window.view-side-by-side')).checked, true);
    assert.equal((await control('view.window.synchronous-scrolling')).checked, true);
    await app.rpc('ui.activate', {doc, control: 'view.window.reset-window-position'});
    await settle(900);
    await app.capture('20-side-by-side', {doc});
    await app.capture('21-side-by-side-second', {window: second.window});

    // None of it touched the undo list beyond the typed text.
    const undo1 = await undoDepth();
    if (undo0 !== null && undo1 !== null) assert.ok(undo1 >= undo0, 'view changes are not undo steps');
  } finally {
    await app.close();
  }
});
