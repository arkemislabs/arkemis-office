// Quill schema-2 content → HTML: what Save As > Web Page writes (and the clipboard's HTML flavour).
//
// Translated from wordcraft crates/formats/src/html/export.rs and crates/formats/src/comments.rs
// (`html`, Print Markup) at ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c: clean semantic
// HTML with inline CSS, pictures as data: URIs, ruby as <ruby>, nested lists from list paragraphs,
// code blocks as <pre><code>, quotes as <blockquote>. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// What differs (docs/behaviour-fidelity.md): upstream writes equations as MathML from its linear
// format (crates/formats/src/mathml.rs `linear_to_mathml`, not translated yet); here an equation is
// `<math><mtext>linear</mtext></math>`, which browsers show as the equation's linear text and
// html-read.mjs reads back exactly. No DOM, no Node built-ins.

import * as F from './_flow.mjs';
import {isSafeHref} from '../model/link.mjs';
import {rgbHex} from '../model/props.mjs';

export const UPSTREAM = Object.freeze({repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/formats/src/html/export.rs', 'crates/formats/src/comments.rs']});

/** Escape text for HTML content and attribute values. */
export function esc(s) {
  let o = '';
  for (const c of String(s)) {
    if (c === '&') o += '&amp;'; else if (c === '<') o += '&lt;'; else if (c === '>') o += '&gt;'; else if (c === '"') o += '&quot;';
    else if (c === '\u000C' || c === '\u000E') continue; else o += c;
  }
  return o;
}
const alignCss = a => ({center: 'text-align:center', right: 'text-align:right', justify: 'text-align:justify', distribute: 'text-align:justify'})[a] ?? null;

function textHtml(t, atStart) {
  let o = '', prevSpace = atStart;
  for (const c of t) {
    if (c === '\n') { o += '<br>'; prevSpace = true; continue; }
    if (c === '\t') o += '<span style="white-space:pre">\t</span>';
    else if (c === ' ' && prevSpace) o += '&nbsp;';
    else o += esc(c);
    prevSpace = c === ' ';
  }
  return o;
}
const trimNum = v => v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');

function fmtTags(f) {
  let open = '';
  const close = [];
  if (f.link && isSafeHref(f.link)) { open += `<a href="${esc(f.link)}">`; close.push('</a>'); }
  const tag = (o, c) => { open += o; close.push(c); };
  if (f.bold) tag('<strong>', '</strong>');
  if (f.italic) tag('<em>', '</em>');
  if (f.underline) tag('<u>', '</u>');
  if (f.strike) tag('<s>', '</s>');
  if (f.sup) tag('<sup>', '</sup>'); else if (f.sub) tag('<sub>', '</sub>');
  if (f.code) tag('<code>', '</code>');
  const css = [];
  if (f.color) css.push(`color:#${rgbHex(f.color)}`);
  if (f.background) css.push(`background-color:#${rgbHex(f.background)}`);
  if (f.size !== null && f.size !== undefined) css.push(`font-size:${trimNum(f.size)}pt`);
  if (f.font) css.push(`font-family:'${esc(f.font.replace(/'/g, ''))}'`);
  if (css.length) tag(`<span style="${css.join(';')}">`, '</span>');
  return [open, close];
}

/** Inline spans → HTML. */
export function inlinesHtml(inlines) {
  let o = '';
  for (const i of inlines) {
    if (i.t === 'text') {
      const [open, close] = fmtTags(i.fmt);
      const atStart = !o;
      o += open + textHtml(i.text, atStart) + close.reverse().join('');
    } else if (i.t === 'ruby') {
      const [open, close] = fmtTags(i.fmt);
      const atStart = !o;
      o += `${open}<ruby>${textHtml(i.base, atStart)}<rt>${textHtml(i.ruby, false)}</rt></ruby>${close.reverse().join('')}`;
    } else if (i.t === 'image') {
      o += `<img src="data:${F.mimeOf(i.img.ext)};base64,${i.img.b64}" alt="${esc(i.img.alt)}" width="${Math.round(i.img.w / 0.75)}" height="${Math.round(i.img.h / 0.75)}">`;
    } else if (i.t === 'anchor') o += `<a id="${esc(i.name)}"></a>`;
    else if (i.t === 'figure') o += `<img alt="${esc(i.alt)}">`;
    else if (i.t === 'equation') o += `<math${i.display ? ' display="block"' : ''}><mtext>${esc(i.linear)}</mtext></math>`;
  }
  return o;
}

function paraAttrs(p) {
  const css = [];
  const a = alignCss(p.align);
  if (a) css.push(a);
  if (p.pageBreak) css.push('break-before:page;page-break-before:always');
  return css.length ? ` style="${css.join(';')}"` : '';
}
function paraHtml(p) {
  const body = inlinesHtml(p.inlines), attrs = paraAttrs(p);
  if (p.kind === 'heading') { const n = Math.max(1, Math.min(6, p.level || 1)); return `<h${n}${attrs}>${body}</h${n}>`; }
  if (p.kind === 'title') return `<h1${attrs}>${body}</h1>`;
  if (p.kind === 'rule') return '<hr>';
  return body ? `<p${attrs}>${body}</p>` : `<p${attrs}>&nbsp;</p>`;
}
function tableHtml(t, out, depth) {
  out.push('<table style="border-collapse:collapse">\n');
  for (const row of t.rows) {
    out.push('<tr>');
    for (const c of row) {
      if (c.covered) continue;
      const tag = c.header ? 'th' : 'td';
      let attrs = '';
      if (c.colspan > 1) attrs += ` colspan="${c.colspan}"`;
      if (c.rowspan > 1) attrs += ` rowspan="${c.rowspan}"`;
      const css = ['padding:4px 6px', c.valign === 'center' ? 'vertical-align:middle' : c.valign === 'bottom' ? 'vertical-align:bottom' : 'vertical-align:top'];
      if (!t.borderless) css.unshift('border:1px solid #999');
      if (c.shading) css.push(`background-color:#${rgbHex(c.shading)}`);
      const single = c.blocks.length === 1 && c.blocks[0].t === 'para' && c.blocks[0].kind === 'normal' && !c.blocks[0].list && !c.blocks[0].pageBreak ? c.blocks[0] : null;
      const a = single ? alignCss(single.align) : null;
      if (a) css.push(a);
      out.push(`<${tag}${attrs} style="${css.join(';')}">`);
      if (single) out.push(inlinesHtml(single.inlines)); else { out.push('\n'); blocksHtml(c.blocks, out, depth + 1); }
      out.push(`</${tag}>`);
    }
    out.push('</tr>\n');
  }
  out.push('</table>\n');
}
function closeList(stack, out) {
  const top = stack.pop();
  if (!top) return;
  if (top[1]) out.push('</li>');
  out.push(top[0] ? '</ol>' : '</ul>');
}
function blocksHtml(blocks, out, depth) {
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.t === 'table') { if (depth < F.MAX_DEPTH) tableHtml(b, out, depth); i++; continue; }
    if (b.list) {
      const stack = [];
      while (i < blocks.length && blocks[i].t === 'para' && blocks[i].list) {
        const q = blocks[i], li = q.list, lv = Math.min(8, li.level);
        while (stack.length > lv + 1) closeList(stack, out);
        if (stack.length === lv + 1 && stack[stack.length - 1][0] !== li.ordered) closeList(stack, out);
        while (stack.length < lv + 1) {
          const top = stack[stack.length - 1];
          if (top && !top[1]) { out.push('<li>'); top[1] = true; }
          out.push(li.ordered ? '<ol>' : '<ul>');
          stack.push([li.ordered, false]);
        }
        const top = stack[stack.length - 1];
        if (top[1]) out.push('</li>\n');
        top[1] = true;
        out.push(`<li${paraAttrs(q)}>${inlinesHtml(q.inlines)}`);
        i++;
      }
      while (stack.length) closeList(stack, out);
      out.push('\n');
      continue;
    }
    if (b.kind === 'code') {
      out.push('<pre><code>');
      let first = true;
      while (i < blocks.length && blocks[i].t === 'para' && blocks[i].kind === 'code' && !blocks[i].list) {
        if (!first) out.push('\n');
        first = false;
        out.push(esc(F.paraText(blocks[i])));
        i++;
      }
      out.push('</code></pre>\n');
      continue;
    }
    if (b.kind === 'quote') {
      out.push('<blockquote>\n');
      while (i < blocks.length && blocks[i].t === 'para' && blocks[i].kind === 'quote' && !blocks[i].list) {
        out.push(paraHtml({...blocks[i], kind: 'normal'}), '\n');
        i++;
      }
      out.push('</blockquote>\n');
      continue;
    }
    out.push(paraHtml(b), '\n');
    i++;
  }
}

/** A complete HTML document for a flow (export_flow). */
export function exportFlow(fl, lang) {
  const m = fl.meta;
  const out = ['<!DOCTYPE html>\n', `<html lang="${esc(lang)}">\n<head>\n<meta charset="utf-8">\n`, '<meta name="generator" content="Arkemis Quill">\n',
    `<title>${esc(m.title)}</title>\n`];
  for (const k of ['author', 'description', 'keywords', 'subject']) if (m[k]) out.push(`<meta name="${k}" content="${esc(m[k])}">\n`);
  out.push("<style>\nbody{font-family:Aptos,Calibri,'Segoe UI',Arial,sans-serif;font-size:12pt;line-height:1.15;max-width:48em;margin:2em auto;padding:0 1em}\n"
    + 'table{border-collapse:collapse;margin:0.5em 0}\nblockquote{margin:0.5em 2em;font-style:italic;color:#404040}\n'
    + "pre{background:#f5f5f5;padding:0.5em;font-family:'Courier New',monospace;font-size:10pt}\n</style>\n</head>\n<body>\n");
  blocksHtml(fl.blocks, out, 0);
  out.push('</body>\n</html>\n');
  return out.join('');
}
/** The document as a complete HTML page (export). */
export function exportHtml(content) { return exportFlow(F.fromContent(content), content.styles?.defaultChr?.lang ?? 'en'); }
/** The document as an HTML fragment (no head or style sheet): the clipboard's HTML (export_fragment). */
export function exportFragment(content) { const out = ['<meta charset="utf-8">']; blocksHtml(F.fromContent(content).blocks, out, 0); return out.join(''); }

/** comments.rs `html`: the comments section a Print Markup copy ends with. */
export function commentsHtml(notes) {
  let s = '<section class="comments">\n<h2>Comments</h2>\n<ol>\n';
  notes.forEach((n, i) => {
    s += `<li id="comment-${i + 1}"><p><strong>${esc(n.author)}</strong>`;
    if (n.quote) s += ` on <q>${esc(n.quote)}</q>`;
    s += `: ${esc(n.text)}</p>`;
    if (n.replies.length) { s += '<ul>'; for (const [a, t] of n.replies) s += `<li><strong>${esc(a)}</strong>: ${esc(t)}</li>`; s += '</ul>'; }
    s += '</li>\n';
  });
  return `${s}</ol>\n</section>\n`;
}

/** formats-v2 contract: the .html bytes of `file` (opts.comments: Print Markup). */
export function write(file, opts = {}) {
  const content = file.content ?? file;
  let s = exportHtml(content);
  if (opts.comments) {
    const notes = F.commentNotes(content);
    if (notes.length) { const at = s.lastIndexOf('</body>'); s = at >= 0 ? s.slice(0, at) + commentsHtml(notes) + s.slice(at) : s + commentsHtml(notes); }
  }
  return new TextEncoder().encode(s);
}
