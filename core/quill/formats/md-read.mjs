// Markdown (.md/.markdown) → Quill schema-2 content: a CommonMark subset plus GitHub tables and
// strikethrough.
//
// Translated from wordcraft crates/formats/src/markdown.rs, markdown/blocks.rs and
// markdown/inlines.rs (ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c): ATX and setext
// headings, paragraphs with soft/hard breaks, block quotes (Quote style), fenced and indented code
// (one Code paragraph per line), thematic breaks (a bottom-border paragraph), bullet and ordered
// lists nested by indentation, GFM pipe tables, link reference definitions, and inlines: emphasis
// and strong by the CommonMark delimiter algorithm, ~~strike~~, code spans, inline and reference
// links, autolinks, images (data: URIs become pictures, others their alt text), backslash escapes,
// entities, HTML comments, <br> and <a id> anchors. Offsets are string indexes, not UTF-8 bytes.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import * as F from './_flow.mjs';
import {decodeEntity} from './html-read.mjs';
import {decode} from './txt-read.mjs';

export const UPSTREAM = Object.freeze({repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c',
  files: ['crates/formats/src/markdown.rs', 'crates/formats/src/markdown/blocks.rs', 'crates/formats/src/markdown/inlines.rs']});

/** Nesting limit for block containers (quotes, list items) and inline links. */
export const MAX_NEST = 32;
const MAX_TAG = 4096;

// --- blocks.rs -------------------------------------------------------------------------------

/** A label as CommonMark compares them: case-folded, white space runs one space. */
export const refLabel = raw => raw.split(/\s+/).filter(Boolean).join(' ').toLowerCase();

function linkDefinition(line) {
  const t = line.trimStart();
  if (line.length - t.length > 3 || !t.startsWith('[')) return null;
  let close = -1;
  for (let i = 1; i < t.length; i++) {
    if (t[i] === '\\') { i++; continue; }
    if (t[i] === '[') return null;
    if (t[i] === ']') { close = i; break; }
  }
  if (close < 0) return null;
  const label = refLabel(t.slice(1, close));
  if (label.startsWith('^') || !label || t[close + 1] !== ':') return null;
  const rest = t.slice(close + 2).trimStart();
  if (!rest) return null;
  let dest, after;
  if (rest.startsWith('<')) {
    const end = rest.indexOf('>', 1);
    if (end < 0) return null;
    dest = rest.slice(1, end); after = rest.slice(end + 1);
  } else {
    const m = /\s/.exec(rest);
    const end = m ? m.index : rest.length;
    dest = rest.slice(0, end); after = rest.slice(end);
  }
  if (!dest) return null;
  const title = after.trim();
  const titled = !title || (title.length >= 2 && ((title[0] === '"' && title.endsWith('"')) || (title[0] === "'" && title.endsWith("'")) || (title[0] === '(' && title.endsWith(')'))));
  return titled ? [label, dest] : null;
}
function takeDefinitions(lines) {
  const refs = new Map();
  let open = null, startsBlock = true;
  const kept = lines.filter(line => {
    const t = line.replace(/^[ \t]+/, '');
    const marker = indent(line) < 4 ? fence(t) : null;
    if (open) {
      if (marker && marker[0] === open[0] && marker[1] >= open[1] && !t.replace(new RegExp(`^\\${open[0]}+`), '').trim()) { open = null; startsBlock = true; }
      return true;
    }
    if (marker) { open = marker; return true; }
    if (startsBlock) {
      const d = linkDefinition(line);
      if (d) { if (!refs.has(d[0])) refs.set(d[0], d[1]); return false; }
    }
    startsBlock = isBlank(line) || atxHeading(t) !== null || thematicBreak(t);
    return true;
  });
  lines.length = 0;
  lines.push(...kept);
  return refs;
}

/** Markdown text → flow. */
export function parse(text) {
  if (text.startsWith('﻿')) text = text.slice(1);
  const lines = text.split('\n').map(l => expandTabs(l.replace(/\r+$/, '')));
  const refs = takeDefinitions(lines);
  const blocks = parseBlocks(lines, 0, 0, refs);
  if (!blocks.length) blocks.push(F.para());
  return F.flow(blocks);
}
function expandTabs(l) {
  if (!/^[ \t]/.test(l) || !l.includes('\t')) return l;
  let out = '', col = 0, i = 0;
  for (; i < l.length; i++) {
    const c = l[i];
    if (c === ' ') { out += ' '; col++; } else if (c === '\t') { const n = 4 - (col % 4); out += ' '.repeat(n); col += n; } else break;
  }
  return out + l.slice(i);
}
const indent = l => l.length - l.replace(/^ +/, '').length;
const isBlank = l => !l.trim();
const stripIndent = (l, n) => l.slice(Math.min(indent(l), n));

function atxHeading(t) {
  let n = 0;
  while (t[n] === '#') n++;
  if (n < 1 || n > 6) return null;
  const rest = t.slice(n);
  if (rest && !/^[ \t]/.test(rest)) return null;
  let body = rest.trim();
  const trimmed = body.replace(/#+$/, '');
  if (trimmed.length !== body.length && (!trimmed || trimmed.endsWith(' '))) body = trimmed.trimEnd();
  return [n, body];
}
export function thematicBreak(t) {
  let ch = null, n = 0;
  for (const c of t) {
    if (c === ' ' || c === '\t') continue;
    if (c === '*' || c === '-' || c === '_') { if (ch && ch !== c) return false; ch = c; n++; } else return false;
  }
  return n >= 3;
}
function fence(t) {
  const c = t[0];
  if (c !== '`' && c !== '~') return null;
  let n = 0;
  while (t[n] === c) n++;
  if (n < 3) return null;
  if (c === '`' && t.slice(n).includes('`')) return null;
  return [c, n];
}
function listMarker(t) {
  const first = t[0];
  if (first === undefined) return null;
  let m;
  if ('-+*'.includes(first)) m = {ordered: false, ch: first, len: 1, start: 1};
  else {
    const d = /^\d{1,9}/.exec(t);
    if (!d || /^\d/.test(t.slice(d[0].length))) return null;
    const dl = t[d[0].length];
    if (dl !== '.' && dl !== ')') return null;
    m = {ordered: true, ch: dl, len: d[0].length + 1, start: Number(d[0]) || 1};
  }
  const rest = t.slice(m.len);
  return !rest || /^[ \t]/.test(rest) ? m : null;
}
function splitRow(l) {
  let t = l.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) {
    const before = t.slice(0, -1);
    const bs = before.length - before.replace(/\\+$/, '').length;
    if (bs % 2 === 0) t = before;
  }
  const cells = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '\\') { if (t[i + 1] === '|') { cur += '|'; i++; } else if (t[i + 1] === '\\') { cur += '\\\\'; i++; } else cur += '\\'; }
    else if (c === '|') { cells.push(cur.trim()); cur = ''; } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}
function delimiterRow(l) {
  if (!l.includes('-')) return null;
  const out = [];
  for (let c of splitRow(l)) {
    c = c.trim();
    const left = c.startsWith(':'), right = c.endsWith(':');
    const core = c.replace(/^:+|:+$/g, '');
    if (!core || !/^-+$/.test(core)) return null;
    out.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return out;
}
function interrupts(l) {
  if (indent(l) >= 4) return false;
  const t = l.replace(/^[ \t]+/, '');
  const m = listMarker(t);
  return atxHeading(t) !== null || thematicBreak(t) || fence(t) !== null || t.startsWith('>') || t.startsWith('<!--')
    || (!!m && (!m.ordered || m.start === 1) && !isBlank(t.slice(m.len)));
}
function joinLines(lines) {
  let s = '';
  lines.forEach((l0, i) => {
    const l = l0.replace(/^[ \t]+/, '');
    if (i + 1 === lines.length) s += l.trimEnd();
    else if (l.endsWith('  ')) s += `${l.trimEnd()}\n`;
    else if (l.endsWith('\\') && !l.endsWith('\\\\')) s += `${l.slice(0, -1)}\n`;
    else s += `${l.trimEnd()} `;
  });
  return s;
}
function flushPara(lines, out, depth, refs) {
  if (!lines.length) return;
  const text = joinLines(lines);
  lines.length = 0;
  const inlines = parseInlines(text, F.fmt(), depth, refs);
  if (!inlines.length) return;
  out.push(F.para('normal', {inlines}));
}
function codePara(line) { const p = F.para('code'); F.pushText(p, line, F.fmt()); return p; }

function parseBlocks(lines, depth, level, refs) {
  const out = [], para = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { flushPara(para, out, depth, refs); i++; continue; }
    const ind = indent(line);
    if (ind >= 4) {
      if (para.length) { para.push(line); i++; continue; }
      i = parseIndentedCode(lines, i, out);
      continue;
    }
    const t = line.replace(/^[ \t]+/, '');
    if (para.length) {
      const u = t.trimEnd();
      if (u && (/^=+$/.test(u) || /^-+$/.test(u))) {
        const text = joinLines(para);
        para.length = 0;
        out.push(F.heading(u.startsWith('=') ? 1 : 2, {inlines: parseInlines(text, F.fmt(), depth, refs)}));
        i++;
        continue;
      }
    }
    const h = atxHeading(t);
    if (h) { flushPara(para, out, depth, refs); out.push(F.heading(h[0], {inlines: parseInlines(h[1], F.fmt(), depth, refs)})); i++; continue; }
    if (thematicBreak(t)) { flushPara(para, out, depth, refs); out.push(F.para('rule')); i++; continue; }
    const fn = fence(t);
    if (fn) {
      flushPara(para, out, depth, refs);
      i++;
      while (i < lines.length) {
        const l = lines[i++];
        const lt = l.replace(/^[ \t]+/, '');
        const f2 = fence(lt);
        if (indent(l) < 4 && f2 && f2[0] === fn[0] && f2[1] >= fn[1] && !lt.replace(new RegExp(`^\\${fn[0]}+`), '').trim()) break;
        out.push(codePara(stripIndent(l, ind)));
      }
      continue;
    }
    if (t.startsWith('<!--')) {
      flushPara(para, out, depth, refs);
      while (i < lines.length) { const l = lines[i++]; if (l.includes('-->')) break; }
      continue;
    }
    if (t.startsWith('>')) { flushPara(para, out, depth, refs); i = parseQuote(lines, i, depth, level, refs, out); continue; }
    if (!para.length && t.includes('|') && i + 1 < lines.length) {
      const aligns = delimiterRow(lines[i + 1]);
      const head = aligns ? splitRow(t) : null;
      if (aligns && head.length === aligns.length) {
        const table = F.ftable();
        const cell = (s, header, a) => F.cell({blocks: [F.para('normal', {align: a, inlines: parseInlines(s, F.fmt(), depth, refs)})], header});
        table.rows.push(head.map((s, k) => cell(s, true, aligns[k])));
        i += 2;
        while (i < lines.length) {
          const l = lines[i];
          if (isBlank(l) || !l.includes('|') || interrupts(l)) break;
          const cells = splitRow(l);
          cells.length = aligns.length;
          table.rows.push(aligns.map((a, k) => cell(cells[k] ?? '', false, a)));
          i++;
        }
        out.push(table);
        continue;
      }
    }
    const m = listMarker(t);
    if (m && (!para.length || ((!m.ordered || m.start === 1) && !isBlank(t.slice(m.len))))) {
      flushPara(para, out, depth, refs);
      i = parseList(lines, i, depth, level, out, refs);
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara(para, out, depth, refs);
  return out;
}
function parseIndentedCode(lines, i, out) {
  const code = [];
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) code.push(''); else if (indent(line) >= 4) code.push(stripIndent(line, 4)); else break;
    i++;
  }
  while (code.length && !code[code.length - 1]) code.pop();
  for (const l of code) out.push(codePara(l));
  return i;
}
function parseQuote(lines, i, depth, level, refs, out) {
  const inner = [];
  while (i < lines.length) {
    const line = lines[i];
    const tr = line.replace(/^[ \t]+/, '');
    if (indent(line) < 4 && tr.startsWith('>')) { const content = tr.slice(1); inner.push(content.startsWith(' ') ? content.slice(1) : content); }
    else if (!isBlank(line) && !interrupts(line) && inner.length && !isBlank(inner[inner.length - 1])) inner.push(line);
    else break;
    i++;
  }
  if (depth >= MAX_NEST) { const p = F.para('quote'); F.pushText(p, inner.join(' '), F.fmt()); out.push(p); return i; }
  for (const b of parseBlocks(inner, depth + 1, level, refs)) {
    if (b.t === 'para' && b.kind === 'normal') b.kind = 'quote';
    out.push(b);
  }
  return i;
}
function markerSpace(ind, markerLen, after) {
  let cols = 0, chars = 0;
  for (const c of after) {
    if (c === ' ') { cols++; chars++; if (cols >= 4) break; } else if (c === '\t') { const col = ind + markerLen + cols; cols += 4 - (col % 4); chars++; break; } else break;
  }
  return [cols, chars];
}
function parseList(lines, i, depth, level, out, refs) {
  const first = listMarker((lines[i] ?? '').replace(/^[ \t]+/, ''));
  if (!first) return i + 1;
  while (i < lines.length) {
    const line = lines[i];
    const ind = indent(line);
    if (ind >= 4) break;
    const t = line.replace(/^[ \t]+/, '');
    const m = listMarker(t);
    if (!m || m.ordered !== first.ordered || m.ch !== first.ch) break;
    const after = t.slice(m.len);
    const [spaces, skip] = indent(after) > 4 ? [1, 1] : /^[ \t]/.test(after) ? markerSpace(ind, m.len, after) : [0, 0];
    const contentIndent = isBlank(after) ? ind + m.len + 1 : ind + m.len + spaces;
    const item = [isBlank(after) ? '' : after.slice(Math.min(skip, after.length))];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) item.push('');
      else if (indent(l) >= contentIndent) item.push(stripIndent(l, contentIndent));
      else if (!isBlank(item[item.length - 1]) && !interrupts(l) && !listMarker(l.replace(/^[ \t]+/, ''))) item.push(l.replace(/^[ \t]+/, ''));
      else break;
      i++;
    }
    while (item.length > 1 && !item[item.length - 1]) item.pop();
    const li = {ordered: first.ordered, level: Math.min(8, level), start: first.start};
    let inner;
    if (depth >= MAX_NEST) { const p = F.para(); F.pushText(p, item.join(' '), F.fmt()); inner = [p]; }
    else inner = parseBlocks(item, depth + 1, Math.min(8, level + 1), refs);
    let placed = false;
    if (!inner.length) { out.push(F.para('normal', {list: li})); placed = true; }
    for (const b of inner) {
      if (b.t === 'para' && !b.list) {
        const prev = out[out.length - 1];
        if (!placed) { b.list = li; placed = true; out.push(b); }
        else if (prev?.t === 'para' && prev.list && prev.list.level === li.level) { F.pushText(prev, '\n', F.fmt()); prev.inlines.push(...b.inlines); }
        else { b.list = li; out.push(b); }
      } else if (b.t === 'para') {
        if (!placed) { out.push(F.para('normal', {list: li})); placed = true; }
        out.push(b);
      } else { placed = true; out.push(b); }
    }
    while (i < lines.length && isBlank(lines[i])) {
      const next = lines[i + 1];
      const nm = next !== undefined && indent(next) < 4 ? listMarker(next.replace(/^[ \t]+/, '')) : null;
      if (!(nm && nm.ordered === first.ordered && nm.ch === first.ch)) return i;
      i++;
    }
  }
  return i;
}

// --- inlines.rs ------------------------------------------------------------------------------

const ASCII_PUNCT = /^[!-/:-@[-`{-~]$/;
const isAsciiPunct = c => !!c && ASCII_PUNCT.test(c);
const isPunct = c => isAsciiPunct(c) || (!/[\p{L}\p{N}]/u.test(c) && !/\s/u.test(c) && !/\p{Cc}/u.test(c));
const isWsChar = c => /\s/u.test(c);

/** Inline Markdown → flow inlines (on top of `base`). */
export function parseInlines(s, base, depth, refs) { return emit(tokenize(s, base, depth, refs)); }

function pushNodeText(nodes, s, f) {
  if (!s) return;
  const last = nodes[nodes.length - 1];
  if (last?.n === 'text' && F.fmtEq(last.fmt, f)) { last.text += s; return; }
  nodes.push({n: 'text', text: s, fmt: f});
}
class Backticks {
  constructor(s) {
    this.runs = new Map();
    for (let i = 0; i < s.length;) {
      if (s[i] === '`') { let k = 0; while (s[i + k] === '`') k++; if (!this.runs.has(k)) this.runs.set(k, []); this.runs.get(k).push(i); i += k; } else i++;
    }
  }
  find(from, n) {
    const starts = this.runs.get(n);
    if (!starts) return null;
    let lo = 0, hi = starts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] < from) lo = mid + 1; else hi = mid; }
    return lo < starts.length ? starts[lo] : null;
  }
}
function matchingBracket(s, open, max, ticks, known) {
  const opens = [];
  for (let i = open; i < s.length; i++) {
    if (i - open > max) return null;
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '`') {
      let n = 0;
      while (s[i + n] === '`') n++;
      const end = ticks.find(i + n, n);
      i = end !== null ? end + n - 1 : i + n - 1;
    } else if (c === '[') opens.push(i);
    else if (c === ']') {
      const o = opens.pop();
      if (o !== undefined) known.set(o, i);
      if (!opens.length) return i;
    }
  }
  for (const o of opens) known.set(o, null);
  return null;
}
class LinkScan {
  constructor(text, refs, ticks) { this.text = text; this.refs = refs; this.ticks = ticks; this.known = new Map(); this.budget = text.length * 8 + 8192; }
  parseAt(open) {
    let close;
    if (this.known.has(open)) close = this.known.get(open);
    else if (this.budget > 0) {
      close = matchingBracket(this.text, open, this.budget, this.ticks, this.known);
      this.budget = Math.max(0, this.budget - Math.max(0, (close ?? this.text.length) - open));
    } else close = null;
    if (close === null || close === undefined || this.budget === 0) return null;
    const labelText = this.text.slice(open + 1, close);
    if (this.text[close + 1] === '(') {
      const d = linkDest(this.text, close + 1);
      this.budget = Math.max(0, this.budget - Math.max(0, (d ? d[1] : this.text.length) - close));
      return d ? [labelText, d[0], d[1]] : null;
    }
    let label, end;
    if (this.text[close + 1] === '[') {
      const rest = this.text.slice(close + 2);
      const shut = rest.indexOf(']');
      if (shut < 0) return null;
      const inner = rest.slice(0, shut);
      label = inner.trim() ? inner : labelText;
      end = close + 2 + shut + 1;
    } else { label = labelText; end = close + 1; }
    const dest = this.refs.get(refLabel(label));
    return dest === undefined ? null : [labelText, dest, end];
  }
}
function linkDest(s, at) {
  if (s[at] !== '(') return null;
  let i = at + 1;
  while (i < s.length && isWsChar(s[i])) i++;
  let dest;
  if (s[i] === '<') {
    let k = i + 1;
    for (;; k++) {
      if (k >= s.length || s[k] === '\n') return null;
      if (s[k] === '\\') { k++; continue; }
      if (s[k] === '>') break;
    }
    dest = s.slice(i + 1, k);
    i = k + 1;
  } else {
    let depth = 0, end = s.length;
    for (let k = i; k < s.length; k++) {
      const c = s[k];
      if (c === '\\') { k++; continue; }
      if (c === '(') depth++;
      else if (c === ')') { if (!depth) { end = k; break; } depth--; } else if (isWsChar(c)) { end = k; break; }
    }
    dest = s.slice(i, end);
    i = end;
  }
  while (i < s.length && isWsChar(s[i])) i++;
  const q = s[i];
  if (q === '"' || q === "'" || q === '(') {
    const closeCh = q === '(' ? ')' : q;
    const end = s.indexOf(closeCh, i + 1);
    if (end < 0) return null;
    i = end + 1;
    while (i < s.length && isWsChar(s[i])) i++;
  }
  return s[i] === ')' ? [unescapeMd(dest), i + 1] : null;
}
function unescapeMd(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) { if (s[i] === '\\' && isAsciiPunct(s[i + 1])) { out += s[i + 1]; i++; } else out += s[i]; }
  return out;
}
function tagAttr(tag, name) {
  const lower = tag.toLowerCase();
  for (let from = 0; ;) {
    const at = lower.indexOf(name, from);
    if (at < 0) return null;
    const before = lower[at - 1];
    const after = lower.slice(at + name.length).trimStart();
    if (before !== undefined && isWsChar(before) && after.startsWith('=')) {
      const v = after.slice(1).trimStart();
      const q = v[0];
      if (q === undefined) return null;
      const off = tag.length - v.length;
      if (q === '"' || q === "'") { const end = v.indexOf(q, 1); return end < 0 ? null : tag.slice(off + 1, off + end); }
      const m = /[\s>]/.exec(v);
      return tag.slice(off, off + (m ? m.index : v.length));
    }
    from = at + name.length;
  }
}
function tokenize(s, base, depth, refs) {
  const nodes = [];
  const ticks = new Backticks(s);
  const links = new LinkScan(s, refs, ticks);
  let i = 0, textStart = 0;
  const flush = () => { if (textStart < i) pushNodeText(nodes, s.slice(textStart, i), base); };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      flush();
      const n = s[i + 1];
      if (isAsciiPunct(n)) { pushNodeText(nodes, n, base); i += 2; } else { pushNodeText(nodes, '\\', base); i++; }
      textStart = i;
    } else if (c === '`') {
      flush();
      const [code, fmt, end] = codeSpan(s, i, base, ticks);
      pushNodeText(nodes, code, fmt);
      i = end; textStart = i;
    } else if (c === '*' || c === '_' || c === '~') {
      flush();
      let n = 0;
      while (s[i + n] === c) n++;
      const before = i > 0 ? [...s.slice(Math.max(0, i - 2), i)].pop() : ' ';
      const after = i + n < s.length ? String.fromCodePoint(s.codePointAt(i + n)) : ' ';
      const lf = !isWsChar(after) && (!isPunct(after) || isWsChar(before) || isPunct(before));
      const rf = !isWsChar(before) && (!isPunct(before) || isWsChar(after) || isPunct(after));
      let open, close;
      if (c === '_') { open = lf && (!rf || isPunct(before)); close = rf && (!lf || isPunct(after)); }
      else if (c === '~' && n !== 2) { open = false; close = false; } else { open = lf; close = rf; }
      if (open || close) nodes.push({n: 'delim', ch: c, orig: n, left: n, open, close, opens: [], closes: []});
      else pushNodeText(nodes, s.slice(i, i + n), base);
      i += n; textStart = i;
    } else if ((c === '!' || c === '[') && depth < MAX_NEST) {
      const img = c === '!';
      const open = img ? i + 1 : i;
      const parsed = s[open] === '[' ? links.parseAt(open) : null;
      if (parsed && img) {
        flush();
        const alt = parseInlines(parsed[0], F.fmt(), depth + 1, refs).filter(x => x.t === 'text').map(x => x.text).join('');
        const data = F.dataUri(parsed[1]);
        const im = data ? F.makeImg(data, null, null, alt) : null;
        if (im) nodes.push({n: 'inl', inl: {t: 'image', img: im}}); else pushNodeText(nodes, alt, base);
        i = parsed[2]; textStart = i;
      } else if (parsed && !base.link) {
        flush();
        const f = {...base, link: F.keptLink(parsed[1])};
        for (const x of parseInlines(parsed[0], f, depth + 1, refs)) nodes.push({n: 'inl', inl: x});
        i = parsed[2]; textStart = i;
      } else i++;
    } else if (c === '<') {
      const r = angleInlines(s, i, base);
      if (r) { flush(); nodes.push(...r[1]); i = r[0]; textStart = i; } else i++;
    } else if (c === '&') {
      const rest = s.slice(i, i + 33);
      const k = rest.indexOf(';');
      const ch = k >= 0 ? decodeEntity(rest.slice(1, k)) : null;
      if (ch !== null) { flush(); pushNodeText(nodes, ch, base); i += k + 1; textStart = i; } else i++;
    } else i++;
  }
  flush();
  return nodes;
}
function angleInlines(s, start, base) {
  if (s.startsWith('<!--', start)) { const pos = s.indexOf('-->', start + 4); if (pos >= 0) return [pos + 3, []]; }
  const rest = s.slice(start + 1);
  const tagEnd = rest.slice(0, MAX_TAG).indexOf('>');
  if (tagEnd < 0) return null;
  const inner = rest.slice(0, tagEnd), lower = inner.toLowerCase();
  const end = start + inner.length + 2;
  const nodes = [];
  if (inner && !/[ <\n]/.test(inner) && (inner.includes('://') || lower.startsWith('mailto:') || (inner.includes('@') && !inner.includes('/')))) {
    pushNodeText(nodes, inner, {...base, link: inner.includes('@') && !inner.includes(':') ? `mailto:${inner}` : inner});
    return [end, nodes];
  }
  if (lower.replace(/\/+$/, '').trim() === 'br') { pushNodeText(nodes, '\n', base); return [end, nodes]; }
  if (lower.startsWith('a ') && rest.slice(inner.length + 1).toLowerCase().startsWith('</a>')) {
    const name = tagAttr(inner, 'id') ?? tagAttr(inner, 'name');
    if (name !== null) nodes.push({n: 'inl', inl: {t: 'anchor', name}});
    return [end + 4, nodes];
  }
  return null;
}
function codeSpan(s, start, base, ticks) {
  let count = 0;
  while (s[start + count] === '`') count++;
  const end = ticks.find(start + count, count);
  if (end === null) return [s.slice(start, start + count), base, start + count];
  let code = s.slice(start + count, end).replace(/\n/g, ' ');
  if (code.length >= 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
  return [code, {...base, code: true}, end + count];
}
const emphIndex = ch => (ch === '*' ? 0 : ch === '_' ? 1 : 2);

/** The CommonMark "process emphasis" pass, then flattening into spans. */
function emit(nodes) {
  const stack = [];
  const bottom = [0, 1, 2].map(() => [0, 1, 2].map(() => [null, null]));
  for (let c = 0; c < nodes.length; c++) {
    const cn = nodes[c];
    if (cn.n !== 'delim') continue;
    if (cn.close) {
      while (cn.left > 0) {
        const bot = bottom[emphIndex(cn.ch)][cn.orig % 3][cn.open ? 1 : 0];
        let found = null;
        for (let k = stack.length - 1; k >= 0; k--) {
          const o = stack[k];
          if (bot !== null && o <= bot) break;
          const on = nodes[o];
          if (on.ch !== cn.ch || !on.open || on.left === 0) continue;
          if (cn.ch === '~' && (on.left < 2 || cn.left < 2)) continue;
          const odd = (on.close || cn.open) && (on.orig + cn.orig) % 3 === 0 && !(on.orig % 3 === 0 && cn.orig % 3 === 0);
          if (odd) continue;
          found = [k, o, on.left];
          break;
        }
        if (!found) { bottom[emphIndex(cn.ch)][cn.orig % 3][cn.open ? 1 : 0] = Math.max(0, c - 1); break; }
        const [k, o, oleft] = found;
        const [used, kind] = cn.ch === '~' ? [2, 'strike'] : oleft >= 2 && cn.left >= 2 ? [2, 'strong'] : [1, 'em'];
        nodes[o].left -= used; nodes[o].opens.push(kind);
        cn.left -= used; cn.closes.push(kind);
        stack.length = k + 1;
        if (oleft - used === 0) stack.length = k;
      }
    }
    if (cn.open && cn.left > 0) stack.push(c);
  }
  const out = [];
  let em = 0, strong = 0, strike = 0;
  const push = (t, f) => {
    if (!t) return;
    const g = {...f, italic: f.italic || em > 0, bold: f.bold || strong > 0, strike: f.strike || strike > 0};
    const last = out[out.length - 1];
    if (last?.t === 'text' && F.fmtEq(last.fmt, g)) { last.text += t; return; }
    out.push({t: 'text', text: t, fmt: g});
  };
  let lastText = null;
  for (const n of nodes) {
    if (n.n === 'text') { push(n.text, n.fmt); lastText = n.fmt; }
    else if (n.n === 'inl') { if (n.inl.t === 'text') push(n.inl.text, n.inl.fmt); else out.push(n.inl); }
    else {
      for (const e of n.closes) { if (e === 'em') em = Math.max(0, em - 1); else if (e === 'strong') strong = Math.max(0, strong - 1); else strike = Math.max(0, strike - 1); }
      if (n.left > 0) push(n.ch.repeat(n.left), lastText ? {...lastText, bold: false, italic: false, strike: false} : F.fmt());
      for (const e of n.opens) { if (e === 'em') em++; else if (e === 'strong') strong++; else strike++; }
    }
  }
  return out;
}

// --- markdown.rs -----------------------------------------------------------------------------

/** Schema-2 content from Markdown text (import / import_on). */
export function importMarkdown(text, page = null) {
  F.beginImport();
  return F.toContent(parse(text), page);
}
/** formats-v2 contract: schema-2 content read from a .md file's bytes. */
export function read(bytes, _opts = {}) { return importMarkdown(decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))); }
