// Review > Proofing: Spelling (F7), Add to Dictionary, Ignore Once, Ignore All, Change, Change All, and the Thesaurus.
// Translated from gridcraft crates/engine/src/cmd/spelling.rs (`spelling`: the text cells of the range that hold no formula, each word
// checked, at most 500 misspelt words; `add_word`; `change`: one word of one cell, or every cell with `all`; `thesaurus`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Where gridcraft checks against the system word list, this checks against the bundled en_US dictionary through the shared service
// (core/common/lib/spelling.mjs): ALL CAPS words, words with digits and addresses are skipped as Office skips them, the user dictionary is
// prefs.userDictionary, and Ignore All and Ignore Once last as long as the workbook is open. Only text cells are checked (never a formula,
// number, date or error). The check starts at the active cell and goes on from the top (Excel asks before it wraps; the dialog says so).
// Ignore Once, Ignore All and the Thesaurus's cell replacement are Excel's own: not checked against upstream. The Thesaurus is the
// built-in word list of the Prism thesaurus (core/prism/lib/thesaurus.mjs), looked up offline.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {hasDoc, gridSel, targetSheet, targetRanges, requireSchema2} from '../../lib/edit-targets.mjs';
import {bad, failed, baseDoc} from '../../lib/data-common.mjs';
import {a1} from '../../lib/addr.mjs';
import {usedBounds, forEachCell, cellAt, writeCell} from '../../model/store.mjs';
import {lockedCellError} from '../edit/cell.mjs';
import {spellingFor, sessionKey, wordsOf, isCheckedLanguage} from '../../../common/lib/spelling.mjs';
import {lookup} from '../../../prism/lib/thesaurus.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/spelling.rs', 'crates/ui-egui/src/dialogs/spelling.rs']};
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));
const MAX_ISSUES = 500;
const MAX_CELLS = 200_000;

const keyOf = (sheetId, row, col, start, word) => `${sheetId}|${row}|${col}|${start}|${String(word).toLowerCase()}`;
/** The suggestion in the case the word was written in. */
const withCase = (word, sug) => {
  if (sug !== sug.toLowerCase()) return sug;
  if (word.length > 1 && word === word.toUpperCase()) return sug.toUpperCase();
  return /^\p{Lu}/u.test(word) ? sug.charAt(0).toUpperCase() + sug.slice(1) : sug;
};

/** The text cells to check, in the order Excel checks them: from the active cell to the end, then from the top. [{row, col, text}] */
function textCells(ctx, p) {
  const content = baseDoc(ctx);
  const sel = gridSel(ctx);
  const si = p?.sheet !== undefined ? targetSheet(ctx, p) : sel.sheet;
  const sheet = content.sheets[si];
  let areas;
  const used = usedBounds(sheet);
  if (typeof p?.range === 'string' && p.range.trim()) areas = targetRanges(ctx, {...p, sheet: si}, ['range']).areas;
  else if (sel.sheet === si && (sel.ranges.length > 1 || sel.ranges.some(r => r.start.row !== r.end.row || r.start.col !== r.end.col))) areas = sel.ranges;
  else areas = used ? [{start: {row: used.r0, col: used.c0}, end: {row: used.r1, col: used.c1}}] : [];
  const cells = [];
  const seen = new Set();
  for (const a of areas) {
    forEachCell(sheet, a.start.row, a.start.col, a.end.row, a.end.col, (row, col, cell) => {
      if (cells.length >= MAX_CELLS || !cell || cell.f !== undefined || typeof cell.v !== 'string' || !cell.v) return;
      const k = row * 20000 + col;
      if (seen.has(k)) return;
      seen.add(k);
      cells.push({row, col, text: cell.v});
    });
  }
  cells.sort((x, y) => x.row - y.row || x.col - y.col);
  // From the active cell (when the selection is a single cell on this sheet), then the cells above it.
  if (sel.sheet === si && !(typeof p?.range === 'string' && p.range.trim())) {
    const at = cells.findIndex(c => c.row > sel.active.row || (c.row === sel.active.row && c.col >= sel.active.col));
    if (at > 0) return {si, sheet, cells: [...cells.slice(at), ...cells.slice(0, at)], wrapAt: cells.length - at};
  }
  return {si, sheet, cells, wrapAt: null};
}

/** Review > Spelling: the misspelt words of the text cells with suggestions for the first ones. {issues, cells, wrapAt}. */
async function spellingCheck(ctx, p) {
  const sp = spellingFor(ctx.prefs);
  const session = sessionKey(ctx.host, ctx.docId);
  const {si, sheet, cells, wrapAt} = textCells(ctx, p ?? {});
  const ignore = new Set((Array.isArray(p?.ignore) ? p.ignore : []).map(w => String(w).toLowerCase()));
  await sp.prepare(cells.flatMap(c => wordsOf(c.text).map(w => w.text)));
  const issues = [];
  let lastSuggested = 0;
  for (let i = 0; i < cells.length && issues.length < MAX_ISSUES; i++) {
    const c = cells[i];
    for (const w of sp.misspellings(c.text, {session})) {
      if (ignore.has(w.text.toLowerCase())) continue;
      const key = keyOf(sheet.id, c.row, c.col, w.start, w.text);
      if (sp.isIgnoredOnce(session, key)) continue;
      issues.push({sheet: sheet.name, cell: a1(c.row, c.col), row: c.row, col: c.col, start: w.start, end: w.end, word: w.text, text: c.text, key, wrapped: wrapAt !== null && i >= wrapAt, suggestions: []});
      if (issues.length >= MAX_ISSUES) break;
    }
  }
  // Suggestions for the words the dialog will show first (each word once).
  const done = new Map();
  for (const it of issues.slice(0, 30)) {
    const lower = it.word.toLowerCase();
    if (!done.has(lower)) done.set(lower, (await sp.suggest(it.word, 6)).map(x => withCase(it.word, x)));
    it.suggestions = done.get(lower);
    lastSuggested += 1;
  }
  return {issues, cells: cells.length, sheet: sheet.name, sheetIndex: si, wrapAt, complete: issues.length === 0, lang: 'en-US'};
}

/** Suggestions for one word (the dialog asks for those the first answer did not carry). */
async function suggest(ctx, p) {
  const word = String(p.word ?? '').trim();
  if (!word) throw bad('review.spellingSuggest', 'missing `word`', {path: '/word'});
  const list = await spellingFor(ctx.prefs).suggest(word, 6);
  return list.map(x => withCase(word, x));
}

function addToDictionary(ctx, p) {
  const w = String(p.word ?? '').trim();
  if (!w) throw bad('review.addToDictionary', 'missing `word`', {path: '/word'});
  if (/\s/.test(w)) throw bad('review.addToDictionary', `${JSON.stringify(w)} isn't a single word`, {path: '/word'});
  const sp = spellingFor(ctx.prefs);
  try { sp.addUserWord(w); } catch (e) { throw bad('review.addToDictionary', e.message, {path: '/word'}); }
  const list = ctx.prefs?.userDictionary ?? [];
  if (!list.includes(w)) ctx.updatePrefs({userDictionary: [...list, w]});
  return {word: w};
}

const isLetter = ch => ch !== undefined && /[\p{L}\p{M}'\-]/u.test(ch);
/** `text` with the whole word `word` replaced by `to` at `start` (when given and it is there), else the first whole-word hit; null when it is not there. */
function swapWord(text, word, to, start, all) {
  const out = [];
  let i = 0, changed = 0;
  const lw = word.toLowerCase();
  while (i < text.length) {
    const at = text.toLowerCase().indexOf(lw, i);
    if (at < 0) break;
    const before = text[at - 1], after = text[at + word.length];
    const whole = !isLetter(before) && !isLetter(after);
    const wanted = whole && (all || start === undefined || at === start);
    out.push(text.slice(i, at), wanted ? to : text.slice(at, at + word.length));
    i = at + word.length;
    if (wanted) { changed += 1; if (!all) break; }
  }
  if (!changed) return null;
  out.push(text.slice(i));
  return {text: out.join(''), changed};
}

/** Change and Change All. */
function changeSpelling(ctx, p) {
  const C = 'review.changeSpelling';
  const word = String(p.word ?? '');
  if (!word) throw bad(C, 'missing `word`', {path: '/word'});
  if (typeof p.to !== 'string') throw bad(C, 'missing `to`', {path: '/to'});
  const content = baseDoc(ctx);
  const si = p.sheet !== undefined ? targetSheet(ctx, p) : gridSel(ctx).sheet;
  requireSchema2(ctx, si);
  const sheet = content.sheets[si];
  const targets = [];
  if (p.all === true) {
    forEachCell(sheet, 0, 0, 1_048_575, 16_383, (row, col, cell) => { if (cell && cell.f === undefined && typeof cell.v === 'string') targets.push({row, col}); });
  } else {
    const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(String(p.cell ?? '').replace(/^.*!/, ''));
    if (!m) throw bad(C, 'missing `cell`', {path: '/cell'});
    const col = [...m[1].toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    targets.push({row: Number(m[2]) - 1, col});
  }
  let changed = 0;
  for (const t of targets) {
    const cell = cellAt(sheet, t.row, t.col);
    if (!cell || cell.f !== undefined || typeof cell.v !== 'string') { if (p.all !== true) throw failed(`${a1(t.row, t.col)} holds no text.`); continue; }
    const swapped = swapWord(cell.v, word, p.to, p.all === true ? undefined : p.start, p.all === true);
    if (!swapped) { if (p.all !== true) throw failed(`The word ${JSON.stringify(word)} is no longer in ${a1(t.row, t.col)}.`); continue; }
    const locked = lockedCellError(ctx, si, t.row, t.col);
    if (locked) { if (p.all === true) continue; throw failed(locked); }
    writeCell(ctx.change, ctx.doc, si, t.row, t.col, {...cell, v: swapped.text});
    changed += swapped.changed;
  }
  return {changed};
}

function ignoreAll(ctx, p) {
  const w = String(p.word ?? '').trim();
  if (!w) throw bad('review.ignoreAll', 'missing `word`', {path: '/word'});
  spellingFor(ctx.prefs).ignoreAll(sessionKey(ctx.host, ctx.docId), w);
  return {ignored: w};
}
function ignoreOnce(ctx, p) {
  if (typeof p.key !== 'string' || !p.key) throw bad('review.ignoreOnce', 'missing `key`', {path: '/key'});
  spellingFor(ctx.prefs).ignoreOnce(sessionKey(ctx.host, ctx.docId), p.key);
  return {ignored: p.key};
}

/** Undo Last in the Spelling dialog for what the person did that is not a cell change: Ignore Once, Ignore All and Add to Dictionary are taken back. */
function undoSpelling(ctx, p) {
  const C = 'review.undoSpelling';
  const sp = spellingFor(ctx.prefs);
  const session = sessionKey(ctx.host, ctx.docId);
  switch (p.action) {
    case 'ignoreOnce':
      if (typeof p.key !== 'string' || !p.key) throw bad(C, 'missing `key`', {path: '/key'});
      sp.unignoreOnce(session, p.key);
      return {undone: p.key};
    case 'ignoreAll': {
      const w = String(p.word ?? '').trim();
      if (!w) throw bad(C, 'missing `word`', {path: '/word'});
      sp.unignoreAll(session, w);
      return {undone: w};
    }
    case 'add': {
      const w = String(p.word ?? '').trim();
      if (!w) throw bad(C, 'missing `word`', {path: '/word'});
      sp.removeUserWord(w);
      ctx.updatePrefs({userDictionary: (ctx.prefs?.userDictionary ?? []).filter(x => x !== w)});
      return {undone: w};
    }
    default: throw bad(C, '`action` is ignoreOnce, ignoreAll or add', {path: '/action'});
  }
}

// ---------------------------------------------------------------- Thesaurus

/** The word a Thesaurus lookup starts from: the active cell's text when it is one word, else its first word. */
function cellWord(ctx) {
  const content = baseDoc(ctx);
  const sel = gridSel(ctx);
  const cell = cellAt(content.sheets[sel.sheet], sel.active.row, sel.active.col);
  const text = typeof cell?.v === 'string' && cell.f === undefined ? cell.v.trim() : '';
  return {text, word: wordsOf(text)[0]?.text ?? '', cell: a1(sel.active.row, sel.active.col)};
}

/** Review > Thesaurus: the synonyms of `word` (default the active cell's word) by meaning; with `to` the active cell's text becomes that synonym. */
function thesaurus(ctx, p) {
  const here = cellWord(ctx);
  const word = String(p.word ?? here.word ?? '').trim();
  if (typeof p.to === 'string') {
    const content = baseDoc(ctx);
    const sel = gridSel(ctx);
    requireSchema2(ctx, sel.sheet);
    const cell = cellAt(content.sheets[sel.sheet], sel.active.row, sel.active.col);
    if (!cell || cell.f !== undefined || typeof cell.v !== 'string') throw failed('The Thesaurus replaces the text of a text cell. Select one first.');
    const locked = lockedCellError(ctx, sel.sheet, sel.active.row, sel.active.col);
    if (locked) throw failed(locked);
    writeCell(ctx.change, ctx.doc, sel.sheet, sel.active.row, sel.active.col, {...cell, v: p.to});
    return {cell: here.cell, text: p.to};
  }
  return {word, cell: here.cell, senses: word ? lookup(word) : []};
}

const spellingState = ctx => {
  const st = hasDoc(ctx);
  if (!st.enabled) return st;
  return isCheckedLanguage('en-US') ? {enabled: true} : {enabled: false, reason: 'no dictionary'};
};

export default defineCommands({
  family: 'review/proofing',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'review.spelling', label: 'Spelling', risk: 'read', effect: 'view', dialog: 'dialog.spelling',
      description: 'Spelling (Review > Proofing, F7): the misspelt words of the text cells (never formulas or numbers) of `range` (default the selection when it is more than one cell, else the sheet) of `sheet`, from the active cell on: {issues: [{sheet, cell, row, col, start, end, word, text, key, wrapped, suggestions}], cells, complete}. `ignore` lists words left out. US English, the bundled en_US dictionary; the dialog opens on the first word.',
      params: s.object({range: s.optional(s.string({max: 4096})), sheet: SHEET, ignore: s.optional(s.array(s.string({max: 255}), {max: 1000}))}),
      state: spellingState, run: spellingCheck},
    {id: 'review.spellingSuggest', label: 'Spelling Suggestions', risk: 'read', effect: 'view', description: 'Query: {word} -> up to six corrections, best first.',
      params: s.object({word: s.string({min: 1, max: 255})}), state: spellingState, run: suggest},
    {id: 'review.addToDictionary', label: 'Add to Dictionary', risk: 'edit', effect: 'view',
      description: 'Add to Dictionary: {word} is never reported again; the user dictionary is kept in this app\'s preferences (prefs.userDictionary) and is not sent anywhere.',
      params: s.object({word: s.string({min: 1, max: 255})}), state: hasDoc, run: addToDictionary},
    {id: 'review.changeSpelling', label: 'Change', risk: 'edit',
      description: 'Change and Change All: {cell, word, to, start?} replaces the whole word in that cell (the one at `start`, else the first); with `all` every text cell of the sheet with that word. Locked cells of a protected sheet are left alone.',
      params: s.object({sheet: SHEET, cell: s.optional(s.string({max: 64})), word: s.string({min: 1, max: 255}), to: s.string({max: 255}), start: s.optional(s.integer({min: 0})), all: s.optional(s.boolean())}),
      state: hasDoc, run: changeSpelling},
    {id: 'review.ignoreAll', label: 'Ignore All', risk: 'read', effect: 'view', description: 'Ignore All: {word} (any case) is not reported while this workbook is open.',
      params: s.object({word: s.string({min: 1, max: 255})}), state: hasDoc, run: ignoreAll},
    {id: 'review.ignoreOnce', label: 'Ignore Once', risk: 'read', effect: 'view', description: 'Ignore Once: {key} (an issue\'s `key`) is not reported at that place while this workbook is open.',
      params: s.object({key: s.string({min: 1, max: 1000})}), state: hasDoc, run: ignoreOnce},
    {id: 'review.undoSpelling', label: 'Undo Last', risk: 'edit', effect: 'view',
      description: 'Undo Last (Spelling dialog): takes back an Ignore Once ({action: "ignoreOnce", key}), an Ignore All ({action: "ignoreAll", word}) or an Add to Dictionary ({action: "add", word}). A Change is undone with Undo.',
      params: s.object({action: s.enum(['ignoreOnce', 'ignoreAll', 'add']), key: s.optional(s.string({max: 1000})), word: s.optional(s.string({max: 255}))}), state: hasDoc, run: undoSpelling},
    {id: 'review.thesaurus', label: 'Thesaurus', risk: 'edit', dialog: 'dialog.thesaurus',
      description: 'Thesaurus (Review > Proofing, Shift+F7): {word?} (default the word of the active cell) -> {word, cell, senses: [{word, synonyms}]}; with `to` the active text cell\'s text becomes that synonym. A small built-in English word list, looked up offline.',
      params: s.object({word: s.optional(s.string({max: 255})), to: s.optional(s.string({max: 255}))}), state: hasDoc, run: thesaurus},
  ],
});

export {textCells, swapWord};
