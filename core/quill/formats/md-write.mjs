// Quill schema-2 content → Markdown: what Save As > Markdown writes.
//
// Translated from wordcraft crates/formats/src/markdown/export.rs and crates/formats/src/comments.rs
// (`markdown`, Print Markup) at ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c: headings,
// paragraphs with escaped block starts, nested lists, fenced code, quotes, rules, GFM pipe tables,
// properly nested emphasis markers, links (unsafe targets as plain text), pictures as
// `![alt](image.ext)` placeholders, equations as their linear text, ruby as its base text.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import * as F from './_flow.mjs';
import {isSafeHref} from '../model/link.mjs';
import {thematicBreak} from './md-read.mjs';

export const UPSTREAM = Object.freeze({repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/formats/src/markdown/export.rs', 'crates/formats/src/comments.rs']});

/** Escape text for Markdown (inline context). */
export function escape(s) {
  let out = '';
  for (const c of String(s)) {
    if ('\\`*_[]<>~|&'.includes(c)) out += `\\${c}`; else if (c === '\u000C' || c === '\u000E') continue; else out += c;
  }
  return out;
}
/** Escape what would start a block at the beginning of a line (at most three leading spaces kept). */
export function escapeLineStart(s) {
  const t = s.replace(/^[ \t]+/, '');
  const lead = s.slice(0, s.length - t.length);
  const cols = [...lead].reduce((n, c) => n + (c === '\t' ? 4 : 1), 0);
  const ind = ' '.repeat(Math.min(cols, 3));
  const d = /^\d*/.exec(t)[0].length;
  const r = t.slice(d);
  const needs = t.startsWith('#') || t.startsWith('>') || t.startsWith('- ') || t.startsWith('+ ') || t.startsWith('-\t') || t.startsWith('+\t') || t === '-' || t === '+'
    || t.startsWith('=') || (t.startsWith('-') && /^-+$/.test(t.replace(/[ \t]+$/, ''))) || thematicBreak(t)
    || (d > 0 && (r.startsWith('. ') || r.startsWith(') ') || r.startsWith('.\t') || r.startsWith(')\t') || r === '.' || r === ')'));
  if (!needs) return cols > 3 || lead.includes('\t') ? ind + t : s;
  if (/^\d/.test(t)) { const k = t.search(/[.)]/); if (k >= 0) return `${ind}${t.slice(0, k)}\\${t.slice(k)}`; }
  return `${ind}\\${t}`;
}
function escapeLines(body) {
  if (!body.includes('\\\n')) return escapeLineStart(body);
  return body.split('\\\n').map(escapeLineStart).join('\\\n');
}
function codeSpan(t) {
  t = t.replace(/\r\n/g, ' ').replace(/[\r\n]/g, ' ');
  let longest = 0, cur = 0;
  for (const c of t) { if (c === '`') { cur++; longest = Math.max(longest, cur); } else cur = 0; }
  const ticks = '`'.repeat(longest + 1);
  const pad = t.startsWith('`') || t.endsWith('`') || (t.startsWith(' ') && t.endsWith(' ') && t.trim()) ? ' ' : '';
  return `${ticks}${pad}${t}${pad}${ticks}`;
}
const MARK = {bold: '**', italic: '*', strike: '~~'};

function entityLike(rest) {
  const end = rest.slice(0, 34).indexOf(';');
  if (end < 0) return false;
  let body = rest.slice(0, end);
  if (body.startsWith('#')) { body = body.slice(1); if (body[0] === 'x' || body[0] === 'X') body = body.slice(1); }
  return !!body && /^[A-Za-z0-9]+$/.test(body);
}
/** `l` as a Markdown link destination that reads back as exactly `l`. */
function linkTarget(l) {
  l = [...l].filter(c => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f).join('');
  let out = '';
  for (let i = 0; i < l.length; i++) {
    const c = l[i], rest = l.slice(i + 1);
    if (c === '<' || c === '>') out += '\\';
    else if (c === '\\' && (!rest || /^[!-/:-@[-`{-~]/.test(rest))) out += '\\';
    else if (c === '&' && entityLike(rest)) out += '\\';
    out += c;
  }
  return /[\s()<>]/.test(l) ? `<${out}>` : out;
}

function inlinesMdImpl(inlines, inTable) {
  const pieces = [];
  for (const i of F.rubyAsText(F.equationsAsText(inlines))) {
    if (i.t === 'text') {
      const f = i.fmt, t = i.text;
      if ((f.bold || f.italic || f.strike) && !f.code) {
        const core = t.replace(/^[ \t\n]+|[ \t\n]+$/g, '');
        const lead = t.slice(0, t.length - t.replace(/^[ \t\n]+/, '').length);
        const trail = t.slice(t.replace(/[ \t\n]+$/, '').length);
        const plain = {...f, bold: false, italic: false, strike: false};
        if (lead) pieces.push([lead, plain, null]);
        if (core) pieces.push([core, f, null]);
        if (trail && core) pieces.push([trail, plain, null]);
      } else pieces.push([t, f, null]);
    } else if (i.t === 'image') pieces.push(['', F.fmt(), `![${escape(i.img.alt)}](image.${i.img.ext})`]);
    else if (i.t === 'anchor') pieces.push(['', F.fmt(), `<a id="${[...i.name].filter(c => /[\p{L}\p{N}_\-.:]/u.test(c)).join('')}"></a>`]);
    else if (i.t === 'figure') pieces.push(['', F.fmt(), `![${escape(i.alt)}]()`]);
  }
  let out = '', link = null;
  const stack = [];
  const closeAll = () => { while (stack.length) out += MARK[stack.pop()]; };
  for (const [text, f, raw] of pieces) {
    const fLink = f.link && isSafeHref(f.link) ? f.link : null;
    if (fLink !== link || raw !== null) {
      closeAll();
      if (link) out += `](${linkTarget(link)})`;
      link = null;
      if (raw !== null) { out += raw; continue; }
      if (fLink) { out += '['; link = fLink; }
    }
    const want = [['bold', f.bold], ['italic', f.italic], ['strike', f.strike]].filter(x => x[1]).map(x => x[0]);
    for (let pos = stack.findIndex(m => !want.includes(m)); pos >= 0; pos = stack.findIndex(m => !want.includes(m))) {
      while (stack.length > pos) out += MARK[stack.pop()];
    }
    for (const m of want) if (!stack.includes(m)) { out += MARK[m]; stack.push(m); }
    if (f.code) out += codeSpan(inTable ? text.replace(/\|/g, '\\|') : text);
    else out += escape(text).replace(/\n/g, '\\\n').replace(/\t/g, '    ');
  }
  closeAll();
  if (link) out += `](${linkTarget(link)})`;
  return out;
}
export const inlinesMd = inlines => inlinesMdImpl(inlines, false);

export function tableMd(t, out) {
  const cols = Math.max(1, F.tableCols(t));
  const cellMd = c => c.blocks.map(b => (b.t === 'para' ? inlinesMdImpl(b.inlines, true).replace(/\\\n/g, '<br>')
    : escape(b.rows.flatMap(r => r.map(F.cellText)).join(' ')))).join('<br>').replace(/\n/g, ' ');
  const span = c => Math.max(1, Math.min(63, c.colspan | 0 || 1));
  const rowMd = r => {
    const v = [];
    for (const c of r) { v.push(c.covered ? '' : cellMd(c)); for (let k = 1; k < span(c); k++) v.push(''); }
    while (v.length < cols) v.push('');
    v.length = cols;
    return v;
  };
  const head = t.rows[0];
  if (!head) return;
  out.push(`| ${rowMd(head).join(' | ')} |`);
  const aligns = [];
  for (const c of head) { aligns.push(c.blocks.find(b => b.t === 'para')?.align ?? null); for (let k = 1; k < span(c); k++) aligns.push(null); }
  while (aligns.length < cols) aligns.push(null);
  aligns.length = cols;
  out.push(`| ${aligns.map(a => (a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---')).join(' | ')} |`);
  for (const r of t.rows.slice(1)) out.push(`| ${rowMd(r).join(' | ')} |`);
}

export function writeBlocks(blocks, out) {
  let counters = Array(9).fill(0), prevList = false, prevTopOrdered = false;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.t === 'table') { tableMd(b, out); out.push(''); prevList = false; continue; }
    if (b.kind === 'code' && !b.list) {
      const lines = [];
      while (i < blocks.length && blocks[i].t === 'para' && blocks[i].kind === 'code' && !blocks[i].list) lines.push(F.paraText(blocks[i++]));
      i--;
      const longest = Math.max(0, ...lines.map(l => [...l].filter(c => c === '`').length));
      const fence = '`'.repeat(Math.max(3, longest + 1));
      out.push(fence, ...lines, fence, '');
      prevList = false;
      continue;
    }
    const body = inlinesMd(b.inlines);
    if (b.list) {
      const li = b.list, lv = Math.min(8, li.level);
      if (!prevList || (lv === 0 && prevTopOrdered !== li.ordered)) counters = Array(9).fill(0);
      if (lv === 0) prevTopOrdered = li.ordered;
      if (counters[lv] === 0) counters[lv] = Math.max(0, (li.start ?? 1) - 1);
      const n = ++counters[lv];
      for (let d = lv + 1; d < 9; d++) counters[d] = 0;
      const marker = li.ordered ? `${n}.` : '-';
      const pad = ' '.repeat(4 * lv), cont = ' '.repeat(4 * lv + marker.length + 1);
      let text;
      if (b.kind === 'code') text = codeSpan(F.paraText(b));
      else {
        text = escapeLines(body).split('\\\n').join(`\\\n${cont}`);
        if (thematicBreak(`${marker} ${text}`)) text = `\\${text}`;
      }
      out.push(`${pad}${marker} ${text}`.trimEnd());
      prevList = true;
      const next = blocks[i + 1];
      if (!(next?.t === 'para' && next.list)) out.push('');
      continue;
    }
    prevList = false;
    let line;
    if (b.kind === 'heading') line = `${'#'.repeat(Math.max(1, Math.min(6, b.level || 1)))} ${body.split('\\\n').join(' ')}`;
    else if (b.kind === 'title') line = `# ${body.split('\\\n').join(' ')}`;
    else if (b.kind === 'rule') line = '---';
    else if (b.kind === 'quote') line = `> ${escapeLines(body).split('\\\n').join('\\\n> ')}`;
    else { if (!body) continue; line = escapeLines(body); }
    out.push(line, '');
  }
}

/** Markdown text of a document (export). */
export function exportMarkdown(content) {
  const out = [];
  writeBlocks(F.fromContent(content).blocks, out);
  let s = out.join('\n');
  while (s.endsWith('\n\n')) s = s.slice(0, -1);
  if (!s.endsWith('\n')) s += '\n';
  return s;
}

/** comments.rs `markdown`: the comments a Print Markup copy ends with. */
export function commentsMarkdown(notes) {
  let s = '\n\n## Comments\n\n';
  notes.forEach((n, i) => {
    s += `${i + 1}. **${escape(n.author)}**`;
    if (n.quote) s += ` on “${escape(n.quote)}”`;
    s += `: ${escape(n.text)}\n`;
    for (const [a, t] of n.replies) s += `    - **${escape(a)}**: ${escape(t)}\n`;
  });
  return s;
}

/** formats-v2 contract: the .md bytes of `file` (opts.comments: Print Markup). */
export function write(file, opts = {}) {
  const content = file.content ?? file;
  let s = exportMarkdown(content);
  if (opts.comments) { const notes = F.commentNotes(content); if (notes.length) s += commentsMarkdown(notes); }
  return new TextEncoder().encode(s);
}
