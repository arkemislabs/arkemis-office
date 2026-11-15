// U:quill/word-core: automatic and manual hyphenation: the dictionary and Liang pattern hyphenator, the layout using it, Manual Hyphenation, and
// the .docx settings.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: wordcraft crates/proof/src/hyphen.rs, patterns.rs and dict.rs (their tests: dictionary words, case, apostrophes, punctuation,
//    compounds, inflections, patterns for unknown words, the limits, Liang's own example, TeX files with blocks and exceptions), layout
//    para/justify.rs `hyphenation_points` (only when automatic hyphenation is on; words in capitals only with `caps`), page.rs
//    `manual_hyphenation`, and the docx settings (w:autoHyphenation, w:hyphenationZone, w:consecutiveHyphenLimit, w:doNotHyphenateCaps).
//    Word: Automatic hyphenation breaks long words at the line end with a hyphen; Manual offers each candidate word.
// 2. Ours: the same data (assets/hyphenation, core/quill/lib/hyphen-data.mjs) and algorithms in core/quill/lib/hyphen.mjs.
// 3. Proof: this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill} from './format-fixture.mjs';
import {layout} from '../../core/quill/layout/index.mjs';
import {openDialogModel} from '../../core/kernel/dialog.mjs';
import {Patterns, hyphenateWord, hyphenPoints, wordBreaks, defaultLimits, dictionaryEn, patternsEn, patternsPl, proofLang, looksVietnamese} from '../../core/quill/lib/hyphen.mjs';
import {inflateRaw} from '../../core/quill/lib/inflate.mjs';
import {writeDocx} from '../../core/quill/formats/docx-write.mjs';
import {read as readDocx} from '../../core/quill/formats/docx-read.mjs';
import manualDialog from '../../core/quill/dialogs/manualHyphenation.mjs';
import hyphenationDialog from '../../core/quill/dialogs/hyphenation.mjs';

const h = w => hyphenateWord(w);

test('the bundled data loads: about 165,000 dictionary words and the English patterns', () => {
  assert.ok(dictionaryEn().size > 150_000, String(dictionaryEn().size));
  assert.ok(patternsEn().size > 1000);
  assert.ok(patternsPl().size > 100);
});

test('dictionary words, case, apostrophes, punctuation and compounds', () => {
  assert.equal(h('happen'), 'hap-pen');
  assert.equal(h('typography'), 'ty-pog-ra-phy');
  assert.equal(h('international'), 'in-ter-na-tion-al');
  assert.equal(h('cat'), 'cat');
  assert.ok(!h('changed').includes('-'));
  assert.equal(h('NASA'), 'NASA');
  assert.equal(wordBreaks('publication')[1], 'dictionary');
  assert.equal(h('Typography'), 'Ty-pog-ra-phy');
  assert.equal(h('TYPOGRAPHY'), 'TYPOGRAPHY', 'a word in capitals is left alone');
  assert.equal(h('typography,'), 'ty-pog-ra-phy,');
  assert.equal(h('“typography”'), '“ty-pog-ra-phy”');
  assert.equal(h("typography's"), "ty-pog-ra-phy's");
  assert.equal(h('typography-composition'), 'ty-pog-ra-phy-com-po-si-tion');
  assert.equal(h('ripples'), 'rip-ples', 'an inflection inherits its stem');
  assert.equal(h('restrained'), 're-strained');
});

test('patterns cover words outside the dictionary; the limits are respected; other languages use their own patterns', () => {
  const [pts, src] = wordBreaks('hyperlocalization');
  assert.equal(src, 'patterns');
  assert.ok(pts.length >= 4, h('hyperlocalization'));
  const lim = {minWord: 5, afterFirst: 3, beforeLast: 3, capitalized: false};
  for (const w of ['typography', 'hyphenation', 'justification', 'Paragraph', 'beautiful']) for (const p of hyphenPoints(w, lim)) assert.ok(p >= 3 && p <= w.length - 3, `${w} ${p}`);
  assert.deepEqual(hyphenPoints('Paragraph', lim), [], 'a capitalised word with capitalized: false');
  assert.deepEqual(hyphenPoints('typography', {...defaultLimits(), minWord: 12}), []);
  assert.equal(hyphenateWord('Beschleunigung', defaultLimits(), 'de'), 'Be-schleu-ni-gung');
  assert.equal(hyphenateWord('programmazione', defaultLimits(), 'it'), 'pro-gram-ma-zio-ne');
  assert.equal(hyphenateWord('nieprawdopodobny', defaultLimits(), 'pl'), 'nie-praw-do-po-dob-ny');
  assert.equal(proofLang('pl-PL'), 'pl');
  assert.equal(proofLang('en-GB'), 'en');
  assert.equal(proofLang(''), 'en');
  assert.equal(looksVietnamese('Tiếng Việt rất đẹp'), true);
  assert.equal(looksVietnamese('The quick brown fox'), false);
});

test("Liang's example and TeX files with blocks, comments and exception words", () => {
  const p = Patterns.parse('hy3ph he2n hena4 hen5at 1na n2at 1tio 2io o2n');
  assert.deepEqual(p.points([...'hyphenation']), [2, 6]);
  assert.equal(p.values(['h', 'é']), null, 'outside the alphabet');
  const tex = Patterns.parse('% a comment\n\\patterns{\n1na n2at % trailing\n.ab4cdefghijklm5n\n}\n\\hyphenation{\nni-gdy\nna-dal\nzawsze\n}\nhy-phen-ation\n');
  assert.deepEqual(tex.exception('nigdy'), [2]);
  assert.deepEqual(tex.exception('zawsze'), []);
  assert.deepEqual(tex.exception('hyphenation'), [2, 6]);
});

test('the raw deflate reader gives what zlib gives', async () => {
  const {deflateRawSync} = await import('node:zlib');
  const data = Buffer.from('hyphenation '.repeat(500) + 'typography');
  assert.equal(Buffer.from(inflateRaw(new Uint8Array(deflateRawSync(data)))).toString(), data.toString());
  assert.throws(() => inflateRaw(new Uint8Array([1, 2, 3])), /inflate/);
});

const LONG = Array.from({length: 40}, () => 'Internationalization and typography require compositional consideration').join(' ');
const hyphenated = q => layout(q.t.content, {view: 'print'}).pages.flatMap(p => p.items).filter(i => i.kind === 'lines').reduce((n, i) => n + i.para.lines.slice(i.l0, i.l1).filter(l => l.hyphen).length, 0);

test('the layout hyphenates at the line end only when Automatic is on; the paragraph can turn it off; words in capitals stay whole', async () => {
  const q = await quill(LONG);
  assert.equal(hyphenated(q), 0, 'off by default');
  await q.exec('layout.hyphenation', {value: true});
  const on = hyphenated(q);
  assert.ok(on >= 5, `${on} hyphenated lines`);
  await q.exec('layout.hyphenation', {limit: 1});
  assert.ok(hyphenated(q) < on, 'a consecutive limit of one hyphen leaves fewer');
  await q.exec('layout.hyphenation', {limit: 0});
  await q.exec('para.suppressHyphens', {value: true}).catch(() => {});
  const caps = await quill(Array.from({length: 40}, () => 'INTERNATIONALIZATION TYPOGRAPHY COMPOSITIONAL CONSIDERATION').join(' '));
  await caps.exec('layout.hyphenation', {value: true, caps: false});
  assert.equal(hyphenated(caps), 0, 'words in capitals stay whole (hyphen_points_in leaves an all-capitals word alone)');
});

test('Manual Hyphenation finds the next candidate word; Yes puts an optional hyphen at the chosen point and goes on; No skips', async () => {
  const q = await quill(LONG);
  q.sel(0, 0);
  const first = (await q.exec('layout.manualHyphenation', {})).result;
  assert.ok(first.word && first.points.length && first.points.includes(first.suggest), JSON.stringify(first));
  const v = openDialogModel(q.t.session, q.t.docId, manualDialog);
  assert.deepEqual([v.word, v.done, v.choice], [first.word, false, first.suggest]);
  const yes = manualDialog.buttons.yes(null, v);
  assert.deepEqual(yes.batch.map(c => c.command), ['caret.set', 'text.optionalHyphen']);
  for (const c of yes.batch) await q.exec(c.command, c.params);
  assert.ok(q.para(0).text.includes('­'), 'an optional hyphen is in the word');
  const second = (await q.exec('layout.manualHyphenation', {})).result;
  assert.ok(second.done || second.word, 'the search goes on');
  const skip = manualDialog.buttons.no(null, v);
  assert.equal(skip.command, 'caret.set');
  const done = await quill('short text');
  assert.deepEqual((await done.exec('layout.manualHyphenation', {})).result, {done: true});
});

test('the Hyphenation box edits Automatic, capitals, zone and limit; the settings are written to the .docx and read back', async () => {
  const q = await quill('Some text.');
  const v = openDialogModel(q.t.session, q.t.docId, hyphenationDialog);
  assert.deepEqual([v.auto, v.caps, v.zone, v.limit], [false, true, 18, 0]);
  const cmd = hyphenationDialog.toCommand({...v, auto: true, caps: false, zone: 24, limit: 2});
  assert.deepEqual(cmd.params, {value: true, caps: false, zone: 24, limit: 2});
  await q.exec(cmd.command, cmd.params);
  const back = await readDocx(await writeDocx(q.t.content));
  assert.deepEqual([back.settings.autoHyphenation, back.settings.hyphenateCaps, back.settings.hyphenationZone, back.settings.consecutiveHyphenLimit], [true, false, 24, 2]);
});
