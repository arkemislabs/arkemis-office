// Tables: a column grid, rows and cells (cells hold block lists). Merges follow OOXML: a cell
// spans `span` grid columns; vertical merges are 'restart' + 'continue' cells.
// Translated from wordcraft crates/doc/src/table.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A table is `{kind: 'table', id, props, grid: number[], rows: Row[], controls?}`, a row
// `{id, props, cells: Cell[], controls?}`, a cell `{id, props, blocks: Block[], controls?}`.
// Props are sparse (a missing cell `span` is 1, a missing `vmerge` is 'none'). The functions here
// return a new table and never change the one passed in; `mkId` makes ids for new rows, cells and
// paragraphs (the document passes its own, which never repeats an id). No DOM, no Node built-ins.

import {newId} from './ids.mjs';
import {newParagraph, paragraphWithText, paraIsEmptyText} from './para.mjs';

/** Hard limits that keep hostile input from exhausting memory. */
export const MAX_ROWS = 32_767;
export const MAX_COLS = 63;
/** Most tables nested one inside another. */
export const MAX_TABLE_DEPTH = 24;

export const cellSpan = c => Math.max(1, Math.min(63, Math.floor(c?.props?.span ?? 1) || 1));
export const vmergeOf = c => c?.props?.vmerge ?? 'none';
const withProps = (x, patch) => ({...x, props: {...(x.props || {}), ...patch}});
const setVmerge = (c, v) => {
  const props = {...(c.props || {})};
  if (v === 'none') delete props.vmerge; else props.vmerge = v;
  return {...c, props};
};

export function emptyCell(mkId = newId) {
  return {id: mkId(), props: {span: 1}, blocks: [newParagraph(mkId())]};
}
export function cellWithText(s, mkId = newId) {
  return {id: mkId(), props: {span: 1}, blocks: [paragraphWithText(s, {}, mkId())]};
}

/** Grid column where the row's first cell starts: the columns `gridBefore` skips. */
export const rowFirstGrid = r => Math.min(Math.max(0, r?.props?.gridBefore ?? 0), MAX_COLS);
export const rowGridAfter = r => Math.min(Math.max(0, r?.props?.gridAfter ?? 0), MAX_COLS);

/** A rows × cols table spanning `width` points, "Table Grid" style. */
export function newTable(rows, cols, width, mkId = newId) {
  rows = Math.max(1, Math.min(MAX_ROWS, rows));
  cols = Math.max(1, Math.min(MAX_COLS, cols));
  const w = Math.max(width / cols, 6);
  return {
    kind: 'table', id: mkId(), props: {style: 'TableGrid'}, grid: new Array(cols).fill(w),
    rows: Array.from({length: rows}, () => ({id: mkId(), props: {}, cells: Array.from({length: cols}, () => withProps(emptyCell(mkId), {width: w}))})),
  };
}

export function tableCols(t) {
  let most = 0;
  for (const r of t.rows) {
    const n = rowFirstGrid(r) + r.cells.reduce((s, c) => s + cellSpan(c), 0) + rowGridAfter(r);
    if (n > most) most = n;
  }
  return Math.max(t.grid.length, most);
}

/** Grid column where cell `c` of row `r` starts. */
export function gridCol(t, r, c) {
  const row = t.rows[r];
  if (!row) return 0;
  let g = rowFirstGrid(row);
  for (let i = 0; i < c && i < row.cells.length; i++) g += cellSpan(row.cells[i]);
  return g;
}

/** Cell index in row `r` that covers grid column `g` (null if none). */
export function cellAtGrid(t, r, g) {
  const row = t.rows[r];
  if (!row) return null;
  let x = rowFirstGrid(row);
  if (g < x) return null;
  for (let i = 0; i < row.cells.length; i++) {
    const s = cellSpan(row.cells[i]);
    if (g < x + s) return i;
    x += s;
  }
  return null;
}

/** Insert a row copied (formatting, empty text) from row `like` at index `at`. */
export function insertRow(t, at, like, mkId = newId) {
  const src = t.rows[Math.min(like, t.rows.length - 1)];
  if (!src || t.rows.length >= MAX_ROWS) return t;
  const props = {...(src.props || {})};
  delete props.header;
  const row = {id: mkId(), props, cells: src.cells.map(c => {
    let nc = {...emptyCell(mkId), props: {...(c.props || {})}};
    if (vmergeOf(nc) === 'restart') nc = setVmerge(nc, 'none');
    return nc;
  })};
  const rows = t.rows.slice();
  rows.splice(Math.min(at, rows.length), 0, row);
  return {...t, rows};
}

export function deleteRow(t, r) {
  if (r >= t.rows.length) return t;
  let out = {...t, rows: t.rows.slice()};
  const starts = t.rows[r].cells.map((x, c) => [x, c]).filter(([x]) => vmergeOf(x) === 'restart').map(([, c]) => gridCol(t, r, c));
  for (const g of starts) {
    const continues = (tt, row) => {
      const i = cellAtGrid(tt, row, g);
      return i !== null && vmergeOf(tt.rows[row]?.cells[i]) === 'continue';
    };
    if (!continues(out, r + 1)) continue;
    const more = continues(out, r + 2);
    const i = cellAtGrid(out, r + 1, g);
    if (i !== null) {
      const row = {...out.rows[r + 1], cells: out.rows[r + 1].cells.slice()};
      row.cells[i] = setVmerge(row.cells[i], more ? 'restart' : 'none');
      out.rows[r + 1] = row;
    }
  }
  out.rows.splice(r, 1);
  return out;
}

/**
 * Split the table before row `at` (Table::split_off). Returns [head, tail]: the rows from `at` on
 * move to the tail, which has this table's properties and grid (and id `tailId`). Merges and row
 * content controls the split cuts are closed and reopened as upstream does.
 */
export function splitTable(t, at, tailId = newId()) {
  at = Math.min(at, t.rows.length);
  let open = [];
  for (const row of t.rows.slice(0, at)) {
    open.push(...(row.controls?.open ?? []));
    const close = Math.min(row.controls?.close ?? 0, open.length);
    open = open.slice(0, open.length - close);
  }
  const headRows = t.rows.slice(0, at), tailRows = t.rows.slice(at);
  const tail = {kind: 'table', id: tailId, props: structuredClone(t.props || {}), grid: t.grid.slice(), rows: tailRows};
  const tailControls = {open: [], close: t.controls?.close ?? 0};
  if (tailControls.close) tail.controls = tailControls;
  const head = {...t, rows: headRows};
  if (head.controls) { head.controls = {...head.controls, close: 0}; if (!head.controls.open?.length) delete head.controls; }
  if (headRows.length) {
    const last = {...headRows[headRows.length - 1]};
    if (open.length) last.controls = {open: last.controls?.open ?? [], close: (last.controls?.close ?? 0) + open.length};
    last.cells = last.cells.map(c => (vmergeOf(c) === 'restart' ? setVmerge(c, 'none') : c));
    headRows[headRows.length - 1] = last;
  }
  open = open.map(c => { const x = {...c}; delete x.id; return x; });
  if (tailRows.length) {
    const first = {...tailRows[0]};
    if (open.length || first.controls) first.controls = {open: [...open, ...(first.controls?.open ?? [])], close: first.controls?.close ?? 0};
    tailRows[0] = first;
    const firstCells = first.cells.slice();
    first.cells.forEach((x, c) => {
      if (vmergeOf(x) !== 'continue') return;
      const g = gridCol(tail, 0, c);
      const i = cellAtGrid(tail, 1, g);
      const more = i !== null && vmergeOf(tail.rows[1]?.cells[i]) === 'continue';
      firstCells[c] = setVmerge(x, more ? 'restart' : 'none');
    });
    tailRows[0] = {...first, cells: firstCells};
  }
  return [head, tail];
}

/** Insert a grid column at grid index `g` (cells spanning it widen instead). */
export function insertCol(t, g, mkId = newId) {
  if (t.grid.length >= MAX_COLS) return t;
  g = Math.min(g, t.grid.length);
  const w = t.grid[Math.min(g, Math.max(0, t.grid.length - 1))] ?? 72;
  const grid = t.grid.slice();
  grid.splice(g, 0, w);
  const rows = t.rows.map(row => {
    let x = 0, idx = null;
    for (let i = 0; i < row.cells.length; i++) {
      const s = cellSpan(row.cells[i]);
      if (g <= x) { idx = [i, false]; break; }
      if (g < x + s) { idx = [i, true]; break; }
      x += s;
    }
    const cells = row.cells.slice();
    if (idx && idx[1]) cells[idx[0]] = withProps(cells[idx[0]], {span: Math.min(cellSpan(cells[idx[0]]) + 1, MAX_COLS)});
    else {
      const c = withProps(emptyCell(mkId), {width: w});
      if (idx) cells.splice(idx[0], 0, c); else cells.push(c);
    }
    return {...row, cells};
  });
  return {...t, grid, rows};
}

/** Delete grid column `g` (spanning cells shrink). */
export function deleteCol(t, g) {
  if (g >= t.grid.length || t.grid.length <= 1) return t;
  const grid = t.grid.slice();
  grid.splice(g, 1);
  const rows = t.rows.map(row => {
    let x = 0;
    const cells = row.cells.slice();
    for (let i = 0; i < cells.length; i++) {
      const s = cellSpan(cells[i]);
      if (g < x + s) {
        if (s > 1) cells[i] = withProps(cells[i], {span: s - 1});
        else cells.splice(i, 1);
        break;
      }
      x += s;
    }
    return {...row, cells};
  }).filter(r => r.cells.length);
  return {...t, grid, rows};
}

const isEmptyPara = b => b.kind === 'para' && paraIsEmptyText(b);

/** Merge cells c0..=c1 of row `r` horizontally (content is concatenated). */
export function mergeRight(t, r, c0, c1) {
  const row = t.rows[r];
  if (!row || c1 <= c0 || c1 >= row.cells.length) return t;
  const cells = row.cells.slice();
  const removed = cells.splice(c0 + 1, c1 - c0);
  let first = {...cells[c0], blocks: cells[c0].blocks.slice()};
  for (const c of removed) {
    first = withProps(first, {span: Math.min(cellSpan(first) + cellSpan(c), MAX_COLS)});
    first.blocks.push(...c.blocks.filter(b => b.kind !== 'para' || !isEmptyPara(b)));
  }
  if (first.blocks.length > 1 && first.blocks[0].kind === 'para' && isEmptyPara(first.blocks[0])) first.blocks.splice(0, 1);
  cells[c0] = first;
  const rows = t.rows.slice();
  rows[r] = {...row, cells};
  return {...t, rows};
}

/** Merge a rectangle of cells (rows r0..=r1, grid columns g0..=g1). */
export function mergeCells(t, r0, r1, g0, g1, mkId = newId) {
  let out = t;
  for (let r = r0; r <= Math.min(r1, out.rows.length - 1); r++) {
    const a = cellAtGrid(out, r, g0), b = cellAtGrid(out, r, g1);
    if (a === null || b === null) continue;
    out = mergeRight(out, r, a, b);
    const rows = out.rows.slice();
    const cells = rows[r].cells.slice();
    cells[a] = setVmerge(cells[a], r1 === r0 ? 'none' : r === r0 ? 'restart' : 'continue');
    rows[r] = {...rows[r], cells};
    out = {...out, rows};
  }
  if (r1 > r0) {
    const a = cellAtGrid(out, r0, g0);
    if (a !== null) {
      const moved = [];
      const rows = out.rows.slice();
      for (let r = r0 + 1; r <= Math.min(r1, rows.length - 1); r++) {
        const ci = cellAtGrid(out, r, g0);
        if (ci === null) continue;
        const cells = rows[r].cells.slice();
        moved.push(...cells[ci].blocks.filter(b => b.kind !== 'para' || !isEmptyPara(b)));
        cells[ci] = {...cells[ci], blocks: [newParagraph(mkId())]};
        rows[r] = {...rows[r], cells};
      }
      const cells = rows[r0].cells.slice();
      cells[a] = {...cells[a], blocks: [...cells[a].blocks, ...moved]};
      rows[r0] = {...rows[r0], cells};
      out = {...out, rows};
    }
  }
  return out;
}

const sumGrid = (grid, a, b) => (a <= b && b <= grid.length ? grid.slice(a, b).reduce((s, x) => s + x, 0) : undefined);

/**
 * Split cell `c` of row `r` into `n` cells horizontally (Table::split_cell). Returns [table, spans]:
 * the parts' spans left to right.
 */
export function splitCell(t, r, c, n, mkId = newId) {
  n = Math.max(1, Math.min(MAX_COLS, n));
  const cell = t.rows[r]?.cells[c];
  if (!cell) return [t, []];
  const span = cellSpan(cell);
  if (n <= 1) return [t, [span]];
  const g = gridCol(t, r, c);
  let end = g + span;
  let grid = t.grid.slice();
  let rows = t.rows.map(row => ({...row, cells: row.cells.slice()}));
  let out = {...t, grid, rows};
  while (grid.length < end && grid.length < MAX_COLS) grid.push(72);
  if (grid.length < end) return [t, [span]];
  for (let j = g; j < end; j++) if (!(Number.isFinite(grid[j]) && grid[j] > 0)) grid[j] = 72;
  const EPS = 0.01;
  const total = grid.slice(g, end).reduce((s, x) => s + x, 0);
  const lines = [];
  for (let k = 1; k < n; k++) {
    const x = total * k / n;
    let acc = 0, hit = null;
    for (let j = g; j < end; j++) {
      const w = grid[j] ?? 0;
      if (j > g && Math.abs(x - acc) <= EPS) { hit = [j, null]; break; }
      if (x < acc + w - EPS) { if (x > acc + EPS) hit = [j, [x - acc, w - (x - acc)]]; break; }
      acc += w;
    }
    if (hit && hit[1] === null) lines.push(hit[0]);
    else if (hit && hit[1] && grid.length < MAX_COLS) {
      const [j, [left, right]] = hit;
      grid[j] = left;
      grid.splice(j + 1, 0, right);
      for (let rr = 0; rr < rows.length; rr++) {
        const ci = cellAtGrid(out, rr, j);
        if (ci === null) continue;
        const cl = rows[rr].cells[ci];
        rows[rr].cells[ci] = withProps(cl, {span: Math.max(1, cl.props?.span ?? 1) + 1});
      }
      end += 1;
      lines.push(j + 1);
    }
  }
  const dedup = lines.filter((x, i) => i === 0 || x !== lines[i - 1]);
  const row = rows[r];
  let a = g;
  const parts = [];
  for (const b of [...dedup, end]) if (b > a) { parts.push([a, b]); a = b; }
  parts.forEach(([pa, pb], k) => {
    if (k === 0) row.cells[c] = withProps(row.cells[c], {span: pb - pa, width: sumGrid(grid, pa, pb)});
    else row.cells.splice(Math.min(c + k, row.cells.length), 0, withProps(emptyCell(mkId), {span: pb - pa, width: sumGrid(grid, pa, pb)}));
  });
  return [out, parts.map(([pa, pb]) => pb - pa)];
}

/** The rows cell `c` of row `r` covers: [first row, count], or null. */
export function verticalExtent(t, r, c) {
  const g = gridCol(t, r, c);
  const at = rr => {
    const ci = cellAtGrid(t, rr, g);
    if (ci === null || gridCol(t, rr, ci) !== g) return null;
    return vmergeOf(t.rows[rr].cells[ci]);
  };
  const cell = t.rows[r]?.cells[c];
  if (!cell) return null;
  let top = r;
  if (vmergeOf(cell) === 'continue') {
    while (top > 0) {
      const up = at(top - 1);
      if (up === null || up === 'none') break;
      top -= 1;
      if (up === 'restart') break;
    }
  }
  let k = 1;
  if (at(top) !== 'none') while (at(top + k) === 'continue') k++;
  return [top, k];
}

/**
 * Split Cells: cut cell `c` of row `r` into cols × rows cells (Table::split_cell_grid). Returns the
 * new table, or null (the table unchanged) when the split can't be made.
 */
export function splitCellGrid(t, r, c, cols, nrows, mkId = newId) {
  cols = Math.max(1, Math.min(MAX_COLS, cols));
  nrows = Math.max(1, Math.min(MAX_ROWS, nrows));
  const ext = verticalExtent(t, r, c);
  if (!ext) return null;
  const [top, k] = ext;
  const g = gridCol(t, r, c);
  const ci = cellAtGrid(t, top, g);
  if (ci === null) return null;
  if ((k > 1 && k % nrows !== 0) || (k === 1 && t.rows.length + nrows - 1 > MAX_ROWS)) return null;
  const height = k > 1 ? k : nrows;
  let out = {...t, rows: t.rows.map(row => ({...row, cells: row.cells.slice()}))};
  if (k > 1 && nrows > 1) {
    const q = k / nrows;
    for (let i = 0; i < k; i++) {
      const cj = cellAtGrid(out, top + i, g);
      if (cj === null) continue;
      const row = out.rows[top + i];
      row.cells[cj] = setVmerge(row.cells[cj], q === 1 ? 'none' : i % q === 0 ? 'restart' : 'continue');
    }
  } else if (k === 1 && nrows > 1) {
    const src = out.rows[top];
    const props = {...(src.props || {})};
    delete props.header;
    const likeCells = [];
    src.cells = src.cells.map((cell, i) => {
      let nc = {...emptyCell(mkId), props: {...(cell.props || {})}};
      let cur = cell;
      if (i === ci) { cur = setVmerge(cell, 'none'); nc = setVmerge(nc, 'none'); }
      else { if (vmergeOf(cell) === 'none') cur = setVmerge(cell, 'restart'); nc = setVmerge(nc, 'continue'); }
      likeCells.push(nc);
      return cur;
    });
    for (let n = 1; n < nrows; n++) {
      const fresh = {id: mkId(), props: structuredClone(props), cells: likeCells.map(lc => ({...lc, id: mkId(), blocks: [newParagraph(mkId())]}))};
      out.rows.splice(top + 1, 0, fresh);
    }
  }
  if (cols > 1) {
    let spans;
    [out, spans] = splitCell(out, top, ci, cols, mkId);
    out = {...out, rows: out.rows.map(row => ({...row, cells: row.cells.slice()}))};
    const total = spans.reduce((s, x) => s + x, 0);
    const vm = vmergeOf(out.rows[top]?.cells[ci]);
    const topRow = out.rows[top];
    for (let i = ci + 1; i < ci + spans.length && i < topRow.cells.length; i++) topRow.cells[i] = setVmerge(topRow.cells[i], vm);
    const grid = out.grid.slice();
    for (let rr = top + 1; rr < top + height; rr++) {
      const cj = cellAtGrid(out, rr, g);
      if (cj === null || gridCol(out, rr, cj) !== g) continue;
      const row = out.rows[rr];
      const cell = row.cells[cj];
      if (cellSpan(cell) !== total) continue;
      let a = g;
      const parts = spans.map((span, n) => {
        let part = n === 0 ? {...cell} : emptyCell(mkId);
        part = setVmerge(part, vmergeOf(cell));
        part = withProps(part, {span, width: sumGrid(grid, a, a + span)});
        a += span;
        return part;
      });
      row.cells.splice(cj, 1, ...parts);
    }
  }
  return out;
}

export const totalWidth = t => t.grid.reduce((s, x) => s + x, 0);
