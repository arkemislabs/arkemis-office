// Review > Thesaurus: synonyms from a small built-in English word list, looked up offline.
// Translated from deckcraft crates/engine/src/thesaurus.rs (`senses_of`, `lookup`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins.

import {THESAURUS_DATA} from './thesaurus-data.mjs';

let table = null;
/** headword -> [synonyms of each sense] (a headword may have several senses, one per line). */
function senses() {
  if (table) return table;
  table = new Map();
  for (const line of THESAURUS_DATA.split('\n')) {
    const at = line.indexOf('|');
    if (at < 0) continue;
    const head = line.slice(0, at).trim();
    const syn = line.slice(at + 1).split(',').map(x => x.trim()).filter(Boolean);
    if (!table.has(head)) table.set(head, []);
    table.get(head).push(syn);
  }
  return table;
}
const sensesOf = head => (senses().get(head) ?? []).map(synonyms => ({word: head, synonyms: [...synonyms]}));

const alnum = c => /[\p{L}\p{N}]/u.test(c);
const SUFFIXES = [['ies', 'y'], ['es', ''], ['s', ''], ['ied', 'y'], ['ed', 'e'], ['ed', ''], ['ing', 'e'], ['ing', '']];

/**
 * The senses for `word`, trying simple English endings when the word itself isn't listed ("goals" ->
 * "goal", "improved" -> "improve", "growing" -> "grow"). Synonyms take the word's capitalisation
 * ("Goal" -> "Aim", "GOAL" -> "AIM"). [{word, synonyms}]
 */
export function lookup(word) {
  const chars = [...String(word ?? '').trim()];
  while (chars.length && !alnum(chars[0]) && chars[0] !== '-') chars.shift();
  while (chars.length && !alnum(chars[chars.length - 1]) && chars[chars.length - 1] !== '-') chars.pop();
  const w = chars.slice(0, 64).join('');
  const lower = w.toLowerCase();
  if (!lower) return [];
  const tries = [lower];
  for (const [suffix, add] of SUFFIXES) {
    if (lower.endsWith(suffix)) {
      const stem = lower.slice(0, lower.length - suffix.length);
      if ([...stem].length >= 2) tries.push(`${stem}${add}`);
    }
  }
  let found = [];
  for (const t of tries) { found = sensesOf(t); if (found.length) break; }
  if (!found.length) return [];
  const wc = [...w];
  const upper = wc.length > 1 && wc.every(c => c === c.toUpperCase() || !/\p{L}/u.test(c)) && wc.some(c => /\p{Lu}/u.test(c));
  const title = !upper && /\p{Lu}/u.test(wc[0]);
  return found.map(s => ({word: s.word, synonyms: s.synonyms.map(x => (upper ? x.toUpperCase() : title ? x.charAt(0).toUpperCase() + x.slice(1) : x))}));
}
