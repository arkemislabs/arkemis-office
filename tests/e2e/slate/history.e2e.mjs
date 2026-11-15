// U:slate/history: OneNote's History tab on a real notebook, end to end through the bridge: unread
// pages (bold in the page list, Next Unread, Mark as Read), Recent Edits and Find by Author in the
// results pane, Page Versions (a version saved by a real edit after a rest, viewed read-only,
// restored, deleted), Delete All Versions and Empty Recycle Bin asking first, the Notebook Recycle
// Bin and its restores. Every step is checked in the document and captured.
//
// Behaviour fidelity: see tests/slate/history.test.mjs. Evidence: artifacts/e2e/slate/history/*.png.
// No OS or DOM input: ui.activate / ui.menu / ui.dialog.* / engine.execute only.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createContent, newPageRecord, SECTION_COLORS, validateContent} from '../../../core/slate/schema.mjs';

const NOW = new Date().toISOString();
const ago = ms => new Date(Date.now() - ms).toISOString();
const DAY = 86_400_000;
const para = (id, text) => ({type: 'paragraph', attrs: {id, style: 'normal', align: null, indent: 0, dir: null, tags: [], spacing: null, audio: null}, ...(text ? {content: [{type: 'text', text}]} : {})});
const body = (cid, lines) => ({type: 'doc', content: [{type: 'container', attrs: {id: cid, x: 60, y: 130, width: 520}, content: lines.map((t, i) => para(`${cid}p${i}`, t))}]});
const stroke = (id, y) => ({id, tool: 'pen', color: '#0070c0', width: 1.9, points: [80, y, 160, y + 14, 240, y]});

function seed() {
  let n = 0;
  const c = createContent('Physics 101', {uid: () => `h${(n++).toString(36).padStart(4, '0')}`, now: NOW});
  c.tree = ['sw1', 'sw2']; c.groups = {}; c.pages = {};
  c.sections = {
    sw1: {id: 'sw1', name: 'Week 1', color: SECTION_COLORS[0], created: NOW, pages: [{id: 'pnotes', level: 0}, {id: 'plab', level: 0}, {id: 'pold', level: 0}]},
    sw2: {id: 'sw2', name: 'Week 2', color: SECTION_COLORS[1], created: NOW, pages: [{id: 'pexam', level: 0}]},
  };
  const page = (id, title, lines, modified, extra = {}) => ({...newPageRecord({id, title, created: ago(30 * DAY)}), body: body(`c${id}`, lines), modified, ...extra});
  c.pages.pnotes = page('pnotes', 'Lecture notes', ['Newton\'s laws describe motion.', 'Force equals mass times acceleration.'], ago(2 * DAY), {author: 'Grace Hopper', modifiedBy: 'Grace Hopper', ink: [stroke('k1', 300)]});
  c.pages.plab = page('plab', 'Lab report', ['Measure the fall time.'], new Date(Math.max(Date.now() - 10 * 60_000, new Date().setHours(0, 0, 1, 0))).toISOString(), {author: 'Ada Lovelace', modifiedBy: 'Ada Lovelace', unread: true});
  c.pages.pold = page('pold', 'Old sketches', ['From the autumn.'], ago(120 * DAY), {author: 'Ada Lovelace', modifiedBy: 'Ada Lovelace'});
  c.pages.pexam = page('pexam', 'Exam review', ['Chapters 1 to 4.'], ago(5 * DAY), {author: 'Grace Hopper', modifiedBy: 'Grace Hopper', unread: true});
  // Two saved versions of the lecture notes, as earlier sessions left them.
  c.versions = {pnotes: [
    {id: 'v1', saved: ago(20 * DAY), author: 'Ada Lovelace', title: 'Lecture notes', color: null, rule: c.pages.pnotes.rule, titleHidden: false, paperSize: null, body: body('cv1', ['Newton\'s laws.']), ink: []},
    {id: 'v2', saved: ago(9 * DAY), author: 'Grace Hopper', title: 'Lecture notes (draft)', color: null, rule: c.pages.pnotes.rule, titleHidden: false, paperSize: null, body: body('cv2', ['Newton\'s laws describe motion.', 'Add the second law.']), ink: [stroke('k0', 240)]},
  ]};
  return validateContent(c);
}

const fileOf = (id, content) => ({id, schema: 2, kind: 'slate', title: content.notebook.name, revision: 0, createdAt: NOW, updatedAt: NOW, starred: false, links: [], content});

test('slate History tab: unread, recent edits, authors, page versions and the Recycle Bin work on a notebook through the ribbon, panes and dialogs', {timeout: 480_000}, async () => {
  const doc = 'slate-history';
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'slate', flow: 'slate/history', files: [fileOf(doc, seed())], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const read = async (address, as = 'json') => (await app.rpc('document.read', {doc, address, as})).value;
  const settle = ms => new Promise(r => setTimeout(r, ms));
  const pick = id => app.rpc('ui.activate', {doc, control: id});
  const select = address => app.rpc('selection.set', {doc, ranges: [{anchor: address, focus: address}]});
  const meta = id => read(`/pg:${id}/meta`);
  const where = async () => (await app.rpc('selection.get', {doc})).selection.ranges[0].anchor;
  const ids = ['pnotes', 'plab', 'pold', 'pexam'];
  const binNow = async () => (await exec('history.recycleBin', {})).entries;
  const versionsOf = async id => (await meta(id)).versions;
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}).catch(() => null); return ui?.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 60_000})
      .catch(e => { throw new Error(e.message + log()); });
    await app.rpc('ui.tab', {doc, id: 'history'});
    await select('/pg:pnotes');
    await settle(900);
    await app.capture('01-history-tab', {doc});

    // ---- Unread: bold pages, Next Unread, Mark as Read / Unread ---------------------------------------------
    await pick('history.unread.next-unread');
    assert.equal(await where(), '/pg:plab', 'the next unread page after the lecture notes');
    assert.equal((await meta('plab')).unread, false, 'landing on it reads it');
    await pick('history.unread.next-unread');
    assert.equal(await where(), '/pg:pexam');
    await select('/pg:pnotes');
    await pick('history.unread.mark-as-read.mark-page-unread');
    await settle(500);
    await app.capture('02-unread-bold-pages', {doc});
    const unread = async () => { const out = []; for (const id of ids) if ((await meta(id)).unread) out.push(id); return out.sort(); };
    assert.deepEqual(await unread(), ['pnotes']);
    await pick('history.unread.mark-as-read.mark-notebook-read');
    assert.deepEqual(await unread(), []);
    await pick('history.unread.mark-as-read.show-unread-changes');
    await pick('history.unread.mark-as-read.show-unread-changes');

    // ---- Recent Edits and Find by Author in the results pane ------------------------------------------------------
    await pick('history.history.recent-edits.last-7-days');
    await settle(700);
    await app.capture('03-recent-edits-7-days', {doc});
    assert.deepEqual((await exec('history.recentEdits', {range: '7d'})).pages.map(p => p.title), ['Lab report', 'Lecture notes', 'Exam review']);
    assert.deepEqual((await exec('history.recentEdits', {range: 'today'})).pages.map(p => p.title), ['Lab report']);
    await pick('history.authors.find-by-author');
    await settle(700);
    await app.capture('04-find-by-author', {doc});
    assert.deepEqual((await exec('history.findByAuthor', {})).authors, [{author: 'Ada Lovelace', pages: 2}, {author: 'Grace Hopper', pages: 2}]);
    await pick('history.authors.hide-authors');
    await settle(500);
    await app.capture('05-authors-hidden', {doc});
    await pick('history.authors.hide-authors');
    await exec('history.closePane', {});

    // ---- Page Versions: a real edit after a rest keeps the page as it was --------------------------------------------
    await select('/pg:pnotes');
    await pick('history.history.page-versions.show-page-versions');
    await settle(700);
    await app.capture('06-page-versions-pane', {doc});
    const before = (await versionsOf('pnotes')).map(v => v.id);
    assert.deepEqual(before, ['v1', 'v2']);
    await exec('surface.ink', {page: 'pnotes', stroke: {tool: 'pen', color: '#ff0000', width: 1.9, points: [90, 340, 200, 360, 300, 340]}});
    let versions = await versionsOf('pnotes');
    assert.equal(versions.length, 3, 'the edit after two days of rest saved the page as it was');
    assert.equal(versions[2].strokes, 1);
    assert.equal(versions[2].title, 'Lecture notes');
    await exec('surface.ink', {page: 'pnotes', stroke: {tool: 'pen', color: '#ff0000', width: 1.9, points: [90, 380, 200, 400, 300, 380]}});
    assert.equal((await versionsOf('pnotes')).length, 3, 'a second edit in the same session keeps nothing more');
    await exec('history.viewVersion', {versionId: 'v2'});
    await settle(800);
    await app.capture('07-viewing-a-version', {doc});
    assert.equal((await meta('pnotes')).title, 'Lecture notes', 'viewing changes nothing');
    await exec('history.restoreVersion', {versionId: 'v2'});
    assert.equal((await meta('pnotes')).title, 'Lecture notes (draft)');
    assert.equal((await versionsOf('pnotes')).length, 4, 'what the page was is kept');
    await settle(600);
    await app.capture('08-restored-version', {doc});
    await exec('history.deleteVersion', {versionId: 'v1'});
    assert.equal((await versionsOf('pnotes')).some(v => v.id === 'v1'), false);

    // Delete All Versions in the Section asks first: the dialog, then the deletion.
    await pick('history.history.page-versions.delete-all-versions-section');
    const dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.confirm-delete-versions');
    await settle(500);
    await app.capture('09-confirm-delete-versions', {doc});
    assert.ok((await versionsOf('pnotes')).length > 0, 'nothing is deleted before the answer');
    await app.rpc('ui.dialog.submit', {doc});
    assert.equal((await versionsOf('pnotes')).length, 0);
    await exec('history.closePane', {});

    // ---- The Recycle Bin: delete a page and a section, look, restore, empty after asking ---------------------------------
    await exec('page.delete', {pageIds: ['pold']});
    await exec('section.delete', {sectionId: 'sw2'});
    await pick('history.history.notebook-recycle-bin.open-recycle-bin');
    await settle(800);
    await app.capture('10-recycle-bin', {doc});
    const bin = await binNow();
    assert.deepEqual(bin.map(e => e.kind), ['section', 'page']);
    await exec('history.restoreItem', {entryId: bin.find(e => e.kind === 'page').entry});
    assert.equal((await meta('pold')).title, 'Old sketches');
    await pick('history.history.notebook-recycle-bin.empty-recycle-bin');
    const ask = await app.rpc('ui.dialog.get', {doc});
    assert.equal(ask.id, 'dialog.confirm-empty-recycle-bin');
    await settle(500);
    await app.capture('11-confirm-empty-recycle-bin', {doc});
    assert.equal((await binNow()).length, 1, 'still there until the answer');
    await app.rpc('ui.dialog.submit', {doc});
    assert.deepEqual(await binNow(), []);
    await settle(500);
    await app.capture('12-bin-emptied', {doc});
  } finally {
    await app.close();
  }
});
