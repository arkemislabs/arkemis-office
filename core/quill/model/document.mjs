// The Quill document: stories, positions, paths, sections, parts, text walks, text boxes, media,
// custom properties, permission ranges and bookmarks, with copy-on-write editing that emits one
// kernel app op (ops.mjs) per commit.
// Translated from wordcraft crates/doc/src/document.rs, position.rs, text_walk.rs, block.rs and
// error.rs at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// `new Document(content)` wraps immutable schema-2 content. Reads see the current state; every
// write copies only what it touches (upstream: `Arc::make_mut`), so unchanged chunks, parts and
// blocks stay shared with the content passed in. `takeOp()` returns the app op that turns the
// starting content into the current one (with its inverse computed by schema.apply), and starts
// a new round. Positions are `{story, path, off}`: `story` is 'body' or a part id; `path` indexes
// blocks (`[block]`, `[table, row, cell, block]`, three more per nesting level; top-level body
// indexes are global across chunks); `off` is a UTF-16 offset in the paragraph.
// No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {newId} from './ids.mjs';
import * as P from './para.mjs';
import {defaultSection, absorb, sectionOf} from './section.mjs';
import {createContent, contentFromText, MAX_LINKED_BOXES, BoxBudget, part as makePart} from './content.mjs';
import {freeId, Counters} from './numbering.mjs';
import {resolvePara} from './styles.mjs';
import {CHUNK_MAX, CHUNK_SIZE, deepIds, collectIds, bodyFromBlocks} from './body.mjs';
import {countWords} from './text.mjs';
import {same} from './props.mjs';
import {buildOp} from './ops.mjs';
import {installEdit, appendPiece} from './edit.mjs';
import {installRanges} from './ranges.mjs';

export const BODY = 'body';

// --- errors (error.rs) ----------------------------------------------------------------------

export const badPath = path => new CommandError('not_found', `no paragraph at ${Array.isArray(path) ? path.join('/') : path}`, {path});
export const badStory = s => new CommandError('not_found', `no story ${s === BODY ? 'Body' : `Part(${s})`}`, {story: s});
export const invalid = msg => new CommandError('failed', msg);

// --- positions (position.rs) ----------------------------------------------------------------

/** Lexicographic order of paths = document order. */
export function cmpPath(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
const storyRank = s => (s === BODY ? -1 : Number(s));
export const cmpStory = (a, b) => storyRank(a) - storyRank(b);
/** Positions compare by story, then path, then offset. */
export const cmpPos = (a, b) => cmpStory(a.story, b.story) || cmpPath(a.path, b.path) || a.off - b.off;
export const samePath = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
export const samePos = (a, b) => a.story === b.story && samePath(a.path, b.path) && a.off === b.off;
export const makePos = (story, path, off) => ({story, path: [...path], off});
export const bodyPos = (block, off) => ({story: BODY, path: [block], off});
export const pathLast = path => path[path.length - 1] ?? 0;
export const pathWithLast = (path, i) => (path.length ? [...path.slice(0, -1), i] : [i]);
export const pathParent = path => path.slice(0, -1);
/** Nesting depth (0 = top-level story block). */
export const pathDepth = path => Math.floor(Math.max(0, path.length - 1) / 3);
/** The enclosing table cell [tablePath, row, cell], or null. */
export function pathCell(path) {
  if (path.length < 4) return null;
  const n = path.length;
  return [path.slice(0, n - 3), path[n - 3], path[n - 2]];
}
const order = (a, b) => (cmpPos(a, b) <= 0 ? [a, b] : [b, a]);
export {order as orderPos};

// --- block lists ----------------------------------------------------------------------------

/** A plain array of blocks (parts, cells). Mutations apply only to arrays the document owns. */
class ArrayList {
  constructor(a) { this.a = a; }
  len() { return this.a.length; }
  get(i) { return this.a[i]; }
  set(i, b) { this.a[i] = b; }
  insert(i, b) { this.a.splice(i, 0, b); }
  remove(i) { return this.a.splice(i, 1)[0]; }
  splice(i, n, items = []) { return this.a.splice(i, n, ...items); }
  push(b) { this.a.push(b); }
  last() { return this.a[this.a.length - 1]; }
  *entries(from = 0) { for (let i = from; i < this.a.length; i++) yield [i, this.a[i]]; }
  *reversed() { for (let i = this.a.length - 1; i >= 0; i--) yield [i, this.a[i]]; }
  toArray() { return this.a.slice(); }
}

/** The chunked body as one list (body.mjs). */
class BodyList {
  constructor(doc) { this.doc = doc; }
  get chunks() { return this.doc.c.body.chunks; }
  starts() {
    const d = this.doc;
    if (d._starts && d._startsVer === d._bodyVer && d._startsOf === d.c.body.chunks) return d._starts;
    const ch = this.chunks;
    const s = new Array(ch.length + 1);
    s[0] = 0;
    for (let i = 0; i < ch.length; i++) s[i + 1] = s[i] + ch[i].length;
    d._starts = s; d._startsVer = d._bodyVer; d._startsOf = ch;
    return s;
  }
  len() { const s = this.starts(); return s[s.length - 1]; }
  locate(i) {
    const s = this.starts();
    let lo = 0, hi = this.chunks.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid] <= i) lo = mid; else hi = mid - 1; }
    return [lo, i - s[lo]];
  }
  get(i) {
    if (!Number.isInteger(i) || i < 0 || i >= this.len()) return undefined;
    const [c, k] = this.locate(i);
    return this.chunks[c][k];
  }
  set(i, b) { const [c, k] = this.locate(i); this.doc._ownChunk(c)[k] = b; }
  insert(i, b) { this.splice(i, 0, [b]); }
  push(b) { this.splice(this.len(), 0, [b]); }
  remove(i) { return this.splice(i, 1)[0]; }
  last() { const n = this.len(); return n ? this.get(n - 1) : undefined; }
  /** Splice across chunks: remove `n` blocks at `i` and insert `items` there. */
  splice(i, n, items = []) {
    const d = this.doc;
    const total = this.len();
    i = Math.max(0, Math.min(i, total));
    n = Math.max(0, Math.min(n, total - i));
    if (!n && !items.length) return [];
    d._ownBody();
    const removed = [];
    let [c, k] = this.locate(i);
    let left = n;
    while (left > 0) {
      const chunk = d._ownChunk(c);
      const take = Math.min(left, chunk.length - k);
      removed.push(...chunk.splice(k, take));
      left -= take;
      if (left > 0) { c += 1; k = 0; }
    }
    d._bodyVer++;
    [c, k] = this.locate(Math.min(i, this.len()));
    const target = d._ownChunk(c);
    target.splice(k, 0, ...items);
    const chunks = d.c.body.chunks;
    // Rebalance: split oversized chunks, drop empty ones (keeping at least one).
    for (let ci = chunks.length - 1; ci >= 0; ci--) {
      const ch = chunks[ci];
      if (ch.length > CHUNK_MAX) {
        const parts = [];
        for (let a = 0; a < ch.length; a += CHUNK_SIZE) { const piece = ch.slice(a, a + CHUNK_SIZE); d.owned.add(piece); parts.push(piece); }
        chunks.splice(ci, 1, ...parts);
      } else if (!ch.length && chunks.length > 1) chunks.splice(ci, 1);
    }
    d._bodyVer++;
    return removed;
  }
  *entries(from = 0) {
    let idx = 0;
    for (const ch of this.chunks) {
      if (idx + ch.length <= from) { idx += ch.length; continue; }
      for (let k = Math.max(0, from - idx); k < ch.length; k++) yield [idx + k, ch[k]];
      idx += ch.length;
    }
  }
  *reversed() {
    const s = this.starts();
    for (let c = this.chunks.length - 1; c >= 0; c--) {
      const ch = this.chunks[c];
      for (let k = ch.length - 1; k >= 0; k--) yield [s[c] + k, ch[k]];
    }
  }
  toArray() { return this.chunks.flat(); }
}

/** Every paragraph of a block, in document order, however deep its tables nest (each_para). */
export function eachPara(b, f) {
  if (b.kind === 'para') { f(b); return; }
  const todo = [b];
  while (todo.length) {
    const x = todo.pop();
    if (x.kind === 'para') { f(x); continue; }
    const rows = x.rows || [];
    for (let r = rows.length - 1; r >= 0; r--) {
      const cells = rows[r].cells || [];
      for (let c = cells.length - 1; c >= 0; c--) for (let k = cells[c].blocks.length - 1; k >= 0; k--) todo.push(cells[c].blocks[k]);
    }
  }
}

/** A copy of block `b` with `f` applied to every paragraph (each_para_mut); f returns the new paragraph or undefined. */
export function mapParas(b, f) {
  if (b.kind === 'para') return f(b) ?? b;
  let changed = false;
  const rows = b.rows.map(row => {
    let rowChanged = false;
    const cells = row.cells.map(cell => {
      let cellChanged = false;
      const blocks = cell.blocks.map(x => { const y = mapParas(x, f); if (y !== x) cellChanged = true; return y; });
      if (!cellChanged) return cell;
      rowChanged = true;
      return {...cell, blocks};
    });
    if (!rowChanged) return row;
    changed = true;
    return {...row, cells};
  });
  return changed ? {...b, rows} : b;
}

/** How deep in nested tables the paragraph walk goes (PARA_WALK_DEPTH). */
export const PARA_WALK_DEPTH = 16;

function walk(list, prefix, out, depth) {
  if (depth > PARA_WALK_DEPTH) return;
  for (const [i, b] of list.entries()) {
    prefix.push(i);
    if (b.kind === 'para') out.push(prefix.slice());
    else {
      b.rows.forEach((row, r) => row.cells.forEach((cell, c) => {
        prefix.push(r, c);
        walk(new ArrayList(cell.blocks), prefix, out, depth + 1);
        prefix.pop(); prefix.pop();
      }));
    }
    prefix.pop();
  }
}

/** walk() for the paragraphs from path `a` to `b` inclusive (walk_between). */
function walkBetween(list, prefix, out, depth, a, b) {
  if (depth > PARA_WALK_DEPTH) return;
  const side = (q, x) => { const m = Math.min(q.length, x.length); return cmpPath(q.slice(0, m), x.slice(0, m)); };
  const from = prefix.length < a.length && cmpPath(prefix, a.slice(0, prefix.length)) === 0 ? a[prefix.length] : 0;
  for (const [i, blk] of list.entries(Math.max(0, from))) {
    prefix.push(i);
    if (side(prefix, b) > 0) { prefix.pop(); break; }
    if (side(prefix, a) >= 0) {
      if (blk.kind === 'para') {
        if (cmpPath(prefix, a) >= 0 && cmpPath(prefix, b) <= 0) out.push(prefix.slice());
      } else {
        blk.rows.forEach((row, r) => row.cells.forEach((cell, c) => {
          prefix.push(r, c);
          if (side(prefix, a) >= 0 && side(prefix, b) <= 0) walkBetween(new ArrayList(cell.blocks), prefix, out, depth + 1, a, b);
          prefix.pop(); prefix.pop();
        }));
      }
    }
    prefix.pop();
  }
}

/** Which text of a paragraph textOf collects: 'plain', 'final'. */
function textOf(list, out, depth, mode) {
  if (depth > 16) return;
  for (const [, b] of list.entries()) {
    if (b.kind === 'para') {
      out.push((mode === 'final' ? P.finalText(b) : P.plainText(b)) + '\n');
    } else {
      for (const row of b.rows) {
        const cells = row.cells.map(c => {
          const s = [];
          textOf(new ArrayList(c.blocks), s, depth + 1, mode);
          return s.join('').replace(/\n+$/, '').replace(/\n/g, ' ');
        });
        out.push(cells.join('\t') + '\n');
      }
    }
  }
}

function storyWordCountOf(list, numbering, styles, counters, depth) {
  if (depth > 16) return 0;
  let total = 0;
  for (const [, b] of list.entries()) {
    if (b.kind === 'para') {
      let n = b.props?.numbering ?? resolvePara(styles, b.props || {}).numbering;
      if (n && n.num === 0) n = null;
      if (n) {
        const got = counters.nextLabel(numbering, n.num, n.level);
        if (got && got[1].format !== 'bullet' && got[1].format !== 'none') total += countWords(got[0]);
      }
      total += countWords(P.plainText(b));
    } else {
      for (const row of b.rows) for (const c of row.cells) total += storyWordCountOf(new ArrayList(c.blocks), numbering, styles, counters, depth + 1);
    }
  }
  return total;
}

/** The note and text box stories an object shows, for reachable(). */
export function notesAndBoxes(o) {
  if (o?.type === 'noteRef') return [[o.id, ['footnote', 'endnote']]];
  return P.textBoxesOf(o).map(id => [id, ['textBox']]);
}

const partIds = parts => Object.keys(parts).map(Number).sort((a, b) => a - b);
/** Key order of a BTreeMap<String, _> (byte order of UTF-8 = code point order). */
const cmpKeys = (a, b) => { const x = [...a], y = [...b]; for (let i = 0; i < Math.min(x.length, y.length); i++) { const d = x[i].codePointAt(0) - y[i].codePointAt(0); if (d) return d; } return x.length - y.length; };

// --- the document ---------------------------------------------------------------------------

export class Document {
  /** Wrap schema-2 content (never changed: edits copy what they touch). */
  constructor(content) {
    if (!content || !content.body || !Array.isArray(content.body.chunks)) throw invalid('Not Quill schema-2 content');
    this.base = content;
    this.c = content;
    this.owned = new WeakSet();
    this.steps = [];
    this._fresh = new Set();
    this._bodyVer = 0;
  }

  /** A blank document (Document::new). */
  static create() { return new Document(createContent()); }
  /** A document from plain text, one paragraph per line (Document::from_text). */
  static fromText(text) { return new Document(contentFromText(text)); }

  /** The current content (immutable to callers). */
  get content() { return this.c; }
  get styles() { return this.c.styles; }
  get numbering() { return this.c.numbering; }
  get settings() { return this.c.settings; }
  get parts() { return this.c.parts; }
  get lastSection() { return this.c.lastSection; }

  // --- ownership (copy on write) -----------------------------------------------------------

  _own(o) {
    if (this.owned.has(o)) return o;
    const c = Array.isArray(o) ? o.slice() : {...o};
    this.owned.add(c);
    return c;
  }
  _ownContent() { if (!this.owned.has(this.c)) { this.c = {...this.c}; this.owned.add(this.c); } return this.c; }
  /** Replace a top-level field (styles, numbering, settings, ...). */
  setField(key, value) { if (key === 'media') this._mediaIndex = null; this._ownContent()[key] = value; }
  /** Change a top-level field: `f(copy)` may mutate the owned copy or return a new value. */
  updateField(key, f) {
    if (key === 'media') this._mediaIndex = null;
    const c = this._ownContent();
    const cur = this._own(c[key]);
    c[key] = cur;
    const r = f(cur);
    if (r !== undefined) c[key] = r;
    return c[key];
  }
  _ownBody() {
    const c = this._ownContent();
    if (!this.owned.has(c.body)) {
      c.body = {...c.body, chunks: c.body.chunks.slice()};
      this.owned.add(c.body);
      this._bodyVer++;
    }
    return c.body;
  }
  _ownChunk(ci) {
    const body = this._ownBody();
    if (!this.owned.has(body.chunks[ci])) { body.chunks[ci] = body.chunks[ci].slice(); this.owned.add(body.chunks[ci]); this._bodyVer++; }
    return body.chunks[ci];
  }
  _ownParts() {
    const c = this._ownContent();
    if (!this.owned.has(c.parts)) { c.parts = {...c.parts}; this.owned.add(c.parts); }
    return c.parts;
  }
  _ownPart(id) {
    const parts = this._ownParts();
    const p = parts[id];
    if (!p) throw badStory(id);
    if (!this.owned.has(p)) { const q = {...p, blocks: p.blocks.slice()}; this.owned.add(q); this.owned.add(q.blocks); parts[id] = q; }
    return parts[id];
  }

  // --- ids -----------------------------------------------------------------------------------

  /** Whether any block, row, cell, object or section of the document (as started) or made since uses `id`. */
  hasId(id) {
    if (this._fresh.has(id)) return true;
    for (const ch of this.base.body.chunks) if (deepIds(ch).has(id)) return true;
    for (const p of Object.values(this.base.parts)) if (deepIds(p.blocks).has(id)) return true;
    if (this.base.lastSection?.id === id || this.c.lastSection?.id === id) return true;
    return false;
  }
  /** A fresh id no part of the document uses. */
  newId() {
    let id = newId();
    while (this.hasId(id)) id = newId();
    this._fresh.add(id);
    return id;
  }
  /** Give every block, row, cell, object and section in `b` a fresh id; returns the new block. */
  freshIds(b) {
    const mk = () => this.newId();
    return reId(b, mk);
  }
  /** `b` with fresh ids only where an id is missing or already used in the document. */
  _adoptIds(b) {
    const seen = new Set();
    const need = id => !id || seen.has(id) || this.hasId(id);
    const fix = id => { const v = need(id) ? this.newId() : id; seen.add(v); this._fresh.add(v); return v; };
    return reId(b, fix, true);
  }

  // --- stories and blocks --------------------------------------------------------------------

  /** A story's block list (read), or null. */
  story(s) {
    if (s === BODY) return new BodyList(this);
    const p = this.c.parts[s];
    return p ? new ArrayList(p.blocks) : null;
  }
  /** A story's block list to change. */
  storyMut(s) {
    if (s === BODY) { this._ownBody(); return new BodyList(this); }
    return new ArrayList(this._ownPart(s).blocks);
  }
  /** The block list that contains the block at `path` (read), or null. */
  container(s, path) {
    let bl = this.story(s);
    if (!bl) return null;
    const parent = pathParent(path);
    if (parent.length % 3 !== 0) return null;
    for (let i = 0; i < parent.length; i += 3) {
      const t = bl.get(parent[i]);
      if (!t || t.kind !== 'table') return null;
      const cell = t.rows[parent[i + 1]]?.cells[parent[i + 2]];
      if (!cell) return null;
      bl = new ArrayList(cell.blocks);
    }
    return bl;
  }
  /** The block list that contains the block at `path`, owned for changing. */
  containerMut(s, path) {
    const bad = () => badPath(path);
    const parent = pathParent(path);
    if (parent.length % 3 !== 0) throw bad();
    if (!this.story(s)) throw badStory(s);
    let bl = this.storyMut(s);
    for (let i = 0; i < parent.length; i += 3) {
      const [b, r, c] = [parent[i], parent[i + 1], parent[i + 2]];
      let t = bl.get(b);
      if (!t || t.kind !== 'table') throw bad();
      if (!t.rows[r]?.cells[c]) throw bad();
      if (!this.owned.has(t)) { t = {...t, rows: t.rows.slice()}; this.owned.add(t); bl.set(b, t); }
      let row = t.rows[r];
      if (!this.owned.has(row)) { row = {...row, cells: row.cells.slice()}; this.owned.add(row); t.rows[r] = row; }
      let cell = row.cells[c];
      if (!this.owned.has(cell)) { cell = {...cell, blocks: cell.blocks.slice()}; this.owned.add(cell); row.cells[c] = cell; }
      bl = new ArrayList(cell.blocks);
    }
    return bl;
  }
  block(s, path) { return this.container(s, path)?.get(pathLast(path)) ?? null; }
  para(s, path) { const b = this.block(s, path); return b?.kind === 'para' ? b : null; }
  paraAt(p) { return this.para(p.story, p.path); }
  table(s, path) { const b = this.block(s, path); return b?.kind === 'table' ? b : null; }
  /** The paragraph at `path`, owned for changing with the para.mjs functions. */
  paraMut(s, path) {
    const i = pathLast(path);
    const bl = this.containerMut(s, path);
    let p = bl.get(i);
    if (!p || p.kind !== 'para') throw badPath(path);
    if (!this.owned.has(p)) { p = {...p}; this.owned.add(p); bl.set(i, p); }
    return p;
  }
  /** Replace the table at `path` with `f(table)` (table.mjs functions return new tables). */
  updateTable(s, path, f) {
    const i = pathLast(path);
    const bl = this.containerMut(s, path);
    const t = bl.get(i);
    if (!t || t.kind !== 'table') throw badPath(path);
    const next = f(t);
    if (next && next !== t) bl.set(i, next);
    return bl.get(i);
  }
  /** Replace the block at `path`. */
  setBlock(s, path, block) {
    const bl = this.containerMut(s, path);
    const i = pathLast(path);
    if (i >= bl.len()) throw badPath(path);
    bl.set(i, block);
  }

  /** Paths of every paragraph in a story, in document order (tables descended, depth-limited). */
  paraPaths(s) {
    const out = [];
    const bl = this.story(s);
    if (bl) walk(bl, [], out, 0);
    return out;
  }
  _firstParaPath(s) {
    const bl = this.story(s);
    if (!bl) return null;
    const go = (list, prefix, depth) => {
      if (depth > PARA_WALK_DEPTH) return null;
      for (const [i, b] of list.entries()) {
        if (b.kind === 'para') return [...prefix, i];
        for (let r = 0; r < b.rows.length; r++) for (let c = 0; c < b.rows[r].cells.length; c++) {
          const got = go(new ArrayList(b.rows[r].cells[c].blocks), [...prefix, i, r, c], depth + 1);
          if (got) return got;
        }
      }
      return null;
    };
    return go(bl, [], 0);
  }
  _lastParaPath(s) {
    const bl = this.story(s);
    if (!bl) return null;
    const go = (list, prefix, depth) => {
      if (depth > PARA_WALK_DEPTH) return null;
      for (const [i, b] of list.reversed()) {
        if (b.kind === 'para') return [...prefix, i];
        for (let r = b.rows.length - 1; r >= 0; r--) for (let c = b.rows[r].cells.length - 1; c >= 0; c--) {
          const got = go(new ArrayList(b.rows[r].cells[c].blocks), [...prefix, i, r, c], depth + 1);
          if (got) return got;
        }
      }
      return null;
    };
    return go(bl, [], 0);
  }
  /** First position of a story. */
  startOf(s) { return {story: s, path: this._firstParaPath(s) ?? [0], off: 0}; }
  /** Last position of a story. */
  endOf(s) {
    const path = this._lastParaPath(s) ?? [0];
    return {story: s, path, off: this.para(s, path)?.text.length ?? 0};
  }

  /** The position just after the shape that owns text box story `part`. */
  textBoxAnchor(part) {
    const stories = [BODY, ...partIds(this.c.parts).filter(k => k !== part)];
    for (const story of stories) {
      for (const path of this.paraPaths(story)) {
        const p = this.para(story, path);
        if (!p) continue;
        for (const [off, o] of P.objectsWithOffsets(p)) if (P.textBoxesOf(o).includes(part)) return {story, path, off: off + 1};
      }
    }
    return null;
  }

  /** The next paragraph path in document order (null at the end). */
  nextPara(s, path) {
    const all = this.paraPaths(s);
    const i = all.findIndex(p => samePath(p, path));
    return i >= 0 ? all[i + 1] ?? null : null;
  }
  prevPara(s, path) {
    const all = this.paraPaths(s);
    const i = all.findIndex(p => samePath(p, path));
    return i > 0 ? all[i - 1] : null;
  }

  /** Clamp a position into the document (valid path, character boundary). */
  clamp(p) {
    const para = this.paraAt(p);
    if (para) return {story: p.story, path: [...p.path], off: P.clampOff(para, p.off)};
    const story = this.story(p.story) ? p.story : BODY;
    const all = this.paraPaths(story);
    let path = null;
    for (let i = all.length - 1; i >= 0; i--) if (cmpPath(all[i], p.path) <= 0) { path = all[i]; break; }
    path = path ?? all[0] ?? [0];
    const q = this.para(story, path);
    return {story, path, off: q ? P.clampOff(q, p.off) : 0};
  }

  /** The whole text of a story, paragraphs separated by \n (table cells by \t). */
  plainText(s) { return this._storyText(s, 'plain'); }
  /** plainText without tracked-deleted runs. */
  finalText(s) { return this._storyText(s, 'final'); }
  _storyText(s, mode) {
    const out = [];
    const bl = this.story(s);
    if (bl) textOf(bl, out, 0, mode);
    const t = out.join('');
    return t.endsWith('\n') ? t.slice(0, -1) : t;
  }

  /** Every story must hold at least one paragraph, and every cell too (ensure_nonempty). */
  ensureNonempty() {
    this._fixStoryBlocks();
    for (const id of partIds(this.c.parts)) {
      if (!this.c.parts[id].blocks.length) this._ownPart(id).blocks.push(P.newParagraph(this.newId()));
    }
  }
  _fixStoryBlocks() {
    const bl = this.story(BODY);
    const last = bl.last();
    let anyPara = false;
    for (const [, b] of bl.entries()) if (b.kind === 'para') { anyPara = true; break; }
    if (!anyPara || last?.kind === 'table') this.storyMut(BODY).push(P.newParagraph(this.newId()));
    const fix = cells => cells.blocks.length === 0 || cells.blocks[cells.blocks.length - 1].kind === 'table';
    for (const [i, b] of [...this.story(BODY).entries()]) {
      if (b.kind !== 'table') continue;
      if (!b.rows.some(r => r.cells.some(fix))) continue;
      this.updateTable(BODY, [i], t => ({...t, rows: t.rows.map(r => ({...r, cells: r.cells.map(c => (fix(c)
        ? {...c, blocks: [...c.blocks, P.newParagraph(this.newId())]} : c))}))}));
    }
  }

  /** Whether this document holds the same content as `other` (same_content). */
  sameContent(other) {
    const a = this.c, b = other instanceof Document ? other.c : other;
    return same(a, b);
  }

  // --- sections ------------------------------------------------------------------------------

  /** Section properties per section: [[index of the body block that ends it, section]]. */
  sections() {
    const v = [];
    const bl = this.story(BODY);
    for (const [i, b] of bl.entries()) if (b.kind === 'para' && b.section) v.push([i, b.section]);
    v.push([Math.max(0, bl.len() - 1), this.c.lastSection]);
    return v;
  }
  /** The footnote or endnote options in effect in section `sect` (note_options). */
  noteOptions(sect, endnote) {
    const own = (endnote ? sect.endnotePr : sect.footnotePr) || {};
    const doc = (endnote ? this.c.settings.endnotePr : this.c.settings.footnotePr) || {};
    const fmt = endnote ? this.c.settings.endnoteFormat : this.c.settings.footnoteFormat;
    let pos = own.pos ?? doc.pos ?? null;
    if (endnote) pos = pos === 'sectEnd' || pos === 'docEnd' ? pos : 'docEnd';
    else pos = pos === 'pageBottom' || pos === 'beneathText' ? pos : 'pageBottom';
    return {pos, numFmt: own.numFmt ?? fmt, numStart: Math.max(1, Math.min(32_767, own.numStart ?? doc.numStart ?? 1)),
      numRestart: own.numRestart ?? doc.numRestart ?? 'continuous'};
  }
  /** The section (index into sections()) that contains top-level body block `block`. */
  sectionIndexOf(block) {
    const s = this.sections();
    const i = s.findIndex(([end]) => block <= end);
    return i < 0 ? 0 : i;
  }
  /** The section properties of the section containing body block `block` (read). */
  sectionOfBlock(block) {
    const s = this.sections();
    const i = s.findIndex(([end]) => block <= end);
    return (i < 0 ? s[s.length - 1] : s[i])[1];
  }
  /** Change the section containing body block `block` (section_mut): `f(copy)` may mutate or return. */
  updateSection(block, f) {
    const ends = this.sections().map(([e]) => e);
    let idx = ends.findIndex(e => block <= e);
    if (idx < 0) idx = ends.length - 1;
    const apply = cur => { const copy = {...cur}; const r = f(copy); return r === undefined ? copy : r; };
    if (idx + 1 < ends.length) {
      const e = ends[idx];
      const p = this.paraMut(BODY, [e]);
      if (p.section) { p.section = apply(p.section); return p.section; }
    }
    this._ownContent().lastSection = apply(this.c.lastSection);
    return this.c.lastSection;
  }
  /** Remove the section break on body paragraph `block`; its section joins the next (remove_section_break). */
  removeSectionBreak(block) {
    const b = this.story(BODY).get(block);
    if (!b || b.kind !== 'para' || !b.section) return false;
    const p = this.paraMut(BODY, [block]);
    const before = p.section;
    delete p.section;
    this.updateSection(block, s => absorb(s, before));
    return true;
  }
  /** The section with stable id `id` and where it is: {section, end} (end null for the last). */
  sectionById(id) {
    for (const [end, s] of this.sections()) if (s.id === id) return {section: s, end: s === this.c.lastSection ? null : end};
    return null;
  }

  // --- parts ---------------------------------------------------------------------------------

  /** Allocate a part id and insert a part (add_part); returns its id (0 when ids run out). */
  addPart(kind, blocks = []) {
    try { return this.tryAddPart(kind, blocks); } catch { return 0; }
  }
  tryAddPart(kind, blocks = []) {
    const ids = partIds(this.c.parts);
    const id = freeId(ids.length ? ids[ids.length - 1] : null, ids, 1);
    if (id === null) throw invalid('no free part id');
    const bl = blocks.map(b => this._adoptIds(b));
    if (!bl.length) bl.push(P.newParagraph(this.newId()));
    this._ownParts()[id] = makePart(kind, bl);
    this.owned.add(this.c.parts[id]);
    return id;
  }
  /** Remove a part (its stories' references are the caller's to drop). */
  removePart(id) {
    if (!this.c.parts[id]) return false;
    delete this._ownParts()[id];
    return true;
  }
  /** Change a part's text body (text boxes). */
  setTextBody(id, body) {
    const p = this._ownPart(id);
    p.body = body;
  }

  // --- words ---------------------------------------------------------------------------------

  /** Count words like Word's status bar (numbered-list labels included). */
  wordCount() { return this.storyWordCount(BODY); }
  /** Word's default count: the body plus its text boxes, footnotes and endnotes. */
  wordCountIncludingNotes() { return this.countedStories().reduce((n, s) => n + this.storyWordCount(s), 0); }
  storyWordCount(s) {
    const bl = this.story(s);
    if (!bl) return 0;
    return storyWordCountOf(bl, this.c.numbering, this.c.styles, new Counters(), 0);
  }
  /** The body, then the text boxes, footnotes and endnotes it shows, in document order. */
  countedStories() { return this._reachable([BODY], notesAndBoxes); }

  /** The stories a reader sees, in reading order (shown_stories). */
  shownStories() {
    const followers = new Set(this.textBoxChains().flatMap(c => c.slice(1)));
    const follow = o => notesAndBoxes(o).filter(([id]) => !followers.has(id));
    const out = this._reachable([BODY], follow);
    const seen = new Set(out);
    const roots = [], rootSeen = new Set();
    const headers = {default: null, first: null, even: null}, footers = {default: null, first: null, even: null};
    for (const [, sec0] of this.sections()) {
      const sec = sectionOf(sec0);
      for (const [set, own] of [[headers, sec.headers], [footers, sec.footers]]) {
        set.default = own.default ?? set.default;
        set.first = own.first ?? set.first;
        set.even = own.even ?? set.even;
        const first = sec.titlePage ? set.first : null;
        const even = this.c.settings.evenOddHeaders ? set.even : null;
        const ord = sec.titlePage ? [first, even, set.default] : [set.default, even, null];
        for (const id of ord) {
          if (id === null || id === undefined) continue;
          const pk = this.c.parts[id]?.kind;
          if ((pk === 'header' || pk === 'footer') && !rootSeen.has(id)) { rootSeen.add(id); roots.push(id); }
        }
      }
    }
    for (const st of this._reachable(roots, follow)) if (!seen.has(st)) { seen.add(st); out.push(st); }
    return out;
  }

  /** `roots`, then every story their objects lead to, transitively, in the order found. */
  _reachable(roots, follow) {
    const out = roots.slice();
    const seen = new Set(out);
    for (let i = 0; i < out.length; i++) {
      const bl = this.story(out[i]);
      const found = [];
      if (bl) for (const [, b] of bl.entries()) eachPara(b, p => { for (const o of P.objectsOf(p)) found.push(...follow(o)); });
      for (const [id, kinds] of found) {
        if (kinds.includes(this.c.parts[id]?.kind) && !seen.has(id)) { seen.add(id); out.push(id); }
      }
    }
    return out;
  }

  // --- text boxes ----------------------------------------------------------------------------

  /** Drop the text box stories no box shows any more; returns how many went. */
  pruneTextBoxes() {
    const parts = this.c.parts;
    if (!Object.values(parts).some(p => p.kind === 'textBox')) return 0;
    const roots = [BODY, ...partIds(parts).filter(id => parts[id].kind !== 'textBox')];
    const live = new Set(this._reachable(roots, o => P.textBoxesOf(o).map(id => [id, ['textBox']])));
    const gone = partIds(parts).filter(id => parts[id].kind === 'textBox' && !live.has(id));
    if (!gone.length) return 0;
    const own = this._ownParts();
    for (const id of gone) delete own[id];
    for (const id of partIds(own)) {
      const next = own[id].body?.next;
      if (next !== undefined && next !== null && !own[next]) { const p = this._ownPart(id); p.body = {...p.body, next: null}; }
    }
    return gone.length;
  }

  /** The chains of linked text boxes, each from the box holding the text (text_box_chains). */
  textBoxChains() {
    const parts = this.c.parts;
    const isBox = id => parts[id]?.kind === 'textBox';
    const prev = new Map();
    for (const id of partIds(parts)) {
      const p = parts[id];
      if (p.kind !== 'textBox') continue;
      const n = p.body?.next;
      if (n !== undefined && n !== null && n !== id && isBox(n) && !prev.has(n)) prev.set(n, id);
    }
    const next = id => { const n = parts[id]?.body?.next; return n !== undefined && n !== null && prev.get(n) === id ? n : null; };
    const out = [];
    for (const id of partIds(parts)) {
      if (parts[id].kind !== 'textBox' || prev.has(id) || next(id) === null) continue;
      const ch = [id];
      let at = id;
      for (let n = next(at); n !== null; n = next(at)) {
        if (ch.length >= MAX_LINKED_BOXES || ch.includes(n)) break;
        ch.push(n);
        at = n;
      }
      out.push(ch);
    }
    return out;
  }
  textBoxChain(part) { return this.textBoxChains().find(c => c.includes(part)) ?? null; }

  /** The size [w, h] of the shapes showing text boxes `ids` (a group member's as stretched). */
  textBoxSizes(ids) {
    const want = new Set(ids);
    const out = new Map();
    const stories = [this.story(BODY), ...partIds(this.c.parts).map(id => new ArrayList(this.c.parts[id].blocks))];
    for (const bl of stories) for (const [, b] of bl.entries()) eachPara(b, p => {
      for (const o of P.objectsOf(p)) {
        if (o.type === 'shape' && o.story !== undefined && o.story !== null && want.has(o.story)) { if (!out.has(o.story)) out.set(o.story, [o.w, o.h]); }
        else if (o.type === 'group') {
          for (const [r, c] of P.groupRects(o, 0, 0, o.w, o.h)) {
            const id = P.textBoxOf(c);
            if (id !== null && want.has(id) && !out.has(id)) out.set(id, [r[2], r[3]]);
          }
        }
      }
    });
    return out;
  }

  _walkObjects(list, budget, f) {
    for (const [, b] of list.entries()) eachPara(b, p => {
      P.objectsOf(p).forEach((o, k) => {
        if (!f(p, k)) return;
        for (const id of P.textBoxesOf(o)) {
          const part = this.c.parts[id];
          if (part?.kind === 'textBox' && budget.enter(id)) { this._walkObjects(new ArrayList(part.blocks), budget, f); budget.leave(); }
        }
      });
    });
  }
  /** Every inline object in reading order: the body's, with each text box's objects where the box is. */
  objectsInReadingOrder(f) { this._walkObjects(this.story(BODY), new BoxBudget(), (p, k) => { f(p.objects[k]); return true; }); }
  /** Like objectsInReadingOrder with each object's paragraph and index; f returns whether to go into its box. */
  objectsInReadingOrderAt(f) { this._walkObjects(this.story(BODY), new BoxBudget(), f); }
  /** Also giving the top-level body block each object is in. */
  objectsInReadingOrderByBlock(f) {
    const budget = new BoxBudget();
    for (const [i, b] of this.story(BODY).entries()) this._walkObjects(new ArrayList([b]), budget, (p, k) => f(i, p, k));
  }
  /** The footnotes and endnotes referenced inside text box story `part` (nested boxes too). */
  notesInTextBox(part) {
    const out = [];
    const budget = new BoxBudget();
    const p = this.c.parts[part];
    if (p?.kind === 'textBox' && budget.enter(part)) {
      this._walkObjects(new ArrayList(p.blocks), budget, (q, k) => { const o = q.objects[k]; if (o.type === 'noteRef') out.push(o.id); return true; });
      budget.leave();
    }
    return out;
  }

  /** A drawing id no shape uses yet (next_shape_id). */
  nextShapeId() {
    let max = 0;
    const see = o => {
      if (o.type === 'shape') max = Math.max(max, o.extra?.id ?? 0);
      else if (o.type === 'group') for (const c of o.children || []) if (c.obj?.type === 'shape') max = Math.max(max, c.obj.extra?.id ?? 0);
    };
    const stories = [this.story(BODY), ...partIds(this.c.parts).map(id => new ArrayList(this.c.parts[id].blocks))];
    for (const bl of stories) for (const [, b] of bl.entries()) eachPara(b, p => P.objectsOf(p).forEach(see));
    return Math.max(1, Math.min(max + 1, 0xffffffff));
  }

  /** Change every inline object `wants` selects, in every story (objects_mut): `f(o)` returns the new object. */
  objectsMut(wants, f) {
    const stories = [BODY, ...partIds(this.c.parts)];
    for (const s of stories) {
      const bl = this.story(s);
      const hits = [];
      for (const [i, b] of bl.entries()) { let any = false; eachPara(b, p => { any ||= P.objectsOf(p).some(wants); }); if (any) hits.push(i); }
      if (!hits.length) continue;
      const ml = this.storyMut(s);
      for (const i of hits) {
        ml.set(i, mapParas(ml.get(i), p => {
          if (!P.objectsOf(p).some(wants)) return undefined;
          return {...p, objects: p.objects.map(o => (wants(o) ? f(o) : o))};
        }));
      }
    }
  }

  /** Repair every paragraph's runs (normalize_runs). */
  normalizeRuns() {
    for (const s of [BODY, ...partIds(this.c.parts)]) {
      const ml = this.storyMut(s);
      for (const [i, b] of [...ml.entries()]) ml.set(i, mapParas(b, p => { const q = {...p}; P.normalize(q); return same(q.runs, p.runs) ? undefined : q; }));
    }
  }

  /** Number of paragraphs in the body (all depths). */
  paragraphCount() { return this.paraPaths(BODY).length; }

  // --- media and properties ------------------------------------------------------------------

  /** Add a media item (base64 bytes); returns its key, deduplicated by content (add_media). */
  addMedia(base64, ext) {
    // The lookup index (upstream MediaIndex): bytes → first key in key order, rebuilt whenever
    // `media` is not the object it was built for, so adding n pictures stays linear.
    let ix = this._mediaIndex;
    if (!ix || ix.of !== this.c.media) {
      const keys = Object.keys(this.c.media).sort(cmpKeys);
      const byBytes = new Map();
      for (let k = keys.length - 1; k >= 0; k--) byBytes.set(this.c.media[keys[k]], keys[k]);
      ix = this._mediaIndex = {of: this.c.media, byBytes, len: keys.length, next: 0};
    }
    const hit = ix.byBytes.get(base64);
    if (hit !== undefined && this.c.media[hit] === base64) return hit;
    const media = this.c.media;
    let i = Math.max(ix.len + 1, ix.next);
    let key = `image${i}.${ext}`;
    while (Object.hasOwn(media, key)) { i += 1; key = `image${i}.${ext}`; }
    this.updateField('media', m => { m[key] = base64; });
    this._mediaIndex = ix;
    if (!ix.byBytes.has(base64)) ix.byBytes.set(base64, key);
    ix.of = this.c.media;
    ix.len += 1;
    ix.next = i + 1;
    return key;
  }
  /** The value of a custom property (names compare case-insensitively). */
  customProp(name) { return this.c.customProps.find(p => p.name.toLowerCase() === String(name).toLowerCase())?.value ?? null; }
  /** Set a custom text property, replacing one of the same name in place. */
  setCustomProp(name, value) {
    this.updateField('customProps', props => {
      const i = props.findIndex(p => p.name.toLowerCase() === String(name).toLowerCase());
      if (i >= 0) props[i] = {...props[i], kind: 'lpwstr', value: String(value)};
      else props.push({name: String(name), kind: 'lpwstr', value: String(value)});
    });
  }
  removeCustomProp(name) {
    const n = this.c.customProps.length;
    const kept = this.c.customProps.filter(p => p.name.toLowerCase() !== String(name).toLowerCase());
    if (kept.length === n) return false;
    this.setField('customProps', kept);
    return true;
  }

  /** Ranges that stay editable while the document is protected (perm_ranges). */
  permRanges() {
    const out = [];
    for (const story of [BODY, ...partIds(this.c.parts)]) {
      const open = new Map();
      for (const path of this.paraPaths(story)) {
        const p = this.para(story, path);
        if (!p) continue;
        for (const [off, o] of P.objectsWithOffsets(p)) {
          if (o.type === 'permStart') {
            const start = {story, path, off: off + 1};
            if (!open.has(o.id)) open.set(o.id, []);
            open.get(o.id).push(out.length);
            out.push({id: o.id, group: o.group ?? '', editor: o.editor ?? '', start, end: {...start}});
          } else if (o.type === 'permEnd') {
            const i = open.get(o.id)?.pop();
            if (i !== undefined) out[i].end = {story, path, off};
          }
        }
      }
      const end = this.endOf(story);
      for (const list of open.values()) for (const i of list) out[i].end = {...end};
    }
    return out;
  }

  /** Bookmark names in the body, in order: [[name, pos]]. */
  bookmarks() {
    const out = [];
    for (const path of this.paraPaths(BODY)) {
      const p = this.para(BODY, path);
      if (!p) continue;
      for (const [off, o] of P.objectsWithOffsets(p)) if (o.type === 'bookmarkStart') out.push([o.name, {story: BODY, path, off}]);
    }
    return out;
  }

  /** The move name of revision `idx`, when it is one end of a move (review.rs). */
  moveName(idx) {
    if (idx === null || idx === undefined) return null;
    return this.c.revisions[idx]?.moveName ?? null;
  }

  // --- the op ----------------------------------------------------------------------------------

  /** Record an anchor-mapping step (ops.mjs). */
  _step(s) { this.steps.push(s); }

  /**
   * The app op that turns the starting content into the current one (null when nothing changed),
   * and start a new round from the current content.
   */
  takeOp() {
    const op = buildOp(this.base, this.c, this.steps);
    this.base = this.c;
    this.owned = new WeakSet();
    this.steps = [];
    this._fresh = new Set();
    this._bodyVer++;
    return op;
  }
}

/** `b` with ids from `mk(oldId)` on every block, row, cell, object and section; `keep` passes the old id. */
function reId(b, mk, keep = false) {
  const id = old => (keep ? mk(old) : mk());
  const obj = o => {
    if (!o || typeof o !== 'object') return o;
    let out = {...o, oid: id(o.oid)};
    if (o.type === 'group') out.children = (o.children || []).map(c => ({...c, obj: obj(c.obj)}));
    return out;
  };
  if (b.kind === 'para') {
    const out = {...b, id: id(b.id)};
    if (b.objects?.length) out.objects = b.objects.map(obj);
    if (b.section) out.section = {...b.section, id: id(b.section.id)};
    return out;
  }
  return {...b, id: id(b.id), rows: b.rows.map(r => ({...r, id: id(r.id), cells: r.cells.map(c => ({...c, id: id(c.id), blocks: c.blocks.map(x => reId(x, mk, keep))}))}))};
}
export {reId};

export {ArrayList, BodyList, walk as walkParaPaths, textOf, defaultSection, bodyFromBlocks};

// --- edit.rs, fields.rs and control.rs methods ----------------------------------------------------

const helpers = {BODY, ArrayList, cmpPath, samePath, samePos, cmpPos, orderPos: order, pathLast, pathWithLast, pathParent, pathDepth, eachPara,
  mapParas, badPath, invalid, PARA_WALK_DEPTH, walkBetween, Document};
installRanges(Document, helpers);
installEdit(Document, helpers);

// --- fragments (edit.rs `impl Fragment`) ----------------------------------------------------------

/** The fragment as the body of a new document (Fragment::to_document). */
export const fragmentToDocument = frag => new Document(createContent(frag.blocks.length ? frag.blocks : [P.newParagraph()]));
/** The fragment's text, paragraphs separated by \n (Fragment::plain_text). */
export const fragmentPlainText = frag => fragmentToDocument(frag).plainText(BODY);
/** `piece` added at the end of `spike` with one paragraph mark after it (Fragment::append_piece, Word's Spike). */
export const appendFragment = (spike, piece) => appendPiece(spike, piece, eachPara, mapParas);
