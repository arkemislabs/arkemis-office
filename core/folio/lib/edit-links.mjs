// Links (ISO 32000-2 §12.5.6.5): web addresses found in page text, link annotation records in the
// folio model (the dictionary links.rs writes), Link Properties' style and action.
//
// Translated from printcraft at 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see
// assets/third-party-licenses/artcraft-reference.txt):
//  * crates/annot/src/links.rs — LinkStyle (defaults: invisible rectangle, invert highlight),
//    Highlight codes, write_style, uri_bytes, write_action, checked_rect, find_urls, email_at;
//  * crates/engine/src/session/view.rs:104-144 `find_urls` — per page, the text's URL ranges as one
//    rectangle per line (view rect → user quad → bounding box), skipping areas a link already covers.
// No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {pageText} from '../model/page-text.mjs';
import {viewRectToQuad} from './geom.mjs';
import {nums, nameAt} from './cos.mjs';

export const HIGHLIGHTS = Object.freeze({None: 'N', Invert: 'I', Outline: 'O', Inset: 'P'});
/** LinkStyle::default: Acrobat's new link — invisible rectangle, blue, thin, solid, invert highlight. */
export const defaultLinkStyle = () => ({visible: false, color: [0, 0, 1], width: 1, dashed: false, underline: false, highlight: 'Invert'});

const isAlnum = c => /[\p{L}\p{N}]/u.test(c);
const asciiAlnum = c => /^[A-Za-z0-9]$/.test(c);

/** links.rs `email_at`. */
function emailAt(chars, start) {
  const local = c => c !== undefined && (asciiAlnum(c) || '._+%-'.includes(c));
  const domain = c => c !== undefined && (asciiAlnum(c) || c === '-' || c === '.');
  if (start > 0 && (local(chars[start - 1]) || chars[start - 1] === '@')) return null;
  let at = start;
  while (local(chars[at])) { at++; if (at - start > 64) return null; }
  const lp = chars.slice(start, at);
  if (!lp.length || lp[0] === '.' || lp.at(-1) === '.' || lp.some((c, i) => c === '.' && lp[i + 1] === '.')) return null;
  if (chars[at] !== '@') return null;
  let end = at + 1;
  while (domain(chars[end])) { end++; if (end - at - 1 > 253) return null; }
  while (end > at + 1 && chars[end - 1] === '.') end--;
  if (chars[end] !== undefined && (asciiAlnum(chars[end]) || chars[end] === '@' || chars[end] === '_')) return null;
  const labels = chars.slice(at + 1, end).join('').split('.');
  let count = 0, tld = 0;
  for (const l of labels) {
    if (!l || l.length > 63 || !asciiAlnum(l[0]) || !asciiAlnum(l.at(-1))) return null;
    count++; tld = l.length;
  }
  if (count < 2 || tld < 2) return null;
  return [end, `mailto:${chars.slice(start, end).join('')}`];
}

/** links.rs `find_urls`: [[from, to) in characters, uri] for http(s)://…, www.… and e-mail addresses. */
export function findUrlRanges(text) {
  const chars = [...String(text)];
  const urlChar = c => c !== undefined && !/\s/u.test(c) && !'<>"\'()[]{}'.includes(c);
  const startsWith = (i, pat) => [...pat].every((p, k) => chars[i + k] !== undefined && chars[i + k].toLowerCase() === p);
  const out = [];
  let i = 0;
  while (i < chars.length) {
    const boundary = i === 0 || !isAlnum(chars[i - 1]);
    if (boundary && (startsWith(i, 'http://') || startsWith(i, 'https://') || startsWith(i, 'www.'))) {
      let j = i;
      while (urlChar(chars[j])) j++;
      while (j > i && '.,;:!?'.includes(chars[j - 1])) j--;
      const s = chars.slice(i, j).join('');
      if (s.length > 6 && s.includes('.')) {
        out.push([[i, j], s.slice(0, 4).toLowerCase() === 'www.' ? `http://${s}` : s]);
        i = j;
        continue;
      }
    }
    if (boundary) {
      const e = emailAt(chars, i);
      if (e) { out.push([[i, e[0]], e[1]]); i = e[0]; continue; }
    }
    i++;
  }
  // Character (code point) indices → UTF-16 offsets for PageText.
  const offsets = [0];
  for (const c of chars) offsets.push(offsets.at(-1) + c.length);
  return out.map(([[a, b], uri]) => [[offsets[a], offsets[b]], uri]);
}

/** links.rs `uri_bytes`: 7-bit ASCII, other bytes percent-encoded. */
export function uriHex(u) {
  const bytes = new TextEncoder().encode(String(u).trim());
  let ascii = '';
  for (const b of bytes) ascii += b >= 0x21 && b <= 0x7e ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  return [...ascii].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

/** links.rs `checked_rect`. */
export function checkedRect(rect) {
  if (!rect.every(Number.isFinite)) throw new CommandError('invalid_params', 'the link area must have finite coordinates');
  const r = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
  const w = r[2] - r[0], h = r[3] - r[1];
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 2 || h < 2) throw new CommandError('invalid_params', 'the link area is too small or too large');
  return r;
}

/** links.rs `write_style` into a model dictionary. */
export function styleDict(st) {
  const bs = {W: st.visible ? Math.min(12, Math.max(0.5, st.width)) : 0, S: st.dashed ? '/D' : st.underline ? '/U' : '/S'};
  if (st.dashed) bs.D = [3];
  return {BS: bs, C: st.color.map(v => Math.min(1, Math.max(0, v))), H: `/${HIGHLIGHTS[st.highlight] ?? 'I'}`};
}

/** A new web link record (links.rs new_link with LinkAction::Uri). */
export function linkAnnotation(id, rect, uri, style = defaultLinkStyle()) {
  const r = checkedRect(rect);
  if (!String(uri ?? '').trim()) throw new CommandError('invalid_params', 'type the web address first');
  return {id, dict: {Type: '/Annot', Subtype: '/Link', Rect: r, F: 4, ...styleDict(style), NM: {$t: id}, A: {S: '/URI', URI: {$x: uriHex(uri)}}}, ap: 'none', edited: true};
}

/** A new link to a page of this document (links.rs LinkAction::GoTo): the destination names the model's page by id (`$pg`), which writing the file turns into the page's object. */
export function gotoAnnotation(id, rect, pageId, style = defaultLinkStyle()) {
  const r = checkedRect(rect);
  if (!pageId) throw new CommandError('invalid_params', 'choose the page the link goes to');
  return {id, dict: {Type: '/Annot', Subtype: '/Link', Rect: r, F: 4, ...styleDict(style), NM: {$t: id}, A: {S: '/GoTo', D: [{$pg: String(pageId)}, '/Fit']}}, ap: 'none', edited: true};
}

export const isLinkRecord = r => nameAt(r.dict, 'Subtype') === 'Link';

/** The page's link records with their user-space rectangles and URIs. */
export function linkRecords(page) {
  return (page.annots ?? []).filter(isLinkRecord).map(r => {
    const rect = nums(r.dict, 'Rect') ?? [0, 0, 0, 0];
    const u = r.dict.A?.URI;
    const uri = u?.$t ?? (u?.$x ? decodeHex(u.$x) : null);
    const goto = Array.isArray(r.dict.A?.D) && r.dict.A.D[0]?.$pg ? r.dict.A.D[0].$pg : null;
    return {id: r.id, rect: [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])], uri, goto};
  });
}
const decodeHex = h => { let s = ''; for (let i = 0; i + 1 < h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16)); return s; };

/** session/view.rs `find_urls` for one page: [{rect (user space), uri}], one per line of each address. */
export async function findUrls(content, page) {
  const pt = await pageText(content, page);
  const text = pt.plain().text;
  const out = [];
  const existing = linkRecords(page);
  for (const [[from, to], uri] of findUrlRanges(text)) {
    const g = pt.glyphRange(from, to);
    if (!g) continue;
    for (const v of pt.lineRects(g[0], g[1] + 1)) {
      const q = viewRectToQuad(page, v);
      const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
      const r = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      if (existing.some(l => l.rect[0] < r[2] && r[0] < l.rect[2] && l.rect[1] < r[3] && r[1] < l.rect[3])) continue;
      if (r[2] - r[0] < 2 || r[3] - r[1] < 2) continue;
      out.push({rect: r, uri});
    }
  }
  return out;
}
