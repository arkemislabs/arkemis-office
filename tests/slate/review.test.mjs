// U:slate/review: OneNote's Review tab (Thesaurus, Language, Password Protection).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. Upstream: Slate has no ArtCraft source; docs/spec/slate.json `review.*` and `password.*` name the
//    commands. OneNote's behaviour: the Thesaurus lists the synonyms of the word at the caret and a
//    chosen synonym replaces the word; Set Proofing Language marks the selected text with a language
//    or "Do not check spelling"; a section is password protected (Set Password), locked and unlocked
//    with the password, the password is changed or removed only with the old one, Lock All locks every
//    protected section, and a locked section shows nothing of its pages.
// 2. Ours does the same on the notebook content. The task adds one requirement OneNote meets with its
//    own file format: the section's pages are really encrypted at rest. The tests read the notebook
//    folder file by file and find neither the page text nor the password in any of them, and open the
//    section again from the folder with the password.
// 3. Proof: these tests and tests/e2e/slate/review.e2e.mjs (ribbon, pane, dialogs, captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {loadNotebook, writeNotebook, saveNotebook} from '../../core/slate/lib/notebook-folder.mjs';
import {forgetAllKeys, hasProtected, hasUnlocked, isLocked, isProtected, openWith, sealForDisk} from '../../core/slate/lib/protect.mjs';
import {LANGUAGES, languageOf, matchCase, synonymsOf} from '../../core/slate/lib/proofing.mjs';
import protectionDialog from '../../core/slate/dialogs/password-protection.mjs';
import setDialog from '../../core/slate/dialogs/password-set.mjs';
import changeDialog from '../../core/slate/dialogs/password-change.mjs';
import removeDialog from '../../core/slate/dialogs/password-remove.mjs';
import unlockDialog from '../../core/slate/dialogs/password-unlock.mjs';
import languageDialog from '../../core/slate/dialogs/language.mjs';
import optionsDialog from '../../core/slate/dialogs/password-options.mjs';
import {LOCK_TIMES, labelOf, lockOptions, minutesOf, watchActivity} from '../../core/slate/lib/autolock.mjs';
import {textSession, textSel} from './format-helpers.mjs';

const SECRET = 'SECRET-LIGHTHOUSE-PLANS';
const PASSWORD = 'correct horse battery';
const runs = t => t.blocks[0].content.map(r => [r.text, (r.marks ?? []).map(m => m.type + (m.attrs ? JSON.stringify(m.attrs) : '')).join(',')]);

/** Two sections: Private (Diary holds the secret, Plans has ink) and Public (Home). */
async function privateSession(extra = {}) {
  const t = await textSession([`${SECRET} are in the diary`], {
    notebook: {sections: [{name: 'Private', pages: ['Diary', 'Plans']}, {name: 'Public', pages: ['Home']}]},
    selection: p => ({ranges: [{anchor: `/pg:${p}`, focus: `/pg:${p}`}], primary: 0}), ...extra});
  t.sec = name => Object.values(t.content.sections).find(s => s.name === name).id;
  t.pg = title => Object.values(t.content.pages).find(p => p.title === title).id;
  await t.exec('surface.ink', {page: t.pg('Plans'), stroke: {tool: 'pen', color: '#12ab34', width: 1.9, points: [1, 1, 40, 40]}});
  return t;
}
const text = t => JSON.stringify(t.content);
const nodeFs = {
  readText: p => fs.readFile(p, 'utf8'),
  async writeText(p, body) { const tmp = `${p}.${process.pid}.tmp`; await fs.writeFile(tmp, body); await fs.rename(tmp, p); },
  list: async p => (await fs.readdir(p, {withFileTypes: true})).map(d => ({name: d.name, dir: d.isDirectory()})),
  mkdir: p => fs.mkdir(p, {recursive: true}).then(() => {}),
  rename: (a, b) => fs.rename(a, b),
  remove: p => fs.rm(p, {recursive: true, force: true}),
};
async function everyFile(dir) {
  const out = [];
  for (const d of await fs.readdir(dir, {withFileTypes: true})) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...await everyFile(p));
    else out.push([p, await fs.readFile(p, 'utf8')]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Thesaurus

test('the thesaurus knows everyday words and their endings; a synonym keeps the case of the word it replaces', () => {
  const big = synonymsOf('Big');
  assert.equal(big.found, true);
  assert.ok(big.meanings[0].synonyms.includes('large'));
  assert.ok(!big.meanings.some(m => m.synonyms.includes('big')), 'the word is not its own synonym');
  assert.equal(synonymsOf('quickly').base, 'quick');
  assert.equal(synonymsOf('happily').found, true);
  assert.ok(synonymsOf('large').meanings[0].synonyms.includes('big'), 'a synonym finds the head word too');
  assert.deepEqual(synonymsOf('qzxv'), {word: 'qzxv', found: false, base: 'qzxv', meanings: []});
  assert.equal(matchCase('Big', 'large'), 'Large');
  assert.equal(matchCase('BIG', 'large'), 'LARGE');
  assert.equal(matchCase('big', 'large'), 'large');
});

test('review.thesaurus looks up the word at the caret, opens the pane and replaces the word with a chosen synonym', async () => {
  const t = await textSession(['A quick fox'], {selection: p => textSel(p, 'b1', 4)});
  const r = await t.exec('review.thesaurus', {});
  assert.equal(r.result.word, 'quick');
  assert.equal(r.result.found, true);
  assert.deepEqual(t.doc.view.pane, {kind: 'thesaurus', word: 'quick'});
  assert.ok(r.result.meanings.some(m => m.synonyms.includes('swift')));
  // Type another word in the pane.
  assert.equal((await t.exec('review.thesaurus', {word: 'nonsenseword'})).result.found, false);
  assert.deepEqual(t.doc.view.pane, {kind: 'thesaurus', word: 'nonsenseword'});
  // Replace: the word at the caret, with a chosen synonym.
  await expectUndoRoundTrip(t, 'review.thesaurus', {word: 'quick', replace: 'swift'}, () => assert.deepEqual(runs(t), [['A swift fox', '']]));
  // Case follows the word.
  const u = await textSession(['Big idea'], {selection: p => textSel(p, 'b1', 0, 3)});
  await u.exec('review.thesaurus', {replace: 'large'});
  assert.deepEqual(runs(u), [['Large idea', '']]);
  // A selection of one bold word keeps its formatting.
  const v = await textSession([{text: 'a good plan', marks: [{type: 'bold', from: 2, to: 6}]}], {selection: p => textSel(p, 'b1', 2, 6)});
  await v.exec('review.thesaurus', {replace: 'fine'});
  assert.deepEqual(runs(v), [['a ', ''], ['fine', 'bold'], [' plan', '']]);
});

test('review.thesaurus is the offline lookup and review.spelling is registered; Search, Accessibility and Linked Notes are too; Translate is not', async () => {
  const t = await textSession(['x']);
  for (const id of ['review.thesaurus', 'review.setLanguage', 'review.password', 'password.set', 'password.change', 'password.remove', 'password.unlock', 'password.lock', 'password.lockAll', 'review.spelling', 'review.spellingList', 'review.ignoreAll', 'review.addToDictionary']) assert.ok(t.registry.has(id), id);
  for (const id of ['review.smartLookup', 'review.checkAccessibility', 'review.linkedNotes']) assert.ok(t.registry.has(id), id);
  for (const id of ['review.translate', 'review.setTranslationLanguage']) assert.equal(t.registry.has(id), false, id);
});

// ---------------------------------------------------------------------------------------------
// Language

test('review.setLanguage marks the selected text (or the word at the caret) with a language, or "do not check"', async () => {
  const t = await textSession(['Bonjour tout le monde'], {selection: p => textSel(p, 'b1', 0, 7)});
  assert.equal(t.state('review.setLanguage').value, 'English (United States)');
  await expectUndoRoundTrip(t, 'review.setLanguage', {language: 'French (France)'}, (_, r) => assert.deepEqual(r.result, {changed: 7, language: 'French (France)', code: 'fr-FR', doNotCheck: false}));
  assert.deepEqual(runs(t), [['Bonjour', 'language{"lang":"fr-FR","noCheck":false}'], [' tout le monde', '']]);
  assert.equal(t.state('review.setLanguage').value, 'French (France)');
  // A tag is accepted; "do not check" is remembered with it.
  await t.exec('review.setLanguage', {language: 'de-DE', doNotCheck: true});
  assert.deepEqual(runs(t)[0], ['Bonjour', 'language{"lang":"de-DE","noCheck":true}']);
  assert.equal(t.state('review.setLanguage').checked, 'mixed');
  // The default language is no mark at all.
  await t.exec('review.setLanguage', {language: 'English (United States)'});
  assert.deepEqual(runs(t), [['Bonjour tout le monde', '']]);
  // A caret in a word marks the word; between words nothing.
  t.select(textSel(t.pageId, 'b1', 10));
  assert.equal((await t.exec('review.setLanguage', {language: 'Spanish (Spain)'})).result.changed, 4);
  assert.deepEqual(runs(t)[1], ['tout', 'language{"lang":"es-ES","noCheck":false}']);
  await assert.rejects(t.exec('review.setLanguage', {language: 'Klingon'}), /not a language/);
  assert.equal(languageOf('fr-fr').name, 'French (France)');
  assert.equal(LANGUAGES.length, 20);
});

test('the Language dialog reads the language at the selection and submits it', async () => {
  const t = await textSession(['Bonjour tout'], {selection: p => textSel(p, 'b1', 0, 7)});
  const ctx = () => t.session.readContext(t.docId);
  assert.deepEqual(languageDialog.init(ctx()), {language: 'English (United States)', doNotCheck: false});
  await t.exec('review.setLanguage', {language: 'Italian (Italy)', doNotCheck: true});
  assert.deepEqual(languageDialog.init(ctx()), {language: 'Italian (Italy)', doNotCheck: true});
  assert.deepEqual(languageDialog.toCommand({language: 'Polish', doNotCheck: false}), {command: 'review.setLanguage', params: {language: 'Polish', doNotCheck: false}});
});

// ---------------------------------------------------------------------------------------------
// Password protection

test('Set Password protects a section; Lock removes its pages from the open notebook; Unlock brings them back as they were', async () => {
  const t = await privateSession();
  const sec = t.sec('Private');
  const diary = t.pg('Diary'), plans = t.pg('Plans');
  // A page deleted from the section is in the bin; it belongs to the section's secret too.
  const had = new Set(Object.keys(t.content.pages));
  await t.exec('page.new', {sectionId: sec});
  const extra = Object.keys(t.content.pages).find(id => !had.has(id));
  await t.exec('page.delete', {pageIds: [extra]});
  const original = structuredClone({pages: t.content.pages, sec: t.content.sections[sec], bin: t.content.notebook.recycleBin, versions: t.content.versions});
  assert.equal(t.content.notebook.recycleBin.length, 1);

  const set = await t.exec('password.set', {sectionId: sec, password: PASSWORD});
  assert.deepEqual(set.result, {section: `/sec:${sec}`, protected: true, locked: false});
  assert.equal(isProtected(t.content.sections[sec]), true);
  assert.equal(isLocked(t.content.sections[sec]), false);
  assert.equal(t.content.sections[sec].protection.kdf, 'PBKDF2-SHA256');
  assert.equal(t.content.sections[sec].protection.cipher, 'AES-256-GCM');
  assert.ok(t.content.sections[sec].protection.iterations >= 100_000);
  assert.equal(text(t).includes(PASSWORD), false, 'the password is not stored');
  assert.equal(t.session.journal.at(-1).params.password, '••••', 'the password is not journaled');
  assert.equal(t.doc.undo.size, 0, 'setting a password empties the undo stack');
  assert.equal(t.doc.lastCommand?.command === 'password.set', false, 'Repeat does not remember the password');
  assert.equal(t.state('password.set').enabled, false, 'a protected section cannot be protected again');

  await t.exec('surface.title', {page: diary, title: 'Diary 2'});   // an edit while unlocked
  const lock = await t.exec('password.lock', {sectionId: sec});
  assert.deepEqual(lock.result, {section: `/sec:${sec}`, locked: true, changed: true});
  assert.equal(isLocked(t.content.sections[sec]), true);
  assert.deepEqual(t.content.sections[sec].pages, []);
  assert.equal(t.content.pages[diary], undefined);
  assert.equal(t.content.notebook.recycleBin.length, 0, 'the section\'s deleted pages leave with it');
  assert.equal(text(t).includes(SECRET), false, 'a locked section shows nothing of its pages');
  assert.equal(text(t).includes('Diary 2'), false);
  assert.equal(t.doc.undo.size, 0, 'Undo cannot bring a locked section back');
  assert.equal(t.doc.redo.size, 0);
  await t.undo().catch(() => {});
  assert.equal(t.content.pages[diary], undefined, 'Undo after Lock does nothing');
  assert.equal(t.state('password.lock').enabled, false, 'a locked section cannot be locked again');
  await assert.rejects(t.exec('page.new', {sectionId: sec}), /password protected and locked/);

  // Wrong password: an error on the field, nothing changes; the right one brings everything back.
  const before = text(t);
  await assert.rejects(t.exec('password.unlock', {sectionId: sec, password: 'wrong'}), e => e.message === 'The password is not correct.' && e.data.fields[0].field === 'password');
  assert.equal(text(t), before);
  const unlock = await t.exec('password.unlock', {sectionId: sec, password: PASSWORD});
  assert.equal(unlock.result.locked, false);
  assert.equal(isLocked(t.content.sections[sec]), false);
  assert.equal(t.content.pages[diary].title, 'Diary 2');
  assert.deepEqual(t.content.pages[plans], original.pages[plans]);
  assert.equal(t.content.notebook.recycleBin.length, 1);
  assert.equal(t.content.notebook.recycleBin[0].id, original.bin[0].id);
  assert.deepEqual(t.content.sections[sec].pages, original.sec.pages);
  assert.ok(text(t).includes(SECRET));
  assert.equal(t.doc.selection.ranges[0].anchor, `/pg:${diary}`, 'the first page opens');
});

test('the notebook as it is saved holds the protected section encrypted, never its pages, versions or bin entries', async () => {
  const t = await privateSession();
  const sec = t.sec('Private');
  const diary = t.pg('Diary'), home = t.pg('Home');
  await t.exec('password.set', {sectionId: sec, password: PASSWORD});
  assert.equal(hasProtected(t.content), true);
  assert.equal(hasUnlocked(t.content), true);
  // While the section is unlocked its pages are in memory, but what is saved is sealed.
  assert.ok(text(t).includes(SECRET));
  const sealed = await sealForDisk(t.content);
  assert.equal(JSON.stringify(sealed).includes(SECRET), false, 'no page text in the saved notebook');
  assert.equal(JSON.stringify(sealed).includes('#12ab34'), false, 'no ink in the saved notebook');
  assert.equal(JSON.stringify(sealed).includes(PASSWORD), false);
  assert.equal(isLocked(sealed.sections[sec]), true);
  assert.deepEqual(sealed.sections[sec].pages, []);
  assert.equal(sealed.pages[diary], undefined);
  assert.ok(sealed.pages[home], 'other sections are saved as they are');
  assert.ok(t.content.pages[diary], 'the open notebook is untouched');
  // The same notebook seals to the same blob (no rewrite on every save); an edit changes it.
  const again = await sealForDisk(t.content);
  assert.equal(again.sections[sec].protection, sealed.sections[sec].protection);
  await t.exec('surface.title', {page: diary, title: 'Diary changed'});
  const changed = await sealForDisk(t.content);
  assert.notEqual(changed.sections[sec].protection.data, sealed.sections[sec].protection.data);
  // The blob opens with the password and holds the edit; a wrong password opens nothing.
  const opened = await openWith(changed.sections[sec], PASSWORD);
  assert.equal(opened.payload.records[diary].title, 'Diary changed');
  assert.ok(JSON.stringify(opened.payload).includes(SECRET));
  assert.equal(await openWith(changed.sections[sec], 'wrong'), null);
  // A blob that was changed does not open.
  const tampered = {...changed.sections[sec], protection: {...changed.sections[sec].protection, data: changed.sections[sec].protection.data.replace(/.$/, c => (c === 'A' ? 'B' : 'A'))}};
  assert.equal(await openWith(tampered, PASSWORD), null);
});

test('in the notebook folder nothing of a protected section is in plain text; reopening it, the section is locked and the password unlocks it', async () => {
  const t = await privateSession();
  const sec = t.sec('Private');
  const diary = t.pg('Diary'), home = t.pg('Home');
  await t.exec('surface.ink', {page: diary, stroke: {tool: 'pen', color: '#ab12cd', width: 1.9, points: [5, 5, 50, 50]}});
  await t.exec('password.set', {sectionId: sec, password: PASSWORD});
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-review-'));
  try {
    const root = path.join(base, 'Notebook').split(path.sep).join('/');
    const prev = await sealForDisk(t.content);
    await writeNotebook(nodeFs, root, prev);
    let files = await everyFile(path.join(base, 'Notebook'));
    for (const [file, body] of files) {
      assert.equal(body.includes(SECRET), false, `${file} has the page text`);
      assert.equal(body.includes('#ab12cd'), false, `${file} has the ink`);
      assert.equal(body.includes(PASSWORD), false, `${file} has the password`);
    }
    assert.equal(files.some(([f]) => /Diary|Plans|\.versions\./.test(path.basename(f))), false, 'no page file of the protected section');
    assert.ok(files.some(([f]) => f.endsWith(path.join('Private', 'section.json'))), 'the section file is there, with the blob');
    assert.ok(files.some(([f, b]) => f.endsWith(path.join('Public', `${home}.json`)) && b.includes(home)), 'an ordinary section is stored as pages');

    // An edit while unlocked: saved over the folder, still sealed; the old plain page files are not left behind.
    await t.exec('surface.title', {page: diary, title: 'Diary edited'});
    const next = await sealForDisk(t.content);
    await saveNotebook(nodeFs, root, prev, next);
    files = await everyFile(path.join(base, 'Notebook'));
    assert.equal(files.some(([, b]) => b.includes('Diary edited')), false);

    // The notebook opens locked, with nothing of its pages; the password opens them.
    const {content: back} = await loadNotebook(nodeFs, root);
    assert.equal(isLocked(back.sections[sec]), true);
    assert.deepEqual(back.sections[sec].pages, []);
    assert.equal(Object.values(back.pages).some(p => p.title === 'Diary edited'), false);
    forgetAllKeys(back);
    const opened = await openWith(back.sections[sec], PASSWORD);
    assert.ok(opened, 'the password opens the section from the folder');
    assert.equal(opened.payload.records[diary].title, 'Diary edited');
    assert.ok(JSON.stringify(opened.payload).includes('#ab12cd'));
    assert.equal(await openWith(back.sections[sec], PASSWORD + '!'), null);
  } finally { await fs.rm(base, {recursive: true, force: true}); }
});

test('a session opened on the locked notebook unlocks it with the password and keeps editing; Lock All locks every section', async () => {
  const t = await privateSession();
  const sec = t.sec('Private'), pub = t.sec('Public');
  await t.exec('password.set', {sectionId: sec, password: PASSWORD});
  await t.exec('password.set', {sectionId: pub, password: 'second secret'});
  const saved = await sealForDisk(t.content);
  forgetAllKeys(t.content);
  // Another session, as after restarting the app: both sections are locked, no keys are in memory.
  const {notebookSession} = await import('./foundation-helpers.mjs');
  const u = await notebookSession(structuredClone(saved));
  assert.equal(Object.values(u.content.sections).every(isLocked), true);
  assert.equal(JSON.stringify(u.content).includes(SECRET), false);
  await assert.rejects(u.exec('password.lock', {sectionId: sec}), /already locked/);
  await u.exec('password.unlock', {sectionId: sec, password: PASSWORD});
  const diary = Object.values(u.content.pages).find(p => p.title === 'Diary').id;
  assert.ok(JSON.stringify(u.content.pages[diary]).includes(SECRET));
  await u.exec('surface.title', {page: diary, title: 'Diary again'});
  assert.equal(u.state('password.lockAll').enabled, true);
  const all = await u.exec('password.lockAll', {});
  assert.deepEqual(all.result.locked, [`/sec:${sec}`]);
  assert.equal(u.state('password.lockAll').enabled, false, 'nothing is unlocked');
  assert.equal(Object.values(u.content.sections).every(isLocked), true);
  assert.equal(Object.keys(u.content.pages).length, 0);
  assert.equal(u.doc.undo.size, 0);
  // The edit made while unlocked came through the lock: unlock again and it is there.
  await u.exec('password.unlock', {sectionId: sec, password: PASSWORD});
  assert.equal(u.content.pages[diary].title, 'Diary again');
});

test('Change Password needs the old password, then only the new one opens the section; Remove Password needs the password and decrypts', async () => {
  const t = await privateSession();
  const sec = t.sec('Private');
  await t.exec('password.set', {sectionId: sec, password: PASSWORD});
  await t.exec('password.lock', {sectionId: sec});
  await assert.rejects(t.exec('password.change', {sectionId: sec, oldPassword: 'nope', newPassword: 'new one'}), e => e.data.fields[0].field === 'oldPassword');
  const oldBlob = t.content.sections[sec].protection;
  await t.exec('password.change', {sectionId: sec, oldPassword: PASSWORD, newPassword: 'new one'});
  assert.notEqual(t.content.sections[sec].protection.salt, oldBlob.salt, 'a new salt');
  assert.equal(isLocked(t.content.sections[sec]), true, 'a locked section stays locked');
  await assert.rejects(t.exec('password.unlock', {sectionId: sec, password: PASSWORD}), /not correct/);
  await t.exec('password.unlock', {sectionId: sec, password: 'new one'});
  assert.ok(text(t).includes(SECRET));
  // Change while unlocked.
  await t.exec('password.change', {sectionId: sec, oldPassword: 'new one', newPassword: 'third'});
  assert.equal(isLocked(t.content.sections[sec]), false);
  const sealed = await sealForDisk(t.content);
  assert.ok(await openWith(sealed.sections[sec], 'third'));
  assert.equal(await openWith(sealed.sections[sec], 'new one'), null);
  // Remove: wrong password refused; with the password the section is plain again.
  await assert.rejects(t.exec('password.remove', {sectionId: sec, password: 'wrong'}), /not correct/);
  await t.exec('password.lock', {sectionId: sec});
  const removed = await t.exec('password.remove', {sectionId: sec, password: 'third'});
  assert.equal(removed.result.protected, false);
  assert.equal(isProtected(t.content.sections[sec]), false);
  assert.equal(t.content.sections[sec].locked, undefined);
  assert.ok(text(t).includes(SECRET), 'a locked section removed from protection is readable again');
  assert.equal(hasProtected(t.content), false);
  const plain = await sealForDisk(t.content);
  assert.equal(plain, t.content, 'nothing to seal');
});

test('a protected section deleted while unlocked is sealed in the Recycle Bin and restores as it was', async () => {
  const t = await privateSession();
  const sec = t.sec('Private');
  await t.exec('password.set', {sectionId: sec, password: PASSWORD});
  await t.exec('section.delete', {sectionId: sec});
  assert.equal(t.content.sections[sec], undefined);
  const entry = t.content.notebook.recycleBin[0];
  assert.equal(entry.kind, 'section');
  const sealed = await sealForDisk(t.content);
  assert.equal(JSON.stringify(sealed).includes(SECRET), false, 'the bin does not keep the pages in plain text');
  const stored = sealed.notebook.recycleBin[0];
  assert.equal(stored.section.locked, true);
  assert.deepEqual(stored.pages, {});
  assert.ok(await openWith(stored.section, PASSWORD));
  assert.equal((await sealForDisk(t.content)).notebook.recycleBin[0], stored, 'sealed once');
  // Restored from the bin it is the section it was.
  await t.exec('history.restoreItem', {entryId: entry.id});
  assert.equal(isLocked(t.content.sections[sec]), false);
  assert.ok(text(t).includes(SECRET));
});

test('the password dialogs check their entries and submit the command; the pane shows the section\'s state; Lock All is a button', async () => {
  const t = await privateSession();
  const sec = t.sec('Private');
  const ctx = () => t.session.readContext(t.docId);
  t.session.setSelection(t.docId, {ranges: [{anchor: `/sec:${sec}`, focus: `/sec:${sec}`}], primary: 0}, {origin: 'test'});
  assert.equal(protectionDialog.preview(ctx(), protectionDialog.init(ctx())).currentSection, 'Private: not password protected');
  assert.match(protectionDialog.preview(ctx(), protectionDialog.init(ctx())).notes, /cannot recover|no one|nobody/i);
  const set = setDialog.init(ctx());
  assert.deepEqual(set, {sectionId: sec, password: '', confirm: ''});
  assert.deepEqual(setDialog.validate(set).map(p => p.field), ['password']);
  assert.deepEqual(setDialog.validate({...set, password: 'a', confirm: 'b'}), [{field: 'confirm', message: 'The passwords do not match.'}]);
  assert.deepEqual(setDialog.validate({...set, password: 'a', confirm: 'a'}), []);
  assert.deepEqual(setDialog.toCommand({...set, password: 'a', confirm: 'a'}), {command: 'password.set', params: {sectionId: sec, password: 'a'}});
  await t.exec('password.set', {sectionId: sec, password: 'a'});
  assert.equal(protectionDialog.preview(ctx(), protectionDialog.init(ctx())).currentSection, 'Private: password protected and unlocked');
  assert.deepEqual(protectionDialog.buttons.lockAll(ctx(), {}), {command: 'password.lockAll', params: {}});
  assert.deepEqual(changeDialog.validate({sectionId: sec, oldPassword: '', newPassword: 'x', confirm: 'y'}).map(p => p.field), ['oldPassword', 'confirm']);
  assert.deepEqual(changeDialog.toCommand({sectionId: sec, oldPassword: 'a', newPassword: 'b', confirm: 'b'}), {command: 'password.change', params: {sectionId: sec, oldPassword: 'a', newPassword: 'b'}});
  assert.deepEqual(removeDialog.validate({sectionId: sec, password: ''}).map(p => p.field), ['password']);
  assert.deepEqual(removeDialog.toCommand({sectionId: sec, password: 'a'}), {command: 'password.remove', params: {sectionId: sec, password: 'a'}});
  assert.equal(unlockDialog.init(ctx(), {sectionId: 'sX'}).sectionId, 'sX');
  assert.deepEqual(unlockDialog.toCommand({sectionId: sec, password: 'a'}), {command: 'password.unlock', params: {sectionId: sec, password: 'a'}});
  assert.deepEqual(protectionDialog.toCommand({}), {batch: []}, 'Close runs nothing');
  const status = (await t.exec('review.password', {})).result;
  assert.equal(status.sections.find(s => s.id === sec).protected, true);
});

// ---------------------------------------------------------------------------------------------
// Password Options: lock after a time, lock on navigating away (a fake clock, never a sleep)

const MIN_MS = 60_000;
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

test('Password Options: defaults, saved as preferences, and the dialog reads and submits them', async () => {
  const t = await privateSession();
  assert.deepEqual(lockOptions(t.session.prefs), {lockAfter: true, minutes: 10, onNavigate: false});
  assert.equal(LOCK_TIMES.length, 10);
  assert.equal(minutesOf('1 hour'), 60);
  assert.equal(labelOf(1440), '1 day');
  const ctx = () => t.session.readContext(t.docId);
  assert.deepEqual(optionsDialog.init(ctx()), {lockAfter: true, lockAfterTime: '10 minutes', lockOnNavigate: false});
  const call = optionsDialog.toCommand({lockAfter: true, lockAfterTime: '5 minutes', lockOnNavigate: true});
  assert.deepEqual(call, {command: 'review.passwordOptions', params: {lockAfter: true, minutes: 5, onNavigate: true}});
  assert.deepEqual((await t.exec(call.command, call.params)).result, {lockAfter: true, minutes: 5, onNavigate: true});
  assert.deepEqual(optionsDialog.init(ctx()), {lockAfter: true, lockAfterTime: '5 minutes', lockOnNavigate: true});
  assert.deepEqual(optionsDialog.validate({lockAfterTime: 'whenever'}).map(p => p.field), ['lockAfterTime']);
  await assert.rejects(t.exec('review.passwordOptions', {minutes: 7}), /Choose one of/);
});

test('a protected section locks after the chosen time with nothing done in it; work in it starts the time again', async () => {
  const t = await privateSession();
  const sec = t.sec('Private'), diary = t.pg('Diary');
  const off = watchActivity(t.session, t.docId, () => t.host.now());
  await t.exec('password.set', {sectionId: sec, password: PASSWORD});
  assert.equal(t.state('password.autoLock').enabled, true);
  t.host.advance(9 * MIN_MS);
  assert.deepEqual((await t.exec('password.autoLock')).result.locked, [], '9 minutes: not yet');
  // Work in the section (an edit): the ten minutes run from there.
  await t.exec('surface.title', {page: diary, title: 'Still here'});
  t.host.advance(9 * MIN_MS);
  assert.deepEqual((await t.exec('password.autoLock')).result.locked, [], '9 minutes after the edit: not yet');
  t.host.advance(2 * MIN_MS);
  const r = await t.exec('password.autoLock');
  assert.deepEqual(r.result.locked, [`/sec:${sec}`]);
  assert.equal(isLocked(t.content.sections[sec]), true);
  assert.equal(JSON.stringify(t.content).includes(SECRET), false);
  assert.equal(t.doc.undo.size, 0);
  assert.equal(t.state('password.autoLock').enabled, false, 'nothing left to lock');
  // The edit made before the lock is still there when it is unlocked again.
  await t.exec('password.unlock', {sectionId: sec, password: PASSWORD});
  assert.equal(t.content.pages[diary].title, 'Still here');
  t.host.advance(11 * MIN_MS);
  assert.equal((await t.exec('password.autoLock')).result.locked.length, 1, 'unlocking starts the time too');
  off();
});

test('Lock after is off, or a longer time chosen: nothing locks early', async () => {
  const t = await privateSession();
  const sec = t.sec('Private');
  await t.exec('password.set', {sectionId: sec, password: PASSWORD});
  await t.exec('review.passwordOptions', {lockAfter: false});
  t.host.advance(600 * MIN_MS);
  assert.equal(t.state('password.autoLock').enabled, false);
  assert.equal(isLocked(t.content.sections[sec]), false);
  await t.exec('review.passwordOptions', {lockAfter: true, minutes: 1});
  t.host.advance(61_000);
  assert.deepEqual((await t.exec('password.autoLock')).result.locked, [`/sec:${sec}`], 'one minute');
  await t.exec('password.unlock', {sectionId: sec, password: PASSWORD});
  await t.exec('review.passwordOptions', {minutes: 120});
  t.host.advance(119 * MIN_MS);
  assert.deepEqual((await t.exec('password.autoLock')).result.locked, []);
  t.host.advance(2 * MIN_MS);
  assert.equal((await t.exec('password.autoLock')).result.locked.length, 1, 'two hours');
});

test('Lock on navigate: opening another section locks the protected one just left', async () => {
  const t = await privateSession();
  const sec = t.sec('Private');
  const off = watchActivity(t.session, t.docId, () => t.host.now());
  await t.exec('password.set', {sectionId: sec, password: PASSWORD});
  const go = id => t.session.setSelection(t.docId, {ranges: [{anchor: id, focus: id}], primary: 0}, {origin: 'test'});
  // Off by default: moving away leaves it unlocked.
  go(`/pg:${t.pg('Home')}`);
  await settle();
  assert.equal(isLocked(t.content.sections[sec]), false);
  go(`/pg:${t.pg('Diary')}`);
  await t.exec('review.passwordOptions', {onNavigate: true});
  await settle();
  assert.equal(isLocked(t.content.sections[sec]), false, 'moving within the section does not lock it');
  go(`/pg:${t.pg('Plans')}`);
  await settle();
  assert.equal(isLocked(t.content.sections[sec]), false);
  go(`/pg:${t.pg('Home')}`);
  await settle();
  assert.equal(isLocked(t.content.sections[sec]), true, 'navigating to Public locked Private');
  assert.equal(JSON.stringify(t.content).includes(SECRET), false);
  assert.equal(t.doc.selection.ranges[0].anchor, `/pg:${t.pg('Home')}`, 'the selection stays where the person went');
  off();
});
