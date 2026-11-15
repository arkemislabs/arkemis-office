// AutoCorrect as you type: the replacement list, TWo INitial CApitals and cAPS LOCK, sentence and
// day capitals, ordinals, web addresses as links, *bold* and _italic_, and the AutoCorrect Options
// (what each switch does, the user's entries and exceptions).
//
// Translated from wordcraft (ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c):
//   crates/engine/src/cmd/tools/typing.rs      autocorrect, autocorrect_word, prev_token, is_turkic,
//                                              upper_char, lower_char, case_fix, emphasis_autoformat,
//                                              has_emphasis, emphasis_at_caret, emphasis_span,
//                                              ordinal_suffix, starts_sentence, should_capitalize,
//                                              INITIAL_CAPS_EXCEPTIONS, NOT_SENTENCE_END, DAYS
//   crates/engine/src/cmd/tools/autocorrect.rs AUTOCORRECT, SMILEYS, AutoCorrectPrefs (defaults,
//                                              cleaned, replacement_in, list, add_exception,
//                                              exception_list), AutoCap (note_backspace)
//   crates/proof/src/lang.rs                   ProofLang::from_tag(..).is_english()
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Offsets are UTF-16 code units (upstream: UTF-8 bytes). The Options dialog itself
// (`tools.autocorrect`) belongs to U:quill/tools; it stores these prefs under `prefs.autocorrect`.

import * as P from '../model/para.mjs';
import {resolveChar} from '../model/styles.mjs';
import {charWithoutSymbol} from '../model/props.mjs';
import {cellOf, caret, at, samePath} from './caret-session.mjs';

// ---- character classes (Rust char methods) -------------------------------------------------------

const isAlphabetic = c => /\p{Alphabetic}/u.test(c);
const isAlphanumeric = c => /[\p{Alphabetic}\p{N}]/u.test(c);
const isWhitespace = c => /\p{White_Space}/u.test(c);
const isUpper = c => /\p{Uppercase}/u.test(c);
const isLower = c => /\p{Lowercase}/u.test(c);
const isControl = c => /\p{Cc}/u.test(c);
const chars = s => [...s];
const lastChar = s => { const a = chars(s); return a[a.length - 1]; };
const firstChar = s => chars(s)[0];

// ---- the replacement list (autocorrect.rs) -----------------------------------------------------------

/** Smileys replaced even when typed straight after a word ("ok:)"), as Word does. */
export const SMILEYS = Object.freeze([':-)', ':-(', ':)', ':(', ':|']);

/** Built-in AutoCorrect replacements (upstream's own list of common typos and symbols). */
export const AUTOCORRECT = Object.freeze([
  ['teh', 'the'], ['adn', 'and'], ['recieve', 'receive'], ['recieved', 'received'], ['seperate', 'separate'], ['definately', 'definitely'],
  ['occured', 'occurred'], ['untill', 'until'], ['wich', 'which'], ['becuase', 'because'], ['thier', 'their'], ['alot', 'a lot'],
  ['accomodate', 'accommodate'], ['acheive', 'achieve'], ['beleive', 'believe'], ['calender', 'calendar'], ['goverment', 'government'],
  ['tommorow', 'tomorrow'], ['wierd', 'weird'], ['i', 'I'], ['dont', "don't"], ['cant', "can't"], ['wont', "won't"], ['didnt', "didn't"],
  ['doesnt', "doesn't"], ['isnt', "isn't"], ['(c)', '©'], ['(r)', '®'], ['(tm)', '™'], ['...', '…'], ['->', '→'], ['-->', '→'],
  ['<-', '←'], ['=>', '⇒'], [':)', '☺'], [':-)', '☺'], [':(', '☹'], [':-(', '☹'], [':|', '\u{1F610}'], ['1/2', '½'], ['1/4', '¼'], ['3/4', '¾'],
]);

/** Built-in words that keep their two initial capitals (plurals of two-letter abbreviations). */
export const INITIAL_CAPS_EXCEPTIONS = Object.freeze(['CDs', 'IDs', 'PCs', 'TVs', 'DJs', 'GBs', 'KBs', 'MBs', 'TBs', 'VMs']);
/** Words with a lowercase first letter and the rest in capitals that aren't cAPS LOCK slips. */
const CAPS_LOCK_EXCEPTIONS = Object.freeze(['iOS', 'mRNA', 'tRNA', 'rRNA', 'cDNA', 'eSIM', 'eSATA', 'iSCSI', 'vCPU']);
/** Abbreviations whose full stop doesn't end a sentence. */
export const NOT_SENTENCE_END = Object.freeze(['e.g.', 'i.e.', 'etc.', 'vs.', 'cf.', 'mr.', 'mrs.', 'ms.', 'dr.', 'st.', 'no.', 'approx.', 'fig.',
  'p.', 'pp.', 'jr.', 'sr.', 'ca.', 'inc.', 'ltd.', 'co.', 'vol.', 'a.m.', 'p.m.']);
/** Names of days, capitalised as you type. */
const DAYS = Object.freeze(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
/** Built-in fractions: AutoFormat's (Fractions), not the replacement list's. */
const FRACTIONS = Object.freeze(['1/2', '1/4', '3/4']);

export const MAX_FROM = 255;
export const MAX_TO = 2000;
export const MAX_ENTRIES = 10_000;

/** AutoCorrectPrefs::default. */
export function defaultAutoCorrect() {
  return {enabled: true, replaceText: true, twoInitialCaps: true, capSentences: true, capCells: true, capDays: true, capsLock: true,
    smartQuotes: true, fractions: true, ordinals: true, boldItalic: false, dashes: true, links: true, bullets: true, numbering: true,
    borderLines: true, tabIndent: false, headingStyles: false, doubleSpacePeriod: false, entries: [], removed: [], exceptions: [],
    exceptionsRemoved: [], initialCapsExceptions: [], autoAddFirstLetter: true, autoAddInitialCaps: true};
}

/** The prefs in effect: defaults overlaid with the saved ones, cleaned (AutoCorrectPrefs::cleaned). */
export function autoCorrectPrefs(prefs) {
  const ac = {...defaultAutoCorrect(), ...(prefs?.autocorrect && typeof prefs.autocorrect === 'object' ? prefs.autocorrect : {})};
  const ok = (t, max) => typeof t === 'string' && t.trim() !== '' && [...t].length <= max && !/[\n\r]/.test(t);
  const seen = new Set();
  ac.entries = (Array.isArray(ac.entries) ? ac.entries : []).filter(e => Array.isArray(e) && ok(e[0], MAX_FROM) && typeof e[1] === 'string'
    && [...e[1]].length <= MAX_TO && !/[\n\r]/.test(e[1]) && !seen.has(e[0]) && seen.add(e[0])).slice(0, MAX_ENTRIES);
  for (const k of ['removed', 'exceptions', 'exceptionsRemoved', 'initialCapsExceptions']) {
    const s2 = new Set();
    ac[k] = (Array.isArray(ac[k]) ? ac[k] : []).filter(a => ok(a, MAX_FROM) && !s2.has(a) && s2.add(a)).slice(0, MAX_ENTRIES);
  }
  return ac;
}

/** A built-in entry that is an English word (letters and apostrophes only), not a symbol. */
const isEnglishEntry = from => chars(from).some(isAlphabetic) && chars(from).every(c => isAlphabetic(c) || c === "'");

/** The replacement for `word` in text that is (`english`) or isn't English (replacement_in). */
export function replacementIn(ac, word, english = true) {
  const user = ac.entries.find(([a]) => a === word);
  if (user) return user[1];
  const hit = AUTOCORRECT
    .filter(([a]) => english || !isEnglishEntry(a))
    .filter(([a]) => !ac.removed.includes(a) && !ac.entries.some(([e]) => e === a))
    .filter(([a]) => ac.fractions || !FRACTIONS.includes(a))
    .find(([a]) => a === word || (chars(a).every(isLower) && word.toLowerCase() === a && isUpper(firstChar(word) ?? '')));
  if (!hit) return null;
  const [a, b] = hit;
  if (a !== word && isLower(firstChar(b) ?? '')) { const cs = chars(b); return cs[0].toUpperCase() + cs.slice(1).join(''); }
  return b;
}

/** The replacement list as the dialog shows it, sorted: [from, to, builtIn] (list). */
export function replacementList(ac) {
  const v = AUTOCORRECT.filter(([a]) => !ac.removed.includes(a) && !ac.entries.some(([e]) => e === a)).map(([a, b]) => [a, b, true])
    .concat(ac.entries.map(([a, b]) => [a, b, false]));
  v.sort((x, y) => (x[0].toLowerCase() < y[0].toLowerCase() ? -1 : x[0].toLowerCase() > y[0].toLowerCase() ? 1 : x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  return v;
}

/** Abbreviations after which a sentence doesn't end, lowercase (exception_list). */
export function exceptionList(ac) {
  const v = NOT_SENTENCE_END.filter(a => !ac.exceptionsRemoved.some(r => r.toLowerCase() === a)).concat(ac.exceptions.map(a => a.toLowerCase()));
  return [...new Set(v)].sort();
}

const plainWord = w => w.trim() !== '' && [...w].length <= MAX_FROM && !/[\s￼]/u.test(w);

/** Add a First Letter exception (add_exception): returns the new prefs. */
export function addException(ac, e) {
  if (!plainWord(e)) return ac;
  const out = {...ac, exceptionsRemoved: ac.exceptionsRemoved.filter(r => r !== e)};
  if (!NOT_SENTENCE_END.includes(e) && !ac.exceptions.includes(e) && ac.exceptions.length < MAX_ENTRIES) out.exceptions = [...ac.exceptions, e];
  return out;
}

/** Add a word that keeps two initial capitals (add_initial_caps_exception). */
export function addInitialCapsException(ac, w) {
  if (!plainWord(w) || INITIAL_CAPS_EXCEPTIONS.includes(w) || ac.initialCapsExceptions.includes(w) || ac.initialCapsExceptions.length >= MAX_ENTRIES) return ac;
  return {...ac, initialCapsExceptions: [...ac.initialCapsExceptions, w]};
}

// ---- language ------------------------------------------------------------------------------------------

/** Turkish, Azerbaijani and Crimean Tatar map i/İ and ı/I as pairs (is_turkic). */
export function isTurkic(lang) {
  if (!lang) return false;
  const primary = String(lang).trim().split(/[-_]/)[0].toLowerCase();
  return ['tr', 'tur', 'az', 'aze', 'crh'].includes(primary);
}
/** ProofLang::from_tag(lang).is_english(): no tag is English. */
export function isEnglish(lang) {
  const t = typeof lang === 'string' ? lang.trim() : '';
  if (!t) return true;
  const primary = t.split(/[-_]/)[0].toLowerCase();
  return primary === 'en' || primary === 'eng';
}
/** upper_char */
export const upperChar = (c, turkic) => (turkic && c === 'i' ? 'İ' : c.toUpperCase());
/** lower_char */
export const lowerChar = (c, turkic) => (c === 'I' && turkic ? 'ı' : c === 'İ' ? 'i' : c.toLowerCase());

// ---- the word rules (typing.rs) --------------------------------------------------------------------------

/** The lowercase token before a word that starts a sentence ("there."), empty when none (prev_token). */
export function prevToken(before) {
  const t = before.trimEnd().replace(/["'”’)\]]+$/u, '');
  if (!t.endsWith('.')) return '';
  const parts = t.split(/\s/u);
  return parts[parts.length - 1].replace(/^["'“‘([]+/u, '').toLowerCase();
}

/** Does a word typed after `before` begin a sentence? (starts_sentence) */
export function startsSentence(before, exceptions) {
  const t0 = before.trimEnd();
  if (!t0) return true;
  if (t0.length === before.length) return false;
  const t = t0.replace(/["'”’)\]]+$/u, '');
  if (!/[.!?]$/.test(t) || t.endsWith('..') || t.endsWith('…')) return false;
  const parts = t.split(/\s/u);
  const prev = parts[parts.length - 1].replace(/^["'“‘([]+/u, '');
  const initial = chars(prev).length === 2 && isUpper(firstChar(prev));
  return !initial && !exceptions.includes(prev.toLowerCase());
}

/** Only plain lowercase words are capitalised (should_capitalize). */
export function shouldCapitalize(word, next) {
  if ((next === '.' || word.endsWith('.')) && chars(word.replace(/\.+$/, '')).length < 2) return false;
  if (word === 'e.g.' || word === 'i.e.') return true;
  const c = firstChar(word);
  return !!c && isLower(c) && chars(word).every(x => isAlphabetic(x) || "'’-.".includes(x)) && !chars(word).some(isUpper)
    && !word.replace(/\.+$/, '').includes('.');
}

/** Code units of a correct ordinal's suffix ("1st" → 2), or null (ordinal_suffix). */
export function ordinalSuffix(word) {
  const m = /^(\d+)(\D.*)$/su.exec(word);
  if (!m || m[1].length > 9) return null;
  const n = Number(m[1]);
  const want = (n % 100 >= 11 && n % 100 <= 13) ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return m[2] === want ? 2 : null;
}

/** TWo INitial CApitals / cAPS LOCK fix for a finished word: [offset of its letters, replacements] (case_fix). */
export function caseFix(ac, word, turkic) {
  if (!ac.twoInitialCaps && !ac.capsLock) return null;
  const m = /\p{Alphabetic}/u.exec(word);
  if (!m) return null;
  const at0 = m.index;
  const rest = word.slice(at0);
  const nm = /[^\p{Alphabetic}]/u.exec(rest);
  const letters = rest.slice(0, nm ? nm.index : rest.length);
  const tail = rest.slice(letters.length);
  if (!chars(word.slice(0, at0)).every(c => "\"'“‘([".includes(c)) || !chars(tail).every(c => "\"'”’)]".includes(c))) return null;
  const cs = chars(letters);
  if (cs.length < 3) return null;
  const [a, b, ...more] = cs;
  if (ac.twoInitialCaps && isUpper(a) && isUpper(b) && more.every(isLower) && !INITIAL_CAPS_EXCEPTIONS.includes(letters)
    && !ac.initialCapsExceptions.includes(letters)) {
    return [at0, [a, lowerChar(b, turkic), ...more]];
  }
  if (ac.capsLock && isLower(a) && isUpper(b) && more.every(isUpper) && !CAPS_LOCK_EXCEPTIONS.includes(letters)) {
    return [at0, [upperChar(a, turkic), lowerChar(b, turkic), ...more.map(c => lowerChar(c, turkic))]];
  }
  return null;
}

/** The marks of a `*bold*` or `_italic_` span `text` ends with: [open, close, bold] or null (emphasis_span). */
export function emphasisSpan(text) {
  const mark = text.endsWith('*') ? '*' : text.endsWith('_') ? '_' : null;
  if (!mark) return null;
  const close = text.length - 1;
  const open = text.slice(0, close).lastIndexOf(mark);
  if (open < 0) return null;
  const inner = text.slice(open + 1, close);
  const edgeOk = c => c !== undefined && !isWhitespace(c);
  if (!edgeOk(firstChar(inner)) || !edgeOk(lastChar(inner)) || !chars(inner).some(isAlphanumeric) || inner.includes(P.OBJ)) return null;
  const before = lastChar(text.slice(0, open));
  const startsWord = before === undefined || isWhitespace(before) || '([{"\'“‘'.includes(before);
  return startsWord ? [open, close, mark === '*'] : null;
}

const ac0 = S => autoCorrectPrefs(S.prefs);
const styleLimited = S => !!S.d.c.settings?.protection && !!S.d.c.settings?.protectFormatting;

/** The span ending at the caret when *Bold* and _italic_ is on (emphasis_at_caret). */
function emphasisAtCaret(S, onEnter) {
  const ac = ac0(S);
  if (!(ac.enabled && ac.boldItalic) || styleLimited(S)) return null;
  const f = S.sel.focus;
  const para = S.d.paraAt(f);
  if (!para) return null;
  const before = para.text.slice(0, f.off);
  let trigger = 0;
  if (!onEnter) {
    const c = lastChar(before);
    if (c === undefined || !(c === ' ' || ',.;:!?'.includes(c))) return null;
    trigger = c.length;
  }
  const span = emphasisSpan(before.slice(0, before.length - trigger));
  if (!span) return null;
  if (S.d.c.settings?.trackChanges || S.ctx?.view?.trackMine) {
    const [open, close] = span;
    const ok = P.runRanges(para).filter(([s, e]) => s <= close && e > open)
      .every(([, , c]) => (c?.del ?? null) === null && c?.ins !== undefined && c?.ins !== null && S.d.c.revisions?.[c.ins]?.author === S.author);
    if (!ok) return null;
  }
  return span;
}

/** Would *bold* / _italic_ change the word ending at the caret? (has_emphasis) */
export const hasEmphasis = (S, onEnter) => emphasisAtCaret(S, onEnter) !== null;

/** Turn the span into real bold or italic; returns the formatting outside it, or null (emphasis_autoformat). */
export function emphasisAutoformat(S, onEnter) {
  const span = emphasisAtCaret(S, onEnter);
  if (!span) return null;
  const [open, close, bold] = span;
  const f = S.sel.focus;
  const para = S.d.paraAt(f);
  const outside = {...(P.propsOfChar(para, close) ?? {})};
  const pos = off => at(f, off);
  S.d.deleteRange(pos(close), pos(close + 1));
  S.d.deleteRange(pos(open), pos(open + 1));
  // The paragraph's own formatting (Paragraph::format): the paragraph mark keeps its formatting.
  P.formatRange(S.d.paraMut(f.story, f.path), open, close - 1, c => (bold ? {...c, bold: true, boldCs: true} : {...c, italic: true, italicCs: true}));
  S.sel = caret(pos(Math.max(f.off - 2, 0)));
  return outside;
}

/** Replace [from, to) of the caret's paragraph with `rep`, in the formatting of `from` without a symbol font. */
function replaceIn(S, f, from, to, rep) {
  const para = S.d.paraAt(f);
  const props = charWithoutSymbol(P.propsOfChar(para, from) ?? {});
  S.d.deleteRange(at(f, from), at(f, to));
  if (rep) S.d.insertText(at(f, from), rep, props);
}

function savePrefs(S, ac) {
  S.prefs = {...S.prefs, autocorrect: ac};
  S.ctx?.updatePrefs?.({autocorrect: ac});
}

/** AutoCorrect the word just before the caret, after a space or punctuation (autocorrect). */
export const autocorrect = S => autocorrectWord(S, false);

/**
 * AutoCorrect the word ending at the caret (autocorrect_word): *emphasis*, case fixes, a
 * replacement (or "wait..." → "wait…", a trailing smiley), ordinal superscripts, links, sentence
 * and day capitals. `onEnter`: Enter finished the word (no trigger character).
 */
export function autocorrectWord(S, onEnter) {
  let ac = ac0(S);
  if (!ac.enabled) return;
  const outside = emphasisAutoformat(S, onEnter);
  let f = S.sel.focus;
  const p0 = S.d.paraAt(f);
  if (!p0) return;
  const text = p0.text;
  const before = text.slice(0, f.off);
  const last = lastChar(before);
  if (last === undefined) return;
  if (!(onEnter || last === ' ' || ',.;:!?'.includes(last))) return;
  const trigger = onEnter ? 0 : last.length;
  const body = before.slice(0, before.length - trigger);
  let start = 0;
  {
    const cps = chars(body);
    let off = body.length;
    for (let k = cps.length - 1; k >= 0; k--) {
      if (isWhitespace(cps[k])) { start = off; break; }
      off -= cps[k].length;
    }
  }
  let word = body.slice(start);
  if (!word) return;
  const mark = ac.boldItalic && (word[0] === '*' || word[0] === '_') ? word[0] : null;
  let opened = false;
  if (mark) {
    const rest = word.slice(1);
    if (rest && !rest.includes(mark)) { start += 1; word = rest; opened = true; }
  }
  const para = S.d.paraAt(f);
  const lang = resolveChar(S.d.c.styles, para.props?.style, P.propsOfChar(para, start) ?? {})?.lang ?? S.prefs?.editingLanguage ?? null;
  const turkic = isTurkic(lang);
  const fix = caseFix(ac, word, turkic);
  if (fix) {
    const [at0, reps] = fix;
    const letters = chars(word.slice(at0)).slice(0, reps.length).join('');
    let end = start + at0 + letters.length;
    const ls = chars(letters);
    for (let k = ls.length - 1; k >= 0; k--) {
      const c = ls[k];
      const from = end - c.length;
      if (reps[k] !== c) replaceIn(S, f, from, end, reps[k]);
      end = from;
    }
    S.view.autocap = {story: f.story, path: [...f.path], start, prev: '', twoCaps: ac.twoInitialCaps && ls.length > 1 && isUpper(ls[0]) && isUpper(ls[1]) ? letters : null,
      backspaced: false, fresh: true};
    const fixed = reps.join('');
    f = at(f, f.off + fixed.length - letters.length);
    S.sel = caret(f);
    word = word.slice(0, at0) + fixed + word.slice(at0 + letters.length);
  }
  const english = isEnglish(lang);
  let from = start, rep = null;
  if (ac.replaceText) {
    rep = replacementIn(ac, word, english);
    if (rep === null && word.length > 3 && word.endsWith('...')) { from = start + word.length - 3; rep = '…'; }
    else if (rep === null) {
      const m = SMILEYS.find(x => word.length > x.length && word.endsWith(x));
      if (m) { from = start + word.length - m.length; rep = AUTOCORRECT.find(([a]) => a === m)?.[1] ?? null; }
    }
  }
  const replaced = rep !== null;
  let caretOff = f.off;
  if (rep !== null) {
    const end = start + word.length;
    replaceIn(S, f, from, end, rep);
    caretOff = f.off + rep.length - (end - from);
    S.sel = caret(at(f, caretOff));
  }
  const end = caretOff - trigger;
  const now = S.d.paraAt(f)?.text;
  if (now === undefined) return;
  word = now.slice(start, end);
  // 1st, 22nd, 103rd → superscript suffix.
  const n = ac.ordinals ? ordinalSuffix(word) : null;
  if (n) { S.d.formatRange(at(f, end - n), at(f, end), c => ({...c, vertAlign: 'superscript'})); return; }
  // Web addresses become links (trailing punctuation stays outside).
  const lower = word.toLowerCase();
  if (ac.links && (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('www.')) && word.length > 8) {
    const url = word.replace(/[.,;:!?)\]"'”’]+$/u, '');
    const href = lower.startsWith('www.') ? `http://${url}` : url;
    S.d.formatRange(at(f, start), at(f, start + url.length), c => ({...c, link: href, style: 'Hyperlink'}));
    const after = {...(outside ?? P.propsOfChar(S.d.paraAt(f), start) ?? {})};
    delete after.link; delete after.style;
    S.view.pending = after;
    return;
  }
  const beforeWord = text.slice(0, start - (opened ? 1 : 0));
  const sentenceOn = beforeWord.trim() === '' && cellOf(f.path) ? ac.capCells : ac.capSentences;
  const exceptions = exceptionList(ac);
  const first = word.split(/\s/u).filter(Boolean)[0] ?? '';
  const next = first.length < word.length ? ' ' : onEnter ? '\n' : last;
  let sentence = sentenceOn && startsSentence(beforeWord, exceptions) && shouldCapitalize(first, next);
  const prev = sentence ? prevToken(beforeWord) : '';
  // Typing the word again after backspacing an automatic capital makes an exception.
  const cap = S.view.autocap;
  if (sentence && prev && cap && cap.backspaced && cap.story === f.story && samePath(cap.path, f.path) && cap.start === start && cap.prev === prev) {
    S.view.autocap = null;
    if (ac.autoAddFirstLetter) { ac = addException(ac, prev); savePrefs(S, ac); sentence = false; }
  }
  const day = ac.capDays && DAYS.includes(first);
  if (sentence || day) {
    const c = firstChar(word);
    if (c !== undefined) {
      const up = upperChar(c, turkic);
      replaceIn(S, f, start, start + c.length, up);
      S.sel = caret(at(f, caretOff + up.length - c.length));
      if (sentence && prev && !replaced) {
        if (S.view.autocap?.fresh) S.view.autocap.prev = prev;
        else S.view.autocap = {story: f.story, path: [...f.path], start, prev, twoCaps: null, backspaced: false, fresh: true};
      }
    }
  }
}

/** A Backspace deleted a..f: it reached back over the capitalised word's first letter (AutoCap::note_backspace). */
export function noteBackspace(S, a, f) {
  const c = S.view.autocap;
  if (c && f.story === c.story && samePath(f.path, c.path) && a.off <= c.start && f.off > c.start) S.view.autocap = {...c, backspaced: true};
}
