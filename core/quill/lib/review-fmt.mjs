// Tracked formatting changes (U:quill/review): recording them while Track Changes is on,
// describing them ("Formatted: Bold, Size: 14") and accepting or rejecting them.
//
// Translated from wordcraft crates/engine/src/cmd/fmt_revisions.rs (`records`, `Recorder`,
// `record`, `compare_formatting`, `diff`, `char_diff`, `para_diff`, `section_diff`, `describe`,
// `words`, `resolve_char`, `resolve_para`, `resolve_containers`, `resolve_table`, `resolve_row`,
// `resolve_cell`, `resolve_section`, `table_diff`, `row_diff`, `cell_diff`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Recording isn't done by each formatting command: after any command that edits the document,
// `recordFormatting` (core/quill/hooks.mjs) compares the paragraphs it changed with the document
// before it, as upstream's Session::run does. Shapes: a run's or mark's `fmtChange` and a
// paragraph's, table's, row's, cell's or section's `fmtChange` are `{rev, old}` (docx-read.mjs).

import {charFormatting, paraFormatting} from '../model/props.mjs';
import * as P from '../model/para.mjs';

/** Tables nested deeper than this aren't compared (hostile documents). */
const MAX_DEPTH = 16;

/** Commands whose formatting edits aren't the author's own changes (records). */
export function records(id) {
  return !(id.startsWith('review.accept') || id.startsWith('review.reject') || ['review.compare', 'review.combine', 'edit.undo', 'edit.redo'].includes(id)
    || id.startsWith('file.'));
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Deep equality of JSON values, absent and undefined keys alike. */
export function deepEq(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
  if (!isObj(a) || !isObj(b)) return false;
  const ka = Object.keys(a).filter(k => a[k] !== undefined), kb = Object.keys(b).filter(k => b[k] !== undefined);
  return ka.length === kb.length && ka.every(k => deepEq(a[k], b[k]));
}

const stripTable = t => { const o = {...(t ?? {})}; delete o.fmtChange; return o; };
const stripRow = stripTable;
const stripCell = c => { const o = {...(c ?? {})}; delete o.fmtChange; delete o.span; delete o.vmerge; return o; };
const stripSection = s => { const o = {...(s ?? {})}; delete o.fmtChange; delete o.headers; delete o.footers; return o; };

/**
 * The formatting recorder (Recorder): `revisions()` reads the document's revision list as it is
 * now, `addRevision(rev)` appends one and returns its index; `before` is the list before the
 * command (whose authors decide what is "own").
 */
class Recorder {
  constructor({author, date, before, revisions, addRevision}) {
    Object.assign(this, {author, date, before: before ?? [], revisionsNow: revisions, addRevision, ridCache: null});
  }
  rid() {
    if (this.ridCache !== null) return this.ridCache;
    const list = this.revisionsNow();
    let found = -1;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].kind === 'format' && list[i].author === this.author && list[i].date === this.date) { found = i; break; }
    this.ridCache = found >= 0 ? found : this.addRevision({kind: 'format', author: this.author, date: this.date});
    return this.ridCache;
  }
  own(rev) { return this.before[rev]?.author === this.author; }
  /** The change `after` should carry, or undefined when it already carries the right one (change). */
  change(before, after, f) {
    const fb = f(before ?? {}), fa = f(after ?? {});
    const had = before?.fmtChange ?? null, has = after?.fmtChange ?? null;
    let want;
    if (deepEq(fb, fa)) {
      if (has) return undefined;
      want = had;
    } else {
      const own = had && this.own(had.rev) ? had : null;
      const old = own ? own.old : fb;
      want = deepEq(old, fa) ? null : {rev: own ? own.rev : this.rid(), old: structuredClone(old)};
    }
    return deepEq(want ?? null, has ?? null) ? undefined : {want: want ?? null};
  }
  /** Record the formatting changes between `b` and `a` (the same text) into the mutable `a` (para). */
  para(b, a) {
    const runs = [];
    const rb = P.runRanges(b), ra = P.runRanges(a);
    let i = 0, j = 0;
    while (i < rb.length && j < ra.length) {
      const [xs, xe, pb] = rb[i], [ys, ye, pa] = ra[j];
      const from = Math.max(xs, ys), to = Math.min(xe, ye);
      const ownInsert = pa.ins !== undefined && pa.ins !== null && this.revisionsNow()[pa.ins]?.author === this.author;
      if (from < to && !ownInsert) {
        const r = this.change(pb, pa, charFormatting);
        if (r) runs.push([from, to, r.want]);
      }
      if (xe <= ye) i++;
      if (ye <= xe) j++;
    }
    const mark = this.change(b.mark ?? {}, a.mark ?? {}, charFormatting);
    const props = this.change(b.props ?? {}, a.props ?? {}, paraFormatting);
    if (!runs.length && !mark && !props) return false;
    for (const [from, to, want] of runs) P.formatRange(a, from, to, c => { if (want) c.fmtChange = want; else delete c.fmtChange; });
    if (mark) { const m = {...(a.mark ?? {})}; if (mark.want) m.fmtChange = mark.want; else delete m.fmtChange; if (Object.keys(m).length) a.mark = m; else delete a.mark; }
    if (props) { const pp = {...(a.props ?? {})}; if (props.want) pp.fmtChange = props.want; else delete pp.fmtChange; if (Object.keys(pp).length) a.props = pp; else delete a.props; }
    return true;
  }
}

/**
 * Record the formatting changes a command made (compared with `beforeContent`) as tracked
 * formatting changes into the Document `d` (record). Only blocks that are new objects are
 * compared; lists of a different length are skipped, as upstream does.
 */
export function recordFormatting(d, beforeContent, {author, date}) {
  const before = beforeContent;
  const rec = new Recorder({author, date, before: before.revisions ?? [], revisions: () => d.c.revisions ?? [],
    addRevision: r => { d.updateField('revisions', rs => [...(rs ?? []), r]); return d.c.revisions.length - 1; }});
  const walk = (story, bBlocks, aBlocks, prefix, depth) => {
    if (bBlocks.length !== aBlocks.length || depth > MAX_DEPTH) return;
    for (let k = 0; k < bBlocks.length; k++) {
      const b = bBlocks[k], a = aBlocks[k];
      if (b === a) continue;
      const path = [...prefix, k];
      if (b.kind === 'para' && a.kind === 'para' && b.text === a.text) {
        const probe = structuredClone(a);
        let changed = rec.para(b, probe);
        let section = null;
        if (b.section && a.section) {
          const r = rec.change(b.section, a.section, stripSection);
          if (r) { section = r; changed = true; }
        }
        if (!changed) continue;
        const pm = d.paraMut(story, path);
        pm.runs = probe.runs;
        if (probe.mark) pm.mark = probe.mark; else delete pm.mark;
        if (probe.props) pm.props = probe.props; else delete pm.props;
        if (section) { const s = {...pm.section}; if (section.want) s.fmtChange = section.want; else delete s.fmtChange; pm.section = s; }
      } else if (b.kind === 'table' && a.kind === 'table' && b.rows.length === a.rows.length && deepEq(b.grid, a.grid)) {
        const tr = rec.change(b.props, a.props, stripTable);
        const rowCh = b.rows.map((rb, r) => rec.change(rb.props, a.rows[r].props, stripRow));
        const cellCh = b.rows.map((rb, r) => (rb.cells.length === a.rows[r].cells.length ? rb.cells.map((cb, c) => rec.change(cb.props, a.rows[r].cells[c].props, stripCell)) : []));
        if (tr || rowCh.some(Boolean) || cellCh.some(l => l.some(Boolean))) {
          d.updateTable(story, path, t => ({...t,
            props: tr ? withChange(t.props, tr.want) : t.props,
            rows: t.rows.map((row, r) => ({...row, props: rowCh[r] ? withChange(row.props, rowCh[r].want) : row.props,
              cells: row.cells.map((cell, c) => (cellCh[r]?.[c] ? {...cell, props: withChange(cell.props, cellCh[r][c].want)} : cell))})),
          }));
        }
        const at = d.table(story, path);
        for (let r = 0; r < b.rows.length; r++) {
          if (b.rows[r].cells.length !== at.rows[r].cells.length) continue;
          for (let c = 0; c < b.rows[r].cells.length; c++) walk(story, b.rows[r].cells[c].blocks, at.rows[r].cells[c].blocks, [...path, r, c], depth + 1);
        }
      }
    }
  };
  walk('body', before.body.chunks.flat(), d.c.body.chunks.flat(), [], 0);
  for (const [k, pb] of Object.entries(before.parts ?? {})) {
    const pa = d.c.parts?.[k];
    if (pa && pa !== pb) walk(Number(k), pb.blocks, pa.blocks, [], 0);
  }
}

const withChange = (props, want) => { const o = {...(props ?? {})}; if (want) o.fmtChange = want; else delete o.fmtChange; return o; };

/** Compare Documents: record how paragraph `nw` (same text) is formatted differently from `old` (compare_formatting). */
export function compareFormatting(old, nw, revisions, author, date) {
  const rec = new Recorder({author, date, before: [], revisions: () => revisions, addRevision: r => { revisions.push(r); return revisions.length - 1; }});
  return rec.para(old, nw);
}

// ---- describing a change ----------------------------------------------------------------------

/** The properties a change sets, as the Style Inspector lists them (diff). */
export function diff(o, n) {
  const out = [];
  o = o ?? {}; n = n ?? {};
  for (const [k, v] of Object.entries(n)) if (v !== undefined && !deepEq(o[k], v)) out.push({prop: k, value: v});
  for (const [k, v] of Object.entries(o)) if (v !== undefined && n[k] === undefined) out.push({prop: k, value: typeof v === 'boolean' ? false : null});
  return out;
}
export const charDiff = c => (c?.fmtChange ? diff(charFormatting(c.fmtChange.old), charFormatting(c)) : []);
export const paraDiff = p => (p?.fmtChange ? diff(paraFormatting(p.fmtChange.old), paraFormatting(p)) : []);
export const sectionDiff = s => (s?.fmtChange ? diff(stripSection(s.fmtChange.old), stripSection(s)) : []);
export const tableDiff = t => (t?.fmtChange ? diff(stripTable(t.fmtChange.old), stripTable(t)) : []);
export const rowDiff = tableDiff;
export const cellDiff = c => (c?.fmtChange ? diff(stripTable(c.fmtChange.old), stripTable(c)) : []);

/** `indentLeft` → `Indent left` (words). */
function words(s) {
  let out = '';
  [...String(s)].slice(0, 64).forEach((c, i) => {
    if (i === 0) out += c.toUpperCase();
    else if (c !== c.toLowerCase() && c === c.toUpperCase()) out += ' ' + c.toLowerCase();
    else out += c;
  });
  return out;
}

/** "Formatted: Bold, Not italic, Size: 14" (describe). */
export function describe(props) {
  const items = (props ?? []).map(d => {
    const label = words(d.prop ?? '');
    const v = d.value;
    if (v === true) return label;
    if (v === false) return `Not ${label.toLowerCase()}`;
    if (v === null || v === undefined) return `${label}: (default)`;
    if (typeof v === 'string') return `${label}: ${v}`;
    if (typeof v === 'number') return `${label}: ${(Number.isFinite(v) ? v : 0).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}`;
    return `${label}: ${JSON.stringify(v)}`;
  });
  return items.length ? `Formatted: ${items.join(', ')}` : 'Formatted';
}

// ---- accepting and rejecting -------------------------------------------------------------------

/** Accept (drop the record) or reject (restore the old formatting) a run's change (resolve_char). Returns the new props. */
export function resolveChar(c, accept) {
  if (!c?.fmtChange) return c;
  const ch = c.fmtChange;
  if (accept) { const o = {...c}; delete o.fmtChange; return o; }
  const o = {...charFormatting(ch.old)};
  for (const k of ['link', 'linkTip', 'ins', 'del']) if (c[k] !== undefined && c[k] !== null) o[k] = c[k];
  return o;
}

/** Accept or reject a paragraph's change; its list numbering change goes with it (resolve_para). */
export function resolvePara(p, accept) {
  const o = {...(p ?? {})};
  delete o.numChange;
  const ch = o.fmtChange;
  if (!ch) return o;
  delete o.fmtChange;
  return accept ? o : paraFormatting(ch.old);
}

/** resolve_section: the headers and footers stay. */
export function resolveSection(s, accept) {
  if (!s?.fmtChange) return s;
  const ch = s.fmtChange;
  if (accept) { const o = {...s}; delete o.fmtChange; return o; }
  const o = {...stripSection(ch.old)};
  if (s.headers !== undefined) o.headers = s.headers;
  if (s.footers !== undefined) o.footers = s.footers;
  if (s.id !== undefined) o.id = s.id;
  return o;
}

export function resolveTableProps(t, accept) {
  if (!t?.fmtChange) return t;
  return accept ? stripTable(t) : stripTable(t.fmtChange.old);
}
export const resolveRowProps = resolveTableProps;
/** resolve_cell: merges are the table's structure, not formatting: they stay. */
export function resolveCellProps(c, accept) {
  if (!c?.fmtChange) return c;
  if (accept) return stripTable(c);
  const o = stripCell(c.fmtChange.old);
  if (c.span !== undefined) o.span = c.span;
  if (c.vmerge !== undefined) o.vmerge = c.vmerge;
  return o;
}

/** A table with every table, row and cell change (and the tables inside its cells) resolved (resolve_containers). */
export function resolveTable(t, accept, depth = 0) {
  if (depth > MAX_DEPTH) return t;
  return {...t, props: resolveTableProps(t.props, accept), rows: t.rows.map(r => ({...r, props: resolveRowProps(r.props, accept),
    cells: r.cells.map(c => ({...c, props: resolveCellProps(c.props, accept), blocks: resolveContainers(c.blocks, accept, depth + 1)}))}))};
}

/** Resolve the containers (tables, sections on paragraphs) of a block list (resolve_containers). */
export function resolveContainers(blocks, accept, depth = 0) {
  if (depth > MAX_DEPTH) return blocks;
  let out = null;
  blocks.forEach((b, i) => {
    let nb = b;
    if (b.kind === 'para' && b.section?.fmtChange) nb = {...b, section: resolveSection(b.section, accept)};
    else if (b.kind === 'table' && hasTableChange(b, 0)) nb = resolveTable(b, accept, depth);
    if (nb !== b) { out ??= blocks.slice(); out[i] = nb; }
  });
  return out ?? blocks;
}

function hasTableChange(t, depth) {
  if (depth > MAX_DEPTH) return false;
  if (t.props?.fmtChange) return true;
  return t.rows.some(r => r.props?.fmtChange || r.cells.some(c => c.props?.fmtChange
    || c.blocks.some(x => (x.kind === 'table' ? hasTableChange(x, depth + 1) : !!x.section?.fmtChange))));
}
