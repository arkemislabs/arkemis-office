// PDF (folio) addresses: docs/architecture.md 14.5 and the resolver contract of 14.7.
//
//   /pg:<pageId>                              page
//   /pg:<pageId>/annot:<annotId>              annotation (comment, highlight, ink, stamp, link, ...)
//   /pg:<pageId>/chars:<from>-<to>            page text in reading order (UTF-16 over the extracted text)
//   /pg:<pageId>/word:<n>                     nth word with its quad
//   /pg:<pageId>/text:<index>.<hash>          an editable content-stream text object (the hash detects staleness)
//   /pg:<pageId>/rect:<x>,<y>,<w>,<h>         a region: points, crop-box relative, top-left origin
//   /field:<name>  /sig:<fieldName>           form field, signature field
//   /bm:<id>  /layer:<ocgId>  /att:<name>  /label:<startPage>
//
// Annotation ids are their /NM (assigned and written back when missing); page ids are the content's.
// Addresses the grammar above does not claim (/pages/0/rotation) fall through to the kernel's
// generic JSON resolver, so schema-1 callers keep working.
//
// Page text (chars:, word:) is printcraft's PageText (model/text.mjs, translated from
// crates/render/src/text.rs at 3109bb2359759e24ef490e1cdbdba00722b20972, MIT, see
// assets/third-party-licenses/artcraft-reference.txt); it is read from the page-text cache the
// surface and the text commands fill.
// No DOM, no Node built-ins.

import {CommandError} from '../kernel/errors.mjs';
import {parse as kernelParse, format as kernelFormat, parseTextRange, genericResolver} from '../kernel/address.mjs';
import {cachedPageText} from './model/page-text.mjs';
import {props, findAnnot, subtypeOfRecord, rectOf} from './model/annots.mjs';
import {userRectToView, viewRectToUser, quadToView, quadsOf, viewSize, pageRotation} from './lib/geom.mjs';
import {labelAt} from '../pdf-page-labels.mjs';
import {textOf} from './lib/cos.mjs';

const TOP = new Set(['pg', 'field', 'sig', 'bm', 'layer', 'att', 'label']);
const UNDER_PAGE = new Set(['annot', 'chars', 'word', 'text', 'rect']);
const invalid = (m, a) => new CommandError('invalid_address', m, a === undefined ? undefined : {address: a});
const notFound = (m, a) => new CommandError('not_found', m, {address: a});

const pages = content => (Array.isArray(content?.pages) ? content.pages : []);
const isFolio = ast => !!ast?.segments?.length && TOP.has(ast.segments[0].kind);

export function parse(input) {
  const ast = kernelParse(input);
  if (!isFolio(ast)) return ast;
  const [top, ...rest] = ast.segments;
  if (top.key === undefined || top.key === '') throw invalid(`${top.kind}: needs a key (/${top.kind}:<id>)`, input);
  if (top.kind !== 'pg' && rest.length) throw invalid(`/${top.kind}:... has no parts`, input);
  if (rest.length > 1) throw invalid('a page address has at most one part', input);
  const part = rest[0];
  if (part) {
    if (!UNDER_PAGE.has(part.kind)) throw invalid(`unknown page part ${part.kind} (annot, chars, word, text, rect)`, input);
    if (part.key === undefined) throw invalid(`${part.kind}: needs a value`, input);
    if (part.kind === 'chars') parseTextRange(part.key);
    if (part.kind === 'word' && !/^\d{1,7}$/.test(part.key)) throw invalid('word:<n> takes a 0-based word number', input);
    if (part.kind === 'text' && !/^\d{1,7}\.[A-Za-z0-9]{1,64}$/.test(part.key)) throw invalid('text:<index>.<hash>', input);
    if (part.kind === 'rect') parseRect(part.key, input);
  }
  return ast;
}

export const format = kernelFormat;

/** "x,y,w,h" → [x, y, w, h] (points, crop-box relative, top-left origin). */
export function parseRect(key, input) {
  const v = String(key).split(',').map(Number);
  if (v.length !== 4 || !v.every(Number.isFinite) || v[2] < 0 || v[3] < 0) throw invalid('rect:<x>,<y>,<w>,<h> in points', input ?? key);
  return v;
}

function pageOf(content, id, input) {
  const list = pages(content);
  const index = list.findIndex(p => p.id === id);
  if (index < 0) throw notFound(`page ${id} does not exist`, input);
  return {page: list[index], index};
}

function findBookmark(list, id) {
  for (const b of list ?? []) {
    if (b.id === id) return b;
    const hit = findBookmark(b.children, id);
    if (hit) return hit;
  }
  return null;
}

/** Words of a page text: [first, last] glyph ranges (word_at over the reading order). */
export function words(text) {
  const out = [];
  for (let i = 0; i < text.glyphs.length;) {
    // Blank glyphs (drawn spaces) are gaps between words, not words.
    if (!text.glyphs[i].text.trim()) { i++; continue; }
    const w = text.wordAt(i);
    if (!w) break;
    out.push(w);
    i = Math.max(w[1], i) + 1;
  }
  return out;
}

export function resolve(content, ast) {
  if (!isFolio(ast)) return genericResolver.resolve(content, ast);
  const input = format(ast);
  const [top, part] = ast.segments;
  switch (top.kind) {
    case 'pg': {
      const {page, index} = pageOf(content, top.key, input);
      if (!part) return {kind: 'page', node: page, page: index, pageId: page.id};
      switch (part.kind) {
        case 'annot': {
          const i = (page.annots ?? []).findIndex(r => r.id === part.key);
          if (i < 0) throw notFound(`annotation ${part.key} is not on page ${page.id}`, input);
          return {kind: 'annotation', node: page.annots[i], page: index, pageId: page.id, index: i, annotId: part.key};
        }
        case 'chars': {
          const {from, to} = parseTextRange(part.key);
          return {kind: 'text', page: index, pageId: page.id, from, to};
        }
        case 'word': return {kind: 'word', page: index, pageId: page.id, n: Number(part.key)};
        case 'text': { const [i, hash] = part.key.split('.'); return {kind: 'textObject', page: index, pageId: page.id, objectIndex: Number(i), hash}; }
        case 'rect': return {kind: 'region', page: index, pageId: page.id, rect: parseRect(part.key, input)};
        default: throw invalid(`unknown page part ${part.kind}`, input);
      }
    }
    case 'field': case 'sig': {
      const f = (content.fields ?? []).find(x => x.name === top.key && (top.kind === 'field' || /signature/i.test(x.type)));
      if (!f) throw notFound(`${top.kind === 'sig' ? 'signature field' : 'field'} ${top.key} does not exist`, input);
      return {kind: top.kind === 'sig' ? 'signature' : 'field', node: f};
    }
    case 'bm': {
      const b = findBookmark(content.bookmarks, top.key);
      if (!b) throw notFound(`bookmark ${top.key} does not exist`, input);
      return {kind: 'bookmark', node: b};
    }
    case 'label': {
      const start = Number(top.key);
      const r = (content.pageLabels ?? []).find(x => x.start === start);
      if (!r) throw notFound(`no page-label range starts at page ${top.key}`, input);
      return {kind: 'label', node: r};
    }
    default: throw notFound(`${top.kind} addresses are not available for this document`, input);
  }
}

/** Friendly forms → canonical: "page 3", "p3", "3" (1-based) → /pg:<id>. */
export function canonical(content, input) {
  const m = /^\s*(?:page\s*|p)?(\d{1,6})\s*$/i.exec(String(input));
  if (m) {
    const page = pages(content)[Number(m[1]) - 1];
    if (!page) throw notFound(`page ${m[1]} does not exist`, input);
    return `/pg:${encodeURIComponent(page.id)}`;
  }
  return format(parse(input));
}

/** Map an address through one content op (paths relative to content). Ids are stable, so only removals matter. */
export function mapThrough(op, ast) {
  if (!isFolio(ast)) return genericResolver.mapThrough(op, ast);
  const [top, part] = ast.segments;
  if (top.kind !== 'pg' || !op?.path) return ast;
  const path = op.path;
  const pageIdsIn = list => new Set((Array.isArray(list) ? list : []).map(p => p?.id));
  // Pages removed (and not put back by the same op).
  if (path.length === 1 && path[0] === 'pages') {
    if (op.op === 'splice') {
      const removed = pageIdsIn(op.removed), added = pageIdsIn(op.items);
      if (removed.has(top.key) && !added.has(top.key)) return {deleted: true, nearest: null};
    } else if (op.op === 'set' && Array.isArray(op.value) && !pageIdsIn(op.value).has(top.key)) return {deleted: true, nearest: null};
    return ast;
  }
  if (part?.kind === 'annot' && path[0] === 'pages' && path.length === 3 && path[2] === 'annots' && op.op === 'splice') {
    const removed = new Set((op.removed ?? []).map(r => r?.id)), added = new Set((op.items ?? []).map(r => r?.id));
    if (removed.has(part.key) && !added.has(part.key)) return {deleted: true, nearest: {segments: [top]}};
  }
  return ast;
}

/** Addresses a list of ops changed (doc.changed events): pages and comments by id. */
export function changed(ops, content) {
  const out = new Set();
  const list = pages(content);
  for (const op of ops) {
    const p = op.path ?? [];
    if (p[0] !== 'pages') { out.add('/' + p.slice(0, 1).join('/')); continue; }
    if (p.length === 1) { out.add('/pages'); continue; }
    const page = list[Number(p[1])];
    if (!page) { out.add('/pages'); continue; }
    if (p[2] === 'annots') {
      const items = op.op === 'splice' ? [...(op.items ?? []), ...(op.removed ?? [])] : p.length >= 4 ? [page.annots?.[Number(p[3])] ?? op.old] : [];
      for (const r of items) if (r?.id) out.add(`/pg:${encodeURIComponent(page.id)}/annot:${encodeURIComponent(r.id)}`);
      if (!items.length) out.add(`/pg:${encodeURIComponent(page.id)}`);
    } else out.add(`/pg:${encodeURIComponent(page.id)}`);
  }
  return [...out];
}

const pageAddr = page => `/pg:${encodeURIComponent(page.id)}`;
const annotAddr = (page, r) => `${pageAddr(page)}/annot:${encodeURIComponent(r.id)}`;

/** document.inspect: pages, their comments, fields and bookmarks with canonical addresses. */
export function enumerate(content, scope, {depth = 1, limit = 100, cursor} = {}) {
  if (!isFolio(scope) && scope?.segments?.length) return genericResolver.enumerate(content, scope, {depth, limit});
  const nodes = [];
  const all = [];
  const list = pages(content);
  const label = i => { try { return content.pageLabels?.length ? labelAt(content.pageLabels, i, list.length) : String(i + 1); } catch { return String(i + 1); } };
  const pushPage = (page, i) => {
    const size = viewSize(page);
    all.push({address: pageAddr(page), kind: 'page', index: i, label: label(i), width: size.width, height: size.height, rotation: pageRotation(page),
      annotations: (page.annots ?? []).length});
    if (depth >= 2 || (scope?.segments?.length === 1 && scope.segments[0].kind === 'pg')) {
      for (const r of page.annots ?? []) all.push({address: annotAddr(page, r), kind: 'annotation', subtype: subtypeOfRecord(r), rect: userRectToView(page, rectOf(r)).map(round),
        contents: textOf(r.dict.Contents) ?? '', author: textOf(r.dict.T) ?? ''});
    }
  };
  if (scope?.segments?.length) {
    const [top] = scope.segments;
    if (top.kind === 'pg') { const {page, index} = pageOf(content, top.key, format(scope)); pushPage(page, index); }
    else if (top.kind === 'field' || top.kind === 'sig') all.push({address: format(scope), kind: top.kind, ...resolve(content, scope).node});
    else if (top.kind === 'bm') all.push({address: format(scope), kind: 'bookmark', title: resolve(content, scope).node.title});
  } else {
    list.forEach(pushPage);
    if (depth >= 1) for (const f of content.fields ?? []) all.push({address: `/field:${encodeURIComponent(f.name)}`, kind: 'field', type: f.type});
    const walk = bs => { for (const b of bs ?? []) { all.push({address: `/bm:${encodeURIComponent(b.id)}`, kind: 'bookmark', title: b.title}); walk(b.children); } };
    if (depth >= 1) walk(content.bookmarks);
  }
  const start = cursor ? Number(cursor) || 0 : 0;
  nodes.push(...all.slice(start, start + limit));
  return start + limit < all.length ? {nodes, cursor: String(start + limit)} : {nodes};
}

const round = v => Math.round(v * 100) / 100;

function textFor(content, page, input) {
  const t = cachedPageText(content, page);
  if (!t) throw new CommandError('unavailable', `the text of page ${page.id} has not been read yet (open the document in a window, or run a text command first)`, {address: input});
  return t;
}

/** document.read: text, props or the annotation dictionary at an address. */
export function read(content, ast, as = 'json') {
  if (!isFolio(ast)) return genericResolver.read(content, ast, as);
  const res = resolve(content, ast);
  const input = format(ast);
  switch (res.kind) {
    case 'page': {
      const page = res.node;
      if (as === 'text') return textFor(content, page, input).plainText();
      return {id: page.id, index: res.page, sourceIndex: page.sourceIndex, ...viewSize(page), rotation: pageRotation(page),
        annotations: (page.annots ?? []).map(r => annotAddr(page, r))};
    }
    case 'annotation': {
      const page = pages(content)[res.page], r = res.node;
      if (as === 'props') return props(r);
      if (as === 'text') return textOf(r.dict.Contents) ?? '';
      return {id: r.id, address: annotAddr(page, r), subtype: subtypeOfRecord(r), rect: userRectToView(page, rectOf(r)).map(round), dict: r.dict,
        quads: quadsOf(r.dict.QuadPoints).map(q => quadToView(page, q).map(pt => pt.map(round))), inReplyTo: r.irt ?? null, popup: r.popup ?? null};
    }
    case 'text': {
      const page = pages(content)[res.page];
      const t = textFor(content, page, input), plain = t.plainText();
      if (res.to > plain.length) throw new CommandError('invalid_address', `chars:${res.from}-${res.to} is past the end of the page text (${plain.length})`, {address: input});
      const g = t.glyphRange(res.from, res.to);
      return {text: plain.slice(res.from, res.to), quads: g ? t.lineRects(g[0], g[1] + 1).map(r => r.map(round)) : []};
    }
    case 'word': {
      const page = pages(content)[res.page];
      const t = textFor(content, page, input);
      const w = words(t)[res.n];
      if (!w) throw notFound(`page ${page.id} has no word ${res.n}`, input);
      const [from, to] = t.charRange(w[0], w[1]);
      return {text: t.textOf(w[0], w[1] + 1), address: `${pageAddr(page)}/chars:${from}-${to}`, quad: t.glyphs[w[0]].quad.map(pt => pt.map(round)),
        rect: t.lineRects(w[0], w[1] + 1)[0]?.map(round)};
    }
    case 'region': {
      const page = pages(content)[res.page];
      const [x, y, w, h] = res.rect;
      return {rect: res.rect, user: viewRectToUser(page, [x, y, x + w, y + h]).map(round)};
    }
    default: return structuredClone(res.node ?? null);
  }
}

/** document.find over the page texts read so far (render/text/search.rs semantics). */
export function find(content, {query, scope, matchCase = false, wholeWord = false, limit = 100}) {
  const out = [];
  const list = pages(content);
  const only = scope?.segments?.[0]?.kind === 'pg' ? scope.segments[0].key : null;
  let unread = 0;
  for (const page of list) {
    if (only && page.id !== only) continue;
    const t = cachedPageText(content, page);
    if (!t) { unread++; continue; }
    const plain = t.plainText();
    for (const [a, b] of t.find(String(query), {caseSensitive: matchCase, wholeWords: wholeWord, limit: limit - out.length})) {
      const [from, to] = t.charRange(a, b - 1);
      out.push({address: `${pageAddr(page)}/chars:${from}-${to}`, text: plain.slice(from, to), context: plain.slice(Math.max(0, from - 30), Math.min(plain.length, to + 30))});
      if (out.length >= limit) return {matches: out, truncated: true, unreadPages: unread};
    }
  }
  return {matches: out, unreadPages: unread};
}

export {findAnnot};
