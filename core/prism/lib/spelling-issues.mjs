// The misspelt and repeated words of a deck (U:prism/spelling): shapes, table cells and notes, each paragraph in its runs' languages, read with the
// shared spelling service (core/common/lib/spelling.mjs): US English, the bundled en_US dictionary; the user dictionary and the ignore lists are the
// service's. The squiggles on the slide (SlideCanvas) and the Spelling pane's list are the same issues.
//
// Translated from deckcraft crates/engine/src/spell.rs (`misspelt`: repeated words first, then each word of the paragraph) and
// crates/ui-egui/src/canvas/squiggles.rs (a squiggle for each misspelt word of the shapes and table cells of the slide; the word the caret is in isn't marked;
// Ignore All hides a word, case-insensitively) at f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Where deckcraft checks the words against a dictionary it finds on the system, this checks them against the bundled one; Ignore Once (a single place) is
// PowerPoint's own. Not checked against upstream.

import {walk} from '../model/presentation.mjs';
import {runContent} from '../model/text.mjs';
import {spelling, wordsOf, isCheckedLanguage} from '../../common/lib/spelling.mjs';
import {COMMON_FIX, keepCase, paragraphWords, repeatedWords, checkLang} from './spell.mjs';

const slidesOf = c => c.slides ?? [];
const paraText = p => (p?.runs ?? []).map(runContent).join('');

/** Ignore Once's key for one issue: where it is and which word. */
export const issueKey = (at, word) => [at.slide, at.shape ?? 'notes', at.row ?? '', at.col ?? '', at.para, at.start, String(word).toLowerCase()].join('|');

/** The first suggestions for a word: the common correction first, then the dictionary's (from what the service already found). */
export function suggestionsFor(word, sp = spelling(), n = 6) {
  const fix = COMMON_FIX[word.toLowerCase()];
  const list = [...(fix ? [keepCase(word, fix)] : []), ...(sp.suggested(word, n) ?? [])];
  return [...new Set(list)].slice(0, n);
}

/** Calls f(paragraph, where) for every paragraph of the deck (or of slide `only`, without its notes): shapes, table cells and notes. */
function eachParagraph(doc, only, f) {
  slidesOf(doc).forEach((sl, i) => {
    if (only !== undefined && only !== i) return;
    walk(sl.shapes, sh => {
      (sh.text?.paragraphs ?? []).forEach((para, pi) => f(para, {slide: i, shape: sh.id, para: pi}));
      if (sh.kind?.type === 'table') {
        (sh.kind.rows ?? []).forEach((row, r) => (row.cells ?? []).forEach((cell, c) => {
          if (cell.hMerge || cell.vMerge) return;
          (cell.text?.paragraphs ?? []).forEach((para, pi) => f(para, {slide: i, shape: sh.id, row: r, col: c, para: pi}));
        }));
      }
    });
    if (only === undefined) (sl.notes?.paragraphs ?? []).forEach((para, pi) => f(para, {slide: i, notes: true, para: pi}));
  });
}

/**
 * The misspelt and repeated words of the deck: [{slide, shape?, row?, col?, notes?, para, start, end, word, lang, key, suggestions, repeated?, deleteFrom?}].
 * `o`: {sp, session (the document: its Ignore All and Ignore Once lists), slide (only this slide, no notes), caret: {shape, cell?, para, off} (its word is left out)}.
 * Sync, from what the service holds: a word not looked up yet is not reported (see `spellingIssuesAll`).
 */
export function spellingIssues(doc, lang, ignore = [], o = {}) {
  const sp = o.sp ?? spelling();
  const dflt = checkLang(doc, lang);
  const skip = new Set(ignore.map(w => String(w).toLowerCase()));
  const out = [];
  eachParagraph(doc, o.slide, (para, at) => {
    const underCaret = w => o.caret && o.caret.shape === at.shape && o.caret.para === at.para && (o.caret.cell ? o.caret.cell.join() : null) === (at.row !== undefined ? [at.row, at.col].join() : null)
      && o.caret.off >= w.start && o.caret.off <= w.end;
    const add = (w, extra) => {
      const issue = {...at, start: w.start, end: w.end, word: w.text, lang: w.lang, ...extra};
      issue.key = issueKey(issue, w.text);
      if (o.session !== undefined && sp.isIgnoredOnce(o.session, issue.key)) return;
      if (underCaret(w)) return;
      out.push(issue);
    };
    const rep = repeatedWords(para, dflt);
    for (const w of rep) if (!skip.has(w.text.toLowerCase())) add(w, {repeated: true, deleteFrom: w.repeated, suggestions: []});
    const repAt = new Set(rep.map(w => w.start));
    const words = paragraphWords(para, dflt);
    if (!words.length) return;
    const allowed = new Set(wordsOf(paraText(para)).map(t => t.start));
    for (const w of words) {
      if (skip.has(w.text.toLowerCase()) || repAt.has(w.start) || !allowed.has(w.start) || !isCheckedLanguage(w.lang)) continue;
      if (sp.check(w.text, o.session)) continue;
      add(w, {suggestions: suggestionsFor(w.text, sp)});
    }
  });
  return out;
}

/** Every word of the deck (or slide) looked up, then `spellingIssues`; the first `limit` issues also have the dictionary's suggestions. */
export async function spellingIssuesAll(doc, lang, ignore = [], o = {}) {
  const sp = o.sp ?? spelling();
  const dflt = checkLang(doc, lang);
  const words = [];
  eachParagraph(doc, o.slide, para => { for (const w of paragraphWords(para, dflt)) if (isCheckedLanguage(w.lang)) words.push(w.text); });
  await sp.prepare(words);
  const first = spellingIssues(doc, lang, ignore, {...o, sp});
  const n = o.suggest ?? 50;
  for (const it of first.slice(0, n)) if (!it.repeated) await sp.suggest(it.word, 6);
  return spellingIssues(doc, lang, ignore, {...o, sp});
}
