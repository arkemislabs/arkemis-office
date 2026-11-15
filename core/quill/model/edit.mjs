// Range editing on a Document: insert text and objects, split paragraphs, delete ranges across
// paragraphs and tables, character and paragraph formatting, copy a range to a fragment and paste
// a fragment (text boxes get stories of their own), convert notes, retarget styles.
// Translated from wordcraft crates/doc/src/edit.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A fragment is `{blocks: Block[], parts: {[sourcePartId]: Part}}`: blocks whose first and last
// paragraphs may be partial, with copies of the text box stories its shapes show. Every method that
// changes paragraph text records how positions move (ops.mjs steps). No DOM, no Node built-ins.

import * as P from './para.mjs';
import {absorb} from './section.mjs';
import {MAX_TABLE_DEPTH} from './table.mjs';
import {charIsEmpty, paraIsEmpty} from './props.mjs';
import {createContent} from './content.mjs';

/** Nesting limit when following text boxes inside text boxes. */
const MAX_BOX_DEPTH = 8;
/** Most text box stories one paste may create. */
export const MAX_PASTED_BOXES = 4096;
/** Most text box content (estimated bytes) one paste may copy. */
export const MAX_PASTED_BOX_BYTES = 32 << 20;

// Estimated sizes of the Rust values whose copies a paste charges (block_cost / object_cost).
const SIZE_BLOCK = 256, SIZE_RUN = 512, SIZE_OBJECT = 256, SIZE_GROUP_CHILD = 264, SIZE_CHAR_PROPS = 512, SIZE_CONTROL = 256, SIZE_SLOT = 8;

/** What a paste may still spend on text box stories (edit.rs `BoxBudget`). */
export class PasteBudget {
  constructor() { this.stories = MAX_PASTED_BOXES; this.bytes = MAX_PASTED_BOX_BYTES; this.active = []; this.costs = new Map(); this.skipped = 0; }
}

const boxIds = p => P.objectsOf(p).flatMap(P.textBoxesOf);

const jsonLen = v => { try { return JSON.stringify(v)?.length ?? 0; } catch { return 0; } };

/** Rough heap bytes a copy of `o` costs (object_cost). */
export function objectCost(o) {
  const floatCost = f => (f?.alt?.text?.length ?? 0) + (f?.alt?.title?.length ?? 0);
  let cost = 0;
  const todo = [o];
  while (todo.length) {
    const x = todo.pop();
    if (!x) continue;
    switch (x.type) {
      case 'image': cost += (x.media?.length ?? 0) + (x.alt?.length ?? 0) + floatCost(x.float); break;
      case 'graphic': cost += (x.alt?.length ?? 0) + floatCost(x.float); break;
      case 'shape': {
        const w = x.extra?.warp;
        const warp = w ? (w.adj || []).reduce((n, [name]) => n + 24 + String(name).length, String(w.preset ?? '').length) : 0;
        cost += floatCost(x.float) + warp;
        break;
      }
      case 'group': todo.push(...(x.children || []).map(c => c.obj)); cost += (x.children?.length ?? 0) * SIZE_GROUP_CHILD + floatCost(x.float); break;
      case 'field': cost += (x.instr?.length ?? 0) + (x.result?.length ?? 0) + (x.form?.length ?? 0); break;
      case 'fieldStart': cost += x.instr?.length ?? 0; break;
      case 'controlStart': cost += SIZE_CONTROL + jsonLen(x.control); break;
      case 'noteRef': cost += x.custom?.length ?? 0; break;
      case 'bookmarkStart': case 'bookmarkEnd': cost += x.name?.length ?? 0; break;
      case 'permStart': cost += (x.group?.length ?? 0) + (x.editor?.length ?? 0); break;
      case 'equation': cost += (x.linear?.length ?? 0) + jsonLen(x.math ?? null); break;
      case 'ruby': cost += (x.base?.length ?? 0) + (x.ruby?.length ?? 0) + (x.lang?.length ?? 0) + SIZE_CHAR_PROPS + jsonLen(x.props ?? {}); break;
      case 'opaque': cost += (x.format?.length ?? 0) + (x.xml?.length ?? 0) + (x.text?.length ?? 0); break;
      default: break;
    }
  }
  return cost;
}

/** Rough size of a block's content, and whether it holds text boxes (block_cost). */
export function blockCost(b, eachPara) {
  let cost = SIZE_BLOCK, boxes = false;
  eachPara(b, p => {
    const items = p.runs.length * SIZE_RUN + P.objectsOf(p).length * SIZE_OBJECT;
    const objects = P.objectsOf(p).reduce((n, o) => n + objectCost(o), 0);
    cost += p.text.length + items + objects;
    boxes ||= boxIds(p).length > 0;
  });
  return [cost, boxes];
}

/** The blocks in a table's cells, row by row. */
const cellBlocks = t => t.rows.flatMap(r => r.cells.flatMap(c => c.blocks));

/** How many tables deep `t` goes, itself included (without recursion). */
export function tableHeight(t) {
  let most = 1;
  const stack = cellBlocks(t).map(b => [b, 1]);
  while (stack.length) {
    const [b, d] = stack.pop();
    if (b.kind === 'table') { const dd = d + 1; most = Math.max(most, dd); stack.push(...cellBlocks(b).map(x => [x, dd])); }
  }
  return most;
}

/** `b` as blocks nesting at most `room` tables deep (fit_tables). */
function fitTables(b, room, out) {
  if (b.kind === 'table' && room === 0) {
    const stack = cellBlocks(b).reverse();
    while (stack.length) {
      const cb = stack.pop();
      if (cb.kind === 'para') out.push(cb); else stack.push(...cellBlocks(cb).reverse());
    }
  } else if (b.kind === 'table' && tableHeight(b) > room) {
    const rows = b.rows.map(r => ({...r, cells: r.cells.map(c => {
      const kept = [];
      for (const cb of c.blocks) fitTables(cb, Math.max(0, room - 1), kept);
      return {...c, blocks: kept};
    })}));
    out.push({...b, rows});
  } else out.push(b);
}

/** Whether block `b`, at walk depth `depth`, has cells the paragraph walk skips (deeper_than_walk). */
function deeperThanWalk(b, depth, PARA_WALK_DEPTH) {
  if (b.kind === 'para') return false;
  return b.rows.flatMap(r => r.cells).some(c => depth + 1 > PARA_WALK_DEPTH || c.blocks.some(x => deeperThanWalk(x, depth + 1, PARA_WALK_DEPTH)));
}

/** Whether a paragraph anywhere in `b` uses paragraph or character style `id` (uses_style). */
function usesStyle(b, id, depth) {
  if (b.kind === 'para') return b.props?.style === id || b.mark?.style === id || b.runs.some(r => r.props?.style === id);
  if (depth < 16) return b.rows.some(r => r.cells.some(c => c.blocks.some(cb => usesStyle(cb, id, depth + 1))));
  return false;
}

// --- fragments ----------------------------------------------------------------------------------

/** A fragment from plain text, one paragraph per line. */
export function fragmentFromText(s) {
  return {blocks: String(s).split('\n').map(l => P.paragraphWithText(l.replace(/\r+$/, ''), {})), parts: {}};
}

/** Whether a fragment holds an equation (in tables too). */
export function fragmentHasEquation(frag, eachPara) {
  let found = false;
  for (const b of frag.blocks) eachPara(b, p => { found ||= P.objectsOf(p).some(o => o.type === 'equation'); });
  return found;
}

/** The equation [linear, display] when the fragment is that one equation and nothing else but white space. */
export function fragmentSoleEquation(frag) {
  let found = null;
  for (const b of frag.blocks) {
    if (b.kind !== 'para') return null;
    for (const c of b.text) {
      if (/\s/u.test(c)) continue;
      if (c !== P.OBJ || found) return null;
      const o = b.objects?.[0];
      if (o?.type !== 'equation') return null;
      found = [o.linear, !!o.display];
    }
  }
  return found;
}

/**
 * Add `piece` at the end of `spike`, followed by a paragraph mark unless it already ends with one
 * (Word's Spike); the piece's text box stories get ids after the spike's. Returns the new fragment.
 */
export function appendPiece(spike, piece, eachPara, mapParas) {
  const blocks = piece.blocks.slice();
  const last = blocks[blocks.length - 1];
  if (!last) return spike;
  const endsWithMark = blocks.length >= 2 && last.kind === 'para' && P.paraIsEmptyText(last);
  if (!endsWithMark) {
    const mark = P.newParagraph();
    if (last.kind === 'para' && last.props) mark.props = {...last.props};
    blocks.push(mark);
  }
  const spikeIds = Object.keys(spike.parts || {}).map(Number);
  const next = spikeIds.length ? Math.max(...spikeIds) + 1 : 1;
  const ids = new Map(Object.keys(piece.parts || {}).map(Number).sort((a, b) => a - b).map((old, i) => [old, next + i]));
  const renumber = b => mapParas(b, p => {
    if (!P.objectsOf(p).some(o => P.textBoxesOf(o).some(id => ids.has(id)))) return undefined;
    return {...p, objects: p.objects.map(o => P.mapTextBoxes(o, old => (ids.has(old) ? ids.get(old) : old)))};
  });
  const parts = {...(spike.parts || {})};
  for (const [old, part] of Object.entries(piece.parts || {})) {
    const nid = ids.get(Number(old));
    if (nid !== undefined) parts[nid] = {...part, blocks: part.blocks.map(renumber)};
  }
  const out = (spike.blocks || []).slice();
  if (out.length >= 2) { const l = out[out.length - 1]; if (l.kind === 'para' && P.paraIsEmptyText(l)) out.pop(); }
  out.push(...blocks.map(renumber));
  void eachPara;
  return {blocks: out, parts};
}

// --- Document methods -----------------------------------------------------------------------------

/** Install the edit methods on Document (edit.rs `impl Document`). */
export function installEdit(D, h) {
  const {BODY, ArrayList, cmpPath, samePath, samePos, orderPos, pathLast, pathWithLast, pathParent, pathDepth, eachPara, mapParas, badPath, invalid,
    PARA_WALK_DEPTH, walkBetween, Document} = h;
  const partIds = parts => Object.keys(parts).map(Number).sort((a, b) => a - b);
  const setProps = (p, props) => { if (props && !paraIsEmpty(props)) p.props = props; else delete p.props; };
  const setSection = (p, s) => { if (s) p.section = s; else delete p.section; };

  Object.assign(D.prototype, {
    // --- paragraph primitives that record how positions move ---
    _pInsertText(story, path, off, s, props) {
      const p = this.paraMut(story, path);
      const n = P.insertText(p, off, s, props);
      if (n) this._step({k: 'text', story, id: p.id, at: off, del: 0, ins: n});
      return n;
    },
    _pInsertObject(story, path, off, obj, props) {
      // An object keeps its id when it is new to the document or is being moved within it.
      const keep = !!obj.oid && (this._movingOid?.has(obj.oid) || !this.hasId(obj.oid));
      const o = keep ? obj : {...obj, oid: this.newId()};
      this._fresh.add(o.oid);
      const p = this.paraMut(story, path);
      P.insertObject(p, off, o, props);
      this._step({k: 'text', story, id: p.id, at: off, del: 0, ins: 1});
      return o;
    },
    _pDelete(story, path, a, b) {
      [a, b] = [Math.min(a, b), Math.max(a, b)];
      const p = this.paraMut(story, path);
      P.deleteRange(p, a, b);
      if (b > a) this._step({k: 'text', story, id: p.id, at: a, del: b - a, ins: 0});
    },
    _pDeleteExcept(story, path, a, b, keep) {
      [a, b] = [Math.min(a, b), Math.max(a, b)];
      const cur = this.para(story, path);
      if (!cur) throw badPath(path);
      let k = (keep || []).filter(o => o >= a && o + 1 <= b && cur.text[o] === P.OBJ);
      if (!k.length) { this._pDelete(story, path, a, b); return; }
      k = [...new Set(k)].sort((x, y) => x - y);
      const pieces = [];
      let from = a;
      for (const o of k) { pieces.push([from, o]); from = o + 1; }
      pieces.push([from, b]);
      for (let i = pieces.length - 1; i >= 0; i--) if (pieces[i][1] > pieces[i][0]) this._pDelete(story, path, pieces[i][0], pieces[i][1]);
    },

    /** Convert footnotes (`foot`) to endnotes and endnotes (`end`) to footnotes (convert_notes). */
    convertNotes(foot, end) {
      const flips = new Set(partIds(this.c.parts).filter(id => (foot && this.c.parts[id].kind === 'footnote') || (end && this.c.parts[id].kind === 'endnote')));
      if (!flips.size) return 0;
      const swap = s => ({FootnoteText: 'EndnoteText', EndnoteText: 'FootnoteText', FootnoteReference: 'EndnoteReference',
        EndnoteReference: 'FootnoteReference'})[s] ?? s;
      const refers = p => P.objectsOf(p).some(o => o.type === 'noteRef' && flips.has(o.id));
      const convert = (p, inNote) => {
        if (!inNote && !refers(p)) return undefined;
        const q = {...p};
        const offs = P.objectOffsets(p);
        const at = [];
        q.objects = P.objectsOf(p).map((o, k) => {
          if (o.type === 'noteRef' && flips.has(o.id)) { at.push(offs[k]); return {...o, kind: o.kind === 'footnote' ? 'endnote' : 'footnote'}; }
          return o;
        });
        if (!q.objects.length) delete q.objects;
        let start = 0;
        q.runs = p.runs.map(r => {
          const e = start + r.len;
          const hit = at.some(o => o >= start && o < e);
          start = e;
          if (hit && r.props?.style) return {...r, props: {...r.props, style: swap(r.props.style)}};
          return r;
        });
        if (inNote) {
          if (q.props?.style) q.props = {...q.props, style: swap(q.props.style)};
          if (q.mark?.style) q.mark = {...q.mark, style: swap(q.mark.style)};
        }
        return q;
      };
      const touches = b => { let any = false; eachPara(b, p => { any ||= refers(p); }); return any; };
      const body = this.storyMut(BODY);
      for (const [i, b] of [...body.entries()]) if (touches(b)) body.set(i, mapParas(b, p => convert(p, false)));
      for (const id of partIds(this.c.parts)) {
        const own = flips.has(id);
        const part = this._ownPart(id);
        if (own) part.kind = part.kind === 'footnote' ? 'endnote' : 'footnote';
        part.blocks.forEach((b, i) => { if (own || touches(b)) part.blocks[i] = mapParas(b, p => convert(p, own)); });
      }
      return flips.size;
    },

    /** Point every paragraph and run using style `from` at `to` (null: the default style); returns the count. */
    restyle(from, to) {
      let n = 0;
      const restyleBlock = (b, depth) => {
        if (b.kind === 'para') {
          const changed = b.props?.style === from || b.mark?.style === from || b.runs.some(r => r.props?.style === from);
          if (!changed) return b;
          const q = {...b};
          if (q.props?.style === from) { q.props = {...q.props}; if (to) q.props.style = to; else delete q.props.style; setProps(q, q.props); }
          if (q.mark?.style === from) { q.mark = {...q.mark}; if (to) q.mark.style = to; else delete q.mark.style; if (charIsEmpty(q.mark)) delete q.mark; }
          q.runs = q.runs.map(r => {
            if (r.props?.style !== from) return r;
            const props = {...r.props};
            if (to) props.style = to; else delete props.style;
            return charIsEmpty(props) ? {len: r.len} : {len: r.len, props};
          });
          P.normalize(q);
          n++;
          return q;
        }
        if (depth >= 16) return b;
        return {...b, rows: b.rows.map(r => ({...r, cells: r.cells.map(c => ({...c, blocks: c.blocks.map(cb => (usesStyle(cb, from, depth + 1) ? restyleBlock(cb, depth + 1) : cb))}))}))};
      };
      for (const s of [BODY, ...partIds(this.c.parts)]) {
        const bl = this.story(s);
        const hits = [];
        for (const [i, b] of bl.entries()) if (usesStyle(b, from, 0)) hits.push(i);
        if (!hits.length) continue;
        const ml = this.storyMut(s);
        for (const i of hits) ml.set(i, restyleBlock(ml.get(i), 0));
      }
      return n;
    },

    /** Insert plain text at `pos` (\n is a manual line break). Returns the position after it. */
    insertText(pos, s, props = {}) {
      const n = this._pInsertText(pos.story, pos.path, pos.off, s, props);
      return {...pos, path: [...pos.path], off: pos.off + n};
    },
    /** Insert an inline object at `pos` (it gets an `oid`); returns the position after it. */
    insertObject(pos, obj, props = {}) {
      this._pInsertObject(pos.story, pos.path, pos.off, obj, props);
      return {...pos, path: [...pos.path], off: pos.off + 1};
    },
    /** Split the paragraph at `pos`; returns the start of the new (second) paragraph. */
    splitParagraph(pos) {
      const i = pathLast(pos.path);
      if (!this.para(pos.story, pos.path)) throw badPath(pos.path);
      const p = this.paraMut(pos.story, pos.path);
      const into = this.newId();
      const tail = P.splitOff(p, pos.off, into);
      this._step({k: 'split', story: pos.story, id: p.id, at: pos.off, into});
      const bl = this.containerMut(pos.story, pos.path);
      bl.insert(Math.min(i + 1, bl.len()), tail);
      return {story: pos.story, path: pathWithLast(pos.path, i + 1), off: 0};
    },
    /** Insert a block before the block at `path`; a table nesting deeper than MAX_TABLE_DEPTH is refused. */
    insertBlock(story, path, block) {
      if (block.kind === 'table' && pathDepth(path) + tableHeight(block) > MAX_TABLE_DEPTH) {
        throw invalid(`tables can't nest more than ${MAX_TABLE_DEPTH} deep`);
      }
      const i = pathLast(path);
      const bl = this.containerMut(story, path);
      if (i > bl.len()) throw badPath(path);
      bl.insert(i, this._adoptIds(block));
    },
    /** Remove the block at `path` (keeps at least one paragraph in the container); returns it. */
    removeBlock(story, path) {
      const i = pathLast(path);
      const bl = this.containerMut(story, path);
      if (i >= bl.len()) throw badPath(path);
      const b = bl.remove(i);
      if (bl.len() === 0 || bl.last()?.kind === 'table') bl.push(P.newParagraph(this.newId()));
      return b;
    },
    /** Paragraph paths between `a` and `b` inclusive (same story), document order. */
    pathsBetween(a0, b0) {
      const [a, b] = orderPos(a0, b0);
      if (a.story !== b.story) return [];
      const out = [];
      const bl = this.story(a.story);
      if (bl) walkBetween(bl, [], out, 0, a.path, b.path);
      return out;
    },

    /** Delete a..b; returns where the deletion collapsed to. On error nothing changes. */
    deleteRange(a0, b0) {
      const [a, b] = orderPos(a0, b0);
      if (samePos(a, b)) return {...a};
      if (a.story !== b.story) throw invalid('range spans stories');
      for (const p of [a, b]) {
        const para = this.para(p.story, p.path);
        if (!para) throw badPath(p.path);
        if (P.clampOff(para, p.off) !== p.off) throw P.badOffset(p.off);
      }
      const kept = this._keptControlMarkers(a, b);
      const keptIn = path => kept.filter(([p]) => samePath(p, path)).map(([, o]) => o);
      if (samePath(a.path, b.path)) {
        this._pDeleteExcept(a.story, a.path, a.off, b.off, keptIn(a.path));
        return {...a};
      }
      if (samePath(pathParent(a.path), pathParent(b.path))) {
        const ia = pathLast(a.path), ib = pathLast(b.path);
        const moved = [];
        for (const [path, off] of kept) {
          if (samePath(path, a.path) || samePath(path, b.path)) continue;
          const p = this.para(a.story, path);
          if (!p) continue;
          const o = P.objectAt(p, off);
          if (!o) continue;
          let props = P.markOf(p);
          for (const [s, e, c] of P.runRanges(p)) if (off >= s && off < e) { props = c; break; }
          moved.push([o, props]);
        }
        {
          const end = this.para(a.story, a.path).text.length;
          this._pDeleteExcept(a.story, a.path, a.off, end, keptIn(a.path));
          this._movingOid = new Set(moved.map(([o]) => o.oid).filter(Boolean));
          for (const [o, props] of moved) this._pInsertObject(a.story, a.path, this.para(a.story, a.path).text.length, o, props);
          this._movingOid = null;
        }
        this._pDeleteExcept(b.story, b.path, 0, b.off, keptIn(b.path));
        const tail = {...this.para(b.story, b.path)};
        const bl = this.containerMut(a.story, a.path);
        const between = [];
        for (let i = ia + 1; i < ib && i < bl.len(); i++) { const x = bl.get(i); if (x?.kind === 'para' && x.section) between.push(x.section); }
        if (ib < bl.len() && ia < ib) bl.splice(ia + 1, ib - ia);
        delete tail.props;
        const sect = tail.section;
        delete tail.section;
        const pa = this.paraMut(a.story, a.path);
        const keepProps = pa.props;
        const at = pa.text.length;
        P.append(pa, tail);
        setProps(pa, keepProps);
        this._step({k: 'join', story: a.story, id: tail.id, into: pa.id, at});
        const before = pa.section;
        setSection(pa, sect);
        if (a.story === BODY && a.path.length === 1) {
          this.updateSection(pathLast(a.path), s => {
            let cur = s;
            for (const x of [...between].reverse()) cur = absorb(cur, x);
            if (before) cur = absorb(cur, before);
            return cur;
          });
        }
        return {...a};
      }
      // Different containers (the range enters or leaves a table).
      const bAtEnd = this.para(b.story, b.path)?.text.length === b.off;
      const paths = this.pathsBetween(a, b);
      for (let k = paths.length - 1; k >= 0; k--) {
        const p = paths[k];
        const para = this.para(a.story, p);
        if (!para) continue;
        const from = samePath(p, a.path) ? a.off : 0;
        const to = samePath(p, b.path) ? b.off : para.text.length;
        this._pDeleteExcept(a.story, p, from, to, keptIn(p));
      }
      let common = 0;
      while (common < a.path.length && common < b.path.length && a.path[common] === b.path[common]) common++;
      const level = common - (common % 3);
      const ia = a.path[level], ib = b.path[level];
      if (ia === undefined || ib === undefined || ia >= ib) return {...a};
      const prefix = a.path.slice(0, level);
      const blockPath = i => [...prefix, i];
      const all = this.paraPaths(a.story);
      const inside = i => {
        const pre = blockPath(i);
        return all.filter(q => q.length > pre.length && pre.every((x, j) => q[j] === x));
      };
      const walked = i => {
        const blk = this.container(a.story, blockPath(i))?.get(i);
        return !!blk && !deeperThanWalk(blk, level / 3, PARA_WALK_DEPTH);
      };
      const aCovers = a.path.length > level + 1 && a.off === 0 && walked(ia) && (() => { const ins = inside(ia); return ins.length && samePath(ins[0], a.path); })();
      const bCovers = b.path.length > level + 1 && walked(ib) && (() => { const ins = inside(ib); return ins.length && samePath(ins[ins.length - 1], b.path); })() && bAtEnd;
      const first = aCovers ? ia : ia + 1;
      const last = bCovers ? ib : ib - 1;
      let removed = 0;
      {
        const bl = this.containerMut(a.story, blockPath(ia));
        for (let i = Math.min(last, bl.len() - 1); i >= first; i--) {
          if (bl.get(i)?.kind === 'table') { bl.remove(i); removed++; }
        }
        if (!removed) return {...a};
        if (bl.len() === 0 || bl.last()?.kind === 'table') bl.push(P.newParagraph(this.newId()));
      }
      const at = aCovers ? {story: a.story, path: blockPath(ia), off: 0} : {...a};
      const end = bCovers ? {story: a.story, path: blockPath(Math.max(0, ib + 1 - removed)), off: 0}
        : {story: a.story, path: blockPath(Math.max(0, ib - removed)), off: 0};
      const paras = p => p.path.length === level + 1 && !!this.para(p.story, p.path);
      if (paras(at) && paras(end) && cmpPath(at.path, end.path) <= 0) return this.deleteRange(at, end);
      if (this.para(at.story, at.path)) return at;
      return this.clamp(at);
    },

    /**
     * Apply `f` to the character formatting of a..b (a collapsed range changes nothing). A fully
     * selected paragraph also gets its mark formatted, but never a hyperlink.
     */
    formatRange(a0, b0, f) {
      const [a, b] = orderPos(a0, b0);
      for (const path of this.pathsBetween(a, b)) {
        const cur = this.para(a.story, path);
        const from = samePath(path, a.path) ? a.off : 0;
        const to = samePath(path, b.path) ? b.off : cur.text.length;
        const para = this.paraMut(a.story, path);
        P.formatRange(para, from, to, f);
        if (to === para.text.length && (from === 0 || !samePath(path, a.path))) {
          const style = para.mark?.style;
          const mark = P.applyProps(P.markOf(para), f);
          if (mark.link !== undefined) {
            delete mark.link; delete mark.linkTip;
            if (style !== undefined && style !== 'Hyperlink') mark.style = style; else delete mark.style;
          }
          if (charIsEmpty(mark)) delete para.mark; else para.mark = mark;
        }
      }
    },
    /** The paragraphs paragraph formatting of a..b applies to (para_paths_in). */
    paraPathsIn(a0, b0) {
      const [a, b] = orderPos(a0, b0);
      const paths = this.pathsBetween(a, b);
      if (b.off === 0 && !samePath(a.path, b.path) && paths.length > 1 && samePath(paths[paths.length - 1], b.path)) paths.pop();
      return paths;
    },
    /** Apply `f` to the paragraph properties of every paragraph a..b covers. */
    formatParagraphs(a, b, f) {
      for (const path of this.paraPathsIn(a, b)) {
        const para = this.paraMut(a.story, path);
        setProps(para, P.applyProps(P.paraPropsOf(para), f));
      }
    },

    /** Copy a..b into a fragment, with copies of the text boxes in it. */
    copyRange(a, b) {
      // What a fragment holds is shared with this document (upstream: Arc clones); give up the
      // objects this round may still change in place, so later edits copy instead of writing
      // through to the fragment.
      this.owned = new WeakSet();
      const blocks = balanceBlocks(this._copyBlocks(a, b), Document);
      return {blocks, parts: this._textBoxParts(blocks)};
    },
    /** The whole body as a fragment (with its text boxes). */
    bodyFragment() {
      this.owned = new WeakSet();
      const blocks = this.story(BODY).toArray();
      return {blocks, parts: this._textBoxParts(blocks)};
    },
    _textBoxParts(blocks) {
      const out = {};
      const todo = [];
      for (const b of blocks) eachPara(b, p => todo.push(...boxIds(p)));
      while (todo.length) {
        const id = todo.pop();
        if (Object.hasOwn(out, id)) continue;
        const part = this.c.parts[id];
        if (part?.kind !== 'textBox') continue;
        for (const b of part.blocks) eachPara(b, p => todo.push(...boxIds(p)));
        out[id] = part;
      }
      return out;
    },
    _copyBlocks(a0, b0) {
      const [a, b] = orderPos(a0, b0);
      const out = [];
      if (a.story !== b.story) return out;
      if (samePath(pathParent(a.path), pathParent(b.path))) {
        const bl = this.container(a.story, a.path);
        if (!bl) return out;
        for (let i = pathLast(a.path); i <= pathLast(b.path); i++) {
          const blk = bl.get(i);
          if (!blk) break;
          if (blk.kind === 'para') {
            const p = {...blk};
            const to = i === pathLast(b.path) ? b.off : p.text.length;
            const from = i === pathLast(a.path) ? a.off : 0;
            P.deleteRange(p, Math.min(to, p.text.length), p.text.length);
            P.deleteRange(p, 0, Math.min(from, p.text.length));
            if (i === pathLast(b.path) && to < (this.para(a.story, b.path)?.text.length ?? 0)) delete p.section;
            out.push(p);
          } else out.push(blk);
        }
        return out;
      }
      for (const path of this.pathsBetween(a, b)) {
        const para = this.para(a.story, path);
        if (!para) continue;
        const q = {...para};
        const to = samePath(path, b.path) ? b.off : q.text.length;
        const from = samePath(path, a.path) ? a.off : 0;
        P.deleteRange(q, Math.min(to, q.text.length), q.text.length);
        P.deleteRange(q, 0, Math.min(from, q.text.length));
        delete q.section;
        out.push(q);
      }
      return out;
    },

    /** Give every text box in `blocks` a new story of its own, copied from `parts` or this document. */
    _adoptTextBoxes(blocks, parts, depth, budget) {
      let any = false;
      for (const b of blocks) eachPara(b, p => { any ||= boxIds(p).length > 0; });
      if (!any) return;
      for (let i = 0; i < blocks.length; i++) {
        blocks[i] = mapParas(blocks[i], p => {
          if (!boxIds(p).length) return undefined;
          return {...p, objects: p.objects.map(o => P.mapTextBoxes(o, old => this._adoptTextBox(old, parts, depth, budget)))};
        });
      }
    },
    _adoptTextBox(old, parts, depth, budget) {
      if (depth >= MAX_BOX_DEPTH || budget.active.includes(old)) return null;
      if (budget.stories === 0) { budget.skipped += 1; return null; }
      const src = parts[old] ?? (this.c.parts[old]?.kind === 'textBox' ? this.c.parts[old] : null);
      if (!src) return null;
      if (!budget.costs.has(old)) {
        let cost = src.blocks.length * SIZE_SLOT;
        for (const b of src.blocks) { const [c, boxes] = blockCost(b, eachPara); if (boxes) cost += c; }
        budget.costs.set(old, cost);
      }
      const cost = budget.costs.get(old);
      if (budget.bytes < cost) { budget.skipped += 1; return null; }
      budget.bytes -= cost;
      budget.stories -= 1;
      const body = {...(src.body || {}), next: null};
      budget.active.push(old);
      const blocks = [];
      for (const b of src.blocks) {
        let boxes = false;
        eachPara(b, p => { boxes ||= boxIds(p).length > 0; });
        if (boxes) {
          const copy = [b];
          this._adoptTextBoxes(copy, parts, depth + 1, budget);
          blocks.push(copy[0]);
        } else blocks.push(b);
      }
      budget.active.pop();
      let id;
      try { id = this.tryAddPart('textBox', blocks); } catch { return null; }
      if (src.body && Object.keys(src.body).length) this.setTextBody(id, body);
      return id;
    },

    /** Insert a fragment at `pos`; returns the position after the pasted content. */
    insertFragment(pos, frag) {
      const room = Math.max(0, MAX_TABLE_DEPTH - pathDepth(pos.path));
      let blocks = [];
      for (const b of frag.blocks) fitTables(b, room, blocks);
      if (!blocks.length) return {...pos};
      if (!this.paraAt(pos)) throw badPath(pos.path);
      blocks = blocks.map(b => this.freshIds(b));
      const budget = new PasteBudget();
      this._adoptTextBoxes(blocks, frag.parts || {}, 0, budget);
      if (budget.skipped > 0) {
        (this.warnings ||= []).push(`paste: ${budget.skipped} text boxes are left empty; their stories are past what one paste copies (${MAX_PASTED_BOXES} stories, ${MAX_PASTED_BOX_BYTES} bytes)`);
      }
      if (blocks.length === 1 && blocks[0].kind === 'para') {
        const src = {...blocks[0]};
        const target = this.paraMut(pos.story, pos.path);
        const tail = P.splitOff(target, pos.off, target.id);
        const added = src.text.length;
        const keep = target.props;
        const sect = tail.section;
        delete src.section;
        P.append(target, src);
        P.append(target, tail);
        setProps(target, keep);
        setSection(target, sect);
        if (added) this._step({k: 'text', story: pos.story, id: target.id, at: pos.off, del: 0, ins: added});
        return {...pos, path: [...pos.path], off: pos.off + added};
      }
      const after = this.splitParagraph(pos);
      const left = pos.path;
      const first = blocks.shift();
      const last = blocks.pop();
      let idx = pathLast(left) + 1;
      if (first.kind === 'para') {
        const l = this.paraMut(pos.story, left);
        const keep = l.props;
        const p2 = {...first};
        const pprops = p2.props;
        delete p2.section;
        const at = l.text.length;
        P.append(l, p2);
        setProps(l, keep && !paraIsEmpty(keep) ? keep : pprops);
        if (first.text.length) this._step({k: 'text', story: pos.story, id: l.id, at, del: 0, ins: first.text.length});
      } else {
        this.insertBlock(pos.story, pathWithLast(left, idx), first);
        idx++;
      }
      for (const b of blocks) { this.insertBlock(pos.story, pathWithLast(left, idx), b); idx++; }
      const right = pathWithLast(after.path, idx);
      if (last && last.kind === 'para') {
        const r = this.paraMut(pos.story, right);
        const tail = {...r};
        r.text = last.text; r.runs = last.runs;
        setProps(r, last.props);
        if (last.mark) r.mark = last.mark; else delete r.mark;
        if (last.objects?.length) r.objects = last.objects; else delete r.objects;
        setSection(r, last.section);
        const off = r.text.length;
        const sect = tail.section;
        P.append(r, tail);
        setSection(r, sect);
        if (off) this._step({k: 'text', story: pos.story, id: r.id, at: 0, del: 0, ins: off});
        return {story: pos.story, path: right, off};
      }
      if (last) {
        this.insertBlock(pos.story, right, last);
        return {story: pos.story, path: pathWithLast(right, idx + 1), off: 0};
      }
      return {story: pos.story, path: right, off: 0};
    },

    /** Replace every block of a story. */
    setStory(story, blocks) {
      const s = this.storyMut(story);
      const bl = blocks.map(b => this._adoptIds(b));
      s.splice(0, s.len(), bl);
      if (s.len() === 0) s.push(P.newParagraph(this.newId()));
    },
  });

  /** Remove the control markers without a partner from copied blocks (control.rs balance_blocks). */
  function balanceBlocks(blocks) {
    const d = new Document(createContent(blocks.length ? blocks : [P.newParagraph()]));
    if (!d.hasUnbalancedControls()) return blocks;
    d.balanceControls();
    return d.story(BODY).toArray();
  }
  void ArrayList;
}

export {fitTables, deeperThanWalk, usesStyle};
