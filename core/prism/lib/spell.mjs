// Spell checking for Review > Spelling: the words of a paragraph (each with its run's language,
// words with digits skipped, apostrophes inside a word kept, hyphenated words checked part by part,
// runs marked "do not check spelling" skipped), repeated words ("the the"), and the list of
// frequent misspellings used when no dictionary for the language is installed.
// Translated from deckcraft crates/engine/src/spell.rs (`paragraph_words`, `repeated`) and
// crates/engine/src/cmd/review.rs (`COMMON`, `check_lang`) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// Not translated: loading Hunspell dictionaries from the system (deckcraft ships none and looks in the
// folders the system's spell checkers use). Here the en_US dictionary is bundled and checked by the shared
// service (core/common/lib/spelling.mjs); the common misspellings below still give the first suggestion.
// Add to Dictionary is kept in the app's prefs.

import {runContent} from '../model/text.mjs';
import {spelling} from '../../common/lib/spelling.mjs';

/** Frequent misspellings, used when no dictionary for the language is installed. */
export const COMMON = Object.freeze(['teh', 'recieve', 'seperate', 'occured', 'untill', 'wich', 'becuase', 'definately', 'thier', 'alot', 'accomodate', 'acheive',
  'adress', 'begining', 'beleive', 'calender', 'commited', 'enviroment', 'goverment', 'independant', 'neccessary', 'occassion', 'publically', 'reccomend', 'tommorow', 'wierd']);

/** The correction offered for each common misspelling (deckcraft offers none without a dictionary; this says what each word was meant to be). */
export const COMMON_FIX = Object.freeze({teh: 'the', recieve: 'receive', seperate: 'separate', occured: 'occurred', untill: 'until', wich: 'which', becuase: 'because',
  definately: 'definitely', thier: 'their', alot: 'a lot', accomodate: 'accommodate', acheive: 'achieve', adress: 'address', begining: 'beginning', beleive: 'believe',
  calender: 'calendar', commited: 'committed', enviroment: 'environment', goverment: 'government', independant: 'independent', neccessary: 'necessary',
  occassion: 'occasion', publically: 'publicly', reccomend: 'recommend', tommorow: 'tomorrow', wierd: 'weird'});
/** The correction in the case the word was written in ("Teh" gives "The", "TEH" gives "THE"). */
export function keepCase(word, fix) {
  if (word.length > 1 && word === word.toUpperCase()) return fix.toUpperCase();
  return /^\p{Lu}/u.test(word) ? fix.charAt(0).toUpperCase() + fix.slice(1) : fix;
}

// The user dictionary is the shared spelling service's (core/common/lib/spelling.mjs): kept in prefs.userDictionary, never sent anywhere.
/** Add `word` to the user dictionary. */
export function addUserWord(word) {
  const w = String(word ?? '').trim();
  if (!w || /[\r\n]/.test(w)) throw new Error('not a word');
  return spelling().addUserWord(w);
}
export const isUserWord = word => spelling().userWords().some(w => w === word || (w === w.toLowerCase() && w === String(word).toLowerCase()));
export const userWordList = () => spelling().userWords();
export const clearUserWords = () => spelling().setUserWords([]);

const alnum = c => /[\p{L}\p{N}]/u.test(c);
const inside = c => alnum(c) || c === "'" || c === '’' || c === '-';

/** The characters of a paragraph with the index of the run each belongs to. */
function charsOf(p) {
  const out = [];
  (p.runs ?? []).forEach((r, ri) => { for (const c of runContent(r).split('')) out.push([c, ri]); });
  return out;
}

/** The words of `p`: [{start, end, text, lang, repeated: null}] (paragraph character offsets), each with its run's language. */
export function paragraphWords(p, dflt) {
  const chars = charsOf(p);
  const langOf = ri => { const l = p.runs?.[ri]?.props?.lang; return l ? l : dflt; };
  const out = [];
  let i = 0;
  while (i < chars.length) {
    if (!inside(chars[i][0])) { i += 1; continue; }
    const start = i;
    while (i < chars.length && inside(chars[i][0])) i += 1;
    let a = start, b = i;
    while (a < b && !alnum(chars[a][0])) a += 1;
    while (b > a && !alnum(chars[b - 1][0])) b -= 1;
    const text = chars.slice(a, b).map(c => c[0]).join('');
    if (!text || /[0-9]/.test(text) || !/\p{L}/u.test(text)) continue;
    let k = a;
    for (const part of text.split('-')) {
      const n = part.length;
      const c = chars[k];
      if (part && c) {
        if (p.runs?.[c[1]]?.props?.noProof !== true) out.push({start: k, end: k + n, text: part, lang: langOf(c[1]), repeated: null});
      }
      k += n + 1;
    }
  }
  return out;
}

/** Words that repeat the word just before them (`the the`), with only spaces between: the second, with `repeated` the offset to cut from. */
export function repeatedWords(p, dflt) {
  const words = paragraphWords(p, dflt);
  const chars = charsOf(p).map(c => c[0]);
  const out = [];
  for (let k = 0; k + 1 < words.length; k++) {
    const [a, b] = [words[k], words[k + 1]];
    const gap = chars.slice(a.end, b.start);
    if (gap.length && gap.every(c => c === ' ' || c === ' ' || c === '\t') && a.lang === b.lang && a.text.toLowerCase() === b.text.toLowerCase()) out.push({...b, repeated: a.end});
  }
  return out;
}

/** The language a check uses: the `lang` parameter, else the first run that says, else US English. */
export function checkLang(doc, lang) {
  if (typeof lang === 'string' && lang) return lang;
  const find = shapes => {
    for (const sh of shapes ?? []) {
      for (const para of sh.text?.paragraphs ?? []) for (const r of para.runs ?? []) if (r.props?.lang) return r.props.lang;
      if (sh.kind?.children) { const hit = find(sh.kind.children); if (hit) return hit; }
    }
    return null;
  };
  for (const sl of doc.slides ?? []) { const hit = find(sl.shapes); if (hit) return hit; }
  return 'en-US';
}
