// Sticky anchors: session-scoped address handles mapped through every commit
// (docs/architecture.md section 4.3). No DOM, no Node built-ins.
//
// `document.anchor {address}` returns "@a<n>"; each commit (and each undo/redo) maps every anchor
// through the content ops with the app's `mapThrough(op, ast)`. A deleted target becomes
// `{deleted: true, nearest}` and stays deleted.

import {CommandError} from './errors.mjs';
import {contentOp} from './change.mjs';

export const ANCHOR_LIMIT = 10_000;

export class AnchorTable {
  constructor({limit = ANCHOR_LIMIT} = {}) {
    this.limit = limit;
    this.next = 1;
    /** @type {Map<string, {ast: object|null, deleted: boolean, nearest?: object|null}>} */
    this.entries = new Map();
  }
  get size() { return this.entries.size; }
  /** Create an anchor for a parsed (non-anchor) address. */
  create(ast) {
    if (!ast || ast.anchor) throw new CommandError('invalid_address', 'Anchor a path address, not another anchor');
    if (this.entries.size >= this.limit) throw new CommandError('too_large', `A document holds at most ${this.limit} anchors`);
    const id = `@a${this.next++}`;
    this.entries.set(id, {ast, deleted: false});
    return id;
  }
  get(id) {
    const e = this.entries.get(id);
    if (!e) throw new CommandError('not_found', `Unknown anchor ${id}`, {address: id});
    return e;
  }
  has(id) { return this.entries.has(id); }
  delete(id) { return this.entries.delete(id); }
  /** Map every anchor through tree ops (content ops only; metadata ops never move addresses). */
  mapThrough(ops, mapThrough) {
    if (!this.entries.size || !ops.length) return;
    for (const op of ops) {
      const cop = contentOp(op);
      if (!cop) continue;
      for (const [id, e] of this.entries) {
        if (e.deleted) {
          if (e.nearest) {
            const n = mapThrough(cop, e.nearest);
            e.nearest = n && n.deleted ? (n.nearest || null) : n;
          }
          continue;
        }
        const next = mapThrough(cop, e.ast);
        if (next && next.deleted) this.entries.set(id, {ast: null, deleted: true, nearest: next.nearest || null});
        else if (next) e.ast = next;
      }
    }
  }
  /** Plain snapshot (for tests and inspection). */
  toJSON(format) {
    const out = {};
    for (const [id, e] of this.entries) {
      out[id] = e.deleted ? {deleted: true, nearest: e.nearest && format ? format(e.nearest) : e.nearest || null}
        : {address: format ? format(e.ast) : e.ast};
    }
    return out;
  }
}
