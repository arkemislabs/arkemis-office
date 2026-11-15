// U:slate/review: OneNote's Review tab on a real notebook, end to end through the bridge: the
// Thesaurus pane and a synonym replacing the word at the caret, Set Proofing Language, and Password
// Protection (the pane, Set Password with a mismatch refused, Lock All, the locked section's
// placeholder, a wrong password refused, Unlock, Change and Remove Password), with the vault file the
// app writes read back after each step: the protected pages are never in it in plain text and the
// password is never in it at all. Every step is checked in the document and captured.
//
// Behaviour fidelity: see tests/slate/review.test.mjs. Evidence: artifacts/e2e/slate/review/*.png.
// No OS or DOM input: ui.activate / ui.dialog.* / engine.execute only.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {devRenderer, launchApp} from '../harness.mjs';
import {createContent, newPageRecord, SECTION_COLORS, validateContent} from '../../../core/slate/schema.mjs';

const NOW = new Date().toISOString();
const SECRET = 'SECRET-LIGHTHOUSE-PLANS';
const PASSWORD = 'e2e-passphrase-42';
const NEW_PASSWORD = 'e2e-second-phrase-77';
const para = (id, text) => ({type: 'paragraph', attrs: {id, style: 'normal', align: null, indent: 0, dir: null, tags: [], spacing: null, audio: null}, ...(text ? {content: [{type: 'text', text}]} : {})});
const body = (cid, lines) => ({type: 'doc', content: [{type: 'container', attrs: {id: cid, x: 60, y: 130, width: 520}, content: lines.map((t, i) => para(`${cid}p${i}`, t))}]});

function seed() {
  let n = 0;
  const c = createContent('Journal', {uid: () => `r${(n++).toString(36).padStart(4, '0')}`, now: NOW});
  c.tree = ['spriv', 'spub']; c.groups = {}; c.pages = {};
  c.sections = {
    spriv: {id: 'spriv', name: 'Private', color: SECTION_COLORS[3], created: NOW, pages: [{id: 'pdiary', level: 0}, {id: 'pplans', level: 0}]},
    spub: {id: 'spub', name: 'Public', color: SECTION_COLORS[1], created: NOW, pages: [{id: 'phome', level: 0}]},
  };
  const page = (id, title, lines, extra = {}) => ({...newPageRecord({id, title, created: NOW}), body: body(`c${id}`, lines), ...extra});
  c.pages.pdiary = page('pdiary', 'Diary', [`${SECRET} are in the old diary.`, 'Nobody else should read this.']);
  c.pages.pplans = page('pplans', 'Plans', ['Second page of the private section.'], {ink: [{id: 'k1', tool: 'pen', color: '#12ab34', width: 1.9, points: [80, 300, 160, 314, 240, 300]}]});
  c.pages.phome = page('phome', 'Home', ['A quick fox jumps over the lazy dog.']);
  return validateContent(c);
}

const fileOf = (id, content) => ({id, schema: 2, kind: 'slate', title: content.notebook.name, revision: 0, createdAt: NOW, updatedAt: NOW, starred: false, links: [], content});

test('slate Review tab: thesaurus, proofing language and password protection work on a notebook through the ribbon, pane and dialogs', {timeout: 600_000}, async () => {
  const doc = 'slate-review';
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'slate', flow: 'slate/review', files: [fileOf(doc, seed())], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const read = async (address, as = 'json') => (await app.rpc('document.read', {doc, address, as})).value;
  const settle = ms => new Promise(r => setTimeout(r, ms));
  const pick = id => app.rpc('ui.activate', {doc, control: id});
  const select = (anchor, focus = anchor) => app.rpc('selection.set', {doc, ranges: [{anchor, focus}]});
  const inspect = () => app.rpc('ui.inspect', {doc});
  const dialog = () => app.rpc('ui.dialog.get', {doc});
  const press = field => app.rpc('ui.dialog.submit', {doc, field});
  const vaultFile = path.join(app.data, 'documents', `${doc}.json`);
  const vault = () => fs.readFile(vaultFile, 'utf8');
  /** Wait until the vault file holds the document at (at least) this protection state, then return its text. */
  const vaultWhen = async test => app.until(async () => { const t = await vault(); return test(t) ? t : null; }, {timeout: 40_000})
    .catch(async e => { const t = await vault().catch(() => ''); throw new Error(`${e.message}
vault: ${t.length} bytes, protection ${t.includes('AES-256-GCM')}, secret ${t.includes(SECRET)}${log()}`); });
  const protectedNow = async id => (await exec('review.password', {})).sections.find(s => s.id === id).protected;
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}).catch(() => null); return ui?.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 60_000})
      .catch(e => { throw new Error(e.message + log()); });

    // ---- The Review tab: what is offered and what is not ---------------------------------------------------------------
    await select('/pg:phome/b:cphomep0/t:4');
    await app.rpc('ui.tab', {doc, id: 'review'});
    await settle(900);
    await app.capture('01-review-tab', {doc});
    const ids = (await inspect()).controls.map(c => c.id);
    for (const id of ['review.proofing.spelling', 'review.proofing.thesaurus', 'review.language.language', 'review.section.password', 'review.insights.search', 'review.accessibility.check-accessibility', 'review.notes.linked-notes']) assert.ok(ids.includes(id), `${id} is on the ribbon`);
    for (const id of ['review.language.translate']) {
      assert.equal(ids.includes(id), false, `${id} is hidden (no engine)`);
    }

    // ---- Thesaurus: the pane, a synonym replaces the word at the caret --------------------------------------------------
    await pick('review.proofing.thesaurus');
    await settle(800);
    await app.capture('02-thesaurus-pane', {doc});
    const looked = await exec('review.thesaurus', {});
    assert.equal(looked.word, 'quick');
    assert.ok(looked.meanings.some(m => m.synonyms.includes('swift')));
    await exec('review.thesaurus', {word: 'quick', replace: 'swift'});
    assert.equal(await read('/pg:phome/b:cphomep0', 'text'), 'A swift fox jumps over the lazy dog.');
    await settle(500);
    await app.capture('03-synonym-replaced', {doc});

    // ---- Proofing language: the dialog marks the selected word --------------------------------------------------------
    await select('/pg:phome/b:cphomep0/t:2', '/pg:phome/b:cphomep0/t:7');
    await pick('review.language.language.set-proofing-language');
    assert.equal((await dialog()).id, 'dialog.language');
    await app.rpc('ui.dialog.set', {doc, values: {language: 'French (France)', doNotCheck: false}});
    await settle(500);
    await app.capture('04-language-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    assert.match(JSON.stringify(await read('/pg:phome/b:cphomep0', 'json')), /"lang":"fr-FR"/);
    await settle(400);
    await app.capture('05-language-marked', {doc});

    // ---- Password Protection: the pane, a mismatch refused, then set ---------------------------------------------------------
    await select('/pg:pdiary');
    await pick('review.section.password');
    const pane = await dialog();
    assert.equal(pane.id, 'dialog.password-protection');
    await settle(700);
    await app.capture('06-password-pane', {doc});
    // Password Options: the auto-lock settings, saved as the document's preferences.
    await press('passwordOptions');
    assert.equal((await dialog()).id, 'dialog.password-options');
    assert.deepEqual([(await dialog()).values.lockAfter, (await dialog()).values.lockAfterTime, (await dialog()).values.lockOnNavigate], [true, '10 minutes', false]);
    await app.rpc('ui.dialog.set', {doc, values: {lockAfterTime: '5 minutes', lockOnNavigate: false}});
    await settle(500);
    await app.capture('06b-password-options', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    assert.deepEqual(await exec('review.passwordOptions', {}), {lockAfter: true, minutes: 5, onNavigate: false});
    await press('setPassword');
    assert.equal((await dialog()).id, 'dialog.password-set');
    await app.rpc('ui.dialog.set', {doc, values: {password: PASSWORD, confirm: PASSWORD + 'x'}});
    await assert.rejects(app.rpc('ui.dialog.submit', {doc}), /do not match/);
    await settle(500);
    await app.capture('07-passwords-do-not-match', {doc});
    assert.equal(await protectedNow('spriv'), false, 'a mismatch protects nothing');
    await app.rpc('ui.dialog.set', {doc, values: {password: PASSWORD, confirm: PASSWORD}});
    await app.rpc('ui.dialog.submit', {doc});
    assert.equal(await protectedNow('spriv'), true);
    await settle(500);
    await app.capture('08-section-protected', {doc});
    // The section is open until it is locked, yet what the app stored is sealed: wait for the autosave.
    const sealed = await vaultWhen(t => t.includes('AES-256-GCM'));
    assert.equal(sealed.includes(SECRET), false, 'the vault holds no page text of a protected section');
    assert.equal(sealed.includes('#12ab34'), false, 'nor its ink');
    assert.equal(sealed.includes(PASSWORD), false, 'the password is nowhere');
    assert.ok(sealed.includes(' fox jumps over the lazy dog.'), 'an ordinary section is stored as it is');

    // ---- Lock All (a button of the pane): the pages leave the notebook, a placeholder shows -----------------------------------
    await press('lockAll');
    await settle(700);
    await assert.rejects(read('/pg:pdiary', 'json'), /./, 'the locked section has no pages in the notebook');
    await app.rpc('ui.dialog.cancel', {doc});
    await select('/sec:spriv');
    await settle(900);
    await app.capture('09-locked-section', {doc});
    await assert.rejects(exec('page.new', {sectionId: 'spriv'}), /locked/);
    const locked = await vaultWhen(t => !t.includes('pdiary"'));
    assert.equal(locked.includes(SECRET), false);
    assert.equal(locked.includes(PASSWORD), false);

    // ---- Unlock: a wrong password is refused on its field, the right one opens the section -------------------------------------------
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.password-unlock', args: {sectionId: 'spriv'}});
    await app.rpc('ui.dialog.set', {doc, values: {password: 'not the password'}});
    await assert.rejects(app.rpc('ui.dialog.submit', {doc}), /not correct/);
    await settle(500);
    const refused = await dialog();
    assert.match(refused.message ?? '', /not correct/);
    await app.capture('10-wrong-password', {doc});
    await app.rpc('ui.dialog.set', {doc, values: {password: PASSWORD}});
    await app.rpc('ui.dialog.submit', {doc});
    await settle(900);
    assert.match(await read('/pg:pdiary/b:cpdiaryp0', 'text'), new RegExp(SECRET));
    await app.capture('11-unlocked-section', {doc});
    // An edit while unlocked is saved sealed.
    await exec('surface.title', {page: 'pdiary', title: 'Diary, edited'});
    await settle(1800);
    const edited = await vault();
    assert.equal(edited.includes('Diary, edited'), false, 'the edit of an unlocked protected page is stored sealed');
    assert.equal(edited.includes(SECRET), false);

    // ---- Change Password and Remove Password through the pane's dialogs ----------------------------------------------------------------
    await select('/pg:pdiary');
    await pick('review.section.password');
    await press('changePassword');
    assert.equal((await dialog()).id, 'dialog.password-change');
    await app.rpc('ui.dialog.set', {doc, values: {oldPassword: 'wrong', newPassword: NEW_PASSWORD, confirm: NEW_PASSWORD}});
    await assert.rejects(app.rpc('ui.dialog.submit', {doc}), /not correct/);
    await app.rpc('ui.dialog.set', {doc, values: {oldPassword: PASSWORD, newPassword: NEW_PASSWORD, confirm: NEW_PASSWORD}});
    await settle(400);
    await app.capture('12-change-password', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    await exec('password.lock', {sectionId: 'spriv'});
    await assert.rejects(exec('password.unlock', {sectionId: 'spriv', password: PASSWORD}), /not correct/);
    await exec('password.unlock', {sectionId: 'spriv', password: NEW_PASSWORD});
    await press('removePassword');
    assert.equal((await dialog()).id, 'dialog.password-remove');
    await app.rpc('ui.dialog.set', {doc, values: {password: NEW_PASSWORD}});
    await settle(300);
    await app.capture('13-remove-password', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    assert.equal(await protectedNow('spriv'), false);
    await app.rpc('ui.dialog.cancel', {doc});
    const plain = await vaultWhen(t => !t.includes('AES-256-GCM'));
    assert.ok(plain.includes(SECRET), 'with the password removed the section is stored as pages again');
    await settle(500);
    await app.capture('14-password-removed', {doc});
  } finally {
    await app.close();
  }
});
