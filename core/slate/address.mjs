// Slate addresses (docs/architecture.md 14.1, 14.6, 14.7; F:slate foundation).
//
// A Slate document is one notebook. Canonical addresses:
//
//   /                                   the notebook
//   /grp:<groupId>                      a section group
//   /sec:<sectionId>                    a section
//   /pg:<pageId>                        a page (page ids are unique in the notebook)
//   /pg:<pageId>/meta                   title, created, modified, colour, rule lines, level, section
//   /pg:<pageId>/title[/t:<from>-<to>]  the page title
//   /pg:<pageId>/c:<containerId>        a note container
//   /pg:<pageId>/b:<blockId>            a paragraph, list, list item, table, row or cell
//   /pg:<pageId>/b:<blockId>/t:4-9      characters 4..9 of a paragraph (UTF-16; objects are one U+FFFC)
//   /pg:<pageId>/media:<id>             a picture, attachment, recording or equation
//   /pg:<pageId>/ink[:<strokeId>]       the ink layer, or one stroke
//   /pg:<pageId>/tag:<blockId>.<tagId>  a note tag on a paragraph
//
// Friendly inputs, canonicalized: `/nb:<id>/...` (the notebook prefix), `/sec:<id>/pg:<id>/...`,
// `/sec:<id>/page:<n>` (n-th page, 1-based), `/sec:<name>` (a section by name),
// `/pg:<id>/c:<cid>/b:<bid>...`, `/pg:<id>/b:<tableId>/r:<i>/c:<j>[/b:<bid>...]` (row i, cell j,
// 0-based, as 14.6 writes table paths).
//
// Content that is not a schema-2 notebook (a schema-1 page from the legacy editor) keeps the
// kernel's generic JSON addressing (`/outline/sections/0/name`), so the interim families work.
//
// No DOM, no Node built-ins.

import {CommandError} from '../kernel/errors.mjs';
import {genericResolver, parse as parseAddress, format as formatAddress, parseTextRange, assertCodeUnitBoundary} from '../kernel/address.mjs';
import {isNotebook, nodeOf} from './schema.mjs';
import {blockIndex, textOf, runsOf, posToPoint, containersOf} from './model/page.mjs';
import {pageIndex, sectionOf, sectionOrder, pagesOf} from './model/notebook.mjs';

const KINDS = new Set(['nb', 'grp', 'sec', 'pg', 'page']);
const PAGE_KINDS = new Set(['meta', 'title', 'c', 'b', 't', 'media', 'ink', 'tag', 'r']);
const OBJECTS = new Set(['image', 'attachment', 'media', 'equation', 'spreadsheet', 'diagram']);

const invalid = (message, address) => new CommandError('invalid_address', message, address === undefined ? undefined : {address});
const notFound = (message, address) => new CommandError('not_found', message, {address});

export const parse = parseAddress;
export const format = formatAddress;

/** Is this AST in Slate's grammar (as opposed to a generic JSON path)? */
const isSlateAst = ast => !!ast?.segments?.length && KINDS.has(ast.segments[0].kind);
/**
 * Slate grammar applies to notebooks: `/` and the kinds above. Other paths on a notebook
 * (`/sections/<id>/name`) and every path on schema-1 content use the generic JSON resolver.
 */
const slateAddress = (content, ast) => isNotebook(content) && (isSlateAst(ast) || !ast?.segments?.length);

// ---------------------------------------------------------------------------------------------
// Normalizing an AST against the content (friendly -> canonical)

/**
 * Turn any accepted form into the canonical target: {kind, ...ids, ast}. Throws invalid_address
 * for a malformed path and not_found for a missing target.
 */
export function target(content, ast) {
  const input = format(ast);
  let segs = ast.segments.slice();
  if (segs[0]?.kind === 'nb') {
    if (segs[0].key !== undefined && segs[0].key !== content.notebook.id) throw notFound(`This document is notebook ${content.notebook.id}, not ${segs[0].key}`, input);
    segs = segs.slice(1);
  }
  if (!segs.length) return {kind: 'notebook', ast: {segments: []}};
  const [head, ...rest] = segs;
  if (head.kind === 'grp') {
    if (rest.length) throw invalid('A section group address ends at the group', input);
    if (!content.groups[head.key]) throw notFound(`No section group ${head.key}`, input);
    return {kind: 'group', groupId: head.key, ast: {segments: [head]}};
  }
  if (head.kind === 'sec') {
    let sid = head.key;
    if (!content.sections[sid]) {
      const byName = Object.values(content.sections).find(s => s.name.toLowerCase() === String(sid ?? '').toLowerCase());
      if (!byName) throw notFound(`No section ${sid}`, input);
      sid = byName.id;
    }
    if (!rest.length) return {kind: 'section', sectionId: sid, ast: {segments: [{kind: 'sec', key: sid}]}};
    const [next, ...more] = rest;
    if (next.kind === 'page') {
      const n = Number(next.key);
      const entry = Number.isInteger(n) && n >= 1 ? content.sections[sid].pages[n - 1] : null;
      if (!entry) throw notFound(`Section ${sid} has no page ${next.key}`, input);
      return pageTarget(content, entry.id, more, input);
    }
    if (next.kind === 'pg') {
      if (sectionOf(content, next.key) !== sid) throw notFound(`No page ${next.key} in section ${sid}`, input);
      return pageTarget(content, next.key, more, input);
    }
    throw invalid(`A section address continues with /pg:<id> or /page:<n>, not /${next.kind}`, input);
  }
  if (head.kind === 'pg') return pageTarget(content, head.key, rest, input);
  throw invalid(`Unknown address kind ${head.kind}`, input);
}

function pageTarget(content, pageId, rest, input) {
  const page = content.pages[pageId];
  if (!page) throw notFound(`No page ${pageId}`, input);
  const base = {kind: 'pg', key: pageId};
  if (!rest.length) return {kind: 'page', pageId, ast: {segments: [base]}};
  const [seg, ...more] = rest;
  if (!PAGE_KINDS.has(seg.kind)) throw invalid(`Unknown page part /${seg.kind}`, input);
  switch (seg.kind) {
    case 'meta':
      if (more.length || seg.key !== undefined) throw invalid('/meta has no key and ends the address', input);
      return {kind: 'meta', pageId, ast: {segments: [base, {kind: 'meta'}]}};
    case 'title': {
      if (seg.key !== undefined) throw invalid('/title has no key', input);
      if (!more.length) return {kind: 'title', pageId, ast: {segments: [base, {kind: 'title'}]}};
      if (more.length !== 1 || more[0].kind !== 't') throw invalid('The title continues only with /t:<from>-<to>', input);
      const range = parseTextRange(more[0].key);
      assertCodeUnitBoundary(page.title, range.from);
      assertCodeUnitBoundary(page.title, range.to);
      return {kind: 'title-text', pageId, range, ast: {segments: [base, {kind: 'title'}, {kind: 't', key: rangeKey(range)}]}};
    }
    case 'ink': {
      if (more.length) throw invalid('An ink address ends at the stroke', input);
      if (seg.key === undefined) return {kind: 'ink', pageId, ast: {segments: [base, {kind: 'ink'}]}};
      const stroke = page.ink.find(s => s.id === seg.key);
      if (!stroke) throw notFound(`No stroke ${seg.key} on page ${pageId}`, input);
      return {kind: 'stroke', pageId, strokeId: seg.key, stroke, ast: {segments: [base, {kind: 'ink', key: seg.key}]}};
    }
    case 'tag': {
      if (more.length) throw invalid('A tag address ends at the tag', input);
      const m = /^([^.]+)\.(.+)$/.exec(seg.key ?? '');
      if (!m) throw invalid('A tag address is /tag:<blockId>.<tagId>', input);
      const hit = blockIndex(nodeOf(page.body)).get(m[1]);
      const tag = hit?.node.attrs.tags?.find?.(t => t?.id === m[2]);
      if (!tag) throw notFound(`No tag ${m[2]} on block ${m[1]}`, input);
      return {kind: 'tag', pageId, blockId: m[1], tagId: m[2], tag, node: hit.node, ast: {segments: [base, {kind: 'tag', key: seg.key}]}};
    }
    default:
      return nodeTarget(content, page, base, rest, input);
  }
}

const rangeKey = r => (r.from === r.to ? String(r.from) : `${r.from}-${r.to}`);

/** /c:<id>, /b:<id>, /media:<id>, table row/cell steps, then an optional /t: range. */
function nodeTarget(content, page, base, segs, input) {
  const doc = nodeOf(page.body);
  const index = blockIndex(doc);
  let hit = null;
  let i = 0;
  while (i < segs.length) {
    const seg = segs[i];
    if (seg.kind === 't') break;
    if (seg.kind === 'r') {
      if (!hit || hit.node.type.name !== 'table') throw invalid('/r:<i> follows a table block', input);
      const row = Number(seg.key);
      const node = Number.isInteger(row) && row >= 0 && row < hit.node.childCount ? hit.node.child(row) : null;
      if (!node) throw notFound(`Table ${hit.node.attrs.id} has no row ${seg.key}`, input);
      hit = index.get(node.attrs.id);
      i++;
      if (segs[i]?.kind === 'c') {
        const col = Number(segs[i].key);
        const cell = Number.isInteger(col) && col >= 0 && col < hit.node.childCount ? hit.node.child(col) : null;
        if (!cell) throw notFound(`Row ${row} has no cell ${segs[i].key}`, input);
        hit = index.get(cell.attrs.id);
        i++;
      }
      continue;
    }
    if (seg.kind === 'c' || seg.kind === 'b' || seg.kind === 'media') {
      const found = index.get(seg.key);
      if (!found) throw notFound(`No ${seg.kind === 'c' ? 'note container' : seg.kind === 'media' ? 'object' : 'block'} ${seg.key} on page ${page.id}`, input);
      if (seg.kind === 'c' && found.node.type.name !== 'container') throw notFound(`${seg.key} is not a note container`, input);
      if (seg.kind === 'media' && !OBJECTS.has(found.node.type.name)) throw notFound(`${seg.key} is not a picture, file, recording, equation, spreadsheet or diagram`, input);
      hit = found;
      i++;
      continue;
    }
    throw invalid(`Unexpected /${seg.kind} in a page address`, input);
  }
  if (!hit) throw invalid('A page part address names a container, block or object', input);
  const name = hit.node.type.name;
  const own = name === 'container' ? {kind: 'c', key: hit.node.attrs.id} : OBJECTS.has(name) ? {kind: 'media', key: hit.node.attrs.id} : {kind: 'b', key: hit.node.attrs.id};
  const kind = name === 'container' ? 'container' : OBJECTS.has(name) ? 'object' : 'block';
  if (i === segs.length) return {kind, pageId: page.id, hit, ast: {segments: [base, own]}};
  if (i !== segs.length - 1) throw invalid('/t: ends the address', input);
  if (!hit.node.isTextblock) throw invalid(`A ${name} has no text offsets; address one of its paragraphs`, input);
  const range = parseTextRange(segs[i].key);
  const text = textOf(hit.node);
  assertCodeUnitBoundary(text, range.from);
  assertCodeUnitBoundary(text, range.to);
  return {kind: 'text', pageId: page.id, hit, range, ast: {segments: [base, own, {kind: 't', key: rangeKey(range)}]}};
}

// ---------------------------------------------------------------------------------------------
// Resolver contract (14.7)

export function resolve(content, ast) {
  if (!slateAddress(content, ast)) return genericResolver.resolve(content, ast);
  const t = target(content, ast);
  switch (t.kind) {
    case 'notebook': return {kind: 'notebook', node: content.notebook, path: []};
    case 'group': return {kind: 'group', node: content.groups[t.groupId], path: ['groups', t.groupId]};
    case 'section': return {kind: 'section', node: content.sections[t.sectionId], path: ['sections', t.sectionId]};
    case 'page': case 'meta': return {kind: t.kind, node: content.pages[t.pageId], path: ['pages', t.pageId], pageId: t.pageId};
    case 'title': case 'title-text': return {kind: t.kind, node: content.pages[t.pageId].title, path: ['pages', t.pageId, 'title'], pageId: t.pageId, range: t.range};
    case 'ink': return {kind: 'ink', node: content.pages[t.pageId].ink, path: ['pages', t.pageId, 'ink'], pageId: t.pageId};
    case 'stroke': return {kind: 'stroke', node: t.stroke, path: ['pages', t.pageId, 'ink'], pageId: t.pageId};
    case 'tag': return {kind: 'tag', node: t.tag, pageId: t.pageId, blockId: t.blockId};
    default: return {kind: t.kind, node: t.hit.node, pos: t.hit.pos, pageId: t.pageId, container: t.hit.container, range: t.range};
  }
}

export function canonical(content, input) {
  const ast = typeof input === 'string' ? parse(input) : input;
  if (!slateAddress(content, ast)) return genericResolver.canonical(content, format(ast));
  return format(target(content, ast).ast);
}

// ---------------------------------------------------------------------------------------------
// Reading

const READ_AS = new Set(['json', 'text', 'runs', 'props']);

function notebookSummary(content) {
  const build = items => items.map(id => content.sections[id]
    ? {address: `/sec:${id}`, kind: 'section', id, name: content.sections[id].name, color: content.sections[id].color, pages: content.sections[id].pages.length,
      protected: !!content.sections[id].protection, locked: content.sections[id].locked === true}
    : {address: `/grp:${id}`, kind: 'group', id, name: content.groups[id].name, items: build(content.groups[id].items)});
  return {address: '/', notebook: {...content.notebook}, items: build(content.tree), pages: Object.keys(content.pages).length};
}

function sectionRead(content, sid) {
  const s = content.sections[sid];
  return {address: `/sec:${sid}`, id: s.id, name: s.name, color: s.color, created: s.created, protected: !!s.protection, locked: s.locked === true,
    pages: pagesOf(content, sid).map(p => ({address: `/pg:${p.id}`, ...p}))};
}

function pageProps(content, pageId) {
  const p = content.pages[pageId];
  const at = pageIndex(content).get(pageId);
  return {address: `/pg:${pageId}`, id: p.id, title: p.title, created: p.created, modified: p.modified, color: p.color, rule: {...p.rule},
    titleHidden: p.titleHidden, paperSize: p.paperSize, level: at?.level ?? 0, section: at ? `/sec:${at.section}` : null,
    containers: containersOf(nodeOf(p.body)).map(c => `/pg:${pageId}/c:${c.id}`), strokes: p.ink.length,
    unread: p.unread === true, author: p.author ?? null, modifiedBy: p.modifiedBy ?? null,
    versions: (content.versions?.[pageId] ?? []).map(v => ({id: v.id, saved: v.saved, author: v.author ?? null, title: v.title, strokes: v.ink.length})),
    ...marksOf(pageId, nodeOf(p.body))};
}

/** The page's tags (each with its /tag: address) and equations (each with its /media: address), as the bridge lists them. */
function marksOf(pageId, doc) {
  const tags = [], equations = [];
  doc.descendants(node => {
    if (node.type.name === 'paragraph') for (const t of node.attrs.tags ?? []) tags.push({address: `/pg:${pageId}/tag:${node.attrs.id}.${t.id}`, block: node.attrs.id, id: t.id, name: t.name, checked: t.checkbox ? t.checked === true : null});
    else if (node.type.name === 'equation') equations.push({address: `/pg:${pageId}/media:${node.attrs.id}`, id: node.attrs.id, linear: node.attrs.linear, format: node.attrs.format ?? 'professional'});
    return true;
  });
  return {tags, equations};
}

function nodeProps(node) {
  const out = {type: node.type.name, ...node.attrs};
  if (node.isTextblock) out.length = textOf(node).length;
  return out;
}

function clipRuns(runs, from, to) {
  const out = [];
  let at = 0;
  for (const r of runs) {
    const end = at + r.text.length;
    if (end > from && at < to) out.push({...r, text: r.text.slice(Math.max(0, from - at), Math.min(r.text.length, to - at))});
    else if (from === to && at <= from && end >= from && !out.length) out.push({...r, text: ''});
    at = end;
  }
  return out;
}

export function read(content, ast, as = 'json') {
  if (!slateAddress(content, ast)) return genericResolver.read(content, ast, as);
  if (!READ_AS.has(as)) throw new CommandError('invalid_params', `A Slate address reads as json, text, runs or props, not ${as}`, {path: '/as'});
  const t = target(content, ast);
  const page = t.pageId ? content.pages[t.pageId] : null;
  switch (t.kind) {
    case 'notebook':
      return as === 'text' ? content.notebook.name : notebookSummary(content);
    case 'group': {
      const g = content.groups[t.groupId];
      return as === 'text' ? g.name : {address: `/grp:${g.id}`, id: g.id, name: g.name, created: g.created, items: g.items.map(id => (content.sections[id] ? `/sec:${id}` : `/grp:${id}`))};
    }
    case 'section': return as === 'text' ? content.sections[t.sectionId].name : sectionRead(content, t.sectionId);
    case 'page':
      if (as === 'text') return textOfPage(page);
      if (as === 'props') return pageProps(content, t.pageId);
      return structuredClone(page);
    case 'meta': return as === 'text' ? page.title : pageProps(content, t.pageId);
    case 'title': return as === 'json' || as === 'text' ? page.title : as === 'runs' ? [{text: page.title, marks: {}}] : {length: page.title.length};
    case 'title-text': {
      const text = page.title.slice(t.range.from, t.range.to);
      return as === 'runs' ? [{text, marks: {}}] : as === 'props' ? {from: t.range.from, to: t.range.to} : text;
    }
    case 'ink': return as === 'text' ? '' : structuredClone(page.ink);
    case 'stroke': return as === 'text' ? '' : structuredClone(t.stroke);
    case 'tag': return as === 'text' ? textOf(t.node) : {...t.tag, block: `/pg:${t.pageId}/b:${t.blockId}`};
    case 'text': {
      const text = textOf(t.hit.node);
      if (as === 'text' || as === 'json') return text.slice(t.range.from, t.range.to);
      if (as === 'runs') return clipRuns(runsOf(t.hit.node), t.range.from, t.range.to);
      return {...nodeProps(t.hit.node), from: t.range.from, to: t.range.to, marks: clipRuns(runsOf(t.hit.node), t.range.from, Math.max(t.range.to, t.range.from + 1))[0]?.marks ?? {}};
    }
    default: {
      const node = t.hit.node;
      if (as === 'text') return textOf(node);
      if (as === 'runs') { if (!node.isTextblock) throw new CommandError('invalid_params', `A ${node.type.name} has no runs; read its paragraphs`, {path: '/as'}); return runsOf(node); }
      if (as === 'props') return nodeProps(node);
      return node.toJSON();
    }
  }
}

function textOfPage(page) {
  const parts = [page.title];
  nodeOf(page.body).forEach(c => parts.push(textOf(c)));
  return parts.filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------------------------
// Enumerating (document.inspect)

function childrenOf(content, t) {
  switch (t.kind) {
    case 'notebook': return content.tree.map(id => itemNode(content, id));
    case 'group': return content.groups[t.groupId].items.map(id => itemNode(content, id));
    case 'section': return content.sections[t.sectionId].pages.map(e => {
      const p = content.pages[e.id];
      return {address: `/pg:${e.id}`, kind: 'page', title: p.title, level: e.level, created: p.created, modified: p.modified};
    });
    case 'page': {
      const page = content.pages[t.pageId];
      const out = [{address: `/pg:${t.pageId}/meta`, kind: 'meta'}, {address: `/pg:${t.pageId}/title`, kind: 'title', text: page.title}];
      for (const c of containersOf(nodeOf(page.body))) out.push({address: `/pg:${t.pageId}/c:${c.id}`, kind: 'container', x: c.x, y: c.y, width: c.width, children: c.node.childCount});
      out.push({address: `/pg:${t.pageId}/ink`, kind: 'ink', children: page.ink.length});
      return out;
    }
    case 'ink': return content.pages[t.pageId].ink.map(s => ({address: `/pg:${t.pageId}/ink:${s.id}`, kind: 'stroke', tool: s.tool, color: s.color, points: s.points.length / 2}));
    case 'container': case 'block': {
      const out = [];
      t.hit.node.forEach(child => {
        if (!child.attrs?.id) return;
        out.push(blockNode(t.pageId, child));
      });
      return out;
    }
    default: return [];
  }
}

function itemNode(content, id) {
  if (content.sections[id]) {
    const s = content.sections[id];
    return {address: `/sec:${id}`, kind: 'section', name: s.name, color: s.color, children: s.pages.length};
  }
  const g = content.groups[id];
  return {address: `/grp:${id}`, kind: 'group', name: g.name, children: g.items.length};
}

function blockNode(pageId, node) {
  const name = node.type.name;
  const out = {address: OBJECTS.has(name) ? `/pg:${pageId}/media:${node.attrs.id}` : `/pg:${pageId}/b:${node.attrs.id}`, kind: name};
  if (node.isTextblock) { out.text = textOf(node); out.style = node.attrs.style; if (node.attrs.tags?.length) out.tags = node.attrs.tags.map(tg => tg.id); }
  else if (!node.isLeaf) out.children = node.childCount;
  return out;
}

const ENUM_KINDS = new Set(['notebook', 'group', 'section', 'page', 'ink', 'container', 'block']);

export function enumerate(content, scope, {depth = 1, cursor, limit = 100} = {}) {
  if (!slateAddress(content, scope)) return genericResolver.enumerate(content, scope, {depth, cursor, limit});
  const t = target(content, scope);
  const all = [];
  const walk = (tt, d) => {
    if (!ENUM_KINDS.has(tt.kind) || d >= depth) return;
    for (const n of childrenOf(content, tt)) {
      all.push(n);
      if (d + 1 < depth) {
        try { walk(target(content, parse(n.address)), d + 1); } catch { /* leaf */ }
      }
    }
  };
  walk(t, 0);
  const start = cursor ? Number(cursor) : 0;
  if (!Number.isInteger(start) || start < 0) throw new CommandError('invalid_params', 'cursor is the value a previous inspection returned', {path: '/cursor'});
  const nodes = all.slice(start, start + limit);
  return start + limit < all.length ? {nodes, cursor: String(start + limit)} : {nodes};
}

// ---------------------------------------------------------------------------------------------
// Find (document.find)

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function find(content, {query, scope, regex = false, matchCase = false, wholeWord = false, limit = 100}) {
  if (!isNotebook(content)) throw new CommandError('unavailable', 'Find works on Slate notebooks');
  let source = regex ? query : escapeRe(query);
  if (wholeWord) source = `\\b(?:${source})\\b`;
  let re;
  try { re = new RegExp(source, 'g' + (matchCase ? '' : 'i') + 'u'); } catch (e) {
    throw new CommandError('invalid_params', `query is not a valid regular expression: ${e?.message ?? e}`, {path: '/query'});
  }
  const t = scope?.segments?.length ? target(content, scope) : {kind: 'notebook'};
  let pages;
  if (t.kind === 'notebook') pages = sectionOrder(content).flatMap(sid => content.sections[sid].pages.map(e => e.id));
  else if (t.kind === 'group') {
    const ids = [];
    const walk = items => items.forEach(id => (content.sections[id] ? ids.push(...content.sections[id].pages.map(e => e.id)) : walk(content.groups[id].items)));
    walk(content.groups[t.groupId].items);
    pages = ids;
  } else if (t.kind === 'section') pages = content.sections[t.sectionId].pages.map(e => e.id);
  else pages = [t.pageId];
  const matches = [];
  const scan = (text, address) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) && matches.length < limit) {
      if (!m[0].length) { re.lastIndex++; continue; }
      const from = m.index, to = from + m[0].length;
      matches.push({address: `${address}/t:${from}-${to}`, from, to, text: m[0], context: text.slice(Math.max(0, from - 40), Math.min(text.length, to + 40))});
    }
  };
  for (const pid of pages) {
    if (matches.length >= limit) break;
    const page = content.pages[pid];
    scan(page.title, `/pg:${pid}/title`);
    nodeOf(page.body).descendants(node => {
      if (matches.length >= limit) return false;
      if (node.isTextblock) { scan(textOf(node), `/pg:${pid}/b:${node.attrs.id}`); return false; }
      return true;
    });
  }
  return {matches, truncated: matches.length >= limit};
}

// ---------------------------------------------------------------------------------------------
// Mapping through changes (anchors and selection, section 4.3)

const segOf = (segs, kind) => segs.find(s => s.kind === kind);

/** Map an address through one content-relative op (change.mjs contentOp). */
export function mapThrough(op, ast) {
  if (!op || !ast?.segments) return ast;
  if (!isSlateAst(ast)) return op.op === 'app' ? ast : genericResolver.mapThrough(op, ast);
  const segs = ast.segments[0].kind === 'nb' ? ast.segments.slice(1) : ast.segments;
  const head = segs[0];
  if (!head) return ast;
  const pageId = head.kind === 'pg' ? head.key : null;
  if (op.op === 'app') {
    const trace = op.forward?.trace;
    if (!trace || !pageId || trace.page !== pageId || segs.length < 2) return ast;
    return mapInPage(ast, segs, trace);
  }
  const path = op.path;
  if (op.op === 'delete') {
    if (path[0] === 'pages' && path.length === 2 && pageId === path[1]) return {deleted: true};
    if (path[0] === 'sections' && path.length === 2 && head.kind === 'sec' && head.key === path[1]) return {deleted: true};
    if (path[0] === 'groups' && path.length === 2 && head.kind === 'grp' && head.key === path[1]) return {deleted: true};
    return ast;
  }
  if (op.op === 'splice' && pageId && path[0] === 'pages' && path[1] === pageId && path[2] === 'ink') {
    const ink = segOf(segs, 'ink');
    if (ink?.key !== undefined && op.removed?.some(s => s?.id === ink.key)) return {deleted: true, nearest: {segments: [head]}};
    return ast;
  }
  if (op.op === 'set' && pageId && path[0] === 'pages' && path[1] === pageId && (path.length === 2 || path[2] === 'body') && segs.length > 1) {
    // The page or its body was replaced as a whole: keep block addresses that still exist.
    const body = path.length === 2 ? op.value?.body : op.value;
    const b = segOf(segs, 'b') ?? segOf(segs, 'c') ?? segOf(segs, 'media');
    if (b && body) {
      try { if (!blockIndex(nodeOf(body)).has(b.key)) return {deleted: true, nearest: {segments: [head]}}; } catch { return {deleted: true, nearest: {segments: [head]}}; }
    }
  }
  return ast;
}

function mapInPage(ast, segs, trace) {
  const head = segs[0];
  const own = segs[1];
  if (!['b', 'c', 'media'].includes(own.kind)) return ast;
  const before = blockIndex(trace.before).get(own.key);
  if (!before) return ast;
  const afterIndex = blockIndex(trace.after);
  const t = segs[2]?.kind === 't' ? parseTextRange(segs[2].key) : null;
  if (!t) {
    if (afterIndex.has(own.key)) return ast;
    const p = posToPoint(trace.after, trace.mapping.map(before.pos, -1));
    return {deleted: true, nearest: p ? {segments: [head, {kind: 'b', key: p.blockId}, {kind: 't', key: String(p.offset)}]} : {segments: [head]}};
  }
  const base = before.pos + 1;
  const caret = t.from === t.to;
  const from = trace.mapping.mapResult(base + t.from, caret ? 1 : 1);
  const to = caret ? from : trace.mapping.mapResult(base + t.to, -1);
  const a = posToPoint(trace.after, from.pos);
  let b = posToPoint(trace.after, to.pos);
  if (!a) return {deleted: true, nearest: {segments: [head]}};
  if (!b || b.blockId !== a.blockId || b.offset < a.offset) b = a;
  const key = a.offset === b.offset ? String(a.offset) : `${a.offset}-${b.offset}`;
  const mapped = {segments: [head, {kind: 'b', key: a.blockId}, {kind: 't', key}]};
  if (!caret && from.deleted && to.deleted && a.offset === b.offset) return {deleted: true, nearest: mapped};
  return mapped;
}

/** Changed addresses for doc.changed events: pages, sections or the notebook. */
export function changed(ops, content) {
  if (!isNotebook(content)) throw new Error('generic');
  const out = new Set();
  for (const op of ops) {
    if (op.op === 'app') { if (op.forward?.page) out.add(`/pg:${op.forward.page}`); continue; }
    const p = op.path;
    if (p[0] === 'pages' && p[1]) out.add(p[2] === 'ink' ? `/pg:${p[1]}/ink` : p[2] === 'title' ? `/pg:${p[1]}/title` : p.length > 2 ? `/pg:${p[1]}/meta` : `/pg:${p[1]}`);
    else if (p[0] === 'sections' && p[1]) out.add(`/sec:${p[1]}`);
    else if (p[0] === 'groups' && p[1]) out.add(`/grp:${p[1]}`);
    else out.add('/');
  }
  return [...out];
}

