// Quill addresses (docs/architecture.md sections 14.1, 14.2 and 14.7): parse, format, resolve,
// canonicalize, enumerate, read and find over schema-2 content, and how addresses (sticky anchors,
// the selection) move through each change. Arkemis glue over the translated model (core/quill/model,
// from wordcraft crates/doc at aadb077e072b7de05f724e359d8db82e151f125c; upstream addresses by
// index paths, `Pos {story, path, off}`, which positionOf/addressOf convert to and from).
//
//   /body                                     main story
//   /hdr:<sectionId>.default|first|even, /ftr:...   header / footer stories (linked ones resolve)
//   /fn:<partId> /en:<partId> /cmt:<commentId> /tbx:<shapeOid> /part:<partId>   other stories
//   /body/b:<id>                              paragraph or table (a nested id may be given alone)
//   /body/b:<tableId>/r:<rowId>/c:<cellId>/b:<blockId>   inside a table cell (nests)
//   /body/b:<id>/t:<from>[-<to>]              UTF-16 offsets in a paragraph's text (U+FFFC per object)
//   /body/b:<id>/o:<oid>                      inline object (picture, shape, field, note, control...)
//   /sec:<id> /style:<id> /list:<numId> /bm:<name> /rev:<index> /page:<n>
//
// Block keys may also be upstream index paths (`b:3`, `b:1.0.1.0` = Path [1, 0, 1, 0]); canonical()
// turns them into ids. Schema-1 content (ProseMirror JSON, before migration) keeps the interim
// grammar `/body/b:<i.j...>/t:<from>-<to>` over its textblocks and plain JSON paths, so commands
// written for schema 1 keep working. No DOM, no Node built-ins.

import {CommandError} from '../kernel/errors.mjs';
import {parse as kParse, format as kFormat, parseTextRange, assertCodeUnitBoundary, genericResolver} from '../kernel/address.mjs';
import {Document, BODY, ArrayList, cmpPath, samePath} from './model/document.mjs';
import {isQuill2} from './model/content.mjs';
import {bodyIndexOf} from './model/body.mjs';
import {textDiff, OP_TYPE} from './model/ops.mjs';
import {resolvePara, resolveChar} from './model/styles.mjs';
import {sectionOf} from './model/section.mjs';
import * as P from './model/para.mjs';

const invalid = (msg, address) => new CommandError('invalid_address', msg, address === undefined ? undefined : {address});
const notFound = (msg, address) => new CommandError('not_found', msg, address === undefined ? undefined : {address});

const STORY_KINDS = new Set(['body', 'hdr', 'ftr', 'fn', 'en', 'cmt', 'tbx', 'part']);
const OBJECT_KINDS = new Set(['sec', 'style', 'list', 'bm', 'rev', 'page']);
const INDEX_PATH = /^\d{1,9}(\.\d{1,9}){0,47}$/;

// --- parse / format ---------------------------------------------------------------------------

/**
 * Classify a parsed address: {kind: 'root'} | {kind: 'flow', story, chain, text, obj} |
 * {kind: 'sec'|'style'|'list'|'bm'|'rev'|'page', key} | {kind: 'json'} (other JSON paths).
 */
export function classify(ast) {
  const segs = ast?.segments;
  if (!Array.isArray(segs)) throw invalid('Not a Quill address');
  if (!segs.length) return {kind: 'root'};
  const [s0, ...rest] = segs;
  if (OBJECT_KINDS.has(s0.kind) && s0.key !== undefined && !rest.length) return {kind: s0.kind, key: s0.key};
  if (!STORY_KINDS.has(s0.kind)) return {kind: 'json'};
  if ((s0.kind === 'body') !== (s0.key === undefined)) return {kind: 'json'};
  const chain = [];
  let text = null, obj = null;
  for (const sg of rest) {
    if (text || obj) throw invalid(`Nothing may follow a text range or object in ${kFormat(ast)}`, kFormat(ast));
    if ((sg.kind === 'b' || sg.kind === 'r' || sg.kind === 'c') && sg.key) {
      const want = chain.length % 3 === 0 ? 'b' : chain.length % 3 === 1 ? 'r' : 'c';
      if (sg.kind !== want) throw invalid(`Expected ${want}: after ${chain.map(c => c.kind).join('/') || 'the story'} in ${kFormat(ast)}`, kFormat(ast));
      chain.push(sg);
    } else if (sg.kind === 't' && sg.key !== undefined) {
      text = parseTextRange(sg.key);
    } else if (sg.kind === 'o' && sg.key) {
      obj = sg.key;
    } else throw invalid(`Unknown Quill address segment ${sg.kind} in ${kFormat(ast)}`, kFormat(ast));
  }
  if ((text || obj) && chain[chain.length - 1]?.kind !== 'b') throw invalid('A text range or object follows a block (b:)', kFormat(ast));
  return {kind: 'flow', story: s0, chain, text, obj};
}

/** Parse an address string; throws invalid_address. */
export function parse(input) {
  const ast = kParse(input);
  if (ast.anchor) return ast;
  classify(ast);
  return ast;
}

export const format = ast => kFormat(ast);

const seg = (kind, key) => (key === undefined ? {kind} : {kind, key: String(key)});

// --- stories ----------------------------------------------------------------------------------

const sectionsCache = new WeakMap();
/** Sections in order with their id: [{section, end}] (end null for the last). Cached per body. */
function sectionList(content) {
  let s = sectionsCache.get(content.body);
  if (s && s.last === content.lastSection) return s.list;
  const d = new Document(content);
  const list = d.sections().map(([end, section], i, all) => ({section, end: i === all.length - 1 ? null : end}));
  sectionsCache.set(content.body, {last: content.lastSection, list});
  return list;
}

/** The part a header/footer address names: its own slot, or the one it links to (an earlier section's). */
function headerPart(content, sectionId, which, footer) {
  const list = sectionList(content);
  const i = list.findIndex(x => x.section.id === sectionId);
  if (i < 0) return null;
  for (let k = i; k >= 0; k--) {
    const set = (footer ? sectionOf(list[k].section).footers : sectionOf(list[k].section).headers);
    const id = set?.[which];
    if (id !== null && id !== undefined) return id;
  }
  return null;
}

/** Find the shape object with `oid` anywhere: {story, path, off, obj} or null. */
function findObject(content, oid) {
  const d = new Document(content);
  for (const story of [BODY, ...Object.keys(content.parts).map(Number)]) {
    for (const path of d.paraPaths(story)) {
      const p = d.para(story, path);
      if (!p?.objects?.length) continue;
      const hit = P.objectsWithOffsets(p).find(([, o]) => o.oid === oid);
      if (hit) return {story, path, off: hit[0], obj: hit[1]};
    }
  }
  return null;
}

/** The story an address's first segment names: 'body' or a part id. */
function storyOf(content, s0, address) {
  switch (s0.kind) {
    case 'body': return BODY;
    case 'hdr': case 'ftr': {
      const m = /^([0-9a-z]{1,64})\.(default|first|even)$/.exec(s0.key);
      if (!m) throw invalid(`${s0.kind}:<sectionId>.default|first|even expected, got ${s0.key}`, address);
      const id = headerPart(content, m[1], m[2], s0.kind === 'ftr');
      if (id === null) throw notFound(`Section ${m[1]} has no ${m[2]} ${s0.kind === 'ftr' ? 'footer' : 'header'}`, address);
      return id;
    }
    case 'fn': case 'en': {
      const id = Number(s0.key);
      const want = s0.kind === 'fn' ? 'footnote' : 'endnote';
      if (!Number.isInteger(id) || content.parts[id]?.kind !== want) throw notFound(`No ${want} ${s0.key}`, address);
      return id;
    }
    case 'cmt': {
      const c = content.comments[s0.key];
      if (!c || !content.parts[c.part]) throw notFound(`No comment ${s0.key}`, address);
      return c.part;
    }
    case 'tbx': {
      if (/^\d+$/.test(s0.key) && content.parts[Number(s0.key)]?.kind === 'textBox') return Number(s0.key);
      const hit = findObject(content, s0.key);
      const id = hit ? P.textBoxOf(hit.obj) : null;
      if (id === null || !content.parts[id]) throw notFound(`No text box ${s0.key}`, address);
      return id;
    }
    case 'part': {
      const id = Number(s0.key);
      if (!Number.isInteger(id) || !content.parts[id]) throw notFound(`No story part ${s0.key}`, address);
      return id;
    }
    default: throw invalid(`Not a story: ${s0.kind}`, address);
  }
}

const storyAddrCache = new WeakMap();
/** The canonical story segment for a story (part ids become hdr/ftr/fn/en/cmt/tbx when they can). */
export function storySegment(content, story) {
  if (story === BODY) return seg('body');
  let cache = storyAddrCache.get(content);
  if (!cache) { cache = new Map(); storyAddrCache.set(content, cache); }
  if (cache.has(story)) return cache.get(story);
  const part = content.parts[story];
  let out = seg('part', story);
  if (part?.kind === 'footnote') out = seg('fn', story);
  else if (part?.kind === 'endnote') out = seg('en', story);
  else if (part?.kind === 'comment') {
    const cid = Object.keys(content.comments).find(k => content.comments[k].part === story);
    if (cid !== undefined) out = seg('cmt', cid);
  } else if (part?.kind === 'header' || part?.kind === 'footer') {
    const footer = part.kind === 'footer';
    for (const {section} of sectionList(content)) {
      const set = footer ? sectionOf(section).footers : sectionOf(section).headers;
      const which = ['default', 'first', 'even'].find(w => set[w] === story);
      if (which) { out = seg(footer ? 'ftr' : 'hdr', `${section.id}.${which}`); break; }
    }
  } else if (part?.kind === 'textBox') {
    const d = new Document(content);
    let shape = null;
    d.objectsInReadingOrder(o => { if (!shape && P.textBoxOf(o) === story && o.oid) shape = o.oid; });
    if (shape) out = seg('tbx', shape);
  }
  cache.set(story, out);
  return out;
}

// --- blocks -----------------------------------------------------------------------------------

/** Index of block `key` (an id, or an index) in a list. */
function indexIn(list, key, content, top) {
  if (top && content && list.len() > 64) {
    const i = bodyIndexOf(content.body, key);
    if (i >= 0) return i;
  } else {
    for (const [i, b] of list.entries()) if (b.id === key) return i;
  }
  if (/^\d{1,9}$/.test(key)) { const i = Number(key); return i < list.len() ? i : -1; }
  return -1;
}

/** Search a story for the block (or row, or cell) with id `id`: its index path, or null. */
function deepFind(list, id, prefix = [], depth = 0) {
  if (depth > 32) return null;
  for (const [i, b] of list.entries()) {
    if (b.id === id) return [...prefix, i];
    if (b.kind !== 'table') continue;
    for (let r = 0; r < b.rows.length; r++) {
      if (b.rows[r].id === id) return [...prefix, i, r];
      for (let c = 0; c < b.rows[r].cells.length; c++) {
        const cell = b.rows[r].cells[c];
        if (cell.id === id) return [...prefix, i, r, c];
        const got = deepFind(new ArrayList(cell.blocks), id, [...prefix, i, r, c], depth + 1);
        if (got) return got;
      }
    }
  }
  return null;
}

/** The node at an index path that may end at a row ([.., t, r]) or a cell ([.., t, r, c]). */
function nodeAtPath(d, story, path) {
  let list = d.story(story);
  let node = null;
  for (let i = 0; i < path.length; i++) {
    const step = i % 3;
    if (step === 0) { node = list?.get(path[i]); if (!node) return null; }
    else if (step === 1) { if (node?.kind !== 'table') return null; node = node.rows[path[i]]; if (!node) return null; }
    else { node = node.cells[path[i]]; if (!node) return null; list = new ArrayList(node.blocks); }
  }
  return node;
}
const kindOfPath = (path, node) => (path.length % 3 === 1 ? (node.kind === 'table' ? 'table' : 'paragraph') : path.length % 3 === 2 ? 'row' : 'cell');

/** Resolve a flow address's chain into an index path. */
function chainPath(content, d, story, chain, address) {
  if (chain.length === 1 && INDEX_PATH.test(chain[0].key) && chain[0].key.includes('.')) {
    const path = chain[0].key.split('.').map(Number);
    if (path.length % 3 !== 1 || !nodeAtPath(d, story, path)) throw notFound(`No block at index path ${chain[0].key}`, address);
    return path;
  }
  const path = [];
  let list = d.story(story);
  let node = null;
  for (let i = 0; i < chain.length; i++) {
    const {kind, key} = chain[i];
    if (kind === 'b') {
      let idx = indexIn(list, key, content, i === 0 && story === BODY);
      if (idx < 0 && i === 0 && chain.length === 1) {
        const deep = deepFind(list, key);
        if (deep) return deep;
      }
      if (idx < 0) throw notFound(`No block ${key} in ${address}`, address);
      path.push(idx);
      node = list.get(idx);
    } else if (kind === 'r') {
      if (node?.kind !== 'table') throw notFound(`Block ${chain[i - 1].key} is not a table`, address);
      let r = node.rows.findIndex(x => x.id === key);
      if (r < 0 && /^\d+$/.test(key) && Number(key) < node.rows.length) r = Number(key);
      if (r < 0) throw notFound(`No row ${key} in ${address}`, address);
      path.push(r);
      node = node.rows[r];
    } else {
      let c = node.cells.findIndex(x => x.id === key);
      if (c < 0 && /^\d+$/.test(key) && Number(key) < node.cells.length) c = Number(key);
      if (c < 0) throw notFound(`No cell ${key} in ${address}`, address);
      path.push(c);
      node = node.cells[c];
      list = new ArrayList(node.blocks);
    }
  }
  return path;
}

/** The chain segments (ids) of an index path. */
function chainOf(d, story, path) {
  const out = [];
  let list = d.story(story);
  let node = null;
  for (let i = 0; i < path.length; i++) {
    const step = i % 3;
    if (step === 0) { node = list.get(path[i]); out.push(seg('b', node.id)); }
    else if (step === 1) { node = node.rows[path[i]]; out.push(seg('r', node.id)); }
    else { node = node.cells[path[i]]; out.push(seg('c', node.id)); list = new ArrayList(node.blocks); }
  }
  return out;
}

// --- positions (commands) -----------------------------------------------------------------------

function flowOf(content, input) {
  const ast = typeof input === 'string' ? parse(input) : input;
  if (ast.anchor) throw invalid('Resolve anchors through the session first', ast.anchor);
  const cls = classify(ast);
  if (cls.kind !== 'flow') throw invalid(`${kFormat(ast)} is not a position in the text`, kFormat(ast));
  return {ast, cls};
}

/** The range [anchor, focus] of positions an address covers (a caret gives two equal positions). */
export function rangeOf(content, input) {
  if (!isQuill2(content)) throw invalid('Positions need Quill schema-2 content (migrate the document first)');
  const {ast, cls} = flowOf(content, input);
  const address = kFormat(ast);
  const d = new Document(content);
  const story = storyOf(content, cls.story, address);
  if (!cls.chain.length) { const a = d.startOf(story), b = d.endOf(story); return [a, b]; }
  const path = chainPath(content, d, story, cls.chain, address);
  const node = nodeAtPath(d, story, path);
  if (path.length % 3 === 1 && node.kind === 'para') {
    if (cls.text) {
      for (const off of [cls.text.from, cls.text.to]) assertCodeUnitBoundary(node.text, off);
      return [{story, path, off: cls.text.from}, {story, path, off: cls.text.to}];
    }
    if (cls.obj) {
      let off = P.objectsWithOffsets(node).find(([, o]) => o.oid === cls.obj)?.[0];
      if (off === undefined) {
        const hit = findObject(content, cls.obj);
        if (!hit) throw notFound(`No object ${cls.obj}`, address);
        return [{story: hit.story, path: hit.path, off: hit.off}, {story: hit.story, path: hit.path, off: hit.off + 1}];
      }
      return [{story, path, off}, {story, path, off: off + 1}];
    }
    return [{story, path, off: 0}, {story, path, off: node.text.length}];
  }
  // A table, row or cell: from its first paragraph to its last.
  const paths = d.paraPaths(story).filter(p => p.length > path.length && path.every((x, i) => p[i] === x));
  if (!paths.length) throw notFound(`${address} holds no paragraph`, address);
  const last = paths[paths.length - 1];
  return [{story, path: paths[0], off: 0}, {story, path: last, off: d.para(story, last).text.length}];
}

/** The position an address names (a range's start). */
export const positionOf = (content, input) => rangeOf(content, input)[0];

/** The canonical address of a position (a caret, `t:off`). */
export function addressOf(content, pos) {
  const d = new Document(content);
  if (!d.para(pos.story, pos.path)) throw notFound(`No paragraph at ${pos.path.join('/')}`);
  return kFormat({segments: [storySegment(content, pos.story), ...chainOf(d, pos.story, pos.path), seg('t', pos.off)]});
}

/** The canonical address of a range in one paragraph (`t:from-to`), or of each end. */
export function rangeAddress(content, a, b) {
  if (a.story === b.story && samePath(a.path, b.path)) {
    const d = new Document(content);
    const [from, to] = a.off <= b.off ? [a.off, b.off] : [b.off, a.off];
    return kFormat({segments: [storySegment(content, a.story), ...chainOf(d, a.story, a.path), seg('t', from === to ? from : `${from}-${to}`)]});
  }
  return null;
}

/** The canonical address of a block (paragraph or table) at an index path. */
export function blockAddress(content, story, path) {
  const d = new Document(content);
  return kFormat({segments: [storySegment(content, story), ...chainOf(d, story, path)]});
}

/** A kernel selection's ranges as positions: [{anchor, focus}] (empty selection: none). */
export function selectionPositions(content, selection) {
  const out = [];
  for (const r of selection?.ranges ?? []) {
    const [a1, a2] = rangeOf(content, r.anchor);
    if (!r.focus || r.focus === r.anchor) { out.push({anchor: a1, focus: a2}); continue; }
    const [f1, f2] = rangeOf(content, r.focus);
    out.push({anchor: a1, focus: cmpPositions(f1, a1) >= 0 ? f2 : f1});
  }
  return out;
}

/** Document order of two positions (body first, then parts by id). */
export const cmpPositions = (a, b) => (a.story === b.story ? cmpPath(a.path, b.path) || a.off - b.off : (a.story === BODY ? -1 : b.story === BODY ? 1 : a.story - b.story));

/** A kernel selection (address strings) for position ranges [{anchor, focus}]. */
export function selectionOf(content, ranges, primary = 0) {
  return {ranges: ranges.map(r => ({anchor: addressOf(content, r.anchor), focus: addressOf(content, r.focus ?? r.anchor)})), primary};
}

// --- resolve / read ---------------------------------------------------------------------------

/** Resolve a schema-1 (ProseMirror JSON) address: the interim textblock grammar or a JSON path. */
function legacyResolve(content, ast) {
  const cls = classify(ast);
  if (cls.kind === 'flow' && cls.story.kind === 'body' && cls.chain.length === 1 && INDEX_PATH.test(cls.chain[0].key)) {
    const path = cls.chain[0].key.split('.').map(Number);
    let node = content.doc;
    for (const i of path) node = node?.content?.[i];
    if (!node || !['paragraph', 'heading', 'codeBlock'].includes(node.type)) throw notFound(`No paragraph at ${kFormat(ast)}`, kFormat(ast));
    const text = (node.content || []).map(n => (n.type === 'text' ? String(n.text ?? '') : P.OBJ)).join('');
    if (cls.text) for (const off of [cls.text.from, cls.text.to]) assertCodeUnitBoundary(text, off);
    return {kind: cls.text ? 'text' : 'paragraph', node, path, text, from: cls.text?.from ?? 0, to: cls.text?.to ?? text.length};
  }
  return genericResolver.resolve(content, ast);
}

/** Resolve an address against content: {kind, node, story?, path?, from?, to?, address}. */
export function resolve(content, ast) {
  if (!isQuill2(content)) return legacyResolve(content, ast);
  const cls = classify(ast);
  const address = kFormat(ast);
  const d = new Document(content);
  switch (cls.kind) {
    case 'root': return {kind: 'document', node: content, address: '/'};
    case 'json': {
      const r = genericResolver.resolve(content, ast);
      return {...r, address};
    }
    case 'sec': {
      const hit = sectionList(content).find(x => x.section.id === cls.key);
      if (!hit) throw notFound(`No section ${cls.key}`, address);
      return {kind: 'section', node: hit.section, end: hit.end, address};
    }
    case 'style': {
      const st = content.styles.styles.find(s => s.id === cls.key) ?? content.styles.styles.find(s => s.name.toLowerCase() === cls.key.toLowerCase());
      if (!st) throw notFound(`No style ${cls.key}`, address);
      return {kind: 'style', node: st, address: kFormat({segments: [seg('style', st.id)]})};
    }
    case 'list': {
      const n = content.numbering.nums.find(x => String(x.id) === cls.key);
      if (!n) throw notFound(`No list ${cls.key}`, address);
      return {kind: 'list', node: n, abstract: content.numbering.abstracts.find(a => a.id === n.abstractId) ?? null, address};
    }
    case 'bm': {
      const bm = d.bookmarks().find(([name]) => name === cls.key);
      if (!bm) throw notFound(`No bookmark ${cls.key}`, address);
      return {kind: 'bookmark', node: {name: bm[0]}, story: BODY, path: bm[1].path, from: bm[1].off, to: bm[1].off, address};
    }
    case 'rev': {
      const rev = content.revisions[Number(cls.key)];
      if (!rev) throw notFound(`No revision ${cls.key}`, address);
      return {kind: 'revision', node: rev, address};
    }
    case 'page': {
      if (typeof pageResolver === 'function') return pageResolver(content, Number(cls.key), address);
      throw notFound('Page addresses come from the layout, which is not running for this document', address);
    }
    default: break;
  }
  const story = storyOf(content, cls.story, address);
  if (!cls.chain.length) return {kind: 'story', node: d.story(story).toArray(), story, path: [], address: kFormat({segments: [storySegment(content, story)]})};
  const path = chainPath(content, d, story, cls.chain, address);
  const node = nodeAtPath(d, story, path);
  const canonicalChain = chainOf(d, story, path);
  const base = [storySegment(content, story), ...canonicalChain];
  const kind = kindOfPath(path, node);
  if (cls.text) {
    if (kind !== 'paragraph') throw invalid('A text range needs a paragraph', address);
    for (const off of [cls.text.from, cls.text.to]) assertCodeUnitBoundary(node.text, off);
    const t = cls.text.from === cls.text.to ? cls.text.from : `${cls.text.from}-${cls.text.to}`;
    return {kind: 'text', node, story, path, from: cls.text.from, to: cls.text.to, address: kFormat({segments: [...base, seg('t', t)]})};
  }
  if (cls.obj) {
    const [a] = rangeOf(content, ast);
    const p = d.para(a.story, a.path);
    const o = P.objectAt(p, a.off);
    return {kind: 'object', node: o, story: a.story, path: a.path, from: a.off, to: a.off + 1,
      address: kFormat({segments: [storySegment(content, a.story), ...chainOf(d, a.story, a.path), seg('o', o.oid)]})};
  }
  return {kind, node, story, path, address: kFormat({segments: base})};
}

let pageResolver = null;
/** The layout registers how `/page:<n>` resolves (it owns pagination). */
export function setPageResolver(fn) { pageResolver = typeof fn === 'function' ? fn : null; }

/** Friendly → canonical: index paths become ids; `paragraph N`, `table N`, `section N`, `bookmark X`, `style X`, `page N`. */
export function canonical(content, input) {
  if (!isQuill2(content)) return kFormat(parse(input));
  const s = String(input).trim();
  const m = /^(paragraph|table|section|bookmark|style|page)\s+(.+)$/i.exec(s);
  if (m) {
    const what = m[1].toLowerCase(), arg = m[2].trim();
    const d = new Document(content);
    if (what === 'paragraph') {
      const n = Number(arg);
      const paths = d.paraPaths(BODY);
      if (!Number.isInteger(n) || n < 1 || n > paths.length) throw notFound(`No paragraph ${arg}`, s);
      return blockAddress(content, BODY, paths[n - 1]);
    }
    if (what === 'table') {
      const n = Number(arg);
      const tables = [];
      for (const [i, b] of d.story(BODY).entries()) if (b.kind === 'table') tables.push(i);
      if (!Number.isInteger(n) || n < 1 || n > tables.length) throw notFound(`No table ${arg}`, s);
      return blockAddress(content, BODY, [tables[n - 1]]);
    }
    if (what === 'section') {
      const n = Number(arg);
      const list = sectionList(content);
      if (!Number.isInteger(n) || n < 1 || n > list.length) throw notFound(`No section ${arg}`, s);
      return `/sec:${list[n - 1].section.id}`;
    }
    if (what === 'bookmark') return resolve(content, parse(`/bm:${encodeURIComponent(arg)}`)).address;
    if (what === 'style') return resolve(content, {segments: [seg('style', arg)]}).address;
    if (what === 'page') return `/page:${Number(arg)}`;
  }
  return resolve(content, parse(s)).address;
}

function runsOf(p, from, to) {
  const out = [];
  let k = P.objectsBefore(p, from);
  for (const [s, e, props] of P.runRanges(p)) {
    const a = Math.max(s, from), b = Math.min(e, to);
    if (b <= a) continue;
    const raw = p.text.slice(a, b);
    const objects = [];
    for (let i = 0; i < raw.length; i++) if (raw[i] === P.OBJ) objects.push(p.objects?.[k++] ?? null);
    out.push({from: a, to: b, text: raw, props, ...(objects.length ? {objects} : {})});
  }
  return out;
}
const shownText = (p, from, to) => {
  let k = P.objectsBefore(p, from), out = '';
  for (const c of p.text.slice(from, to)) { if (c === P.OBJ) out += P.objectPlainText(p.objects?.[k++]); else out += c; }
  return out;
};
const flatJson = v => (v && typeof v === 'object' ? structuredClone(v) : v);

/** Read what an address names as 'text' | 'display' | 'runs' | 'props' | 'json'. */
export function read(content, ast, as = 'json') {
  if (!isQuill2(content)) {
    const r = legacyResolve(content, ast);
    if (as === 'text' || as === 'display') return r.text !== undefined ? r.text.slice(r.from, r.to) : typeof r.node === 'string' ? r.node : JSON.stringify(r.node);
    return genericResolver.read(content, ast);
  }
  const r = resolve(content, ast);
  const d = new Document(content);
  if (as === 'json') {
    if (r.kind === 'document') return {...content, body: {blocks: d.story(BODY).toArray()}};
    if (r.kind === 'text') return {text: r.node.text.slice(r.from, r.to), runs: runsOf(r.node, r.from, r.to)};
    return flatJson(r.node);
  }
  if (as === 'text' || as === 'display') {
    switch (r.kind) {
      case 'document': return d.plainText(BODY);
      case 'story': return d.plainText(r.story);
      case 'paragraph': return P.plainText(r.node);
      case 'text': case 'object': return shownText(r.node.kind === 'para' ? r.node : d.para(r.story, r.path), r.from, r.to);
      case 'table': case 'row': case 'cell': {
        const [a, b] = rangeOf(content, ast);
        return d.pathsBetween(a, b).map(p => P.plainText(d.para(a.story, p))).join('\n');
      }
      case 'bookmark': return r.node.name;
      default: return JSON.stringify(r.node);
    }
  }
  if (as === 'runs') {
    if (r.kind === 'paragraph') return runsOf(r.node, 0, r.node.text.length);
    if (r.kind === 'text') return runsOf(r.node, r.from, r.to);
    throw new CommandError('invalid_params', `runs are read from a paragraph or text range, not a ${r.kind}`, {path: '/as'});
  }
  if (as === 'props') {
    const tableStylePara = null;
    switch (r.kind) {
      case 'paragraph': return {direct: r.node.props ?? {}, mark: r.node.mark ?? {}, resolved: resolvePara(content.styles, r.node.props || {}, tableStylePara)};
      case 'text': {
        const c = P.propsOfChar(r.node, r.from);
        return {direct: c, resolved: resolveChar(content.styles, r.node.props?.style ?? null, c)};
      }
      case 'table': case 'row': case 'cell': return r.node.props ?? {};
      case 'section': case 'style': case 'list': case 'revision': return flatJson(r.node);
      default: throw new CommandError('invalid_params', `props are not read from a ${r.kind}`, {path: '/as'});
    }
  }
  throw new CommandError('invalid_params', `Quill reads text, display, runs, props or json, not ${as}`, {path: '/as'});
}

// --- enumerate / find -------------------------------------------------------------------------

const preview = s => (s.length > 80 ? s.slice(0, 80) + '…' : s);

/** Children of an address with their canonical addresses (document.inspect). */
export function enumerate(content, scope, {depth = 1, cursor, limit = 100} = {}) {
  if (!isQuill2(content)) return genericResolver.enumerate(content, scope, {depth, limit});
  const r = resolve(content, scope);
  const d = new Document(content);
  const start = Math.max(0, Number(cursor) || 0);
  const nodes = [];
  let more = false;
  const push = n => { if (nodes.length >= limit) { more = true; return false; } nodes.push(n); return true; };
  const blockNode = (story, path, b, dd) => {
    const address = blockAddress(content, story, path);
    if (b.kind === 'para') {
      const n = {address, kind: 'paragraph', text: preview(P.plainText(b)), length: b.text.length};
      if (b.props?.style) n.style = b.props.style;
      if (b.props?.numbering) n.list = b.props.numbering;
      if (b.section) n.section = `/sec:${b.section.id}`;
      if (b.objects?.length) n.objects = b.objects.length;
      return n;
    }
    const n = {address, kind: 'table', rows: b.rows.length, cols: b.grid.length};
    if (dd > 1) n.children = b.rows.map((row, ri) => ({address: `${address}/r:${row.id}`, kind: 'row',
      cells: row.cells.map((cell, ci) => ({address: `${address}/r:${row.id}/c:${cell.id}`, kind: 'cell',
        children: dd > 2 ? cell.blocks.map((x, k) => blockNode(story, [...path, ri, ci, k], x, dd - 2)) : undefined}))}));
    return n;
  };
  if (r.kind === 'document') {
    const stories = [{address: '/body', kind: 'story', blocks: d.story(BODY).len()}];
    for (const id of Object.keys(content.parts).map(Number).sort((a, b) => a - b)) {
      stories.push({address: kFormat({segments: [storySegment(content, id)]}), kind: content.parts[id].kind, blocks: content.parts[id].blocks.length});
    }
    for (const {section} of sectionList(content)) stories.push({address: `/sec:${section.id}`, kind: 'section'});
    stories.slice(start).every(push);
  } else if (r.kind === 'story') {
    const list = d.story(r.story);
    for (const [i, b] of list.entries(start)) if (!push(blockNode(r.story, [i], b, depth))) break;
  } else if (r.kind === 'table') {
    r.node.rows.slice(start).every((row, k) => push({address: `${r.address}/r:${row.id}`, kind: 'row', cells: row.cells.length, index: start + k}));
  } else if (r.kind === 'row') {
    r.node.cells.slice(start).every(cell => push({address: `${r.address}/c:${cell.id}`, kind: 'cell', blocks: cell.blocks.length, props: cell.props ?? {}}));
  } else if (r.kind === 'cell') {
    r.node.blocks.slice(start).every((b, k) => push(blockNode(r.story, [...r.path, start + k], b, depth)));
  } else if (r.kind === 'paragraph') {
    let k = 0;
    for (const run of runsOf(r.node, 0, r.node.text.length)) {
      if (k++ < start) continue;
      if (!push({address: `${r.address}/t:${run.from}-${run.to}`, kind: 'run', text: preview(run.text), props: run.props})) break;
    }
    for (const [off, o] of P.objectsWithOffsets(r.node)) {
      if (k++ < start) continue;
      if (!push({address: `${r.address}/o:${o.oid}`, kind: o.type, offset: off})) break;
    }
  }
  const out = {nodes};
  if (more) out.cursor = String(start + nodes.length);
  return out;
}

/** Text search over paragraphs: {matches: [{address, from, to, text, context}], truncated, scope}. */
export function find(content, {query, scope, regex = false, matchCase = false, wholeWord = false, limit = 100}) {
  let source = regex ? query : String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord) source = `\\b(?:${source})\\b`;
  let re;
  try { re = new RegExp(source, 'g' + (matchCase ? '' : 'i') + 'u'); } catch (e) {
    throw new CommandError('invalid_params', `query is not a valid regular expression: ${e instanceof Error ? e.message : e}`, {path: '/query'});
  }
  const matches = [];
  const scan = (text, addr) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) && matches.length < limit) {
      if (!m[0].length) { re.lastIndex++; continue; }
      matches.push({address: `${addr}/t:${m.index}-${m.index + m[0].length}`, from: m.index, to: m.index + m[0].length, text: m[0],
        context: text.slice(Math.max(0, m.index - 40), Math.min(text.length, m.index + m[0].length + 40))});
    }
  };
  const scopeAddr = scope ? kFormat(scope) : '/';
  if (!isQuill2(content)) {
    const walk = (node, path) => {
      if (matches.length >= limit || !node) return;
      if (['paragraph', 'heading', 'codeBlock'].includes(node.type)) {
        scan((node.content || []).map(n => (n.type === 'text' ? String(n.text ?? '') : P.OBJ)).join(''), `/body/b:${path.join('.')}`);
        return;
      }
      (node.content || []).forEach((c, i) => walk(c, [...path, i]));
    };
    (content.doc?.content || []).forEach((c, i) => walk(c, [i]));
    return {matches, truncated: matches.length >= limit, scope: scopeAddr};
  }
  const d = new Document(content);
  const r = scope && scope.segments?.length ? resolve(content, scope) : {kind: 'document'};
  const stories = r.kind === 'document' ? [BODY, ...Object.keys(content.parts).map(Number)] : [r.story];
  for (const story of stories) {
    if (matches.length >= limit) break;
    const paths = d.paraPaths(story).filter(p => !r.path || r.kind === 'story' || (p.length >= r.path.length && r.path.every((x, i) => p[i] === x)));
    for (const path of paths) {
      if (matches.length >= limit) break;
      scan(d.para(story, path).text, blockAddress(content, story, path));
    }
  }
  return {matches, truncated: matches.length >= limit, scope: scopeAddr};
}

// --- change mapping ---------------------------------------------------------------------------

/** Steps (ops.mjs) for a raw kernel op on schema-2 content (a command that wrote paths directly). */
function rawSteps(op) {
  const before = [], after = [];
  if (op.op === 'set') { before.push(op.old); after.push(op.value); }
  else if (op.op === 'delete') before.push(op.old);
  else if (op.op === 'splice') { before.push(...(op.removed || [])); after.push(...(op.items || [])); }
  const collect = (vals, ids, paras) => {
    const stack = [...vals];
    while (stack.length) {
      const v = stack.pop();
      if (!v || typeof v !== 'object') continue;
      if (Array.isArray(v)) { stack.push(...v); continue; }
      if (typeof v.id === 'string') ids.add(v.id);
      if (typeof v.oid === 'string') ids.add(v.oid);
      if (v.kind === 'para' && typeof v.id === 'string') paras.set(v.id, v);
      for (const k of ['chunks', 'blocks', 'rows', 'cells', 'objects', 'children', 'obj', 'section']) if (v[k]) stack.push(v[k]);
    }
  };
  const oldIds = new Set(), newIds = new Set(), oldParas = new Map(), newParas = new Map();
  collect(before, oldIds, oldParas);
  collect(after, newIds, newParas);
  const steps = [];
  for (const [id, p] of newParas) {
    const q = oldParas.get(id);
    const diff = q && textDiff(q.text, p.text);
    if (diff) steps.push({k: 'text', id, at: diff[0], del: diff[1], ins: diff[2]});
  }
  const removed = [...oldIds].filter(id => !newIds.has(id));
  if (removed.length) steps.push({k: 'remove', ids: removed});
  return steps;
}

/** Map an offset through a text step; `assoc` -1 keeps a position at an insertion point before it. */
function mapOffset(off, s, assoc) {
  if (off < s.at) return off;
  if (off > s.at + s.del) return off + s.ins - s.del;
  if (off === s.at + s.del && (s.del > 0 || assoc > 0)) return off + s.ins - s.del;
  return s.at;
}

/** Map a classified flow address through steps; returns the new ast or {deleted, nearest}. */
function mapFlow(ast, cls, steps) {
  let chain = cls.chain.map(c => ({...c}));
  let text = cls.text ? {...cls.text} : null;
  const obj = cls.obj;
  const storySeg = ast.segments[0];
  const build = () => ({segments: [storySeg, ...chain, ...(text ? [seg('t', text.from === text.to ? text.from : `${text.from}-${text.to}`)] : []),
    ...(obj ? [seg('o', obj)] : [])]});
  for (const s of steps) {
    const li = chain.length - 1;
    const last = chain[li];
    if (s.k === 'remove') {
      const ids = s.ids instanceof Set ? s.ids : new Set(s.ids);
      const gone = chain.findIndex(c => ids.has(c.key));
      // The nearest is what held the removed block, row or cell (the story for a top-level block).
      if (gone >= 0) return {deleted: true, nearest: {segments: [storySeg, ...chain.slice(0, gone)]}};
      if (obj && ids.has(obj)) return {deleted: true, nearest: {segments: [storySeg, ...chain]}};
      continue;
    }
    if (!last || last.kind !== 'b') continue;
    if (s.k === 'text' && s.id === last.key) {
      if (text) {
        if (text.from === text.to) { const o = mapOffset(text.from, s, 1); text = {from: o, to: o}; }
        else {
          const from = mapOffset(text.from, s, -1), to = mapOffset(text.to, s, 1);
          text = {from, to: Math.max(from, to)};
        }
      }
    } else if (s.k === 'split' && s.id === last.key) {
      // What follows the split point moves to the new paragraph; a range across it keeps its head.
      if (text) {
        if (text.from >= s.at) {
          chain[li] = seg('b', s.into);
          text = {from: text.from - s.at, to: text.to - s.at};
        } else if (text.to > s.at) text = {from: text.from, to: s.at};
      }
    } else if (s.k === 'join' && s.id === last.key) {
      chain[li] = seg('b', s.into);
      if (text) text = {from: text.from + s.at, to: text.to + s.at};
      else if (!obj) return {deleted: true, nearest: {segments: [storySeg, ...chain]}};
    }
  }
  return build();
}

/** Map an address through one content op (sticky anchors, the selection after a command). */
export function mapThrough(op, ast) {
  if (!op || !ast?.segments) return ast;
  let cls;
  try { cls = classify(ast); } catch { return ast; }
  if (op.op === 'app') {
    if (op.forward?.type !== OP_TYPE || cls.kind !== 'flow') return ast;
    return mapFlow(ast, cls, op.forward.steps || []);
  }
  if (op.path?.[0] === 'doc' || cls.kind !== 'flow') return genericResolver.mapThrough(op, ast);
  return mapFlow(ast, cls, rawSteps(op));
}

/** Addresses of what a list of content ops changed (doc.changed events). */
export function changed(ops, content) {
  const out = new Set();
  const d = isQuill2(content) ? new Document(content) : null;
  for (const op of ops) {
    if (op.op !== 'app' || op.forward?.type !== OP_TYPE) {
      out.add(op.path?.length ? kFormat({segments: op.path.map(k => ({kind: String(k)}))}) : '/');
      continue;
    }
    for (const c of op.forward.changed || []) {
      if (c.field) out.add(c.field === 'lastSection' && content?.lastSection?.id ? `/sec:${content.lastSection.id}` : `/${c.field}`);
      else if (c.id && d) {
        const i = bodyIndexOf(content.body, c.id);
        if (i >= 0) out.add(`/body/b:${c.id}`);
      } else if (c.story !== undefined && c.story !== BODY && d && content.parts[c.story]) out.add(kFormat({segments: [storySegment(content, c.story)]}));
    }
  }
  return [...out];
}
