// Proofing (U:quill/review): Word Count, the Thesaurus, and the proofing language.
//
// Translated from wordcraft crates/engine/src/cmd/review/proofing.rs (`word_count`, `thesaurus`)
// and crates/engine/src/cmd/tools/actions.rs (`language`) with crates/proof/src/lang.rs
// (`normalize_tag`) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import * as P from '../model/para.mjs';
import {BODY} from '../model/document.mjs';
import {countWords} from '../model/text.mjs';
import {ordered, samePos, samePath} from './caret-session.mjs';

const DRAWINGS = new Set(['image', 'graphic', 'shape', 'group']);

/** A selected picture, shape or text box: one drawing character selected (objects::object_selection). */
export function objectSelected(d, sel) {
  const [a, b] = ordered(sel);
  if (a.story !== b.story || !samePath(a.path, b.path) || b.off !== a.off + 1) return false;
  const p = d.paraAt(a);
  if (!p || p.text[a.off] !== P.OBJ) return false;
  return DRAWINGS.has(P.objectAt(p, a.off)?.type);
}

/** The selected text, paragraphs on new lines (Session::selected_text). */
export function selectedText(d, sel) {
  const [a, b] = ordered(sel);
  if (a.story !== b.story) return '';
  const out = [];
  for (const path of d.pathsBetween(a, b)) {
    const p = d.para(a.story, path);
    if (!p) continue;
    const from = samePath(path, a.path) ? a.off : 0, to = samePath(path, b.path) ? b.off : p.text.length;
    out.push(P.plainText({...p, text: p.text.slice(from, to), objects: (p.objects ?? []).slice(P.objectsBefore(p, from), P.objectsBefore(p, to))}));
  }
  return out.join('\n');
}

/**
 * Word Count (word_count): pages, words, characters with and without spaces, paragraphs and
 * lines of the selection, else of the document (with `includeTextBoxes`, its text boxes,
 * footnotes and endnotes too). `lay` is the document's layout.
 */
export function wordCount(d, sel, lay, includeTextBoxes) {
  const stories = includeTextBoxes ? d.countedStories() : [BODY];
  const whole = samePos(sel.anchor, sel.focus) || objectSelected(d, sel);
  const text = whole ? stories.map(st => d.plainText(st)).join('\n') : selectedText(d, sel);
  const words = whole ? stories.reduce((n, st) => n + d.storyWordCount(st), 0) : countWords(text);
  const chars = [...text];
  const characters = chars.filter(c => !/\s/u.test(c)).length;
  const charactersWithSpaces = chars.filter(c => c !== '\n' && c !== '\r').length;
  const paragraphs = text.split('\n').filter(l => l.trim()).length;
  let lines = 0;
  for (const page of lay?.pages ?? []) for (const it of page.items) if (it.kind === 'lines' && stories.includes(it.story)) lines += it.l1 - it.l0;
  return {pages: lay?.pages?.length ?? 1, words, characters, charactersWithSpaces, paragraphs, lines, includeTextBoxes: !!includeTextBoxes};
}

/** A tiny built-in thesaurus of common words (upstream's own list, proofing.rs `thesaurus`). */
export const THESAURUS = Object.freeze({
  good: ['fine', 'excellent', 'decent', 'solid', 'worthy'], bad: ['poor', 'inferior', 'faulty', 'unpleasant'],
  big: ['large', 'huge', 'sizable', 'vast', 'major'], small: ['little', 'tiny', 'compact', 'minor', 'modest'],
  fast: ['quick', 'rapid', 'swift', 'speedy'], slow: ['unhurried', 'gradual', 'leisurely', 'sluggish'],
  happy: ['glad', 'cheerful', 'content', 'joyful', 'pleased'], sad: ['unhappy', 'sorrowful', 'downcast', 'gloomy'],
  important: ['significant', 'key', 'vital', 'essential', 'major'], show: ['display', 'reveal', 'present', 'demonstrate'],
  make: ['create', 'build', 'produce', 'craft', 'form'], use: ['employ', 'apply', 'utilize', 'operate'], help: ['assist', 'aid', 'support', 'serve'],
  start: ['begin', 'launch', 'open', 'initiate'], end: ['finish', 'close', 'conclude', 'stop'], say: ['state', 'tell', 'remark', 'mention'],
  think: ['believe', 'consider', 'reckon', 'suppose'], new: ['fresh', 'novel', 'recent', 'modern'], old: ['aged', 'former', 'ancient', 'vintage'],
  beautiful: ['lovely', 'attractive', 'gorgeous', 'stunning'], easy: ['simple', 'effortless', 'straightforward'],
  hard: ['difficult', 'tough', 'demanding', 'firm'], work: ['labor', 'effort', 'job', 'task', 'operate'], idea: ['concept', 'notion', 'thought', 'plan'],
  change: ['alter', 'modify', 'adjust', 'shift'], great: ['excellent', 'superb', 'terrific', 'considerable'], very: ['extremely', 'highly', 'truly', 'really'],
  shared: ['common', 'joint', 'communal', 'mutual'], community: ['group', 'society', 'collective', 'circle'],
});

/** The word at the caret (Paragraph::word_at, trimmed), lower-cased. */
export function wordAtCaret(d, f) {
  const p = d.paraAt(f);
  if (!p) return null;
  const [a, b] = P.wordAt(p, f.off);
  return p.text.slice(a, b).trim().toLowerCase();
}

/** Synonyms of `word` (thesaurus): {word, synonyms}. */
export const synonyms = word => ({word, synonyms: [...(Object.hasOwn(THESAURUS, word) ? THESAURUS[word] : [])]});

/** A BCP 47 tag in its usual case (pl-PL, en-US, sr-Latn-RS, es-419), or null (lang.rs normalize_tag). */
export function normalizeTag(t) {
  const parts = String(t ?? '').trim().replace(/_/g, '-').split('-');
  if (!parts[0] || !/^[A-Za-z]{2,3}$/.test(parts[0])) return null;
  const out = [parts[0].toLowerCase()];
  for (const x of parts.slice(1)) {
    if (/^[A-Za-z]{4}$/.test(x)) out.push(x[0].toUpperCase() + x.slice(1).toLowerCase());
    else if (/^[A-Za-z]{2}$/.test(x)) out.push(x.toUpperCase());
    else if (/^\d{3}$/.test(x) || /^[A-Za-z0-9]{5,8}$/.test(x)) out.push(x.toLowerCase());
    else return null;
  }
  return out.join('-');
}

/** The languages Review › Language › Set Proofing Language offers (the ribbon's list, then Word's other common ones). */
export const LANGUAGES = Object.freeze([
  ['en-US', 'English (United States)'], ['en-GB', 'English (United Kingdom)'], ['en-AU', 'English (Australia)'], ['en-CA', 'English (Canada)'],
  ['pl-PL', 'Polish'], ['pt-BR', 'Portuguese (Brazil)'], ['it-IT', 'Italian'], ['hr-HR', 'Croatian'], ['tr-TR', 'Turkish'], ['ru-RU', 'Russian'],
  ['cs-CZ', 'Czech'], ['id-ID', 'Indonesian'], ['es-ES', 'Spanish (Spain)'], ['es-MX', 'Spanish (Mexico)'], ['es-419', 'Spanish (Latin America)'],
  ['es-UY', 'Spanish (Uruguay)'], ['de-DE', 'German (Germany)'], ['fr-FR', 'French (France)'], ['nl-NL', 'Dutch (Netherlands)'],
  ['pt-PT', 'Portuguese (Portugal)'], ['bg-BG', 'Bulgarian'], ['vi-VN', 'Vietnamese'], ['ja-JP', 'Japanese'], ['zh-CN', 'Chinese (Simplified, China)'],
]);
