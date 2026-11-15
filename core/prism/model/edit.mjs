// Text editing on a TextBody: positions are [paragraph, offset]. Inserting text with `\n` splits
// paragraphs; formatting a range splits runs at its ends.
// Translated from deckcraft crates/model/src/edit.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// Offsets are UTF-16 code units (see text.mjs). Every function that changes a body takes the body
// and returns `{body, pos}` with a new body object (the input is never mutated), so a command can
// write the result through ctx.change.

import {paraLen, paraText, runLen, isTextRun, isBreakRun, normalizeParagraph, bodyText, bodyFromText, propsEqual} from './text.mjs';
import * as words from './words.mjs';

const cloneBody = b => structuredClone(b ?? {body: {}, paragraphs: []});
const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);
const order = (a, b) => (cmp(a, b) <= 0 ? [a, b] : [b, a]);

export function clampPos(body, [p, c]) {
  const ps = body.paragraphs ?? [];
  if (!ps.length) return [0, 0];
  const pi = Math.min(Math.max(p, 0), ps.length - 1);
  return [pi, Math.min(Math.max(c, 0), paraLen(ps[pi]))];
}

/** Split the paragraph's runs so a run boundary falls at `at`; returns the index of the first run starting at or after it. Mutates `p`. */
function splitAt(p, at) {
  let pos = 0;
  for (let i = 0; i < p.runs.length; i++) {
    const len = runLen(p.runs[i]);
    if (pos === at) return i;
    if (at < pos + len) {
      const r = p.runs[i];
      if (!isTextRun(r)) return i + 1;
      const k = at - pos;
      const second = {...r, text: r.text.slice(k)};
      p.runs[i] = {...r, text: r.text.slice(0, k)};
      p.runs.splice(i + 1, 0, second);
      return i + 1;
    }
    pos += len;
  }
  return p.runs.length;
}

/** The explicit run properties in effect at `pos` (the run before the caret, or the end mark). */
export function propsAt(body, pos) {
  const [pi, ch] = clampPos(body, pos);
  const p = body.paragraphs?.[pi];
  if (!p) return {};
  let acc = 0, last = null;
  for (const r of p.runs ?? []) {
    const len = runLen(r);
    if (ch <= acc + len && ch > acc) return {...(r.props ?? {})};
    if (acc + len >= ch && ch === 0) return {...(r.props ?? {})};
    acc += len;
    last = r.props ?? {};
  }
  return {...(last ?? p.endProps ?? {})};
}

const withProps = (text, props, extra) => {
  const r = {text, ...extra};
  if (props && Object.keys(props).length) r.props = props;
  return r;
};
const norm = p => { const n = normalizeParagraph(p); Object.assign(p, n); };

/**
 * Insert `text` at `pos` (with `props`, else the props at `pos`). `\n` starts a new paragraph
 * (same level and paragraph props); U+000B inserts a line break. Returns {body, pos}.
 */
export function insert(bodyIn, pos, textIn, props) {
  const body = cloneBody(bodyIn);
  if (!body.paragraphs.length) body.paragraphs.push({level: 0, runs: []});
  let [pi, ch] = clampPos(body, pos);
  const pr = props ?? propsAt(body, [pi, ch]);
  const text = String(textIn).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let first = true;
  for (const part of text.split('\n')) {
    if (!first) {
      const p = body.paragraphs[pi];
      const idx = splitAt(p, ch);
      const tail = p.runs.splice(idx);
      const np = {level: p.level ?? 0, runs: tail};
      if (p.props) np.props = structuredClone(p.props);
      if (p.defProps) np.defProps = structuredClone(p.defProps);
      if (p.endProps) np.endProps = structuredClone(p.endProps);
      p.endProps = {...pr};
      body.paragraphs.splice(pi + 1, 0, np);
      pi += 1;
      ch = 0;
    }
    first = false;
    part.split('\u000b').forEach((seg, k) => {
      const p = body.paragraphs[pi];
      if (k > 0) {
        const idx = splitAt(p, ch);
        p.runs.splice(idx, 0, withProps('', pr, {kind: {kind: 'break'}}));
        ch += 1;
      }
      if (!seg) return;
      const idx = splitAt(p, ch);
      p.runs.splice(idx, 0, withProps(seg, pr));
      ch += seg.length;
    });
    const p = body.paragraphs[pi];
    norm(p);
    if (!p.runs.length) p.endProps = {...pr};
  }
  return {body, pos: [pi, ch]};
}

function propsOfRange(p, at) {
  let acc = 0;
  for (const r of p.runs) {
    const len = runLen(r);
    if (at < acc + len || (at === acc + len && at > 0)) return {...(r.props ?? {})};
    acc += len;
  }
  return {...(p.runs[p.runs.length - 1]?.props ?? p.endProps ?? {})};
}

/** Delete the range between `a` and `b`; returns {body, pos} with the caret at the start. */
export function remove(bodyIn, a, b) {
  const body = cloneBody(bodyIn);
  if (!body.paragraphs.length) return {body, pos: [0, 0]};
  const [s, e] = order(clampPos(body, a), clampPos(body, b));
  if (cmp(s, e) === 0) return {body, pos: s};
  if (s[0] === e[0]) {
    const p = body.paragraphs[s[0]];
    const endProps = propsOfRange(p, s[1]);
    const i0 = splitAt(p, s[1]);
    const i1 = splitAt(p, e[1]);
    if (i1 > i0) p.runs.splice(i0, i1 - i0);
    norm(p);
    if (!p.runs.length) p.endProps = endProps;
    return {body, pos: s};
  }
  const pe = body.paragraphs[e[0]];
  const tail = pe ? pe.runs.splice(splitAt(pe, e[1])) : [];
  const ps = body.paragraphs[s[0]];
  ps.runs.length = splitAt(ps, s[1]);
  ps.runs.push(...tail);
  norm(ps);
  if (e[0] > s[0] && e[0] < body.paragraphs.length) body.paragraphs.splice(s[0] + 1, e[0] - s[0]);
  return {body, pos: s};
}
export {remove as delete_};

/**
 * Apply `f(props) -> props` to the run properties of every run in [a, b). An empty range changes
 * the empty paragraph's end mark (so typing there picks the formatting up). Returns the new body.
 */
export function format(bodyIn, a, b, f) {
  const body = cloneBody(bodyIn);
  if (!body.paragraphs.length) return body;
  const [s, e] = order(clampPos(body, a), clampPos(body, b));
  const same = cmp(s, e) === 0;
  for (let pi = s[0]; pi <= e[0]; pi++) {
    const p = body.paragraphs[pi];
    if (!p) continue;
    const from = pi === s[0] ? s[1] : 0;
    const to = pi === e[0] ? e[1] : paraLen(p);
    if (!p.runs.length || (from === to && same)) { p.endProps = f({...(p.endProps ?? {})}); continue; }
    const i0 = splitAt(p, from);
    const i1 = splitAt(p, to);
    for (let i = i0; i < i1; i++) p.runs[i] = {...p.runs[i], props: f({...(p.runs[i].props ?? {})})};
    if (to === paraLen(p)) p.endProps = f({...(p.endProps ?? {})});
    norm(p);
  }
  return body;
}

/** Apply `f` to every run in the body (and end marks). */
export function formatAll(bodyIn, f) {
  const body = cloneBody(bodyIn);
  for (const p of body.paragraphs) {
    p.runs = p.runs.map(r => ({...r, props: f({...(r.props ?? {})})}));
    p.endProps = f({...(p.endProps ?? {})});
    norm(p);
  }
  return body;
}

/** The text between two positions (`\n` between paragraphs). */
export function textRange(body, a, b) {
  const [s, e] = order(clampPos(body, a), clampPos(body, b));
  let out = '';
  for (let pi = s[0]; pi <= e[0]; pi++) {
    const p = body.paragraphs?.[pi];
    if (!p) continue;
    const t = paraText(p);
    const from = pi === s[0] ? s[1] : 0;
    const to = pi === e[0] ? e[1] : t.length;
    out += t.slice(Math.min(from, t.length), Math.min(to, t.length));
    if (pi !== e[0]) out += '\n';
  }
  return out;
}

/** A formatted copy of the range. */
export function slice(bodyIn, a, b) {
  const body = cloneBody(bodyIn);
  const [s, e] = order(clampPos(body, a), clampPos(body, b));
  const out = {body: body.body, paragraphs: []};
  if (body.listStyle) out.listStyle = body.listStyle;
  for (let pi = s[0]; pi <= e[0]; pi++) {
    const p = body.paragraphs[pi];
    if (!p) continue;
    const to = pi === e[0] ? e[1] : paraLen(p);
    p.runs.length = splitAt(p, to);
    const from = pi === s[0] ? s[1] : 0;
    p.runs.splice(0, splitAt(p, from));
    out.paragraphs.push(p);
  }
  return out;
}

/** Insert a formatted body at `pos` (paste): the first paragraph merges into the current one. */
export function insertBody(bodyIn, pos, src) {
  let body = cloneBody(bodyIn);
  let caret = clampPos(body, pos);
  (src.paragraphs ?? []).forEach((sp, k) => {
    if (k > 0) {
      ({body, pos: caret} = insert(body, caret, '\n'));
      const p = body.paragraphs[caret[0]];
      p.level = sp.level ?? 0;
      if (sp.props) p.props = structuredClone(sp.props); else delete p.props;
    }
    for (const r of sp.runs ?? []) {
      if (isTextRun(r)) ({body, pos: caret} = insert(body, caret, r.text, {...(r.props ?? {})}));
      else if (isBreakRun(r)) ({body, pos: caret} = insert(body, caret, '\u000b', {...(r.props ?? {})}));
      else {
        const p = body.paragraphs[caret[0]];
        const idx = splitAt(p, caret[1]);
        p.runs.splice(idx, 0, structuredClone(r));
        caret = [caret[0], caret[1] + runLen(r)];
      }
    }
  });
  return {body, pos: caret};
}

const paraTextAt = (body, pi) => (body.paragraphs?.[pi] ? paraText(body.paragraphs[pi]) : '');

/** The word a double-click selects around `pos`: [start, end] positions. */
export function wordAt(body, pos) {
  const [pi, ch] = clampPos(body, pos);
  const [s, e] = words.wordAt(paraTextAt(body, pi), ch);
  return [[pi, s], [pi, e]];
}

/** Next/previous word stop (Ctrl+Right/Left), crossing paragraph ends. */
export function wordMove(body, pos, forward) {
  const [pi, ch] = clampPos(body, pos);
  const t = paraTextAt(body, pi);
  const n = body.paragraphs?.length ?? 0;
  if (forward) {
    const s = words.nextStop(t, ch);
    if (s !== null) return [pi, s];
    return pi + 1 < n ? [pi + 1, 0] : [pi, ch];
  }
  const s = words.prevStop(t, ch);
  if (s !== null) return [pi, s];
  return pi > 0 ? [pi - 1, paraLen(body.paragraphs[pi - 1])] : [pi, 0];
}

/** Ctrl+Up: the start of the paragraph, or of the previous one when already there. */
export function paraUp(body, pos) {
  const [pi, ch] = clampPos(body, pos);
  return ch > 0 ? [pi, 0] : [Math.max(pi - 1, 0), 0];
}
/** Ctrl+Down: the start of the next paragraph, or the end of the last one. */
export function paraDown(body, pos) {
  const [pi] = clampPos(body, pos);
  const n = body.paragraphs?.length ?? 0;
  return pi + 1 < n ? [pi + 1, 0] : [pi, body.paragraphs?.[pi] ? paraLen(body.paragraphs[pi]) : 0];
}

/** One grapheme left/right across paragraph boundaries (deckcraft: one character). */
export function charMove(body, pos, forward) {
  const [pi, ch] = clampPos(body, pos);
  const t = paraTextAt(body, pi);
  const n = t.length;
  if (forward) {
    if (ch < n) return [pi, nextBoundary(t, ch)];
    return pi + 1 < (body.paragraphs?.length ?? 0) ? [pi + 1, 0] : [pi, ch];
  }
  if (ch > 0) return [pi, prevBoundary(t, ch)];
  return pi > 0 ? [pi - 1, paraLen(body.paragraphs[pi - 1])] : [0, 0];
}
/** The next code-point boundary after `i` (UTF-16 offsets never split a surrogate pair). */
const nextBoundary = (t, i) => { const c = t.codePointAt(i); return i + (c !== undefined && c > 0xffff ? 2 : 1); };
const prevBoundary = (t, i) => { const lo = t.charCodeAt(i - 1); return i - (i >= 2 && lo >= 0xdc00 && lo <= 0xdfff ? 2 : 1); };

/**
 * Delete a word from `pos` as Ctrl+Backspace (`forward` false) or Ctrl+Delete does in PowerPoint,
 * with its smart-cut spacing. Returns {body, pos}.
 */
export function deleteWord(bodyIn, pos, forward) {
  const body = cloneBody(bodyIn);
  if (!body.paragraphs.length) return {body, pos: [0, 0]};
  const [pi, ch] = clampPos(body, pos);
  const t = paraTextAt(body, pi);
  if (!forward) {
    const s = words.prevStop(t, ch);
    const to = s !== null ? [pi, s] : charMove(body, [pi, ch], false);
    return remove(body, to, [pi, ch]);
  }
  const e = words.deleteForwardEnd(t, ch);
  if (e === null) return remove(body, [pi, ch], charMove(body, [pi, ch], true));
  const r = remove(body, [pi, ch], [pi, e]);
  return smartSpace(r.body, r.pos);
}

/** PowerPoint's smart-cut spacing after a word was deleted at `at`. */
function smartSpace(body, at) {
  const [pi, s] = at;
  const chars = paraTextAt(body, pi);
  const after = chars[s];
  const before = s > 0 ? chars[s - 1] : undefined;
  if ((after === undefined || words.isClosingPunct(after)) && before === ' ') {
    let w = s;
    while (w > 0 && chars[w - 1] === ' ') w--;
    if (w > 0 && words.isAlnum(chars[w - 1])) return remove(body, [pi, w], [pi, s]);
    return {body, pos: at};
  }
  if (before !== undefined && after !== undefined && words.isSentencePunct(before) && words.isAlnum(after)) {
    const digits = s >= 2 && words.isNumeric(chars[s - 2]) && words.isNumeric(after);
    if (!digits) return insert(body, at, ' ');
  }
  return {body, pos: at};
}

/** End of the body. */
export function end(body) {
  const ps = body.paragraphs ?? [];
  const pi = Math.max(ps.length - 1, 0);
  return [pi, ps[pi] ? paraLen(ps[pi]) : 0];
}

function posOfChar(body, nIn) {
  let n = nIn;
  const ps = body.paragraphs ?? [];
  for (let pi = 0; pi < ps.length; pi++) {
    const len = paraLen(ps[pi]);
    if (n <= len) return [pi, n];
    n -= len + 1;
  }
  return end(body);
}

/**
 * Make the body's plain text read `text`, as if typed in place: only the span between the longest
 * common prefix and suffix changes, so untouched text keeps its formatting. Returns the new body.
 */
export function replaceText(bodyIn, text) {
  const body = cloneBody(bodyIn);
  const old = bodyText(body);
  if (old === text) return body;
  let pre = 0;
  while (pre < old.length && pre < text.length && old[pre] === text[pre]) pre++;
  const room = Math.min(old.length, text.length) - pre;
  let suf = 0;
  while (suf < room && old[old.length - 1 - suf] === text[text.length - 1 - suf]) suf++;
  if (pre === 0 && suf === 0) {
    const fresh = bodyFromText(text);
    const out = {...fresh, body: body.body};
    if (body.listStyle) out.listStyle = body.listStyle;
    return out;
  }
  const a = posOfChar(body, pre), b = posOfChar(body, old.length - suf);
  const r = remove(body, a, b);
  const mid = text.slice(pre, text.length - suf);
  return mid ? insert(r.body, r.pos, mid).body : r.body;
}

/** The case Shift+F3 changes `s` to next: lowercase → Title → UPPER → lower; any mix → UPPER. */
export function nextCase(s) {
  const alpha = /\p{Alphabetic}/u.test(s);
  if (s === s.toLowerCase() && alpha) return 'title';
  if (s === s.toUpperCase() && alpha) return 'lower';
  return 'upper';
}

/** Change case: upper, lower, sentence, title, toggle. */
export const changeCase = (s, mode) => changeCaseParts([s], mode).join('');
/** Change the case of consecutive pieces (a paragraph's runs) as one string. */
export function changeCaseParts(parts, mode) {
  let start = true;
  return parts.map(s => {
    if (mode === 'upper') return s.toUpperCase();
    if (mode === 'lower') return s.toLowerCase();
    if (mode === 'toggle') return [...s].map(c => (c !== c.toLowerCase() ? c.toLowerCase() : c.toUpperCase())).join('');
    const title = mode === 'title';
    let out = '';
    for (const c of s) {
      if (start && /\p{Alphabetic}/u.test(c)) { out += c.toUpperCase(); start = false; } else out += c.toLowerCase();
      if ((title && /\s/u.test(c)) || (!title && (c === '.' || c === '!' || c === '?'))) start = true;
    }
    return out;
  });
}
export {propsEqual};
