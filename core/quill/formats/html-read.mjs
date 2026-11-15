// HTML (.html/.htm/.xhtml) → Quill schema-2 content: what File > Open reads from a web page.
//
// Translated from wordcraft crates/formats/src/html.rs, html/import.rs, html/lexer.rs,
// html/builder.rs, html/css.rs, html/entity.rs and html/math_ruby.rs (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c). A tolerant tag-soup reader (no DOM): a tokenizer
// plus a stack of open elements with HTML's implicit closes for p, li, tr, td/th and headings;
// p, div, h1–h6, b/strong, i/em, u, s/strike/del, sup/sub, code/kbd, a (links, id/name
// anchors), br, hr, ul/ol/li (nested), table/tr/td/th (colspan/rowspan), img (data: URIs, others
// through the caller's loader), blockquote, pre, font, ruby (rb/rt/rp), and the CSS properties
// color, background-color, font-weight, font-style, font-size, font-family, text-decoration,
// vertical-align, text-align, white-space and page breaks. Scripts and styles are skipped.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// What differs (docs/behaviour-fidelity.md): upstream reads `<math>` into an equation through its
// MathML converter (crates/formats/src/mathml.rs, not translated yet); here a `<math>` element's
// text becomes the equation's linear text (an `<mtext>` written by html-write.mjs reads back
// exactly). No DOM, no Node built-ins.

import * as F from './_flow.mjs';
import {isSafeHref} from '../model/link.mjs';
import {cp1252} from '../model/encoding.mjs';
import {decode as decodeText, decodeAs} from './txt-read.mjs';

export const UPSTREAM = Object.freeze({repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c',
  files: ['crates/formats/src/html/import.rs', 'crates/formats/src/html/lexer.rs', 'crates/formats/src/html/builder.rs', 'crates/formats/src/html/css.rs',
    'crates/formats/src/html/entity.rs', 'crates/formats/src/html/math_ruby.rs']});

// --- entity.rs -------------------------------------------------------------------------------

const ENTITIES = (() => {
  const m = new Map();
  const add = (names, ch) => { for (const n of names.split(' ')) m.set(n, ch); };
  add('amp AMP', '&'); add('lt LT', '<'); add('gt GT', '>'); add('quot QUOT', '"'); add('apos APOS', "'"); add('nbsp NBSP', ' ');
  add('copy COPY', '©'); add('reg REG', '®'); add('trade TRADE', '™'); add('euro EURO', '€'); add('pound POUND', '£'); add('yen YEN', '¥');
  add('cent CENT', '¢'); add('asymp approx', '≈');
  const pairs = 'ensp   emsp   thinsp   shy ­ hellip … mdash — ndash – minus − lsquo ‘ rsquo ’ sbquo ‚ ldquo “ rdquo ” bdquo „ laquo « raquo » '
    + 'bull • middot · deg ° plusmn ± times × divide ÷ frac12 ½ frac14 ¼ frac34 ¾ frac13 ⅓ frac23 ⅔ frac18 ⅛ frac38 ⅜ frac58 ⅝ frac78 ⅞ sup1 ¹ sup2 ² '
    + 'sup3 ³ micro µ permil ‰ prime ′ Prime ″ oline ‾ frasl ⁄ sect § para ¶ curren ¤ dagger † Dagger ‡ larr ← rarr → uarr ↑ darr ↓ harr ↔ lArr ⇐ '
    + 'rArr ⇒ uArr ⇑ dArr ⇓ hArr ⇔ crarr ↵ forall ∀ part ∂ exist ∃ empty ∅ nabla ∇ isin ∈ notin ∉ ni ∋ prod ∏ sum ∑ radic √ prop ∝ ang ∠ and ∧ '
    + 'or ∨ cap ∩ cup ∪ int ∫ there4 ∴ sim ∼ cong ≅ ne ≠ equiv ≡ le ≤ ge ≥ sub ⊂ sup ⊃ nsub ⊄ sube ⊆ supe ⊇ oplus ⊕ otimes ⊗ perp ⊥ sdot ⋅ '
    + 'infin ∞ loz ◊ spades ♠ clubs ♣ hearts ♥ diams ♦ check ✓ iexcl ¡ iquest ¿ szlig ß auml ä ouml ö uuml ü Auml Ä Ouml Ö Uuml Ü eacute é '
    + 'egrave è ecirc ê euml ë Eacute É Egrave È Ecirc Ê Euml Ë aacute á agrave à acirc â atilde ã Agrave À Aacute Á Acirc Â Atilde Ã iacute í '
    + 'igrave ì icirc î iuml ï Iacute Í Igrave Ì Icirc Î Iuml Ï oacute ó ograve ò ocirc ô otilde õ Oacute Ó Ograve Ò Ocirc Ô Otilde Õ uacute ú '
    + 'ugrave ù ucirc û Uacute Ú Ugrave Ù Ucirc Û yacute ý yuml ÿ Yacute Ý ntilde ñ Ntilde Ñ ccedil ç Ccedil Ç aring å Aring Å oslash ø Oslash Ø '
    + 'aelig æ AElig Æ alpha α beta β gamma γ delta δ epsilon ε zeta ζ eta η theta θ iota ι kappa κ lambda λ mu μ nu ν xi ξ pi π rho ρ sigma σ '
    + 'tau τ upsilon υ phi φ chi χ psi ψ omega ω Gamma Γ Delta Δ Theta Θ Lambda Λ Xi Ξ Pi Π Sigma Σ Upsilon Υ Phi Φ Psi Ψ Omega Ω';
  const t = pairs.split(' ');
  for (let i = 0; i + 1 < t.length; i += 2) m.set(t[i], t[i + 1]);
  m.set('zwj', '‍'); m.set('zwnj', '‌');
  return m;
})();

/** The text of entity `name` (without `&` and `;`), or null (entity.rs decode_entity). */
export function decodeEntity(name) {
  if (name.startsWith('#')) {
    let digits = name.slice(1), radix = 10;
    if (digits[0] === 'x' || digits[0] === 'X') { digits = digits.slice(1); radix = 16; }
    if (!digits || !(radix === 16 ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) return null;
    const v = parseInt(digits, radix);
    if (!Number.isFinite(v) || v > 0xffffffff) return null;
    if (v === 0) return '�';
    if (v >= 0x80 && v <= 0x9f) return cp1252(v);
    if (v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) return '�';
    return String.fromCodePoint(v);
  }
  return ENTITIES.get(name) ?? null;
}
/** Replace entity references in `s`. */
export function unescape(s) {
  if (!s.includes('&')) return s;
  let out = '', rest = s;
  for (let k = rest.indexOf('&'); k >= 0; k = rest.indexOf('&')) {
    out += rest.slice(0, k);
    const after = rest.slice(k + 1);
    const e = after.slice(0, 33).indexOf(';');
    const t = e >= 0 ? decodeEntity(after.slice(0, e)) : null;
    if (t !== null) { out += t; rest = after.slice(e + 1); } else { out += '&'; rest = after; }
  }
  return out + rest;
}
function sniffCharset(head) {
  let i = head.indexOf('charset'), n = 7;
  if (i < 0) { i = head.indexOf('encoding'); n = 8; }
  if (i < 0) return null;
  const after = head.slice(i + n).trimStart();
  if (!after.startsWith('=')) return null;
  const t = after.slice(1).trimStart().replace(/^["']+/, '');
  const m = /^[^\s"';>/]*/.exec(t);
  const label = m[0].trim();
  return label || null;
}
/** Decode HTML bytes: BOM, then a `charset` in the first 2 KB, else UTF-8 with a legacy fallback. */
export function decode(b) {
  b = b instanceof Uint8Array ? b : new Uint8Array(b);
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff) || (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)) return decodeText(b);
  const head = new TextDecoder('utf-8').decode(b.subarray(0, 2048)).toLowerCase();
  const label = sniffCharset(head);
  if (label) { const s = decodeAs(b, label); if (s !== null) return s; }
  try { return new TextDecoder('utf-8', {fatal: true}).decode(b); } catch { return decodeText(b); }
}

// --- lexer.rs --------------------------------------------------------------------------------

const isWs = c => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const isAlnum = c => /[A-Za-z0-9]/.test(c);

export class Lexer {
  constructor(s) { this.s = s; this.pos = 0; }
  rest() { return this.s.slice(this.pos); }
  skipPast(pat) {
    const k = this.s.toLowerCase().indexOf(pat.toLowerCase(), this.pos);
    const start = this.pos;
    if (k >= 0) { this.pos = k + pat.length; return k; }
    this.pos = this.s.length;
    return start === this.s.length ? this.s.length : this.s.length;
  }
  skipPastEndTag(tag) {
    const lower = this.s.toLowerCase(), p = `</${tag}`;
    while (this.pos < this.s.length) {
      const k = lower.indexOf(p, this.pos);
      if (k < 0) { this.pos = this.s.length; return; }
      const nb = this.s[k + p.length];
      if (nb === undefined || isWs(nb) || nb === '>' || nb === '/') { this.pos = k + p.length; this.skipPast('>'); return; }
      this.pos = k + 2;
    }
  }
  next() {
    const s = this.s, at = this.pos;
    if (at >= s.length) return null;
    if (s[at] !== '<') {
      let end = s.indexOf('<', at);
      if (end < 0) end = s.length;
      this.pos = end;
      return {t: 'text', text: unescape(s.slice(at, end))};
    }
    if (s.startsWith('<!--', at)) { this.pos += 4; this.skipPast('-->'); return {t: 'text', text: ''}; }
    if (s.startsWith('<!', at) || s.startsWith('<?', at)) { this.skipPast('>'); return {t: 'text', text: ''}; }
    if (s.startsWith('</', at)) {
      const m = /^[A-Za-z0-9:-]*/.exec(s.slice(at + 2, at + 2 + 256));
      const name = m[0].toLowerCase();
      if (!name) { this.pos += 2; return {t: 'text', text: '</'}; }
      this.skipPast('>');
      return {t: 'end', name};
    }
    if (!/[A-Za-z]/.test(s[at + 1] ?? '')) { this.pos += 1; return {t: 'text', text: '<'}; }
    const name = /^[A-Za-z0-9:-]*/.exec(s.slice(at + 1, at + 1 + 256))[0].toLowerCase();
    let i = at + 1 + name.length;
    const attrs = [];
    let selfClose = false;
    for (;;) {
      while (i < s.length && isWs(s[i])) i++;
      if (i >= s.length) break;
      if (s[i] === '>') { i++; break; }
      if (s[i] === '/') { if (s[i + 1] === '>') { selfClose = true; i += 2; break; } i++; continue; }
      const a0 = i;
      while (i < s.length && !isWs(s[i]) && s[i] !== '=' && s[i] !== '>' && s[i] !== '/') i++;
      const an = s.slice(a0, i).toLowerCase();
      if (!an) { i++; continue; }
      while (i < s.length && isWs(s[i])) i++;
      let val = '';
      if (s[i] === '=') {
        i++;
        while (i < s.length && isWs(s[i])) i++;
        if (s[i] === '"' || s[i] === "'") {
          const q = s[i], v0 = i + 1;
          let e = s.indexOf(q, v0);
          if (e < 0) e = s.length;
          val = unescape(s.slice(v0, e));
          i = e + 1;
        } else {
          const v0 = i;
          while (i < s.length && !isWs(s[i]) && s[i] !== '>') i++;
          val = unescape(s.slice(v0, i));
        }
      }
      if (attrs.length < 64) attrs.push([an, val]);
    }
    this.pos = Math.min(i, s.length);
    return {t: 'start', name, attrs, selfClose};
  }
}

// --- css.rs ----------------------------------------------------------------------------------

/** A CSS length (or font-size keyword) in points; null when it is not one. */
export function cssLenPt(v) {
  v = String(v).trim().toLowerCase();
  const num = s => { const t = s.trim(); if (!t) return null; const x = Number(t); return Number.isFinite(x) ? x : null; };
  const suf = (sfx, k) => { if (!v.endsWith(sfx)) return undefined; const x = num(v.slice(0, -sfx.length)); return x === null ? null : x * k; };
  for (const [sfx, k] of [['pt', 1], ['px', 0.75], ['rem', 12], ['em', 12], ['in', 72], ['cm', 72 / 2.54], ['mm', 72 / 25.4], ['%', 0.12]]) {
    const r = suf(sfx, k);
    if (r !== undefined) return r;
  }
  const kw = {'xx-small': 7, 'x-small': 7.5, small: 10, smaller: 10, medium: 12, large: 13.5, larger: 13.5, 'x-large': 18, 'xx-large': 24, 'xxx-large': 36}[v];
  if (kw !== undefined) return kw;
  const x = num(v);
  return x === null ? null : x * 0.75;
}
function stripImportant(v) {
  const s = v.trim();
  const pos = s.lastIndexOf('!');
  if (pos >= 0 && s.slice(pos + 1).trim().toLowerCase() === 'important') return s.slice(0, pos).trim();
  return s;
}
/** Apply a `style` attribute to formatting / block properties (st: {fmt, align, preserve, pageBreak, pageBreakAfter}). */
export function applyStyle(css, st) {
  const f = st.fmt;
  for (const decl of css.split(';').slice(0, 64)) {
    const c = decl.indexOf(':');
    if (c < 0) continue;
    const k = decl.slice(0, c).trim().toLowerCase(), v = stripImportant(decl.slice(c + 1)), lv = v.toLowerCase();
    switch (k) {
      case 'font-weight': f.bold = lv.startsWith('bold') || (/^\d+$/.test(lv) && Number(lv) >= 600); break;
      case 'font-style': f.italic = lv === 'italic' || lv === 'oblique'; break;
      case 'text-decoration': case 'text-decoration-line':
        if (lv.includes('none')) { f.underline = false; f.strike = false; }
        if (lv.includes('underline')) f.underline = true;
        if (lv.includes('line-through')) f.strike = true;
        break;
      case 'color': { const col = F.parseColor(v); if (col) f.color = col; break; }
      case 'background-color': case 'background': { for (const t of v.split(/\s+/)) { const col = F.parseColor(t); if (col) { f.background = col; break; } } break; }
      case 'font-size': { const p = cssLenPt(v); if (p !== null && p >= 1 && p <= 1638) f.size = p; break; }
      case 'font-family': {
        const fam = v.split(',')[0].trim().replace(/^["']+|["']+$/g, '');
        if (F.isMono(fam) || fam.toLowerCase() === 'monospace') f.code = true;
        else if (fam && !['serif', 'sans-serif', 'inherit', 'initial'].includes(fam.toLowerCase())) f.font = F.keptFont(fam) ?? f.font;
        break;
      }
      case 'vertical-align': f.sup = lv === 'super'; f.sub = lv === 'sub'; break;
      case 'text-align': st.align = {center: 'center', right: 'right', end: 'right', justify: 'justify', left: 'left', start: 'left'}[lv] ?? st.align; break;
      case 'white-space': st.preserve = lv.startsWith('pre'); break;
      case 'page-break-before': case 'break-before': st.pageBreak = lv === 'always' || lv === 'page'; break;
      case 'page-break-after': case 'break-after': st.pageBreakAfter = lv === 'always' || lv === 'page'; break;
      default:
    }
  }
}

// --- builder.rs ------------------------------------------------------------------------------

const MAX_STACK = 256;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'basefont', 'frame']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'figure', 'figcaption', 'address', 'dl', 'dt', 'dd',
  'center', 'form', 'fieldset', 'body', 'html', 'caption', 'thead', 'tbody', 'tfoot', 'details', 'summary', 'legend', 'hgroup']);
/** Block kind of an element name: {k, n} or null (inline). */
export function blockKind(n) {
  if (BLOCK.has(n)) return {k: 'block'};
  if (/^h[1-6]$/.test(n)) return {k: 'heading', n: Number(n[1])};
  if (n === 'blockquote') return {k: 'quote'};
  if (['pre', 'listing', 'xmp', 'plaintext'].includes(n)) return {k: 'pre'};
  if (['ul', 'menu', 'dir'].includes(n)) return {k: 'list', ordered: false};
  if (n === 'ol') return {k: 'list', ordered: true};
  if (n === 'li') return {k: 'li'};
  if (n === 'table') return {k: 'table'};
  if (n === 'tr') return {k: 'tr'};
  if (n === 'td' || n === 'th') return {k: 'cell'};
  if (n === 'head') return {k: 'head'};
  return null;
}
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul', 'figure', 'center', 'dd', 'dt', 'li']);
const attr = (attrs, name) => { const a = attrs.find(([k]) => k === name); return a ? a[1] : null; };

function applyFontAttributes(attrs, fmt) {
  const color = attr(attrs, 'color');
  const col = color !== null ? F.parseColor(color) : null;
  if (col) fmt.color = col;
  const face = attr(attrs, 'face');
  if (face !== null) {
    const family = face.split(',')[0].trim();
    if (F.isMono(family)) fmt.code = true; else if (family) fmt.font = F.keptFont(family) ?? fmt.font;
  }
  let size = attr(attrs, 'size');
  if (size === null) return;
  size = size.trim();
  const int = t => (/^[+-]?\d+$/.test(t) ? Number(t) : null);
  let points = null;
  if (size.startsWith('+')) { const d = int(size.slice(1)); points = d === null ? null : 3 + d; }
  else if (size.startsWith('-')) { const d = int(size.slice(1)); points = d === null ? null : 3 - d; }
  else points = int(size);
  if (points !== null) fmt.size = [7.5, 10, 12, 13.5, 18, 24, 36][Math.max(1, Math.min(7, points)) - 1];
}
function declaresBorder(attrs, isTable) {
  const b = attr(attrs, 'border');
  if (isTable && b !== null) { const t = b.trim(); if (/^\d+$/.test(t) ? Number(t) > 0 : !t) return true; }
  const style = attr(attrs, 'style');
  if (style === null) return false;
  return style.split(';').some(decl => {
    const c = decl.indexOf(':');
    if (c < 0) return false;
    const name = decl.slice(0, c).trim().toLowerCase();
    if (!['border', 'border-top', 'border-right', 'border-bottom', 'border-left'].includes(name)) return false;
    const value = decl.slice(c + 1).trim().toLowerCase();
    return !!value && !value.split(/\s+/).some(t => ['none', 'hidden', '0', '0px', '0pt'].includes(t));
  });
}
/** White space inside ruby markup collapsed as body text does, without the edge spaces. */
export function collapseWs(s) {
  let out = '';
  for (const c of s) { if (' \t\n\r\f'.includes(c)) { if (!out.endsWith(' ')) out += ' '; } else out += c; }
  return out.replace(/^ +| +$/g, '');
}

class Builder {
  constructor(images) {
    this.images = images; this.containers = [[]]; this.cells = []; this.tables = []; this.stack = []; this.para = null; this.paraCont = false;
    this.pendingPageBreak = false; this.preLead = null; this.preTail = false; this.meta = F.meta(); this.title = null;
  }
  fmt() { return this.stack.length ? {...this.stack[this.stack.length - 1].fmt} : F.fmt(); }
  preserve() { return !!this.stack[this.stack.length - 1]?.preserve; }
  inHead() { return this.stack.some(e => e.kind.k === 'head'); }
  startPara() {
    if (!this.para) {
      const p = F.para();
      let listLevel = null, liAt = null, lists = 0;
      for (let i = this.stack.length - 1; i >= 0; i--) {
        const e = this.stack[i];
        if (e.kind.k === 'cell') {
          if (!p.align) {
            const outer = this.stack.slice(0, i + 1);
            const chainEls = [];
            for (let j = outer.length - 1; j >= 0 && outer[j].kind.k !== 'table'; j--) chainEls.push(outer[j]);
            for (let j = outer.length - 1; j >= 0; j--) if (outer[j].kind.k === 'table') { chainEls.push(outer[j]); break; }
            p.align = chainEls.find(o => o.align)?.align ?? null;
          }
          break;
        }
        if (e.kind.k === 'table') break;
        if (e.kind.k === 'heading' && p.kind === 'normal') { p.kind = 'heading'; p.level = Math.max(1, Math.min(6, e.kind.n)); }
        else if (e.kind.k === 'pre' && p.kind === 'normal') p.kind = 'code';
        else if (e.kind.k === 'quote' && p.kind === 'normal') p.kind = 'quote';
        else if (e.kind.k === 'li' && liAt === null) liAt = i;
        else if (e.kind.k === 'list') { if (listLevel === null) listLevel = e.kind.ordered; lists++; }
        if (!p.align && e.align && e.kind.k !== 'inline') p.align = e.align;
      }
      if (listLevel !== null && liAt !== null) {
        p.list = {ordered: listLevel, level: Math.min(8, Math.max(0, lists - 1)), start: 1};
        this.paraCont = !!this.stack[liAt].used;
        this.stack[liAt].used = true;
      } else this.paraCont = false;
      let pbBefore = false;
      for (let i = this.stack.length - 1; i >= 0 && this.stack[i].kind.k !== 'cell'; i--) if (this.stack[i].pageBreak) { this.stack[i].pageBreak = false; pbBefore = true; }
      p.pageBreak = pbBefore || this.pendingPageBreak;
      this.pendingPageBreak = false;
      this.para = p;
    }
    return this.para;
  }
  container() { if (!this.containers.length) this.containers.push([]); return this.containers[this.containers.length - 1]; }
  flush() {
    const p = this.para;
    if (!p) return;
    this.para = null;
    const preLead = this.preLead ?? false, preTail = this.preTail;
    this.preLead = null; this.preTail = false;
    if (p.kind !== 'code') {
      const ALL = ' \t\r\n', BREAKS = '\r\n';
      F.trimWith(p, preLead ? BREAKS : ALL, preTail ? BREAKS : ALL);
      if (!F.paraText(p).trim()) F.trim(p);
    }
    if (p.inlines.length === 1 && F.paraText(p) === ' ') { p.inlines = []; this.paraCont = false; this.container().push(p); return; }
    if (F.paraIsEmpty(p) && p.kind !== 'code' && !p.list) return;
    const cont = this.paraCont;
    this.paraCont = false;
    const c = this.container();
    const prev = c[c.length - 1];
    if (cont && prev?.t === 'para' && prev.list && prev.list.level === p.list?.level) {
      F.pushText(prev, '\n', F.fmt());
      prev.inlines.push(...p.inlines);
      return;
    }
    c.push(p);
  }
  text(t) {
    if (this.inHead()) { if (this.title !== null) this.title += t; return; }
    if (!t) return;
    let inner = null;
    for (let i = this.stack.length - 1; i >= 0; i--) if (['table', 'tr', 'cell'].includes(this.stack[i].kind.k)) { inner = this.stack[i].kind.k; break; }
    if ((inner === 'table' || inner === 'tr') && !t.trim()) return;
    const code = this.stack.some(e => e.kind.k === 'pre');
    const f = this.fmt();
    if (code) {
      let first = true;
      for (let line of t.split('\n')) {
        if (!first) {
          const emptyStart = (!this.para || !this.para.inlines.length) && this.preFresh();
          if (!emptyStart) { this.startPara(); this.flush(); }
        }
        first = false;
        line = line.replace(/\r+$/, '');
        if (line) { F.pushText(this.startPara(), line, {...f, code: false}); this.markPreUsed(); }
      }
      return;
    }
    if (this.preserve()) { this.noteEdge(true); F.pushText(this.startPara(), t, f); return; }
    let s = '';
    const last = this.para?.inlines[this.para.inlines.length - 1];
    let prevSpace = !this.para ? true : !last ? true : last.t === 'text' ? /[ \n]$/.test(last.text) : false;
    for (const c of t) {
      if (' \t\n\r\f'.includes(c)) { if (!prevSpace) { s += ' '; prevSpace = true; } } else { s += c; prevSpace = false; }
    }
    if (!s) return;
    this.noteEdge(false);
    F.pushText(this.startPara(), s, f);
  }
  noteEdge(preserved) { if (!this.para || !this.para.inlines.length) this.preLead = preserved; this.preTail = preserved; }
  pushRuby(base, ruby) {
    const pre = this.preserve();
    const tx = s => (pre ? s : collapseWs(s));
    base = tx(base); ruby = tx(ruby);
    const f = this.fmt();
    if (!base || !ruby) { F.pushText(this.startPara(), base || ruby, f); return; }
    this.startPara().inlines.push({t: 'ruby', base, ruby, fmt: f});
  }
  preFresh() { for (let i = this.stack.length - 1; i >= 0; i--) if (this.stack[i].kind.k === 'pre') return !this.stack[i].used; return false; }
  markPreUsed() { for (let i = this.stack.length - 1; i >= 0; i--) if (this.stack[i].kind.k === 'pre') { this.stack[i].used = true; return; } }
  popTo(k) { while (this.stack.length > k) this.close(this.stack.pop()); }
  close(e) {
    if (e.pageBreakAfter || e.pageBreak) this.pendingPageBreak = true;
    if (e.kind.k !== 'inline') this.flush();
    if (e.kind.k === 'cell') {
      this.flush();
      const blocks = this.containers.length > 1 ? this.containers.pop() : [];
      const cell = this.cells.pop() ?? F.cell();
      cell.blocks = blocks;
      const t = this.tables[this.tables.length - 1];
      if (t) (t.row ||= []).push(cell);
    } else if (e.kind.k === 'tr') {
      const t = this.tables[this.tables.length - 1];
      if (t?.row) { t.rows.push(t.row); t.row = null; }
    } else if (e.kind.k === 'table') {
      const t = this.tables.pop();
      if (t) {
        if (t.row) { t.rows.push(t.row); t.row = null; }
        const rows = t.rows.filter(r => r.length).slice(0, 4096);
        const ft = F.ftable({rows, widths: [], borderless: !t.bordered});
        if (ft.rows.length) { F.insertCovered(ft); this.container().push(ft); }
      }
    }
  }
  findOpen(pred, stop) {
    for (let i = this.stack.length - 1; i >= 0; i--) { if (pred(this.stack[i])) return i; if (stop(this.stack[i])) return null; }
    return null;
  }
  closeHeadForStart(name) {
    if (!['html', 'head', 'base', 'basefont', 'bgsound', 'link', 'meta', 'noframes', 'noscript', 'script', 'style', 'template', 'title'].includes(name)) {
      const k = this.findOpen(e => e.kind.k === 'head', () => false);
      if (k !== null) this.popTo(k);
    }
  }
  startHeadMetadata(name, attrs) {
    if (name === 'title') { this.title = ''; return false; }
    if (name === 'meta') {
      const n = (attr(attrs, 'name') ?? '').toLowerCase(), content = attr(attrs, 'content') ?? '';
      if (['author', 'description', 'keywords', 'subject'].includes(n)) this.meta[n] = content;
      return true;
    }
    return false;
  }
  closeImplicitly(name, isTablePart) {
    const k1 = CLOSES_P.has(name) ? this.findOpen(e => e.name === 'p', e => ['cell', 'table', 'li', 'quote'].includes(e.kind.k)) : null;
    if (k1 !== null) this.popTo(k1);
    if (/^h[1-6]$/.test(name) && this.stack[this.stack.length - 1]?.kind.k === 'heading') this.popTo(this.stack.length - 1);
    if (name === 'li') { const k = this.findOpen(e => e.kind.k === 'li', e => ['list', 'table', 'cell'].includes(e.kind.k)); if (k !== null) this.popTo(k); }
    if (name === 'dt' || name === 'dd') {
      const k = this.findOpen(e => e.name === 'dt' || e.name === 'dd', e => ['table', 'cell'].includes(e.kind.k) || e.name === 'dl');
      if (k !== null) this.popTo(k);
    }
    if (isTablePart && this.tables.length) {
      if (name === 'td' || name === 'th') { const k = this.findOpen(e => e.kind.k === 'cell', e => ['table', 'tr'].includes(e.kind.k)); if (k !== null) this.popTo(k); }
      if (name === 'tr') {
        const k = this.findOpen(e => ['tr', 'cell'].includes(e.kind.k), e => e.kind.k === 'table');
        if (k !== null) { let kk = k; while (kk > 0 && ['tr', 'cell'].includes(this.stack[kk - 1].kind.k)) kk--; this.popTo(kk); }
      }
    }
  }
  startSpecial(name, attrs) {
    if (name === 'br') {
      if (this.stack.some(e => e.kind.k === 'pre')) { this.startPara(); this.flush(); } else { const f = this.fmt(); F.pushText(this.startPara(), '\n', f); }
    } else if (name === 'hr') { this.flush(); this.container().push(F.para('rule')); }
    else if (name === 'wbr') { const f = this.fmt(); F.pushText(this.startPara(), '​', f); }
    else if (name === 'img') {
      const alt = attr(attrs, 'alt') ?? '';
      const dim = key => { const v = attr(attrs, key); if (v === null) return null; const t = v.trim().replace(/px$/, '').trim(); const x = Number(t); return t && Number.isFinite(x) ? x * 0.75 : null; };
      let width = dim('width'), height = dim('height');
      const style = attr(attrs, 'style');
      if (style !== null) for (const decl of style.split(';')) {
        const c = decl.indexOf(':');
        if (c < 0) continue;
        const key = decl.slice(0, c).trim().toLowerCase(), value = decl.slice(c + 1);
        if (key === 'width') width = cssLenPt(value) ?? width; else if (key === 'height') height = cssLenPt(value) ?? height;
      }
      const src = attr(attrs, 'src');
      let data = null;
      if (src !== null) data = src.trimStart().startsWith('data:') ? F.dataUri(src) : this.images(src.trim());
      const image = data ? F.makeImg(data, width, height, alt) : null;
      const f = this.fmt();
      if (image) this.startPara().inlines.push({t: 'image', img: image});
      else if (alt) F.pushText(this.startPara(), alt, f);
    } else return false;
    return true;
  }
  elementStyle(name, attrs, kind) {
    const st = {fmt: this.fmt(), align: null, preserve: this.preserve(), pageBreak: false, pageBreakAfter: false};
    const fmt = st.fmt;
    switch (name) {
      case 'b': case 'strong': case 'th': fmt.bold = true; break;
      case 'i': case 'em': case 'cite': case 'var': case 'dfn': case 'address': fmt.italic = true; break;
      case 'u': case 'ins': fmt.underline = true; break;
      case 's': case 'strike': case 'del': fmt.strike = true; break;
      case 'code': case 'kbd': case 'tt': case 'samp': fmt.code = true; break;
      case 'sup': fmt.sup = true; break;
      case 'sub': fmt.sub = true; break;
      case 'small': fmt.size = fmt.size === null ? 10 : Math.max(1, fmt.size * 0.833); break;
      case 'big': fmt.size = fmt.size === null ? 14 : Math.min(1638, fmt.size * 1.2); break;
      case 'mark': fmt.background = [255, 255, 0]; break;
      case 'font': applyFontAttributes(attrs, fmt); break;
      case 'a': { const href = attr(attrs, 'href'); if (href !== null && isSafeHref(href)) fmt.link = F.keptLink(href.trim()); break; }
      default:
    }
    const al = kind.k !== 'table' ? attr(attrs, 'align') : null;
    if (al !== null) st.align = {center: 'center', middle: 'center', right: 'right', justify: 'justify', left: 'left'}[al.toLowerCase()] ?? null;
    if (name === 'center') st.align = 'center';
    const style = attr(attrs, 'style');
    if (style !== null) applyStyle(style, st);
    if (kind.k === 'pre') st.preserve = true;
    return st;
  }
  start(name, attrs, selfClose) {
    if (this.startHeadMetadata(name, attrs)) return;
    const isTablePart = ['tr', 'td', 'th'].includes(name);
    const inTable = this.tables.length < F.MAX_DEPTH;
    this.closeImplicitly(name, isTablePart);
    if (name === 'a' && !this.inHead()) {
      const id = attr(attrs, 'id') || attr(attrs, 'name');
      if (id) this.startPara().inlines.push({t: 'anchor', name: id});
    }
    if (this.startSpecial(name, attrs)) return;
    if (VOID.has(name) || (selfClose && !blockKind(name) && name !== 'a' && name !== 'span')) return;
    if (this.stack.length >= MAX_STACK) return;
    let kind = blockKind(name) ?? {k: 'inline'};
    if (['table', 'tr', 'cell'].includes(kind.k) && !inTable) kind = {k: 'block'};
    if (['tr', 'cell'].includes(kind.k) && !this.tables.length) kind = {k: 'block'};
    if (kind.k !== 'inline') this.flush();
    const st = this.elementStyle(name, attrs, kind);
    if (kind.k === 'table') this.tables.push({rows: [], row: null, bordered: declaresBorder(attrs, true)});
    else if (kind.k === 'tr') { const t = this.tables[this.tables.length - 1]; if (t?.row) { t.rows.push(t.row); t.row = null; } }
    else if (kind.k === 'cell') {
      const noRow = this.findOpen(e => e.kind.k === 'tr', e => e.kind.k === 'table') === null;
      const t = this.tables[this.tables.length - 1];
      if (t && declaresBorder(attrs, false)) t.bordered = true;
      if (noRow && t) { if (t.row) t.rows.push(t.row); t.row = []; }
      const num = (k, max) => { const v = attr(attrs, k); return v !== null && /^\d+$/.test(v.trim()) ? Math.max(1, Math.min(max, Number(v.trim()))) : null; };
      const bg = attr(attrs, 'bgcolor');
      const shading = (bg !== null ? F.parseColor(bg) : null) ?? st.fmt.background;
      const va = v => ({top: 'top', middle: 'center', center: 'center', bottom: 'bottom'})[v.trim().toLowerCase()] ?? null;
      let valign = attr(attrs, 'valign') !== null ? va(attr(attrs, 'valign')) : null;
      const style = attr(attrs, 'style');
      if (style !== null) for (const decl of style.split(';')) {
        const c = decl.indexOf(':');
        if (c >= 0 && decl.slice(0, c).trim().toLowerCase() === 'vertical-align') valign = va(decl.slice(c + 1)) ?? valign;
      }
      this.cells.push(F.cell({colspan: num('colspan', 63) ?? 1, rowspan: num('rowspan', 1000) ?? 1, header: name === 'th', shading, valign}));
      st.fmt.background = null;
      this.containers.push([]);
    }
    this.stack.push({name, kind, fmt: st.fmt, align: st.align, preserve: st.preserve, pageBreak: st.pageBreak, pageBreakAfter: st.pageBreakAfter, used: false});
  }
  end(name) {
    if (name === 'title') { if (this.title !== null) { this.meta.title = this.title.split(/\s+/).filter(Boolean).join(' '); this.title = null; } return; }
    let target;
    if (name === 'td' || name === 'th') target = this.findOpen(e => e.kind.k === 'cell', e => e.kind.k === 'table');
    else if (name === 'tr') target = this.findOpen(e => e.kind.k === 'tr', e => e.kind.k === 'table');
    else target = this.findOpen(e => e.name === name, e => name !== 'table' && ['table', 'cell'].includes(e.kind.k));
    if (target !== null) this.popTo(target);
  }
  finish() {
    this.popTo(0);
    this.flush();
    while (this.containers.length > 1) { const c = this.containers.pop(); this.container().push(...c); }
    const blocks = this.containers.pop() ?? [];
    if (this.title !== null) this.meta.title = this.title;
    return {blocks, meta: this.meta};
  }
}

// --- math_ruby.rs ----------------------------------------------------------------------------

/** A `<math>` element's text, up to its matching end tag (nested math counted; capped). */
function readMathText(lx) {
  let depth = 0, text = '', count = 0;
  for (let t = lx.next(); t; t = lx.next()) {
    if (++count > 200_000) break;
    if (t.t === 'text') text += t.text;
    else if (t.t === 'start' && t.name.split(':').pop() === 'math' && !t.selfClose) depth++;
    else if (t.t === 'end' && t.name.split(':').pop() === 'math') { if (!depth) break; depth--; }
  }
  return text.replace(/\s+/g, ' ').trim();
}
const endsRuby = t => (t.t === 'start' || t.t === 'end') && !!blockKind(t.name);
/** A `<ruby>` element's base text and reading (math_ruby.rs read_ruby). */
export function readRuby(lx) {
  const out = {base: '', ruby: ''};
  let part = 'base', nested = 0;
  for (let count = 0; count < 4096; count++) {
    const start = lx.pos;
    const t = lx.next();
    if (!t) break;
    if (!nested && endsRuby(t)) { lx.pos = start; break; }
    if (t.t === 'text') { if (part === 'base') out.base += t.text; else if (part === 'ruby') out.ruby += t.text; }
    else if (t.t === 'start') {
      if (t.name === 'rb') part = 'base'; else if (t.name === 'rt') part = 'ruby'; else if (t.name === 'rp') part = 'fallback'; else if (t.name === 'ruby' && !t.selfClose) nested++;
    } else if (['rb', 'rt', 'rp'].includes(t.name)) part = 'base';
    else if (t.name === 'ruby') { if (nested) nested--; else break; }
  }
  return out;
}

// --- import.rs -------------------------------------------------------------------------------

/** HTML text → flow (`images(src)`: bytes of a picture that isn't a data: URI, or null). */
export function parse(s, images = () => null) {
  const lx = new Lexer(s);
  const b = new Builder(images);
  let guard = 0;
  for (let t = lx.next(); t; t = lx.next()) {
    if (++guard > 50_000_000) break;
    if (t.t === 'text') b.text(t.text);
    else if (t.t === 'start') {
      b.closeHeadForStart(t.name);
      if (t.name.split(':').pop() === 'math' && !t.selfClose) {
        const linear = readMathText(lx);
        const display = (attr(t.attrs, 'display') ?? '').toLowerCase() === 'block';
        if (!b.inHead() && linear) b.startPara().inlines.push({t: 'equation', linear, display});
        continue;
      }
      if (t.name === 'ruby' && !t.selfClose) { const r = readRuby(lx); if (!b.inHead()) b.pushRuby(r.base, r.ruby); continue; }
      if (['script', 'style', 'noscript', 'template', 'textarea'].includes(t.name) && !t.selfClose) { lx.skipPastEndTag(t.name); continue; }
      b.start(t.name, t.attrs, t.selfClose);
    } else b.end(t.name);
  }
  return b.finish();
}

/** Schema-2 content from HTML text (import / import_on). */
export function importHtml(s, images = () => null, page = null) {
  F.beginImport();
  return F.toContent(parse(s, images), page);
}

/** formats-v2 contract: schema-2 content read from an .html file's bytes. */
export function read(bytes, opts = {}) {
  return importHtml(decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)), opts.images ?? (() => null));
}
