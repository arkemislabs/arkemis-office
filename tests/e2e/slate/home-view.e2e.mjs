// U:slate/clipboard and U:slate/view: OneNote's Home tab (the Clipboard group, the drawn Styles and
// Tags galleries, Customize Tags, Find Tags) and View tab (Full Page View, the navigation panes, vertical
// tabs, the dark page, Page Width, the Immersive Reader, the window commands) on a real notebook, end
// to end through the bridge. Every step is checked in the document or the shell state and captured.
//
// Behaviour fidelity: see tests/slate/clipboard.test.mjs and tests/slate/view.test.mjs. Evidence:
// artifacts/e2e/slate/home-view/*.png. No OS or DOM input; the clipboard is the app's test-mode one
// (in memory), never the person's.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createContent, newPageRecord, SECTION_COLORS, validateContent} from '../../../core/slate/schema.mjs';

const NOW = new Date().toISOString();
const para = (id, text, extra = {}) => ({type: 'paragraph', attrs: {id, style: 'normal', align: null, indent: 0, dir: null, tags: [], spacing: null, ...extra}, ...(text ? {content: [{type: 'text', text}]} : {})});
const bold = (text, id) => ({type: 'paragraph', attrs: {id, style: 'normal', align: null, indent: 0, dir: null, tags: [], spacing: null, audio: null}, content: [{type: 'text', text, marks: [{type: 'bold'}]}]});

function seed() {
  let n = 0;
  const c = createContent('Physics', {uid: () => `v${(n++).toString(36).padStart(4, '0')}`, now: NOW});
  c.tree = ['slec', 'slab']; c.groups = {}; c.pages = {};
  c.sections = {
    slec: {id: 'slec', name: 'Lectures', color: SECTION_COLORS[0], created: NOW, pages: [{id: 'p1', level: 0}, {id: 'p2', level: 0}]},
    slab: {id: 'slab', name: 'Labs', color: SECTION_COLORS[1], created: NOW, pages: [{id: 'p3', level: 0}]},
  };
  const page = (id, title, blocks) => ({...newPageRecord({id, title, created: NOW}), body: {type: 'doc', content: [{type: 'container', attrs: {id: `c${id}`, x: 60, y: 130, width: 560}, content: blocks}]}});
  c.pages.p1 = page('p1', 'Newton', [bold('Newton laws', 'b1'), para('b2', 'Force equals mass times acceleration'), para('b3', 'Every action has an equal reaction')]);
  c.pages.p2 = page('p2', 'Energy', [para('e1', 'Kinetic energy is one half m v squared')]);
  c.pages.p3 = page('p3', 'Pendulum', [para('l1', 'Measure the period of a pendulum')]);
  return validateContent(c);
}

const fileOf = (id, content) => ({id, schema: 2, kind: 'slate', title: content.notebook.name, revision: 0, createdAt: NOW, updatedAt: NOW, starred: false, links: [], content});

test('slate Home and View tabs: clipboard, drawn galleries, navigation, dark page, reader and windows work through the ribbon', {timeout: 600_000}, async () => {
  const doc = 'slate-home-view';
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'slate', flow: 'slate/home-view', files: [fileOf(doc, seed())], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const read = async (address, as = 'json') => (await app.rpc('document.read', {doc, address, as})).value;
  const settle = ms => new Promise(r => setTimeout(r, ms));
  const pick = (id, value) => app.rpc('ui.activate', {doc, control: id, ...(value === undefined ? {} : {value})});
  const select = (anchor, focus = anchor) => app.rpc('selection.set', {doc, ranges: [{anchor, focus}]});
  const inspect = () => app.rpc('ui.inspect', {doc});
  const control = async id => (await inspect()).controls.find(c => c.id === id);
  const shot = (name) => app.capture(name, {doc});
  const open = async (id, name) => {
    await app.rpc('ui.menu', {doc, control: id});
    await settle(700);
    assert.equal((await inspect()).menu, id, `${id} is open`);
    if (name) await shot(name);
    await app.rpc('ui.menu', {doc, control: id, open: false});
  };
  const block = id => read(`/pg:p1/b:${id}`, 'json');
  const textOf = n => (n.content ?? []).map(c => c.text ?? '').join('');
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}).catch(() => null); return ui?.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 60_000})
      .catch(e => { throw new Error(e.message + log()); });

    // ================================ Home ==================================================================
    await select('/pg:p1/b:b2/t:5');
    await app.rpc('ui.tab', {doc, id: 'home'});
    await settle(900);
    await shot('01-home-tab');
    const ids = (await inspect()).controls.map(c => c.id);
    for (const id of ['home.clipboard.paste', 'home.clipboard.cut', 'home.clipboard.copy', 'home.clipboard.format-painter', 'home.styles.styles', 'home.tags.tags', 'home.tags.to-do-tag', 'home.tags.find-tags']) assert.ok(ids.includes(id), `${id} is on the Home tab`);
    for (const id of ['home.tags.outlook-tasks', 'home.email.email-page', 'home.meetings.meeting-details', 'home.voice.dictate', 'home.copilot.copilot']) assert.equal(ids.includes(id), false, `${id} is hidden (no engine)`);

    // ---- Styles gallery: drawn tiles, a tile applies the style ---------------------------------------------------------
    const styles = await control('home.styles.styles');
    assert.equal(styles.value.length, 11);
    assert.ok(styles.value.every(t => t.icon && t.label), 'every style tile has an icon and its name');
    await open('home.styles.styles', '02-styles-gallery');
    await pick('home.styles.styles', 'heading-2');
    assert.equal((await block('b2')).attrs.style, 'h2');
    assert.deepEqual((await control('home.styles.styles')).value.filter(t => t.selected).map(t => t.value), ['heading-2']);
    await pick('home.styles.styles.normal');
    assert.equal((await block('b2')).attrs.style, 'normal');

    // ---- Tags gallery: every tag with its icon; a tile tags the paragraph; Customize Tags and Find Tags ------------------------
    const tags = await control('home.tags.tags');
    assert.equal(tags.value.length, 29);
    assert.deepEqual(tags.value.slice(0, 4).map(t => t.label), ['To Do', 'Important', 'Question', 'Remember for later']);
    assert.ok(tags.value.every(t => t.icon), 'every tag tile has its icon');
    await open('home.tags.tags', '03-tags-gallery');
    await pick('home.tags.tags', 'important');
    assert.deepEqual((await block('b2')).attrs.tags.map(t => t.id), ['important']);
    await pick('home.tags.to-do-tag');
    assert.deepEqual((await block('b2')).attrs.tags.map(t => t.id), ['important', 'to-do']);
    await settle(500);
    await shot('04-paragraph-tagged');
    await pick('home.tags.tags.customize-tags');
    assert.equal((await app.rpc('ui.dialog.get', {doc})).id, 'dialog.customize-tags');
    await settle(600);
    await shot('05-customize-tags');
    await app.rpc('ui.dialog.cancel', {doc});
    await pick('home.tags.find-tags');
    await settle(900);
    await shot('06-find-tags');

    // ---- Clipboard: Copy, Cut, Paste and its menu, Format Painter ---------------------------------------------------------------------------------
    await select('/pg:p1/b:b1/t:0', '/pg:p1/b:b1/t:6');
    await pick('home.clipboard.copy');
    await select('/pg:p1/b:b3/t:34');
    await open('home.clipboard.paste', '07-paste-menu');
    await pick('home.clipboard.paste');
    assert.equal(textOf(await block('b3')), 'Every action has an equal reactionNewton');
    assert.ok((await block('b3')).content.some(c => c.text === 'Newton' && c.marks?.some(m => m.type === 'bold')), 'the pasted word keeps its bold');
    await select('/pg:p1/b:b3/t:34', '/pg:p1/b:b3/t:40');
    await pick('home.clipboard.cut');
    assert.equal(textOf(await block('b3')), 'Every action has an equal reaction');
    await select('/pg:p1/b:b3/t:34');
    await pick('home.clipboard.paste.keep-text-only');
    assert.equal(textOf(await block('b3')), 'Every action has an equal reactionNewton');
    assert.equal((await block('b3')).content.some(c => c.marks?.length), false, 'Keep Text Only drops the bold');
    await exec('clipboard.paste', {text: ' (see p. 4)', html: '<b>unused</b>', mode: 'text-only'});
    // Format Painter: pick up the bold, paint the second paragraph's first word.
    await select('/pg:p1/b:b1/t:0', '/pg:p1/b:b1/t:6');
    await pick('home.clipboard.format-painter');
    assert.equal((await control('home.clipboard.format-painter')).checked, true);
    await shot('08-format-painter-on');
    await select('/pg:p1/b:b2/t:0', '/pg:p1/b:b2/t:5');
    await app.until(async () => (await block('b2')).content.some(c => c.text === 'Force' && c.marks?.some(m => m.type === 'bold')) || null, {timeout: 10_000});
    assert.equal((await control('home.clipboard.format-painter')).checked, false, 'painting turns it off');
    await shot('09-painted');

    // ---- Right-click menus: OneNote's items for a page, a page in the list, a section tab and a tag ---------------------------------------------------
    const menu = async (target, name) => {
      const m = await app.rpc('ui.contextMenu', {doc, target});
      if (name) { await settle(500); await shot(name); }
      await app.rpc('ui.contextMenu', {doc, open: false});
      return m.items.map(i => i.label);
    };
    assert.deepEqual(await menu('page-canvas', '10a-menu-page'), ['Paste', 'Paste Options', 'Insert Space', 'Page Color', 'Rule Lines', 'Select All', 'Insert Picture...', 'Insert Table...']);
    assert.deepEqual((await menu('page-tab', '10b-menu-page-tab')).slice(0, 8), ['New Page', 'New Subpage', 'Cut', 'Copy', 'Paste', 'Rename', 'Delete', 'Move or Copy...']);
    assert.ok((await menu('section-tab', '10c-menu-section-tab')).includes('Password Protect This Section...'));
    assert.deepEqual((await menu('tag', '10d-menu-tag')).slice(-3), ['Phone number', 'Customize Tags...', 'Remove Tag']);
    assert.deepEqual((await menu('text-selection')).slice(0, 3), ['Cut', 'Copy', 'Paste Options']);

    // ================================ View ==================================================================
    await select('/pg:p1/b:b2/t:3');
    await app.rpc('ui.tab', {doc, id: 'view'});
    await settle(800);
    await shot('10-view-tab');
    const vids = (await inspect()).controls.map(c => c.id);
    for (const id of ['view.views.normal-view', 'view.views.full-page-view', 'view.views.dock-to-desktop', 'view.immersive-reader.immersive-reader', 'view.show.navigation-panes', 'view.show.tabs-layout',
      'view.show.switch-background', 'view.zoom.page-width', 'view.window.new-window', 'view.window.new-docked-window', 'view.window.always-on-top']) assert.ok(vids.includes(id), `${id} is on the View tab`);
    assert.equal(vids.includes('view.window.send-to-onenote-tool'), false, 'Send to OneNote Tool is hidden');

    // Full Page View, Normal View
    await pick('view.views.full-page-view');
    assert.equal((await control('view.views.full-page-view')).checked, true);
    await settle(600);
    await shot('11-full-page-view');
    await pick('view.views.normal-view');
    assert.equal((await control('view.views.normal-view')).checked, true);

    // Navigation panes: the page list off, then everything off, then back
    await pick('view.show.navigation-panes.show-page-list');
    await settle(500);
    await shot('12-page-list-hidden');
    await pick('view.show.navigation-panes.show-navigation');
    await settle(500);
    await shot('13-navigation-hidden');
    await exec('view.navigationPanes', {});
    await settle(400);

    // Tabs layout: vertical, then horizontal again
    await pick('view.show.tabs-layout.vertical-tabs');
    await settle(700);
    await shot('14-vertical-tabs');
    await pick('view.show.tabs-layout.horizontal-tabs');

    // Switch Background: the dark page
    await pick('view.show.switch-background');
    assert.equal((await control('view.show.switch-background')).checked, true);
    await settle(600);
    await shot('15-dark-page');
    await pick('view.show.switch-background');
    assert.equal((await control('view.show.switch-background')).checked, false);

    // Zoom: Page Width becomes a percent the page fits at
    const before = (await inspect()).doc.zoom;
    await pick('view.zoom.page-width');
    await app.until(async () => { const z = (await inspect()).doc; return z.fit === null && z.zoom !== before ? z : null; }, {timeout: 10_000});
    await settle(500);
    await shot('16-page-width');
    await pick('view.zoom.zoom-100');

    // Immersive Reader: on, its options, off
    await pick('view.immersive-reader.immersive-reader');
    await settle(800);
    await shot('17-immersive-reader');
    await exec('view.immersiveReader', {textSize: 3, spacing: true, theme: 'sepia', lineFocus: 1});
    await settle(700);
    await shot('18-reader-sepia-line-focus');
    await exec('view.immersiveReader', {theme: 'dark'});
    await settle(500);
    await shot('19-reader-dark');
    await exec('view.immersiveReader', {value: false});

    // Window: Always on Top and Dock to Desktop keep their flags (the system is not asked in test mode), New Window opens a second window
    await pick('view.window.always-on-top');
    await app.until(async () => (await control('view.window.always-on-top'))?.checked || null, {timeout: 10_000});
    await pick('view.window.always-on-top');
    await pick('view.views.dock-to-desktop');
    await app.until(async () => (await control('view.views.dock-to-desktop'))?.checked || null, {timeout: 10_000});
    await pick('view.views.dock-to-desktop');
    const windowsBefore = (await app.rpc('app.describe')).windows.length;
    await pick('view.window.new-window');
    await app.until(async () => ((await app.rpc('app.describe')).windows.length > windowsBefore) || null, {timeout: 20_000});
  } finally {
    await app.close();
  }
});
