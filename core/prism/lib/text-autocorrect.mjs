// AutoCorrect and AutoFormat as you type: the replacement list (built-in plus your own entries),
// TWo INitial CApitals, sentence capitals, day names, cAPS LOCK, fractions, ordinals with
// superscript, automatic bulleted and numbered lists (and Backspace right after one undoing it),
// smart quotes, and the AutoCorrect Options command's preferences.
// Translated from deckcraft crates/engine/src/cmd/text/autocorrect.rs (`AUTOCORRECT`, `DAYS`,
// `replacement`, `correct_word`, `autocorrect`, `AutoList`, `auto_list_style`,
// `start_auto_list`, `undo_auto_list`, `is_ordinal`, `superscript_suffix`,
// `autocorrect_options`) and crates/engine/src/cmd/text/editing.rs (`typed`) and the Prefs
// defaults in crates/engine/src/lib.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. U:prism/text. No DOM, no Node built-ins.
//
// Preferences live in `prefs.prism` (deckcraft `Prefs`): autocorrect, smartQuotes, acTwoInitials,
// acSentenceCaps, acDays, acCapsLock, acFractions, acOrdinals, acLists (all on by default),
// acEntries ([from, to] pairs, yours, winning over the built-in list), acRemoved (built-in
// entries you deleted). The AutoList state (Backspace undoes a list AutoFormat just started)
// is session view state `autoList`.

import {paraText} from '../model/text.mjs';
import {remove, insert, format, propsAt, changeCase} from '../model/edit.mjs';
import {textSelection} from '../model/doc.mjs';
import {bad, bodyOf, bodyPath, textPositions, setTextSelection, editText, samePos} from './text-session.mjs';

/** Built-in AutoCorrect replacements (common slips and symbols). */
export const AUTOCORRECT = Object.freeze([
  ['teh', 'the'], ['adn', 'and'], ['recieve', 'receive'], ['recieved', 'received'], ['seperate', 'separate'], ['occured', 'occurred'],
  ['occurence', 'occurrence'], ['thier', 'their'], ['wich', 'which'], ['acheive', 'achieve'], ['accross', 'across'], ['adress', 'address'],
  ['alot', 'a lot'], ['appearence', 'appearance'], ['arguement', 'argument'], ['basicly', 'basically'], ['beggining', 'beginning'],
  ['beleive', 'believe'], ['calender', 'calendar'], ['commitee', 'committee'], ['definately', 'definitely'], ['dont', "don't"],
  ['doesnt', "doesn't"], ['didnt', "didn't"], ['isnt', "isn't"], ['embarass', 'embarrass'], ['enviroment', 'environment'],
  ['existance', 'existence'], ['foward', 'forward'], ['freind', 'friend'], ['goverment', 'government'], ['happend', 'happened'], ['i', 'I'],
  ['ive', "I've"], ['immediatly', 'immediately'], ['independant', 'independent'], ['knowlege', 'knowledge'], ['libary', 'library'],
  ['neccessary', 'necessary'], ['necesary', 'necessary'], ['noticable', 'noticeable'], ['occassion', 'occasion'], ['posession', 'possession'],
  ['prefered', 'preferred'], ['publically', 'publicly'], ['realy', 'really'], ['recomend', 'recommend'], ['refered', 'referred'],
  ['relevent', 'relevant'], ['succesful', 'successful'], ['tommorow', 'tomorrow'], ['tomorow', 'tomorrow'], ['truely', 'truly'],
  ['untill', 'until'], ['wierd', 'weird'], ['youre', "you're"], ['(c)', '©'], ['(r)', '®'], ['(tm)', '™'], ['(e)', '€'], ['...', '…'],
  ['->', '→'], ['<-', '←'], ['=>', '⇒'], ['--', '–'],
].map(e => Object.freeze(e)));

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** deckcraft `Prefs::default()` for the AutoCorrect options. */
export const AC_DEFAULTS = Object.freeze({autocorrect: true, smartQuotes: true, acTwoInitials: true, acSentenceCaps: true, acDays: true,
  acCapsLock: true, acFractions: true, acOrdinals: true, acLists: true, acEntries: [], acRemoved: []});
/** The AutoCorrect preferences in effect. */
export function acPrefs(prefs) {
  const p = prefs?.prism ?? {};
  const out = {...AC_DEFAULTS};
  for (const k of Object.keys(AC_DEFAULTS)) if (p[k] !== undefined) out[k] = p[k];
  out.acEntries = Array.isArray(out.acEntries) ? out.acEntries.filter(e => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string') : [];
  out.acRemoved = Array.isArray(out.acRemoved) ? out.acRemoved.filter(x => typeof x === 'string') : [];
  return out;
}

const eqi = (a, b) => a.toLowerCase() === b.toLowerCase();
const isUpper = c => /\p{Lu}/u.test(c);
const isLower = c => /\p{Ll}/u.test(c);
const isAlpha = c => /\p{Alphabetic}/u.test(c);
const isWs = c => /\s/u.test(c);

/** deckcraft `replacement`: your entries (exact, then any case), then the built-in list. */
export function replacement(pr, word) {
  let e = pr.acEntries.find(([k]) => k === word) ?? pr.acEntries.find(([k]) => eqi(k, word));
  if (e) return e[1];
  e = AUTOCORRECT.find(([k]) => eqi(k, word));
  if (!e) return null;
  const [k, to] = e;
  if (pr.acRemoved.some(r => eqi(r, k))) return null;
  // "i" only on its own, lower case.
  if (k === 'i' && word !== 'i') return null;
  return isUpper([...word][0] ?? '') ? changeCase(to, 'sentence') : to;
}

/** deckcraft `correct_word`: what a just-typed `word` becomes (null: unchanged). */
export function correctWord(pr, word, sentenceStart, typing) {
  let out = replacement(pr, word);
  if (typing && out === null) {
    const chars = [...word];
    const letters = chars.every(isAlpha);
    if (pr.acFractions) out = {'1/2': '½', '1/4': '¼', '3/4': '¾'}[word] ?? null;
    if (out === null && letters && chars.length >= 3) {
      const restLower = chars.slice(2).every(isLower);
      const restUpper = chars.slice(1).every(isUpper);
      if (pr.acTwoInitials && isUpper(chars[0]) && isUpper(chars[1]) && restLower) out = chars.map((c, i) => (i === 1 ? c.toLowerCase() : c)).join('');
      else if (pr.acCapsLock && isLower(chars[0]) && restUpper) out = chars.map((c, i) => (i === 0 ? c.toUpperCase() : c.toLowerCase())).join('');
    }
    if (out === null && pr.acDays && DAYS.includes(word)) out = changeCase(word, 'sentence');
  }
  if (typing && pr.acSentenceCaps && sentenceStart) {
    const w = out ?? word;
    const cs = [...w];
    if (cs.length && isLower(cs[0]) && cs.every(isAlpha)) out = cs[0].toUpperCase() + cs.slice(1).join('');
  }
  return out !== null && out !== word ? out : null;
}

/** deckcraft `is_ordinal`: a number with its ordinal suffix (1st, 22nd, 103rd, 11th). */
export function isOrdinal(word) {
  const m = /^([0-9]+)([a-z]*)$/.exec(word);
  if (!m || m[2].length !== 2) return false;
  const d = m[1];
  const teen = d.length >= 2 && d[d.length - 2] === '1';
  const last = d[d.length - 1];
  const want = teen ? 'th' : last === '1' ? 'st' : last === '2' ? 'nd' : last === '3' ? 'rd' : 'th';
  return m[2] === want;
}

/** deckcraft `auto_list_style`: the list command and params a typed lead starts. */
export function autoListStyle(lead) {
  const bullet = c => ['format.bullets', {on: true, char: c}];
  const number = scheme => ['format.numbering', {on: true, scheme}];
  switch (lead) {
    case '*': return bullet('•');
    case '-': case '–': return bullet('–');
    case '--': case '—': return bullet('■');
    case '>': return bullet('➢');
    case '<>': return bullet('◆');
    case '1.': return number('arabicPeriod');
    case '1)': return number('arabicParenR');
    case 'I.': return number('romanUcPeriod');
    case 'i.': return number('romanLcPeriod');
    case 'A.': return number('alphaUcPeriod');
    case 'a.': return number('alphaLcPeriod');
    case 'a)': return number('alphaLcParenR');
    default: return null;
  }
}

/** deckcraft `typed`: smart quotes for one typed quote character. */
export function typed(prefs, body, at, text) {
  if (!acPrefs(prefs).smartQuotes || [...text].length !== 1) return text;
  const line = body?.paragraphs?.[at[0]] ? paraText(body.paragraphs[at[0]]) : '';
  const prev = at[1] > 0 ? line[at[1] - 1] : undefined;
  const opening = prev === undefined || isWs(prev) || '([{'.includes(prev);
  if (text === '"') return opening ? '“' : '”';
  if (text === "'") return opening ? '‘' : '’';
  return text;
}

/** Write a body for the text selection `t` without a separate undo step (part of the typing). */
function writeBody(ctx, t, body, caret) {
  ctx.change.set(bodyPath(ctx.doc, t), body);
  setTextSelection(ctx, t, body, caret, caret);
}

/**
 * deckcraft `autocorrect`: after a space or punctuation, correct the word just typed (and start
 * an automatic list, or superscript an ordinal's suffix). Runs inside text.insert's transaction.
 */
export function autocorrect(ctx, typing) {
  const pr = acPrefs(ctx.prefs);
  if (!pr.autocorrect) return;
  const t = textSelection(ctx.doc, ctx.selection);
  if (!t) return;
  const body = bodyOf(ctx.doc, t);
  if (!body) return;
  const {caret, anchor} = textPositions(body, t);
  const pi = caret[0];
  const line = body.paragraphs?.[pi] ? paraText(body.paragraphs[pi]) : '';
  const end = caret[1];
  if (end === 0 || !(isWs(line[end - 1]) || '.,;:!?'.includes(line[end - 1]))) return;
  if (typing && pr.acLists) {
    // A lead such as `i.` or `a.` is kept as typed, so the space after it starts its list.
    if (autoListStyle(line.slice(0, end)) || startAutoList(ctx, t, body, line, end, !samePos(anchor, caret))) return;
  }
  let wordEnd = end - 1;
  let start = wordEnd;
  while (start > 0 && !isWs(line[start - 1])) start--;
  // "word," and "word." also count: the punctuation was typed before the space.
  let word = line.slice(start, wordEnd);
  if (replacement(pr, word) === null) {
    const trimmed = word.replace(/[.,;:!?]+$/u, '');
    if (trimmed && trimmed.length < word.length && !word.endsWith('...')) {
      wordEnd -= word.length - trimmed.length;
      word = trimmed;
    }
  }
  const before = [...line.slice(0, start)].reverse().find(c => !isWs(c));
  const sentenceStart = before === undefined || '.!?'.includes(before);
  // "word..." becomes "word…", the word corrected too.
  const ellipsis = [...word].length > 3 && word.endsWith('...') && replacement(pr, '...') !== null;
  let rep;
  if (ellipsis) {
    const stem = word.replace(/\.+$/u, '');
    rep = `${correctWord(pr, stem, sentenceStart, typing) ?? stem}…`;
  } else rep = correctWord(pr, word, sentenceStart, typing);
  if (rep === null) {
    if (typing && pr.acOrdinals && isOrdinal(word)) superscriptSuffix(ctx, t, body, pi, wordEnd, caret);
    return;
  }
  const delta = rep.length - word.length;
  const r = remove(body, [pi, start], [pi, wordEnd]);
  const ins = insert(r.body, [pi, start], rep);
  writeBody(ctx, t, ins.body, [pi, Math.max(end + delta, 0)]);
}

/** deckcraft `superscript_suffix`: superscript the ordinal's two letters before `end`. */
function superscriptSuffix(ctx, t, body, pi, end, caret) {
  const a = [pi, Math.max(end - 2, 0)], b = [pi, end];
  if ((propsAt(body, b).baseline ?? 0) > 0) return;
  writeBody(ctx, t, format(body, a, b, rp => ({...rp, baseline: 0.3})), caret);
}

/**
 * deckcraft `start_auto_list`: the caret's paragraph holds only a list lead before the space or
 * tab just typed: the lead and the space go and the paragraph becomes a list paragraph (through
 * the format family's format.bullets / format.numbering). False when nothing changed.
 */
function startAutoList(ctx, t, body, line, end, isRange) {
  if (isRange || !(line[end - 1] === ' ' || line[end - 1] === '\t')) return false;
  const style = autoListStyle(line.slice(0, end - 1));
  if (!style || !ctx.registry?.has?.(style[0])) return false;
  const typedLead = line.slice(0, end);
  const pi = textPositions(body, t).caret[0];
  const props = structuredClone(body.paragraphs[pi]?.props ?? {});
  editText(ctx, 'text.insert', (b, sel) => {
    const r = remove(b, [pi, 0], [pi, end]);
    sel.anchor = [pi, 0];
    sel.caret = [pi, 0];
    return {body: r.body};
  });
  ctx.run(style[0], style[1]);
  const sel = ctx.selection.ranges[0];
  ctx.setView({autoList: {anchor: sel?.anchor ?? null, focus: sel?.focus ?? null, typed: typedLead, props, version: (ctx.version ?? 0) + 1}});
  return true;
}

/**
 * deckcraft `undo_auto_list`: Backspace right after AutoFormat started a list gives the paragraph
 * back its typed lead and its own formatting. False when the last change was anything else.
 */
export function undoAutoList(ctx) {
  const a = ctx.view?.autoList;
  if (!a) return false;
  ctx.setView({autoList: null});
  const r = ctx.selection.ranges[0];
  if (a.version !== ctx.version || !r || r.anchor !== a.anchor || r.focus !== a.focus) return false;
  editText(ctx, 'text.delete', (body, sel) => {
    const pi = sel.caret[0];
    const paragraphs = [...body.paragraphs];
    if (paragraphs[pi]) {
      const {props, ...rest} = paragraphs[pi];
      void props;
      paragraphs[pi] = Object.keys(a.props ?? {}).length ? {...rest, props: structuredClone(a.props)} : rest;
    }
    const ins = insert({...body, paragraphs}, sel.caret, a.typed);
    sel.anchor = ins.pos;
    sel.caret = ins.pos;
    return {body: ins.body};
  });
  return true;
}

/** deckcraft `autocorrect_options`: change the options and list; returns them and the effective replacement list. */
export function autocorrectOptions(ctx, p) {
  const pr = acPrefs(ctx.prefs);
  const next = {...pr, acEntries: pr.acEntries.map(e => [...e]), acRemoved: [...pr.acRemoved]};
  const keys = {on: 'autocorrect', twoInitials: 'acTwoInitials', sentenceCaps: 'acSentenceCaps', days: 'acDays', capsLock: 'acCapsLock',
    fractions: 'acFractions', ordinals: 'acOrdinals', lists: 'acLists', smartQuotes: 'smartQuotes'};
  for (const [k, slot] of Object.entries(keys)) if (typeof p[k] === 'boolean') next[slot] = p[k];
  if (p.add !== undefined) {
    const [from0, to] = Array.isArray(p.add) ? p.add : [];
    if (typeof from0 !== 'string' || typeof to !== 'string') throw bad('text.autocorrect', '`add` is [from, to]', {path: '/add'});
    const from = from0.trim();
    if (!from || /\s/u.test(from) || [...from].length > 64 || [...to].length > 255) {
      throw bad('text.autocorrect', '`from` is one word (up to 64 characters), `to` up to 255', {path: '/add'});
    }
    next.acEntries = next.acEntries.filter(([k]) => k !== from);
    next.acRemoved = next.acRemoved.filter(k => !eqi(k, from));
    if (next.acEntries.length >= 2000) throw bad('text.autocorrect', 'the list is full', {path: '/add'});
    next.acEntries.push([from, to]);
  }
  if (typeof p.remove === 'string') {
    const from = p.remove;
    const had = next.acEntries.length;
    next.acEntries = next.acEntries.filter(([k]) => k !== from);
    if (had === next.acEntries.length && AUTOCORRECT.some(([k]) => eqi(k, from)) && !next.acRemoved.some(r => eqi(r, from))) next.acRemoved.push(from);
  }
  const changed = JSON.stringify(next) !== JSON.stringify(pr);
  if (changed) ctx.updatePrefs({prism: {...(ctx.prefs?.prism ?? {}), ...next}});
  const entries = [...next.acEntries, ...AUTOCORRECT.filter(([k]) => !next.acRemoved.some(r => eqi(r, k)) && !next.acEntries.some(([e]) => eqi(e, k))).map(e => [...e])];
  return {on: next.autocorrect, twoInitials: next.acTwoInitials, sentenceCaps: next.acSentenceCaps, days: next.acDays, capsLock: next.acCapsLock,
    fractions: next.acFractions, ordinals: next.acOrdinals, lists: next.acLists, smartQuotes: next.smartQuotes, entries};
}
