// Ports of the upstream Rust tests for the Insert tab: wordcraft
// crates/engine/src/cmd/insert/tests.rs at aadb077e072b7de05f724e359d8db82e151f125c. Each test
// names the Rust test it ports.
//
// Behaviour fidelity:
// 1. ArtCraft (cmd/insert.rs and insert/{objects,items,links,header_footer}.rs): bookmarks span
//    the selection and are moved by re-adding a name, deleted with both their marks; a symbol in
//    its own font leaves the caret's font for what follows; Edit Header on a page creates the
//    header slot that page shows and Close takes an unwritten one away again; date pictures follow
//    Word's (d, dd, ddd, dddd, M…MMMM, yy, yyyy, h, hh, H, HH, mm, ss, am/pm). Word's Insert tab
//    behaves the same.
// 2. Ours runs the same code on the schema-2 model through the kernel (one undo step each).
// 3. These tests (engine), tests/quill/insert.test.mjs (undo round trips of every Insert command)
//    and tests/e2e/quill/insert-tab.e2e.mjs (the ribbon and dialogs through the bridge).
// Not ported: tiffs_with_jpeg_strips_are_refused (needs the `image` crate's TIFF writer; the
// probe's TIFF compression refusal is covered in tests/quill/insert.test.mjs with a hand-made
// header), an_empty_new_header_is_never_saved / the docx read-back half of
// edit_header_on_a_page_creates_its_slot (the docx writer is the formats-docx unit's).

import test from 'node:test';
import assert from 'node:assert/strict';
import {doc, blocks, ready, selectBody, selectedText, selPositions} from '../table-helpers.mjs';
import {base64Decode, base64Encode} from '../../../core/quill/lib/insert-objects.mjs';
import {bookmarkNameOk, formatDate, formatDateParts} from '../../../core/quill/commands/insert.mjs';
import * as P from '../../../core/quill/model/para.mjs';

await ready();
const enc = s => new TextEncoder().encode(s);

/** Every bookmark mark in the body, in order: [paragraph, start?, name]. */
function bookmarkMarks(t) {
  const out = [];
  blocks(t).forEach((p, i) => {
    if (p.kind !== 'para') return;
    for (const [, o] of P.objectsWithOffsets(p)) {
      if (o.type === 'bookmarkStart') out.push([i, true, o.name]);
      else if (o.type === 'bookmarkEnd') out.push([i, false, o.name]);
    }
  });
  return out;
}
const rejects = async (p, re) => { try { await p; } catch (e) { if (re) assert.match(String(e.message), re); return e; } assert.fail('expected an error'); };

test('insert/tests.rs base64_round_trip', () => {
  const data = enc('hello world!?');
  assert.deepEqual(base64Decode(base64Encode(data)), data);
  assert.equal(base64Decode('!!!'), null);
});

test('insert/tests.rs deleting_a_bookmark_removes_its_start_and_end', async () => {
  const t = await doc('Alpha beta\ngamma delta');
  selectBody(t, [0, 6], [1, 5]);
  await t.exec('insert.bookmark', {name: 'Across'});
  assert.deepEqual(bookmarkMarks(t), [[0, true, 'Across'], [1, false, 'Across']]);
  await t.exec('edit.goto', {bookmark: 'Across'});
  const picked = selectedText(t).replace(/￼/g, '');
  assert.ok(picked.startsWith('beta') && picked.endsWith('gamma'), JSON.stringify(picked));
  await t.exec('select.text', {text: 'delta'});
  await t.exec('insert.deleteBookmark', {name: 'Across'});
  assert.deepEqual(bookmarkMarks(t), []);
  assert.deepEqual(blocks(t).map(b => P.plainText(b)), ['Alpha beta', 'gamma delta']);
  assert.equal(selectedText(t), 'delta', 'the selection stays on its text');
  await rejects(t.exec('insert.deleteBookmark', {name: 'Across'}));
  await t.undo();
  assert.equal(bookmarkMarks(t).length, 2, 'one undo step');
});

test('insert/tests.rs adding_a_bookmark_again_moves_all_of_it', async () => {
  const t = await doc('Alpha beta\ngamma delta');
  selectBody(t, [0, 6], [1, 5]);
  await t.exec('insert.bookmark', {name: 'Spot'});
  await t.exec('select.text', {text: 'delta'});
  await t.exec('insert.bookmark', {name: 'Spot'});
  assert.deepEqual(bookmarkMarks(t), [[1, true, 'Spot'], [1, false, 'Spot']]);
  const p = blocks(t)[1];
  const offs = P.objectsWithOffsets(p).map(([o]) => o);
  assert.equal(p.text.slice(offs[0] + 1, offs[1]), 'delta');
});

test('insert/tests.rs bookmark_name_validation_rules (#3491)', async () => {
  for (const ok of ['Mark1', 'A', 'Alpha_Beta_123', '_Hidden', '_foo', 'быстрый_доступ_к_документам', 'a'.repeat(40), 'я'.repeat(40)]) assert.ok(bookmarkNameOk(ok), ok);
  for (const bad of ['', '1mark', 'a&b', 'a!b', 'a-b', 'a.b', 'foo bar', 'a'.repeat(41), 'я'.repeat(41)]) assert.ok(!bookmarkNameOk(bad), bad);
  const t = await doc('Test content');
  await t.exec('insert.bookmark', {name: 'быстрый_доступ_к_документам'});
  await t.exec('insert.bookmark', {name: '_Hidden'});
  await rejects(t.exec('insert.bookmark', {name: '1mark'}));
  await rejects(t.exec('insert.bookmark', {name: 'a&b'}));
  await rejects(t.exec('insert.bookmark', {name: 'a!b'}));
});

const docEnd = async t => { selectBody(t, [blocks(t).length - 1, P.plainText(blocks(t).at(-1)).length], [blocks(t).length - 1, P.plainText(blocks(t).at(-1)).length]); };

test('insert/tests.rs a_mixed_symbol_string_keeps_symbols_and_text_apart', async () => {
  const t = await doc('a');
  await docEnd(t);
  await t.exec('insert.symbol', {char: 'A', font: 'My Custom Font'});
  const p = blocks(t)[0];
  assert.equal(P.propsOfChar(p, 1).symFont, 'My Custom Font', 'the private-use glyph');
  assert.equal(P.propsOfChar(p, 2).symFont, undefined, 'the plain letter');
  assert.equal(P.propsOfChar(p, 2).font, 'My Custom Font');
});

test('insert/tests.rs an_astral_symbol_stays_text_in_its_font', async () => {
  const t = await doc('a');
  await docEnd(t);
  await t.exec('insert.symbol', {char: '\u{1F600}', font: 'Wingdings'});
  const p = blocks(t)[0];
  assert.equal(P.propsOfChar(p, 1).symFont, undefined, 'w:sym can\'t hold it');
  assert.equal(P.propsOfChar(p, 1).font, 'Wingdings');
});

test('insert/tests.rs symbol_takes_its_own_font', async () => {
  const t = await doc('ab');
  await docEnd(t);
  await t.exec('insert.symbol', {char: '♥', font: 'DejaVu Sans'});
  await t.exec('text.insert', {text: 'c'});
  const p = blocks(t)[0];
  assert.equal(p.text, 'ab♥c');
  assert.equal(P.propsOfChar(p, 2).font, 'DejaVu Sans', 'the symbol');
  assert.equal(P.propsOfChar(p, 3).font, undefined, 'typing after it');
  await rejects(t.exec('insert.symbol', {char: ''}));
});

test('insert/tests.rs date_pictures', () => {
  assert.equal(formatDateParts('MM/DD/YYYY', 2026, 10, 21, [17, 27, 3], 0), '10/21/2026');
  assert.equal(formatDateParts('D MMMM YYYY', 2026, 10, 21, [17, 27, 3], 0), '21 October 2026');
  assert.equal(formatDateParts('hh:mm', 2026, 10, 21, [17, 27, 3], 0), '05:27');
  assert.equal(formatDateParts('h:mm', 2026, 10, 21, [17, 27, 3], 0), '5:27');
  assert.equal(formatDateParts('HH:mm', 2026, 10, 21, [5, 7, 3], 0), '05:07');
  assert.equal(formatDate('yyyy-MM-dd', Date.now()).length, 10);
  assert.ok(formatDate('MMMM d, yyyy', Date.now()).includes(', '));
  const tm = formatDate('h:mm:ss am/pm', Date.now());
  assert.ok(tm.endsWith(' AM') || tm.endsWith(' PM'), tm);
  assert.equal(tm.split(':').length - 1, 2, tm);
});

async function twoPages() {
  const t = await doc('');
  await t.exec('text.insert', {text: 'One'});
  await t.exec('insert.pageBreak');
  await t.exec('text.insert', {text: 'Two'});
  return t;
}
const lastSection = t => t.content.lastSection ?? t.content.sections?.at?.(-1) ?? t.content.section;
const headerParts = t => Object.values(t.content.parts ?? {}).filter(p => p.kind === 'header' || p.kind === 'footer').length;

test('insert/tests.rs close_header_returns_to_the_body_selection (#3331)', async () => {
  const t = await twoPages();
  await t.exec('select.text', {text: 'Two'});
  const before = structuredClone(t.doc.selection);
  await t.exec('insert.editHeader');
  await t.exec('text.insert', {text: 'Head'});
  await t.exec('insert.closeHeader');
  assert.deepEqual(t.doc.selection, before);
  await t.exec('insert.editFooter', {page: 1});
  await t.exec('insert.closeHeader');
  assert.deepEqual(t.doc.selection, before);
  assert.equal(headerParts(t), 1, 'the empty footer made by the double-click is taken away');
});

test('insert/tests.rs edit_header_on_a_page_creates_its_slot (#960)', async () => {
  const t = await twoPages();
  const r = await t.exec('insert.editHeader', {page: 1});
  const id = r.result.story;
  assert.ok(id !== undefined && id !== null, JSON.stringify(r.result));
  assert.equal(selPositions(t).focus.story, id);
  await t.exec('insert.closeHeader');
  assert.equal(headerParts(t), 0, 'closing it unwritten leaves no header');
  // A written footer stays.
  const f = await t.exec('insert.editFooter', {page: 0});
  await t.exec('text.insert', {text: 'Foot'});
  await t.exec('insert.closeHeader');
  assert.equal(headerParts(t), 1);
  assert.ok(Object.keys(t.content.parts).map(Number).includes(Number(f.result.story)));
  // A junk page is an error, not a crash.
  await rejects(t.exec('insert.editHeader', {page: 99}));
  void lastSection;
});

test('insert/tests.rs creating_a_header_is_an_undoable_protected_edit (undo half)', async () => {
  const t = await twoPages();
  await t.exec('insert.editHeader', {page: 1});
  assert.equal(headerParts(t), 1);
  await t.undo();
  assert.equal(headerParts(t), 0, 'undo takes the new header away');
});
