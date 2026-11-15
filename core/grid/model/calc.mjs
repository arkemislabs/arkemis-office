// Dependency graph and recalculation, attached to the document content.
// Translated from gridcraft crates/calc/src/recalc.rs, recalc/graph.rs and recalc/pass_host.rs at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The graph maps every formula cell to its static precedents. A reverse index answers "which
// formulas read this cell?": single cells in a map, ranges as row intervals per column (wide ranges
// per sheet), each an interval tree (O(log n + matches)). After an edit the dirty set is the
// transitive closure of dependents, evaluated in row-major order with on-demand evaluation as the
// safety net; cycles give #CIRC! unless iterative calculation is on.
//
// Where gridcraft writes results into the workbook, the kernel's documents are immutable and every
// write is an undoable change, so results live here, beside the content: a CalcEngine follows one
// workbook through its edits and undo/redo by diffing block objects (content is structurally
// shared, so an unchanged block is the same object) and recalculating what changed. Values a file
// carried for formula cells (`v` beside `f`) are shown only until the engine has calculated.
// No DOM, no Node built-ins.

import {CellError, ERR, GArray, sameValue, fromJSONValue} from '../lib/value.mjs';
import {MAX_ROWS, MAX_COLS, rangeOf, range as mkRange, contains, intersects, isSingle, height, width, count as rangeCount, union, parseRange} from '../lib/addr.mjs';
import {serialFromUnixMs, unixNowMs} from '../lib/date.mjs';
import {Evaluator, precedents, parseFormula} from './eval.mjs';
import {cellAt, sheetBlocks, blockEntries, blockOf, forEachCell, usedBounds, hasContent, isLegacySheet, fromLegacyCell, parseKey} from './store.mjs';
import {merges, isRowHidden, colWidth, pointsToChars, tableRanges} from './sheet.mjs';
import {resolveStyle, styleById} from './style.mjs';

// ---------------------------------------------------------------------------------------------
// Keys: one number per (sheet, row, col)

const SHEET_SPAN = 2 ** 34;
export const key = (s, r, c) => s * SHEET_SPAN + r * MAX_COLS + c;
export const keySheet = k => Math.floor(k / SHEET_SPAN);
export const keyRow = k => Math.floor((k % SHEET_SPAN) / MAX_COLS);
export const keyCol = k => (k % SHEET_SPAN) % MAX_COLS;

// ---------------------------------------------------------------------------------------------
// graph.rs: Intervals and Graph

const WIDE = 64;
const PENDING = 32;
/** Row intervals [r0, r1] with payloads; query(a, b) finds those overlapping rows a..b. */
export class Intervals {
  constructor() { this.items = []; this.dead = []; this.deadCount = 0; this.maxEnd = []; this.pending = new Map(); }
  static id(r0, r1, t) { return `${r0}|${r1}|${typeof t === 'object' ? t.join(',') : t}`; }
  isEmpty() { return this.items.length === this.deadCount && this.pending.size === 0; }
  find(r0, r1, id) {
    let lo = 0, hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1, it = this.items[mid];
      if (it[0] < r0 || (it[0] === r0 && (it[1] < r1 || (it[1] === r1 && it[3] < id)))) lo = mid + 1; else hi = mid;
    }
    const it = this.items[lo];
    return it && it[0] === r0 && it[1] === r1 && it[3] === id ? lo : -1;
  }
  insert(r0, r1, t) {
    const id = Intervals.id(r0, r1, t);
    const i = this.find(r0, r1, id);
    if (i >= 0) { if (this.dead[i]) { this.dead[i] = false; this.deadCount--; } return; }
    this.pending.set(id, [r0, r1, t, id]);
  }
  remove(r0, r1, t) {
    const id = Intervals.id(r0, r1, t);
    const i = this.find(r0, r1, id);
    if (i >= 0) { if (!this.dead[i]) { this.dead[i] = true; this.deadCount++; } return; }
    this.pending.delete(id);
  }
  settle(force = false) {
    if (!force && this.pending.size <= PENDING && this.deadCount <= Math.max(this.items.length >> 1, PENDING)) return;
    const all = this.items.filter((_, i) => !this.dead[i]);
    for (const it of this.pending.values()) all.push(it);
    this.pending.clear();
    all.sort((p, q) => p[0] - q[0] || p[1] - q[1] || (p[3] < q[3] ? -1 : p[3] > q[3] ? 1 : 0));
    const dedup = [];
    for (const it of all) if (!dedup.length || dedup[dedup.length - 1][3] !== it[3] || dedup[dedup.length - 1][0] !== it[0] || dedup[dedup.length - 1][1] !== it[1]) dedup.push(it);
    let size = 1;
    while (size < dedup.length) size <<= 1;
    const maxEnd = new Float64Array(2 * size);
    for (let i = 0; i < dedup.length; i++) maxEnd[size + i] = dedup[i][1];
    for (let i = size - 1; i >= 1; i--) maxEnd[i] = Math.max(maxEnd[2 * i], maxEnd[2 * i + 1]);
    this.items = dedup; this.dead = new Array(dedup.length).fill(false); this.deadCount = 0; this.maxEnd = maxEnd;
  }
  /** Calls fn(payload) for every interval with r0 <= b && r1 >= a. */
  query(a, b, fn) {
    for (const it of this.pending.values()) if (it[0] <= b && it[1] >= a) fn(it[2]);
    let lo = 0, hi = this.items.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.items[mid][0] <= b) lo = mid + 1; else hi = mid; }
    if (lo === 0) return;
    this.walk(1, 0, this.maxEnd.length >> 1, lo, a, fn);
  }
  walk(node, lo, hi, p, a, fn) {
    if (lo >= p || node >= this.maxEnd.length || this.maxEnd[node] < a) return;
    if (hi - lo <= 1) {
      const it = this.items[lo];
      if (it && !this.dead[lo] && it[1] >= a) fn(it[2]);
      return;
    }
    const mid = lo + ((hi - lo) >> 1);
    this.walk(2 * node, lo, mid, p, a, fn);
    this.walk(2 * node + 1, mid, hi, p, a, fn);
  }
}

export class Graph {
  constructor() {
    this.nodes = new Map();          // key -> {areas, dynamic}
    this.cellDeps = new Map();       // precedent key -> Set(dependent keys)
    this.colDeps = new Map();        // sheet*MAX_COLS+col -> Intervals<key>
    this.wideDeps = new Map();       // sheet -> Intervals<[c0, c1, key]>
    this.dynamic = new Set();
    this.unsettledCols = new Set();
    this.unsettledWide = new Set();
  }
  get size() { return this.nodes.size; }
  static entries(areas) {
    const cells = new Set(), cols = new Map(), wide = new Map();
    for (const a of areas) {
      const r = a.range;
      if (isSingle(r)) cells.add(key(a.sheet, r.start.row, r.start.col));
      else if (width(r) > WIDE) wide.set(`${a.sheet}|${r.start.row}|${r.end.row}|${r.start.col}|${r.end.col}`, [a.sheet, r]);
      else for (let c = r.start.col; c <= r.end.col; c++) cols.set(`${a.sheet}|${c}|${r.start.row}|${r.end.row}`, [a.sheet, c, r.start.row, r.end.row]);
    }
    return [cells, [...cols.values()], [...wide.values()]];
  }
  insert(k, node) {
    this.remove(k);
    const [cells, cols, wide] = Graph.entries(node.areas);
    for (const c of cells) { let s = this.cellDeps.get(c); if (!s) this.cellDeps.set(c, s = new Set()); s.add(k); }
    for (const [s, c, r0, r1] of cols) {
      const ck = s * MAX_COLS + c;
      let iv = this.colDeps.get(ck);
      if (!iv) this.colDeps.set(ck, iv = new Intervals());
      iv.insert(r0, r1, k);
      this.unsettledCols.add(ck);
    }
    for (const [s, r] of wide) {
      let iv = this.wideDeps.get(s);
      if (!iv) this.wideDeps.set(s, iv = new Intervals());
      iv.insert(r.start.row, r.end.row, [r.start.col, r.end.col, k]);
      this.unsettledWide.add(s);
    }
    if (node.dynamic) this.dynamic.add(k);
    this.nodes.set(k, node);
  }
  remove(k) {
    const old = this.nodes.get(k);
    if (!old) return;
    this.nodes.delete(k);
    const [cells, cols, wide] = Graph.entries(old.areas);
    for (const c of cells) { const s = this.cellDeps.get(c); if (s) { s.delete(k); if (!s.size) this.cellDeps.delete(c); } }
    for (const [s, c, r0, r1] of cols) { const ck = s * MAX_COLS + c; const iv = this.colDeps.get(ck); if (iv) { iv.remove(r0, r1, k); this.unsettledCols.add(ck); } }
    for (const [s, r] of wide) { const iv = this.wideDeps.get(s); if (iv) { iv.remove(r.start.row, r.end.row, [r.start.col, r.end.col, k]); this.unsettledWide.add(s); } }
    this.dynamic.delete(k);
  }
  settle() {
    for (const ck of this.unsettledCols) { const iv = this.colDeps.get(ck); if (iv) { iv.settle(); if (iv.isEmpty()) this.colDeps.delete(ck); } }
    for (const s of this.unsettledWide) { const iv = this.wideDeps.get(s); if (iv) { iv.settle(); if (iv.isEmpty()) this.wideDeps.delete(s); } }
    this.unsettledCols.clear(); this.unsettledWide.clear();
  }
  /** Formulas that read cell (sheet, row, col). */
  dependents(sheet, row, col, out) {
    const s = this.cellDeps.get(key(sheet, row, col));
    if (s) for (const k of s) out.push(k);
    const iv = this.colDeps.get(sheet * MAX_COLS + col);
    if (iv) iv.query(row, row, k => out.push(k));
    const w = this.wideDeps.get(sheet);
    if (w) w.query(row, row, ([c0, c1, k]) => { if (c0 <= col && col <= c1) out.push(k); });
  }
  /** Formulas that read any cell of a range (a formula can be listed more than once). */
  dependentsOfRange(sheet, r, out) {
    if (rangeCount(r) <= 4096) {
      for (let row = r.start.row; row <= r.end.row; row++) for (let col = r.start.col; col <= r.end.col; col++) {
        const s = this.cellDeps.get(key(sheet, row, col));
        if (s) for (const k of s) out.push(k);
      }
    } else {
      for (const [ck, s] of this.cellDeps) {
        if (keySheet(ck) === sheet && contains(r, {row: keyRow(ck), col: keyCol(ck)})) for (const k of s) out.push(k);
      }
    }
    if (width(r) <= this.colDeps.size) {
      for (let col = r.start.col; col <= r.end.col; col++) { const iv = this.colDeps.get(sheet * MAX_COLS + col); if (iv) iv.query(r.start.row, r.end.row, k => out.push(k)); }
    } else {
      for (const [ck, iv] of this.colDeps) {
        const s = Math.floor(ck / MAX_COLS), col = ck % MAX_COLS;
        if (s === sheet && col >= r.start.col && col <= r.end.col) iv.query(r.start.row, r.end.row, k => out.push(k));
      }
    }
    const w = this.wideDeps.get(sheet);
    if (w) w.query(r.start.row, r.end.row, ([c0, c1, k]) => { if (c0 <= r.end.col && r.start.col <= c1) out.push(k); });
  }
  precedentsOf(k) { return this.nodes.get(k)?.areas ?? []; }
}

// ---------------------------------------------------------------------------------------------
// The workbook as the evaluator reads it (gridcraft Workbook API over the document content)

export class WorkbookView {
  constructor(content, engine) {
    this.content = content; this.engine = engine;
    this.sheets = content.sheets ?? [];
    this.dateSystem = content.dateSystem === 1904 ? 1904 : 1900;
    this.byName = new Map(this.sheets.map((s, i) => [s.name.toLowerCase(), i]));
    this.tables = null;
  }
  sheetIndex(name) { return this.byName.get(String(name).toLowerCase()) ?? -1; }
  name(bare, si) {
    const names = this.content.names ?? [];
    const l = bare.toLowerCase(), sheetId = this.sheets[si]?.id;
    return names.find(n => n.scope && n.scope === sheetId && n.name.toLowerCase() === l) ?? names.find(n => !n.scope && n.name.toLowerCase() === l) ?? null;
  }
  allTables() {
    if (this.tables) return this.tables;
    this.tables = [];
    this.sheets.forEach((s, si) => {
      for (const t of s.tables ?? []) {
        try {
          const g = tableRanges(t);
          const cols = (t.columns ?? []).map(c => (typeof c === 'string' ? c : c.name).toLowerCase());
          this.tables.push({sheet: si, name: t.name, ...g, columnIndex: n => cols.indexOf(String(n).toLowerCase())});
        } catch { /* a malformed table range reads as no table */ }
      }
    });
    return this.tables;
  }
  table(name) { const l = name.toLowerCase(); return this.allTables().find(t => t.name.toLowerCase() === l) ?? null; }
  tableAt(si, at) { return this.allTables().find(t => t.sheet === si && contains(t.range, at)) ?? null; }
  isRowHidden(si, row) { return isRowHidden(this.sheets[si], row); }
  isRowFiltered(si, row) {
    const sh = this.sheets[si];
    if (!isRowHidden(sh, row)) return false;
    const af = sh.autofilter;
    if (af && af.criteria && Object.keys(af.criteria).length) { const r = parseRange(af.range); if (r && row > r.start.row && row <= r.end.row) return true; }
    return this.allTables().some(t => t.sheet === si && t.data && row >= t.data.start.row && row <= t.data.end.row && (sh.tables?.find(x => x.name === t.name)?.filter?.length ?? 0) > 0);
  }
  colChars(si, col) { return pointsToChars(colWidth(this.sheets[si], col)); }
  cellStyle(si, row, col) {
    const c = cellAt(this.sheets[si], row, col);
    if (c?.style) return resolveStyle(c.style);
    return resolveStyle(styleById(this.content, c?.s ?? 0));
  }
  fileName() { return this.engine?.fileName ?? ''; }
}

// ---------------------------------------------------------------------------------------------
// pass_host.rs

const MAX_NESTED = 64;
const MAX_ITERATION_WORK = 10_000_000;

class PassHost {
  constructor(engine, exprs, now) {
    this.engine = engine; this.wb = engine.wb; this.exprs = exprs;
    this.results = new Map(); this.pending = new Set(exprs.keys()); this.inProgress = new Set();
    this.spills = new Map(); this.used = new Map(); this.now = now;
    this.cycles = []; this.cycleSeen = new Set(); this.depth = 0; this.suspend = null;
    this.waiting = new Set(); this.abandoned = []; this.also = [];
    this.iterate = false; this.prev = new Map(); this.stack = []; this.members = new Set(); this.tainted = new Set(); this.taint = false;
    this.outOfStack = false; this.evalDepth = 0; this.volatile = false; this.suspensions = 0;
  }
  calculate(k) {
    const work = [[k, []]];
    while (work.length) {
      const top = work[work.length - 1][0];
      this.compute(top);
      const next = this.suspend;
      if (next !== null) {
        this.suspend = null;
        this.suspensions++;
        const held = this.abandoned; this.abandoned = [];
        for (const h of held) this.waiting.add(h);
        work[work.length - 1][1] = held;
        const seen = new Set([next]);
        for (const s of this.also) if (!seen.has(s)) { seen.add(s); work.push([s, []]); }
        this.also = [];
        work.push([next, []]);
      } else {
        work.pop();
        if (work.length) { for (const a of work[work.length - 1][1]) this.waiting.delete(a); work[work.length - 1][1] = []; }
      }
    }
  }
  compute(k) {
    if (this.results.has(k)) {
      if (this.iterate && this.tainted.has(k)) this.taint = true;
      return this.results.get(k);
    }
    const expr = this.exprs.get(k);
    if (expr === undefined) return this.engine.sheetValue(keySheet(k), keyRow(k), keyCol(k));
    if (this.suspend !== null) {
      if (this.depth >= MAX_NESTED && !this.inProgress.has(k) && !this.waiting.has(k)) this.also.push(k);
      return ERR.Calc;
    }
    if (this.inProgress.has(k) || this.waiting.has(k)) {
      if (this.iterate) return this.circularRead(k);
      if (!this.cycleSeen.has(k)) { this.cycleSeen.add(k); this.cycles.push(k); }
      return ERR.Circ;
    }
    if (this.depth >= MAX_NESTED) { this.suspend = k; return ERR.Calc; }
    this.inProgress.add(k);
    this.depth++;
    const outerTaint = this.taint; this.taint = false;
    if (this.iterate) this.stack.push(k);
    const outerOut = this.outOfStack; this.outOfStack = false;
    const savedEvalDepth = this.evalDepth;
    if (this.depth === 1) this.evalDepth = 0;
    let v;
    if (expr === null) v = ERR.Name;
    else { const ev = new Evaluator(this, keySheet(k), {row: keyRow(k), col: keyCol(k)}); v = ev.value(expr); }
    this.evalDepth = savedEvalDepth;
    const out = this.outOfStack; this.outOfStack = outerOut;
    if (out && this.depth > 1 && this.suspend === null) {
      this.suspend = k; this.depth--; this.inProgress.delete(k);
      if (this.iterate) this.stack.pop();
      this.taint = outerTaint;
      return ERR.Calc;
    }
    if (this.suspend !== null) {
      this.depth--; this.inProgress.delete(k); this.abandoned.push(k);
      if (this.iterate) this.stack.pop();
      this.taint = outerTaint;
      return ERR.Calc;
    }
    const legacy = this.engine.legacyArrayRange(k);
    if (legacy) v = fitToRange(v, legacy);
    this.depth--; this.inProgress.delete(k); this.pending.delete(k);
    if (this.iterate) { this.stack.pop(); if (this.taint) this.tainted.add(k); else this.tainted.delete(k); }
    this.taint ||= outerTaint;
    const keepBlanks = expr && expr.t === 'call' && (expr.name === 'GROUPBY' || expr.name === 'PIVOTBY');
    if (v instanceof GArray) {
      let a = v;
      if (!keepBlanks && a.data.some(x => x === null || x === undefined)) a = new GArray(a.rows, a.cols, a.data.map(x => (x === null || x === undefined ? 0 : x)));
      this.spills.set(k, a);
      v = a.data[0] ?? null;
    } else if (v === null || v === undefined) v = 0;
    const sp = this.spills.get(k);
    if (sp && this.spillBlocked(k, sp)) { this.spills.delete(k); v = ERR.Spill; }
    this.results.set(k, v);
    return v;
  }
  spillBlocked(k, a) {
    const si = keySheet(k), ar = keyRow(k), ac = keyCol(k);
    const sh = this.wb.sheets[si];
    if (!sh) return false;
    const er = ar + Math.max(a.rows - 1, 0), ec = ac + Math.max(a.cols - 1, 0);
    if (er >= MAX_ROWS || ec >= MAX_COLS) return true;
    const range = rangeOf(ar, ac, er, ec);
    if (merges(sh).some(m => intersects(m, range))) return true;
    if (this.wb.allTables().some(t => t.sheet === si && contains(t.range, {row: ar, col: ac}))) return true;
    let blocked = false;
    forEachCell(sh, ar, ac, er, ec, (r, c, cell) => {
      if ((r !== ar || c !== ac) && hasContent(cell)) { blocked = true; return false; }
      return true;
    });
    if (blocked) return true;
    const own = this.engine.spillRanges.get(k);
    for (const [anchor, rr] of this.engine.spillRanges) {
      if (anchor === k || keySheet(anchor) !== si || this.exprs.has(anchor) || !intersects(rr, range)) continue;
      const inter = rr && range ? true : false;
      if (inter && !(own && contains(own, rr.start) && contains(own, rr.end))) return true;
    }
    return false;
  }
  previous(k) {
    const v = this.prev.has(k) ? this.prev.get(k) : this.engine.sheetValue(keySheet(k), keyRow(k), keyCol(k));
    return v === null || v === undefined || v === ERR.Circ ? 0 : v;
  }
  circularRead(k) {
    this.taint = true;
    const i = this.stack.lastIndexOf(k);
    if (i >= 0) for (const s of this.stack.slice(i)) this.members.add(s); else this.members.add(k);
    return this.previous(k);
  }
  iterateLoops(order, maxIterations, maxChange) {
    const again = order.filter(k => this.tainted.has(k));
    const set = new Set(again);
    const maxPasses = Math.max(1, Math.floor(MAX_ITERATION_WORK / Math.max(again.length, 1)));
    let passes = 1;
    while (passes < Math.min(maxIterations, maxPasses) && !this.converged(maxChange)) {
      this.prev = new Map();
      for (const k of again) if (this.results.has(k)) { this.prev.set(k, this.results.get(k)); this.results.delete(k); }
      this.pending = new Set(set);
      for (const a of [...this.spills.keys()]) if (set.has(a)) this.spills.delete(a);
      for (const k of again) this.calculate(k);
      passes++;
    }
    return passes;
  }
  converged(maxChange) {
    for (const k of this.members) {
      if (!this.results.has(k)) continue;
      const n = this.results.get(k), o = this.previous(k);
      if (typeof n === 'number' && typeof o === 'number') { const d = Math.abs(n - o); if (!(d < maxChange || d === 0)) return false; }
      else if (!sameValue(n, o)) return false;
    }
    return true;
  }
  // Host
  stackExhausted() { this.outOfStack = true; }
  noteVolatile() { this.volatile = true; }
  nowSerial() { return this.now; }
  random() { return this.engine.random(); }
  formulaText(si, row, col) { return this.engine.formulaText(si, row, col); }
  spillRange(si, row, col) {
    const k = key(si, row, col);
    if (!(this.pending.has(k) || this.results.has(k))) return this.engine.spillRanges.get(k) ?? null;
    this.compute(k);
    const arr = this.spills.get(k);
    if (!arr) return null;
    const er = row + Math.max(arr.rows - 1, 0), ec = col + Math.max(arr.cols - 1, 0);
    if (er >= MAX_ROWS || ec >= MAX_COLS) return null;
    const range = rangeOf(row, col, er, ec), sh = this.wb.sheets[si];
    let blocked = merges(sh).some(m => intersects(m, range));
    if (!blocked) forEachCell(sh, row, col, er, ec, (r, c, cell) => { if ((r !== row || c !== col) && hasContent(cell)) { blocked = true; return false; } return true; });
    return blocked ? null : range;
  }
  cellValue(si, row, col) {
    const k = key(si, row, col);
    if (this.pending.has(k) || this.results.has(k)) return this.compute(k);
    for (const [anchor, arr] of this.spills) {
      if (keySheet(anchor) !== si) continue;
      const ar = keyRow(anchor), ac = keyCol(anchor);
      if (row >= ar && col >= ac && row - ar < arr.rows && col - ac < arr.cols) {
        if (this.iterate && this.tainted.has(anchor)) this.taint = true;
        return arr.get(row - ar, col - ac) ?? null;
      }
    }
    return this.engine.sheetValue(si, row, col);
  }
  usedRange(si) {
    if (!this.used.has(si)) this.used.set(si, this.engine.usedRange(si));
    return this.used.get(si);
  }
  rangeValues(si, r) {
    const h = height(r), w = width(r);
    const out = new Array(h * w).fill(null);
    const sh = this.wb.sheets[si];
    if (!sh) return out;
    const formulas = [];
    forEachCell(sh, r.start.row, r.start.col, r.end.row, r.end.col, (row, col, cell) => {
      const i = (row - r.start.row) * w + (col - r.start.col);
      if (cell.f !== undefined) formulas.push([i, row, col]);
      else out[i] = fromJSONValue(cell.v);
      return true;
    });
    for (const [ak, rr] of this.engine.spillRanges) {
      if (keySheet(ak) !== si || !intersects(rr, r)) continue;
      for (let row = Math.max(rr.start.row, r.start.row); row <= Math.min(rr.end.row, r.end.row); row++) {
        for (let col = Math.max(rr.start.col, r.start.col); col <= Math.min(rr.end.col, r.end.col); col++) {
          const i = (row - r.start.row) * w + (col - r.start.col);
          if (out[i] === null) { const v = this.engine.spill.get(key(si, row, col)); if (v !== undefined) out[i] = v; }
        }
      }
    }
    for (const [i, row, col] of formulas) out[i] = this.cellValue(si, row, col);
    if (this.spills.size) {
      for (const [anchor, arr] of this.spills) {
        if (keySheet(anchor) !== si) continue;
        const ar = keyRow(anchor), ac = keyCol(anchor);
        for (let dr = 0; dr < arr.rows; dr++) for (let dc = 0; dc < arr.cols; dc++) {
          const row = ar + dr, col = ac + dc;
          if ((dr || dc) && row >= r.start.row && row <= r.end.row && col >= r.start.col && col <= r.end.col) out[(row - r.start.row) * w + (col - r.start.col)] = arr.get(dr, dc) ?? null;
        }
        if (this.iterate && this.tainted.has(anchor)) this.taint = true;
      }
    }
    return out;
  }
  visitRange(si, r, fn) {
    const sh = this.wb.sheets[si];
    if (!sh) return false;
    forEachCell(sh, r.start.row, r.start.col, r.end.row, r.end.col, (row, col, cell) => { if (cell.f !== undefined) this.cellValue(si, row, col); return true; });
    for (const a of this.spills.keys()) if (keySheet(a) === si) return false;
    for (const [ak, rr] of this.engine.spillRanges) if (keySheet(ak) === si && intersects(rr, r)) return false;
    let go = true;
    forEachCell(sh, r.start.row, r.start.col, r.end.row, r.end.col, (row, col, cell) => {
      go = fn(cell.f !== undefined ? this.cellValue(si, row, col) : fromJSONValue(cell.v));
      return go;
    });
    return true;
  }
}

/** A legacy (Ctrl+Shift+Enter) array formula's result fitted to the range it was entered in. */
function fitToRange(v, r) {
  if (rangeCount(r) > 16_000_000) return ERR.Num;
  const h = height(r), w = width(r);
  if (!(v instanceof GArray)) return h * w === 1 ? v : GArray.filled(h, w, v);
  if (h * w === 1) return v.data[0] ?? null;
  const data = [];
  for (let row = 0; row < h; row++) for (let c = 0; c < w; c++) {
    const x = v.get(v.rows === 1 ? 0 : row, v.cols === 1 ? 0 : c);
    data.push(x === undefined ? ERR.NA : x);
  }
  return new GArray(h, w, data);
}

// ---------------------------------------------------------------------------------------------
// recalc.rs: the engine

const exprCache = new Map();
function exprOf(text) {
  let e = exprCache.get(text);
  if (e === undefined) {
    e = parseFormula(text);
    if (exprCache.size > 50_000) exprCache.clear();
    exprCache.set(text, e);
  }
  return e;
}

/** Strongly connected components (Tarjan, iterative): [componentOf[], sizes[]]. */
function components(edges) {
  const n = edges.length, low = new Array(n).fill(0), num = new Array(n).fill(-1), onStack = new Array(n).fill(false), comp = new Array(n).fill(-1);
  const stack = [];
  let next = 0, comps = 0;
  for (let root = 0; root < n; root++) {
    if (num[root] >= 0) continue;
    const call = [[root, 0]];
    num[root] = low[root] = next++;
    stack.push(root); onStack[root] = true;
    while (call.length) {
      const top = call[call.length - 1], v = top[0];
      if (top[1] < edges[v].length) {
        const w = edges[v][top[1]++];
        if (num[w] < 0) { num[w] = low[w] = next++; stack.push(w); onStack[w] = true; call.push([w, 0]); }
        else if (onStack[w]) low[v] = Math.min(low[v], num[w]);
        continue;
      }
      call.pop();
      if (call.length) { const u = call[call.length - 1][0]; low[u] = Math.min(low[u], low[v]); }
      if (low[v] === num[v]) { for (;;) { const w = stack.pop(); onStack[w] = false; comp[w] = comps; if (w === v) break; } comps++; }
    }
  }
  const size = new Array(comps).fill(0);
  for (const c of comp) size[c]++;
  return [comp, size];
}

export class CalcEngine {
  constructor() {
    this.content = null; this.wb = null;
    this.graph = new Graph();
    this.formulas = new Map();     // key -> formula text
    this.vals = new Map();         // key -> value of a formula cell
    this.spill = new Map();        // key -> spilled value (non-anchor cells)
    this.spillRanges = new Map();  // anchor key -> range
    this.circular = [];
    this.rng = 0x9E3779B97F4A7C15n;
    this.fixedNow = null;
    this.lastRecalcCells = 0;
    this.lastRecalcMs = 0;
    this.fileName = '';
    this.version = 0;
  }
  now() { return this.fixedNow ?? serialFromUnixMs(unixNowMs()); }
  random() {
    let x = this.rng;
    x ^= x >> 12n; x ^= (x << 25n) & 0xFFFFFFFFFFFFFFFFn; x ^= x >> 27n;
    this.rng = x;
    return Number(((x * 0x2545F4914F6CDD1Dn) & 0xFFFFFFFFFFFFFFFFn) >> 11n) / 2 ** 53;
  }

  // -- reads -----------------------------------------------------------------------------------
  /** The value a cell shows: its formula's result, its constant, or a spilled value. */
  sheetValue(si, row, col) {
    const k = key(si, row, col);
    if (this.formulas.has(k)) return this.vals.has(k) ? this.vals.get(k) : null;
    const c = cellAt(this.wb.sheets[si], row, col);
    if (c && c.v !== undefined && c.v !== null) return fromJSONValue(c.v);
    const s = this.spill.get(k);
    return s === undefined ? null : s;
  }
  formulaText(si, row, col) { return this.formulas.get(key(si, row, col)) ?? null; }
  legacyArrayRange(k) {
    const c = cellAt(this.wb.sheets[keySheet(k)], keyRow(k), keyCol(k));
    return c?.a ? parseRange(c.a) : null;
  }
  usedRange(si) {
    const b = usedBounds(this.wb.sheets[si]);
    let r = b ? rangeOf(b.r0, b.c0, b.r1, b.c1) : null;
    for (const [ak, rr] of this.spillRanges) if (keySheet(ak) === si) r = r ? union(r, rr) : rr;
    return r;
  }
  /** The spill range of the dynamic array anchored at (si, row, col), or null. */
  spillRangeAt(si, row, col) { return this.spillRanges.get(key(si, row, col)) ?? null; }
  /** The anchor of the spill covering a non-anchor cell: {row, col, range} or null. */
  spillAnchorOf(si, row, col) {
    for (const [ak, rr] of this.spillRanges) {
      if (keySheet(ak) === si && contains(rr, {row, col}) && !(keyRow(ak) === row && keyCol(ak) === col)) return {row: keyRow(ak), col: keyCol(ak), range: rr};
    }
    return null;
  }

  // -- sync with the content --------------------------------------------------------------------
  /** Brings the engine to `content` (diffing from the content it last saw) and recalculates. */
  sync(content) {
    if (content === this.content) return false;
    const prev = this.content;
    const structural = !prev || structureChanged(prev, content);
    this.content = content;
    this.wb = new WorkbookView(content, this);
    this.version++;
    const t0 = Date.now();
    if (structural) this.recalcAll();
    else {
      const changed = [], extra = [];
      content.sheets.forEach((sheet, si) => {
        const old = prev.sheets[si];
        if (old === sheet) return;
        diffSheet(old, sheet, si, changed);
        if ((old.rows !== sheet.rows || old.merges !== sheet.merges || old.xlsxLayout !== sheet.xlsxLayout)) {
          for (const k of this.spillRanges.keys()) if (keySheet(k) === si) extra.push(k);
          for (const [k, f] of this.formulas) if (keySheet(k) === si && /SUBTOTAL|AGGREGATE/i.test(f)) extra.push(k);
        }
      });
      // A diff touching more cells than a full pass would visit recalculates from scratch.
      if (changed.length > 50_000 && changed.length > this.formulas.size) this.recalcAll();
      else if (changed.length || extra.length) this.cellsChanged(changed, extra);
    }
    this.lastRecalcMs = Date.now() - t0;
    return true;
  }

  /** Rebuilds the graph from scratch. */
  rebuild() {
    this.graph = new Graph();
    this.formulas = new Map();
    const wb = this.wb;
    wb.sheets.forEach((sheet, si) => {
      const blocks = sheetBlocks(sheet), legacy = isLegacySheet(sheet);
      for (const bk in blocks) {
        const e = blockEntries(blocks[bk]);
        for (let i = 0; i < e.cells.length; i++) {
          const cell = legacy ? fromLegacyCell(e.cells[i]) : e.cells[i];
          if (cell.f === undefined) continue;
          const k = key(si, e.rows[i], e.cols[i]);
          this.formulas.set(k, cell.f);
          const expr = exprOf(cell.f);
          if (expr) { const [areas, dynamic] = precedents(wb, si, expr); this.graph.insert(k, {areas, dynamic}); }
        }
      }
    });
    this.graph.settle();
  }
  /** Recalculates every formula (F9 / Ctrl+Alt+F9, and after loading). */
  recalcAll() {
    this.rebuild();
    this.vals = new Map(); this.spill = new Map(); this.spillRanges = new Map(); this.circular = [];
    this.run([...this.formulas.keys()]);
  }

  /** Updates the graph for cells whose content changed and recalculates their dependents. */
  cellsChanged(changed, extraSeeds = []) {
    const wb = this.wb;
    const cleared = [];
    for (const k of changed) {
      const si = keySheet(k), row = keyRow(k), col = keyCol(k);
      const cell = cellAt(wb.sheets[si], row, col);
      if (cell?.f !== undefined) {
        this.formulas.set(k, cell.f);
        const expr = exprOf(cell.f);
        if (expr) { const [areas, dynamic] = precedents(wb, si, expr); this.graph.insert(k, {areas, dynamic}); }
        else { this.graph.remove(k); this.graph.nodes.delete(k); }
      } else {
        this.formulas.delete(k);
        this.vals.delete(k);
        this.graph.remove(k);
        const r = this.spillRanges.get(k);
        if (r) {
          this.spillRanges.delete(k);
          for (let rr = r.start.row; rr <= r.end.row; rr++) for (let cc = r.start.col; cc <= r.end.col; cc++) this.spill.delete(key(si, rr, cc));
          cleared.push([si, r]);
        }
      }
    }
    this.graph.settle();
    const manual = wb.content.calc?.mode === 'manual';
    if (manual) { this.run(changed.filter(k => this.formulas.has(k))); return; }
    const seeds = [...changed, ...extraSeeds];
    // Formulas showing #SPILL! (usually none): the only ones a freed cell can unblock. Collected
    // once, so an edit of n cells costs O(n + spill errors), not O(n x formulas).
    const spillErrors = [];
    for (const [fk, val] of this.vals) if (val === ERR.Spill) spillErrors.push(fk);
    const emptied = new Map();
    for (const k of changed) {
      const si = keySheet(k), row = keyRow(k), col = keyCol(k);
      for (const [anchor, r] of this.spillRanges) if (anchor !== k && keySheet(anchor) === si && contains(r, {row, col})) seeds.push(anchor);
      for (const fk of spillErrors) {
        if (keySheet(fk) !== si || fk === k) continue;
        const fr = keyRow(fk), fc = keyCol(fk);
        if (fr <= row && fc <= col && fr >= row - 64 && fc >= col - 64) seeds.push(fk);
      }
      if (!hasContent(cellAt(wb.sheets[si], row, col))) {
        const e = emptied.get(si);
        emptied.set(si, e ? {row: Math.max(e.row, row), col: Math.max(e.col, col)} : {row, col});
      }
    }
    for (const [si, end] of emptied) {
      for (const fk of spillErrors) {
        if (keySheet(fk) === si && keyRow(fk) <= end.row && keyCol(fk) <= end.col) seeds.push(fk);
      }
    }
    for (const k of changed) {
      const r = this.spillRanges.get(k);
      if (r) for (let rr = r.start.row; rr <= r.end.row; rr++) for (let cc = r.start.col; cc <= r.end.col; cc++) seeds.push(key(keySheet(k), rr, cc));
    }
    for (const [si, r] of cleared) for (let rr = r.start.row; rr <= r.end.row; rr++) for (let cc = r.start.col; cc <= r.end.col; cc++) seeds.push(key(si, rr, cc));
    this.run(this.dirtyClosure(seeds));
  }

  dirtyClosure(seeds) {
    const seen = new Set(), queue = [];
    const deps = [];
    const visit = k => { if (!seen.has(k)) { seen.add(k); queue.push(k); } };
    for (const k of seeds) {
      if (this.graph.nodes.has(k) || this.formulas.has(k)) visit(k);
      deps.length = 0;
      this.graph.dependents(keySheet(k), keyRow(k), keyCol(k), deps);
      for (const d of deps) visit(d);
    }
    for (const k of this.graph.dynamic) visit(k);
    for (let i = 0; i < queue.length; i++) {
      const k = queue[i];
      deps.length = 0;
      this.graph.dependents(keySheet(k), keyRow(k), keyCol(k), deps);
      for (const d of deps) visit(d);
    }
    return [...seen];
  }

  /** Evaluates the dirty set and keeps the results (and spills). */
  run(dirty0) {
    let dirty = dirty0;
    let dynamicAgain = this.graph.dynamic.size > 0;
    this.lastRecalcCells = 0;
    const calc = this.wb.content.calc ?? {};
    for (let round = 0; round < 8 && dirty.length; round++) {
      dirty.sort((a, b) => a - b);
      const exprs = new Map();
      for (const k of dirty) { const f = this.formulas.get(k); if (f !== undefined) exprs.set(k, exprOf(f)); }
      const host = new PassHost(this, exprs, this.now());
      host.iterate = !!calc.iterative;
      for (const k of dirty) if (exprs.has(k)) host.calculate(k);
      if (host.iterate && host.members.size) host.iterateLoops(dirty, Math.min(Math.max(1, calc.maxIterations ?? 100), 32767), Math.abs(calc.maxChange ?? 0.001));
      this.lastRecalcCells += host.results.size;
      if (this.circular.length) { const ev = new Set(dirty); this.circular = this.circular.filter(k => !ev.has(k)); }
      this.circular.push(...host.cycles);
      const spillChanges = this.writeBack(dirty, host.results, host.spills);
      if (dynamicAgain && host.spills.size) { dynamicAgain = false; spillChanges.push(...this.graph.dynamic); }
      if (!spillChanges.length) break;
      dirty = this.dirtyClosure([...new Set(spillChanges)]);
    }
    if (calc.iterative) this.circular = [];
    else this.circular = this.circular.filter(k => this.formulas.has(k));
  }

  writeBack(dirty, results, spills) {
    const spillChanges = [], freed = [];
    for (const [k, v] of results) this.vals.set(k, v);
    for (const k of dirty) {
      const nw = spills.get(k), old = this.spillRanges.get(k) ?? null;
      if (!old && !nw) continue;
      const si = keySheet(k), ar = keyRow(k), ac = keyCol(k);
      if (old && nw && this.spillsAsBefore(si, ar, ac, old, nw)) continue;
      if (old) {
        for (let r = old.start.row; r <= old.end.row; r++) for (let c = old.start.col; c <= old.end.col; c++) this.spill.delete(key(si, r, c));
        this.spillRanges.delete(k);
      }
      let changedRange = old;
      if (nw) {
        const er = ar + nw.rows - 1, ec = ac + nw.cols - 1;
        const range = rangeOf(ar, ac, Math.min(er, MAX_ROWS - 1), Math.min(ec, MAX_COLS - 1));
        if (this.spillIsBlocked(si, ar, ac, range, er, ec)) {
          this.vals.set(k, ERR.Spill);
          const deps = [];
          this.graph.dependentsOfRange(si, range, deps);
          spillChanges.push(...deps.filter(d => d !== k));
        } else {
          let i = 0;
          for (let r = ar; r <= er; r++) for (let c = ac; c <= ec; c++, i++) if (r !== ar || c !== ac) this.spill.set(key(si, r, c), nw.data[i] ?? null);
          this.spillRanges.set(k, range);
          changedRange = changedRange ? union(changedRange, range) : range;
        }
      }
      if (changedRange) {
        const deps = [];
        this.graph.dependentsOfRange(si, changedRange, deps);
        const cur = this.spillRanges.get(k);
        const freedOld = old && cur ? !(contains(cur, old.start) && contains(cur, old.end)) : !cur;
        spillChanges.push(...deps.filter(d => d !== k || freedOld));
      }
      const cur = this.spillRanges.get(k);
      if (old && !(cur && contains(cur, old.start) && contains(cur, old.end))) freed.push([si, old]);
    }
    for (const [si, r] of freed) {
      for (const fk of this.formulas.keys()) {
        if (keySheet(fk) === si && keyRow(fk) <= r.end.row && keyCol(fk) <= r.end.col && this.vals.get(fk) === ERR.Spill) spillChanges.push(fk);
      }
    }
    return spillChanges;
  }
  spillIsBlocked(si, ar, ac, range, er, ec) {
    if (er >= MAX_ROWS || ec >= MAX_COLS) return true;
    const sh = this.wb.sheets[si];
    let blocked = false;
    forEachCell(sh, range.start.row, range.start.col, range.end.row, range.end.col, (r, c, cell) => {
      if ((r !== ar || c !== ac) && hasContent(cell)) { blocked = true; return false; }
      return true;
    });
    if (blocked) return true;
    for (let r = range.start.row; r <= range.end.row && !blocked; r++) for (let c = range.start.col; c <= range.end.col; c++) {
      if ((r !== ar || c !== ac) && this.spill.has(key(si, r, c))) { blocked = true; break; }
    }
    if (blocked) return true;
    if (merges(sh).some(m => intersects(m, range))) return true;
    return this.wb.allTables().some(t => t.sheet === si && contains(t.range, {row: ar, col: ac}));
  }
  spillsAsBefore(si, ar, ac, range, arr) {
    const er = ar + Math.max(arr.rows - 1, 0), ec = ac + Math.max(arr.cols - 1, 0);
    if (range.start.row !== ar || range.start.col !== ac || range.end.row !== er || range.end.col !== ec) return false;
    const sh = this.wb.sheets[si];
    if (merges(sh).some(m => intersects(m, range))) return false;
    if (this.wb.allTables().some(t => t.sheet === si && contains(t.range, {row: ar, col: ac}))) return false;
    let i = 0;
    for (let r = ar; r <= er; r++) for (let c = ac; c <= ec; c++, i++) {
      if (r === ar && c === ac) continue;
      if (hasContent(cellAt(sh, r, c))) return false;
      const s = this.spill.get(key(si, r, c));
      if (s === undefined || !sameValue(s, arr.data[i] ?? null)) return false;
    }
    return true;
  }

  /** Evaluates a formula in the context of a cell without storing it (CF, validation, Evaluate Formula). */
  evaluate(si, at, formula) {
    const body = String(formula).replace(/^=/, '');
    const expr = parseFormula(body);
    if (!expr) return ERR.Name;
    const host = new PassHost(this, new Map(), this.now());
    return new Evaluator(host, si, at).value(expr);
  }
  /** Circular references (formula keys) as {sheet, row, col}. */
  circularCells() { return this.circular.map(k => ({sheet: keySheet(k), row: keyRow(k), col: keyCol(k)})); }
}

// ---------------------------------------------------------------------------------------------
// Diffs

function structureChanged(prev, next) {
  if (!Array.isArray(prev.sheets) || !Array.isArray(next.sheets) || prev.sheets.length !== next.sheets.length) return true;
  if (prev.names !== next.names || prev.dateSystem !== next.dateSystem || prev.calc !== next.calc) return true;
  for (let i = 0; i < next.sheets.length; i++) {
    const a = prev.sheets[i], b = next.sheets[i];
    if (a === b) continue;
    if (a.id !== b.id || a.name !== b.name || a.tables !== b.tables || isLegacySheet(a) !== isLegacySheet(b)) return true;
  }
  return false;
}

/** Pushes keys of cells that differ between two versions of a sheet (only touched blocks are visited). */
function diffSheet(a, b, si, out) {
  if (isLegacySheet(b)) {
    if (a.cells === b.cells) return;
    const seen = new Set();
    for (const k in b.cells) { seen.add(k); if (a.cells?.[k] !== b.cells[k]) { const p = parseKey(k); if (p) out.push(key(si, p[0], p[1])); } }
    for (const k in a.cells ?? {}) if (!seen.has(k)) { const p = parseKey(k); if (p) out.push(key(si, p[0], p[1])); }
    return;
  }
  const ba = a.blocks ?? {}, bb = b.blocks ?? {};
  if (ba === bb) return;
  const keys = new Set([...Object.keys(ba), ...Object.keys(bb)]);
  for (const bk of keys) {
    const x = ba[bk], y = bb[bk];
    if (x === y) continue;
    if (x) for (const ck in x) if (!y || y[ck] !== x[ck]) { const p = parseKey(ck); if (p) out.push(key(si, p[0], p[1])); }
    if (y) for (const ck in y) if (!x || !(ck in x)) { const p = parseKey(ck); if (p) out.push(key(si, p[0], p[1])); }
  }
}

// ---------------------------------------------------------------------------------------------
// One engine per workbook lineage

const engines = new WeakMap();   // content -> engine
const recent = [];               // engines most recently used (lineage lookup)
const RECENT = 8;

/** The engine for a content object, synced to it (an engine following the same workbook is reused). */
export function engineFor(content) {
  let e = engines.get(content);
  if (e) { e.sync(content); return e; }
  e = findLineage(content) ?? new CalcEngine();
  e.sync(content);
  engines.set(content, e);
  const i = recent.indexOf(e);
  if (i >= 0) recent.splice(i, 1);
  recent.unshift(e);
  if (recent.length > RECENT) recent.length = RECENT;
  return e;
}
function findLineage(content) {
  const ids = (content.sheets ?? []).map(s => s.id).join('\u0000');
  let best = null, bestScore = 0;
  for (const e of recent) {
    const c = e.content;
    if (!c || (c.sheets ?? []).map(s => s.id).join('\u0000') !== ids) continue;
    let score = 0;
    content.sheets.forEach((s, i) => {
      const o = c.sheets[i];
      if (o === s) score += 1000;
      else if (o && o.blocks && s.blocks) for (const bk in s.blocks) if (o.blocks[bk] === s.blocks[bk]) score++;
    });
    if (score > bestScore) { best = e; bestScore = score; }
  }
  return best;
}
/** Forget the engine attached to a content lineage (tests). */
export function dropEngines() { recent.length = 0; }
