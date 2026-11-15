// The shared spelling service (core/common/lib/spelling.mjs) over the bundled en_US dictionary.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpelling, spelling, resetSpelling, isCheckedLanguage, wordsOf} from '../../core/common/lib/spelling.mjs';
import {openEngine} from '../../core/common/lib/spelling-engine.mjs';

let engine;
/** A service over the real dictionary, looked up in this thread. */
async function service() {
  engine ??= await openEngine('en-US');
  return createSpelling({check: async words => words.map(w => engine.correct(w)), suggest: async (w, n) => engine.suggest(w, n)});
}
const wrong = async (sp, text, opts) => (await sp.misspellingsAll(text, opts)).map(t => t.text);

test('known words are correct and misspellings are found', async () => {
  const sp = await service();
  await sp.prepare(['hello', 'world', 'recieve', 'teh', 'color', "don't", 'Arkemis']);
  assert.equal(sp.check('hello'), true);
  assert.equal(sp.check('Hello'), true, 'a capital at the start is fine');
  assert.equal(sp.check("don't"), true);
  assert.equal(sp.check('color'), true);
  assert.equal(sp.check('recieve'), false);
  assert.equal(sp.check('teh'), false);
  assert.equal(sp.check('Arkemis'), false, 'a name the dictionary has never seen');
  assert.deepEqual(await wrong(sp, 'The team will recieve the report teh next day.'), ['recieve', 'teh']);
});

test('curly apostrophes are the same as straight ones', async () => {
  const sp = await service();
  assert.deepEqual(await wrong(sp, 'They don\u2019t know what it\u2019s for, nor the team\u2019s plan.'), []);
});

test('suggestions come best first and are limited', async () => {
  const sp = await service();
  const s = await sp.suggest('recieve', 6);
  assert.equal(s[0], 'receive');
  assert.ok(s.length <= 6);
  assert.ok((await sp.suggest('helo', 3)).length <= 3);
  assert.ok((await sp.suggest('helo', 8)).includes('hello'));
  assert.deepEqual(await sp.suggest('recieve', 1), ['receive']);
});

test('a word not looked up yet counts as correct, is queued, and the version goes up when answers arrive', async () => {
  const sp = await service();
  const seen = [];
  const off = sp.subscribe(v => seen.push(v));
  const v0 = sp.version;
  assert.equal(sp.check('zzyzxqq'), true, 'unknown for now');
  assert.equal(sp.misspellings('a zzyzxqq here').length, 0);
  await sp.prepare(['zzyzxqq']);
  assert.ok(sp.version > v0);
  assert.ok(seen.length >= 1);
  assert.equal(sp.check('zzyzxqq'), false);
  assert.deepEqual(sp.misspellings('a zzyzxqq here').map(t => [t.start, t.end, t.text]), [[2, 9, 'zzyzxqq']]);
  off();
});

test('Ignore All is per session and covers every case of the word', async () => {
  const sp = await service();
  const text = 'Quillx and quillx and QUILLX, then Quillxy.';
  assert.deepEqual(await wrong(sp, text, {session: 'a'}), ['Quillx', 'quillx', 'Quillxy']);
  sp.ignoreAll('a', 'Quillx');
  assert.deepEqual(await wrong(sp, text, {session: 'a'}), ['Quillxy']);
  assert.deepEqual(await wrong(sp, text, {session: 'b'}), ['Quillx', 'quillx', 'Quillxy'], 'another document is not affected');
  assert.deepEqual(sp.ignoredWords('a'), ['quillx']);
  sp.recheck('a');
  assert.deepEqual(await wrong(sp, text, {session: 'a'}), ['Quillx', 'quillx', 'Quillxy']);
});

test('Ignore Once is a key the caller chose, cleared by Recheck', async () => {
  const sp = await service();
  assert.equal(sp.isIgnoredOnce('d', 'p1:teh:0'), false);
  sp.ignoreOnce('d', 'p1:teh:0');
  assert.equal(sp.isIgnoredOnce('d', 'p1:teh:0'), true);
  assert.equal(sp.isIgnoredOnce('d', 'p1:teh:1'), false);
  assert.equal(sp.isIgnoredOnce('e', 'p1:teh:0'), false);
  sp.recheck('d');
  assert.equal(sp.isIgnoredOnce('d', 'p1:teh:0'), false);
});

test('the user dictionary is kept, replaced from prefs and never touches the dictionary', async () => {
  const sp = await service();
  assert.deepEqual(await wrong(sp, 'Arkemis and Zenvo.'), ['Arkemis', 'Zenvo']);
  sp.addUserWord('Arkemis');
  sp.addUserWord('zenvo');
  assert.deepEqual(await wrong(sp, 'Arkemis and Zenvo and zenvo.'), [], 'lower-case entries match any case');
  assert.deepEqual(sp.userWords().sort(), ['Arkemis', 'zenvo']);
  assert.deepEqual(await wrong(sp, 'arkemis'), ['arkemis'], 'a capitalised entry is exact');
  sp.removeUserWord('zenvo');
  assert.deepEqual(await wrong(sp, 'zenvo'), ['zenvo']);
  sp.setUserWords(['Quillx']);
  assert.deepEqual(sp.userWords(), ['Quillx']);
  assert.deepEqual(await wrong(sp, 'Arkemis Quillx'), ['Arkemis']);
  assert.throws(() => sp.addUserWord('  '), /not a word/);
  assert.throws(() => sp.addUserWord('a\nb'), /not a word/);
  sp.setUserWords([]);
});

test('ALL CAPS words, words with numbers, one-letter words and addresses are skipped', async () => {
  const sp = await service();
  const text = [
    'NASA and XYZZYQ are shouted.', 'The part x7zq9 and abc123 and 3rd and B2B are codes.', 'A b c are letters.', 'my_variable_zz is a name.',
    'Visit http://example.com/recieve or www.exmple.com or mail teh@exmple.org now.',
    'Open C:\\Docs\\recieve.txt or \\\\server\\recieve\\file or /usr/lib/recieve or ~/recieve.txt.',
  ].join(' ');
  assert.deepEqual(await wrong(sp, text), []);
  assert.deepEqual(await wrong(sp, 'Xyzzyq is not shouted, and neither is recieve.'), ['Xyzzyq', 'recieve']);
  assert.deepEqual(wordsOf('See https://a.example/teh now').map(t => t.text), ['See', 'now']);
});

test('hyphenated words are checked part by part and offsets point into the text', async () => {
  const sp = await service();
  const text = 'A well-known teh-man, \u201cquoted recieve.\u201d';
  const bad = await sp.misspellingsAll(text);
  assert.deepEqual(bad.map(t => t.text), ['teh', 'recieve']);
  for (const t of bad) assert.equal(text.slice(t.start, t.end), t.text);
});

test('only US English is checked; other languages are the caller to leave out', () => {
  assert.equal(isCheckedLanguage('en-US'), true);
  assert.equal(isCheckedLanguage(undefined), true);
  assert.equal(isCheckedLanguage('en'), true);
  assert.equal(isCheckedLanguage('en-GB'), false);
  assert.equal(isCheckedLanguage('de-DE'), false);
});

test('skip(start, end) leaves a range out (text marked do not check spelling)', async () => {
  const sp = await service();
  assert.deepEqual(await wrong(sp, 'teh and recieve', {skip: s => s < 4}), ['recieve']);
});

test('the shared service loads the dictionary on the first use and answers like the dictionary does', async () => {
  resetSpelling();
  const sp = spelling();
  assert.equal(sp.loaded, false);
  assert.deepEqual(await wrong(sp, 'The seperate team'), ['seperate']);
  assert.equal(sp.loaded, true);
  resetSpelling();
});

test('a dictionary that fails to load makes nothing misspelt and does not loop', async () => {
  const sp = createSpelling({check: async () => { throw new Error('no dictionary'); }, suggest: async () => { throw new Error('no dictionary'); }});
  assert.equal(sp.check('qwzxv'), true);
  await sp.prepare(['qwzxv']);
  assert.equal(sp.check('qwzxv'), true);
  assert.deepEqual(await sp.suggest('qwzxv'), []);
});
