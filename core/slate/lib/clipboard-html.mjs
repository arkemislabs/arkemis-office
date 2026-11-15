// HTML for the clipboard (Home > Clipboard; U:slate/clipboard): a copied page selection as HTML, and
// pasted HTML read back into paragraphs of formatted runs. Slate has no ArtCraft upstream. There is
// no DOM here (core), so both directions are small and strict: only what the page can hold is
// written or read (paragraphs, headings, lists as paragraphs, bold, italic, underline, strike, sub,
// superscript, links, highlight, colour, pictures given as data URLs); anything else is dropped to
// its text. Scripts and styles are never read. No DOM, no Node built-ins.

import {sheetHtml} from './sheet-text.mjs';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------------------------------------
// Writing: a slice's blocks -> HTML

const TAGS = {bold: 'strong', italic: 'em', underline: 'u', strike: 's', subscript: 'sub', superscript: 'sup'};

function inlineHtml(node) {
  const t = node.type.name;
  let out;
  if (node.isText) out = esc(node.text);
  else if (t === 'hardBreak') return '<br>';
  else if (t === 'image') return `<img src="${esc(node.attrs.src)}" alt="${esc(node.attrs.alt ?? '')}">`;
  else if (t === 'equation') out = `<span data-equation="">${esc(node.attrs.linear)}</span>`;
  else if (t === 'attachment') out = esc(node.attrs.name ?? '');
  else if (t === 'spreadsheet') return sheetHtml(node.attrs);
  else if (t === 'diagram') out = esc(node.attrs.text ?? '').replace(/\n/g, '<br>');
  else out = esc(node.textContent ?? '');
  for (const m of node.marks ?? []) {
    const n = m.type.name;
    if (TAGS[n]) out = `<${TAGS[n]}>${out}</${TAGS[n]}>`;
    else if (n === 'highlight') out = `<mark style="background:${esc(m.attrs.color)}">${out}</mark>`;
    else if (n === 'link') out = `<a href="${esc(m.attrs.href)}">${out}</a>`;
    else if (n === 'textStyle') {
      const css = [m.attrs.color ? `color:${m.attrs.color}` : '', m.attrs.fontFamily ? `font-family:${m.attrs.fontFamily}` : '', m.attrs.fontSize ? `font-size:${m.attrs.fontSize}pt` : ''].filter(Boolean).join(';');
      if (css) out = `<span style="${esc(css)}">${out}</span>`;
    }
  }
  return out;
}

function inlineOf(p) { const x = []; p.forEach(c => x.push(inlineHtml(c))); return x.join(''); }

function blockHtml(node) {
  const t = node.type.name;
  if (t === 'paragraph') {
    const inner = [];
    node.forEach(c => inner.push(inlineHtml(c)));
    const style = node.attrs.style;
    const tag = /^h[1-6]$/.test(style) ? style : style === 'code' ? 'pre' : 'p';
    return `<${tag}>${inner.join('')}</${tag}>`;
  }
  if (t === 'bulletList' || t === 'orderedList') {
    const items = [];
    node.forEach(li => { const parts = []; li.forEach(b => parts.push(b.type.name === 'paragraph' ? inlineOf(b) : blockHtml(b))); items.push(`<li>${parts.join('')}</li>`); });
    return `<${t === 'orderedList' ? 'ol' : 'ul'}>${items.join('')}</${t === 'orderedList' ? 'ol' : 'ul'}>`;
  }
  if (t === 'table') {
    const rows = [];
    node.forEach(r => { const cells = []; r.forEach(c => cells.push(`<td>${blocksHtml(c)}</td>`)); rows.push(`<tr>${cells.join('')}</tr>`); });
    return `<table><tbody>${rows.join('')}</tbody></table>`;
  }
  if (node.isInline) return `<p>${inlineHtml(node)}</p>`;
  return blocksHtml(node);
}
function blocksHtml(node) { const out = []; node.forEach(c => out.push(blockHtml(c))); return out.join(''); }

/** The HTML of a ProseMirror Fragment (a slice's content). Inline-only content is a run of inline HTML, otherwise blocks. */
export function fragmentHtml(fragment) {
  let blocks = false;
  fragment.forEach(n => { if (!n.isInline) blocks = true; });
  const out = [];
  fragment.forEach(n => out.push(blocks ? blockHtml(n) : inlineHtml(n)));
  return `<html><body><!--StartFragment-->${out.join('')}<!--EndFragment--></body></html>`;
}

// ---------------------------------------------------------------------------------------------
// Reading: HTML -> paragraphs [{style, runs: [{text, marks: [{type, attrs?}]} | {image: {src, alt}}]}]

const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•'};
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
  return ENTITIES[e.toLowerCase()] ?? m;
});

const BLOCK = new Set(['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote', 'ul', 'ol', 'table', 'section', 'article', 'header', 'footer']);
const MARK_OF = {b: 'bold', strong: 'bold', i: 'italic', em: 'italic', u: 'underline', s: 'strike', strike: 'strike', del: 'strike', sub: 'subscript', sup: 'superscript'};
const MAX_HTML = 5_000_000;

/**
 * Paragraphs of runs from HTML. `keep` ('all' | 'emphasis') chooses what formatting is read: all
 * (links, highlight, colour, font, sub/superscript, emphasis) or emphasis only (bold, italic,
 * underline, strike), the rest taking the formatting where it lands (Merge Formatting).
 */
export function parseHtml(html, {keep = 'all'} = {}) {
  let src = String(html ?? '').slice(0, MAX_HTML);
  const frag = /<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/i.exec(src);
  if (frag) src = frag[1];
  src = src.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, '');
  const paras = [];
  let cur = null;
  const stack = [];
  const open = (style = 'normal') => { cur = {style, runs: []}; paras.push(cur); };
  const close = () => { if (cur && !cur.runs.length) paras.pop(); cur = null; };
  const marksNow = () => {
    const out = [];
    for (const f of stack) {
      if (f.mark && (keep === 'all' || ['bold', 'italic', 'underline', 'strike'].includes(f.mark.type)) && !out.some(m => m.type === f.mark.type && JSON.stringify(m.attrs) === JSON.stringify(f.mark.attrs))) out.push(f.mark);
    }
    return out;
  };
  const text = raw => {
    const t = decode(raw.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' '));
    if (!t || (!cur && !t.trim())) return;
    if (!cur) open();
    const piece = cur.runs.length ? t : t.replace(/^ /, '');
    if (!piece) return;
    const marks = marksNow();
    const last = cur.runs[cur.runs.length - 1];
    if (last && !last.image && JSON.stringify(last.marks) === JSON.stringify(marks)) last.text += piece;
    else cur.runs.push({text: piece, marks});
  };
  const re = /<(\/?)([a-z][a-z0-9]*)\b([^>]*)>|([^<]+)|</gi;
  let m;
  let guard = 0;
  while ((m = re.exec(src)) && guard++ < 400_000) {
    if (m[4] !== undefined) { text(m[4]); continue; }
    if (!m[2]) { text('<'); continue; }
    const tag = m[2].toLowerCase();
    const attrs = m[3] ?? '';
    const attr = name => { const a = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs); return a ? decode(a[2] ?? a[3] ?? a[4] ?? '') : null; };
    if (m[1]) {
      if (BLOCK.has(tag)) close();
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
      continue;
    }
    if (tag === 'br') { if (!cur) open(); cur.runs.push({text: '\n', marks: []}); continue; }
    if (tag === 'img') {
      const s = attr('src');
      if (s && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) { if (!cur) open(); cur.runs.push({image: {src: s, alt: attr('alt') ?? ''}}); }
      else if (attr('alt')) text(attr('alt'));
      continue;
    }
    if (BLOCK.has(tag)) { close(); open(/^h[1-6]$/.test(tag) ? tag : tag === 'pre' ? 'code' : 'normal'); if (tag === 'ul' || tag === 'ol' || tag === 'table' || tag === 'tr') close(); }
    const f = {tag};
    if (MARK_OF[tag]) f.mark = {type: MARK_OF[tag]};
    else if (tag === 'a' && attr('href')) f.mark = {type: 'link', attrs: {href: attr('href'), title: attr('title')}};
    else if (tag === 'mark') { const bg = /background(?:-color)?:\s*(#[0-9a-f]{6})/i.exec(attr('style') ?? '')?.[1]; f.mark = {type: 'highlight', attrs: {color: bg ? bg.toLowerCase() : '#ffff00'}}; }
    else if (tag === 'span' || tag === 'font') {
      const st = attr('style') ?? '';
      const color = /(?:^|;)\s*color:\s*(#[0-9a-f]{6})/i.exec(st)?.[1] ?? null;
      if (color) f.mark = {type: 'textStyle', attrs: {color: color.toLowerCase(), fontFamily: null, fontSize: null}};
    }
    if (!['hr', 'meta', 'link', 'col'].includes(tag)) stack.push(f);
  }
  close();
  return paras.map(p => ({...p, runs: p.runs.map((r, i, all) => (r.image ? r : {...r, text: i === all.length - 1 ? r.text.replace(/ $/, '') : r.text}))}));
}

/** Plain text lines -> paragraphs of one run each (line breaks make paragraphs). */
export function parseText(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map(line => ({style: 'normal', runs: line ? [{text: line, marks: []}] : []}));
}
