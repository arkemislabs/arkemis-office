// Body tables in the page flow: rows split across pages, repeated header rows, rows kept with the
// next, rows that can't split, at-least and exact rows, footnotes in rows.
//
// Translated from wordcraft crates/layout/src/table_flow.rs (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c). Not translated: floating tables (`w:tblpPr`; such a
// table is laid out in the text flow), header/footer table wrap areas.
import {layoutTable, splitRow} from './table.mjs';
import {tableNotes} from './notes.mjs';
import {translate} from './placed.mjs';

/** The most items repeated header rows add per table (MAX_HEADER_ITEMS). */
export const MAX_HEADER_ITEMS = 500_000;

/** Word takes a row's keep-with-next from the first paragraph of its first cell (row_keeps_next). */
function rowKeepsNext(row) {
  const c = row.cells[0];
  if (!c) return false;
  const items = row.items.slice(c.items[0], c.items[1]);
  let depth = Infinity, story = null;
  for (const it of items) if (it.kind === 'cell' && it.table.length + 3 < depth) { depth = it.table.length + 3; story = it.story; }
  if (depth === Infinity) return false;
  const l = items.find(it => it.kind === 'lines' && it.path.length === depth && it.path[it.path.length - 1] === 0 && it.story === story);
  return l ? !!l.para.rp.keepNext : false;
}

const exactRow = r => r?.props?.heightRule === 'exact' && r.props.height > 0;

function rowCanStart(row, laid, room, pageHeight) {
  if (laid.height <= room + 0.01) return true;
  const p = row.props ?? {};
  if (p.header || p.cantSplit || exactRow(row)) return false;
  if (p.heightRule === 'atLeast' && p.height > room + 0.01 && p.height <= pageHeight + 0.01) return false;
  return splitRow(laid, room) !== null;
}

/** Place a body table (place_table). */
export function placeTable(ctx, pb, t, block, bodyTop) {
  pb.prev = null;
  const width = pb.colW();
  const tl = layoutTable(ctx, 'body', t, [block], width, 1);
  const headerRows = [];
  for (let r = 0; r < t.rows.length && t.rows[r].props?.header; r++) headerRows.push(r);
  const isHeader = new Set(headerRows);
  let headerRepeats = 0;
  const headerCost = headerRows.reduce((s, i) => s + Math.max(tl.rows[i]?.items.length ?? 0, 1), 0);
  const kept = tl.rows.map((_, i) => [i, 0]);
  for (let i = tl.rows.length - 2; i >= 0; i--) {
    const row = tl.rows[i];
    if (i < headerRows.length || !rowKeepsNext(row)) continue;
    const [end, h] = kept[i + 1];
    kept[i] = [end, row.height + h];
  }
  const repeatedHeight = headerRows.reduce((s, i) => s + (tl.rows[i]?.height ?? 0), 0);
  const place = row => {
    const x = pb.colX() + tl.x, y = pb.y;
    const pg = pb.page();
    if (pg) for (const it of row.items) pg.items.push(translate({...it}, x, y));
    pb.y += row.height;
    pb.contentBottom = Math.max(pb.contentBottom, pb.y);
  };
  const shortOfMin = (ri, room) => { const p = t.rows[ri]?.props ?? {}; return p.heightRule === 'atLeast' && p.height > room + 0.01; };
  const first = headerRows.length;
  if (headerRows.length && !pb.atTop() && tl.rows[first]) {
    const row = tl.rows[first];
    const room = pb.bottom - pb.y - tl.rows.slice(0, first).reduce((s, r) => s + r.height, 0);
    const splittable = !t.rows[first]?.props?.cantSplit;
    if (row.height + row.edge > room + 0.01 && (shortOfMin(first, room) || !(splittable && splitRow(row, room)))) pb.advance(block, bodyTop);
  }
  const tableAtTop = pb.atTop();
  tl.rows.forEach((row, ri) => {
    const rp = t.rows[ri]?.props ?? {};
    const splittable = !isHeader.has(ri) && !(rp.cantSplit || exactRow(t.rows[ri]));
    let rest = null, fresh = false;
    const underTopHeaders = ri === first && tableAtTop;
    for (let pass = 0; pass < 1000; pass++) {
      const cur = rest ?? row;
      const deferKept = pb.y + cur.height <= pb.bottom + 0.01 && !pb.web && !pb.atTop() && !fresh && rest === null
        && (ri === 0 || kept[ri - 1][0] < ri) && (() => {
          const [end, height] = kept[ri];
          if (end === ri) return false;
          const next = t.rows[end], laid = tl.rows[end];
          if (!next || !laid) return false;
          const pageHeight = pb.bottom - bodyTop - repeatedHeight;
          return height <= pageHeight + 0.01 && !rowCanStart(next, laid, pb.bottom - pb.y - height, pageHeight);
        })();
      if (pb.y + cur.height + cur.edge <= pb.bottom + 0.01 && !deferKept) break;
      const room = pb.bottom - pb.y;
      const movesOn = rest === null && !pb.atTop() && !fresh && !underTopHeaders && shortOfMin(ri, room);
      const split = splittable && !movesOn && !deferKept ? splitRow(cur, room) : null;
      if (split) { place(split[0]); tableNotes(ctx, pb, split[0].items); rest = split[1]; } else if (pb.atTop() || fresh) break;
      pb.advance(block, bodyTop);
      if (!isHeader.has(ri) && headerRepeats + headerCost <= MAX_HEADER_ITEMS) {
        headerRepeats += headerCost;
        for (const h of headerRows) if (tl.rows[h]) place(tl.rows[h]);
      }
      fresh = true;
    }
    const last = rest ?? row;
    place(last);
    tableNotes(ctx, pb, last.items);
  });
}
