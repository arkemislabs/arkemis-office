// Home › Cells › Format: Row Height…, AutoFit Row Height, Column Width…, AutoFit Column Width,
// Default Width…, Hide & Unhide (rows, columns) and Lock Cell.
// Translated from gridcraft crates/engine/src/cmd/format/sizes.rs (`line_targets`, `row_height`,
// `col_width`, `chars_to_points`, `autofit_cols`, `autofit_rows`, `default_width`, `hide`) and
// crates/engine/src/cmd/format.rs (`home.lockCell`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Sizes are pixels at 96 dpi, the model's unit (header drags send pixels); `points` (row height)
// and `chars` (column width) take Excel's units, those of its Row Height and Column Width dialogs.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {CommandError} from '../../../kernel/errors.mjs';
import {applyStyle, activeStyle, approxTextWidth, fitRows, styleOfId} from '../../lib/format-ranges.mjs';
import {SHEET, RANGE, ON, ROWS, COLS, UPSTREAM_COMMIT, withDoc} from '../../lib/format-params.mjs';
import {lineTargets} from '../../lib/format-lines.mjs';
import {targetSheet, areaAddress, gridSel, bad, baseDoc, requireSchema2} from '../../lib/edit-targets.mjs';
import {MAX_ROWS, MAX_COLS} from '../../lib/addr.mjs';
import {forEachCell, usedBounds} from '../../model/store.mjs';
import {merges, rowHeight, colWidth, charsToPixels, pointsToChars} from '../../model/sheet.mjs';
import {valueAt} from '../../model/index.mjs';
import {formatValue} from '../../lib/numfmt.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/format/sizes.rs', 'crates/engine/src/cmd/format.rs']};
const other = message => new CommandError('invalid_params', message);

/** sizes.rs `chars_to_points`: Excel column width in characters (7 px digits) -> pixels. */
export const charsToPx = c => (c <= 0 ? 0 : c < 1 ? Math.round(c * 12) : Math.round(c * 7 + 5));

/** Writes a whole line map at once (one change) after `edit(map)` mutated a copy. */
function editLines(ctx, si, key, edit) {
  const cur = ctx.doc.sheets[si][key];
  const map = {...(cur && typeof cur === 'object' ? cur : {})};
  edit(map);
  for (const k of Object.keys(map)) if (!map[k] || !Object.keys(map[k]).length) delete map[k];
  if (!Object.keys(map).length) { if (cur !== undefined) ctx.change.delete(['sheets', si, key]); return; }
  ctx.change.set(['sheets', si, key], map);
}
const clean = info => { for (const k of Object.keys(info)) if (info[k] === undefined || info[k] === false) delete info[k]; return info; };

function rowHeightCmd(ctx, p) {
  let h;
  if (p.height !== undefined) {
    if (!(p.height >= 0 && p.height <= 546)) throw other('Row height must be between 0 and 546 pixels (409.5 points).');
    h = p.height;
  } else if (p.points !== undefined) {
    if (!(p.points >= 0 && p.points <= 409.5)) throw other('Row height must be between 0 and 409.5 points.');
    h = p.points * 4 / 3;
  } else throw bad('home.rowHeight', 'missing `height` (pixels) or `points`');
  const {sheet: si, lines} = lineTargets(ctx, p, true);
  requireSchema2(ctx, si);
  editLines(ctx, si, 'rows', map => {
    for (const [a, b] of lines) for (let r = a; r <= Math.min(b, a + MAX_ROWS - 1); r++) map[r] = clean({...(map[r] ?? {}), size: h, hidden: h === 0, custom: true});
  });
  return {sheet: si, height: h, points: Math.round(h * 0.75 * 100) / 100};
}

function colWidthCmd(ctx, p) {
  let w;
  if (p.width !== undefined) {
    if (!(p.width >= 0 && p.width <= 1800)) throw other('Column width must be between 0 and 1800 pixels.');
    w = p.width;
  } else if (p.chars !== undefined) {
    if (!(p.chars >= 0 && p.chars <= 255)) throw other('Column width must be between 0 and 255 characters.');
    w = charsToPx(p.chars);
  } else throw bad('home.columnWidth', 'missing `width` (pixels) or `chars`');
  const {sheet: si, lines} = lineTargets(ctx, p, false);
  requireSchema2(ctx, si);
  editLines(ctx, si, 'cols', map => {
    for (const [a, b] of lines) for (let c = a; c <= b; c++) map[c] = clean({...(map[c] ?? {}), size: w, hidden: w === 0});
  });
  return {sheet: si, width: w, chars: pointsToChars(w)};
}

/** The text a cell shows (number format applied), for AutoFit. */
function cellText(ctx, base, si, row, col, st) {
  let v;
  try { v = valueAt(base, si, row, col); } catch { v = null; }
  if (v === null || v === undefined) return '';
  try { return formatValue(v, st.numFmt, ctx.doc.dateSystem === 1904 ? 1904 : 1900).text ?? ''; } catch { return String(v); }
}
const EXACT_TEXT_WIDTHS = 2000;

function autofitCols(ctx, p) {
  const base = baseDoc(ctx);
  const {sheet: si, lines} = lineTargets(ctx, p, false);
  requireSchema2(ctx, si);
  const sh = ctx.doc.sheets[si];
  const used = usedBounds(sh);
  const ms = merges(sh).filter(m => !(m.start.row === m.end.row && m.start.col === m.end.col));
  const measure = typeof ctx.host?.measureText === 'function' ? ctx.host.measureText.bind(ctx.host) : null;
  const known = new Map();
  let distinct = 0;
  const af = sh.autofilter?.range ? sh.autofilter.range : null;
  const zoom = (sh.zoom ?? 100) / 100;
  const widths = [];
  for (const [a, b] of lines) {
    for (let c = a; c <= Math.min(b, a + MAX_COLS - 1); c++) {
      if (!used) continue;
      let max = 0;
      forEachCell(sh, used.r0, c, used.r1, c, (row, col, cell) => {
        if (ms.some(m => m.start.row <= row && row <= m.end.row && m.start.col <= col && col <= m.end.col)) return;
        const id = cell.s ?? 0;
        const st = styleOfId(ctx, id);
        const text = cellText(ctx, base, si, row, col, st);
        for (const line of String(text).split(/\r?\n/)) {
          let w;
          const k = `${id}\u0000${line}`;
          if (known.has(k)) w = known.get(k);
          else {
            if (measure && distinct < EXACT_TEXT_WIDTHS) {
              try {
                w = measure({family: st.font.name, size: st.font.size * 96 / 72, weight: st.font.bold ? 700 : 400, style: st.font.italic ? 'italic' : 'normal'}, line).width;
              } catch { w = approxTextWidth(line, st.font.size, st.font.bold); }
            } else w = approxTextWidth(line, st.font.size, st.font.bold);
            known.set(k, w);
            distinct++;
          }
          const filter = af && filterButtonAt(af, row, col) ? (12.5 * 96 / 72) / Math.min(1, Math.max(0.1, zoom)) : 0;
          max = Math.max(max, w + 6 + (st.align.indent ?? 0) * 9 + filter);
        }
      });
      if (max > 0) widths.push([c, Math.min(1785, Math.max(8, max))]);
    }
  }
  editLines(ctx, si, 'cols', map => {
    for (const [c, w] of widths) map[c] = clean({...(map[c] ?? {}), size: Math.ceil(w), hidden: false});
  });
  return {sheet: si, columns: widths.length};
}
function filterButtonAt(rangeText, row, col) {
  const m = /^\$?([A-Z]{1,3})\$?(\d+):\$?([A-Z]{1,3})\$?(\d+)$/i.exec(String(rangeText));
  if (!m) return false;
  const colOf = t => [...t.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return row === Number(m[2]) - 1 && col >= colOf(m[1]) && col <= colOf(m[3]);
}

function autofitRows(ctx, p) {
  baseDoc(ctx);
  const {sheet: si, lines} = lineTargets(ctx, p, true);
  requireSchema2(ctx, si);
  const rows = [];
  editLines(ctx, si, 'rows', map => {
    for (const [a, b0] of lines) {
      const b = Math.min(b0, a + 100_000);
      for (let r = a; r <= b; r++) {
        if (map[r]) map[r] = clean({...map[r], custom: false, hidden: false});
        rows.push(r);
      }
    }
  });
  fitRows(ctx, si, rows);
  return {sheet: si, rows: rows.length};
}

function hide(ctx, p, rows, on) {
  const {sheet: si, lines} = lineTargets(ctx, p, rows);
  requireSchema2(ctx, si);
  editLines(ctx, si, rows ? 'rows' : 'cols', map => {
    const max = rows ? MAX_ROWS : MAX_COLS;
    for (const [a0, b0] of lines) {
      // Unhiding a single selected line also reveals hidden neighbours (Excel needs the lines on
      // both sides selected; gridcraft is forgiving).
      const [a, b] = !on && a0 === b0 ? [Math.max(0, a0 - 1), Math.min(max - 1, b0 + 1)] : [a0, b0];
      for (let i = a; i <= Math.min(b, a + max - 1); i++) {
        if (on) map[i] = {...(map[i] ?? {}), hidden: true};
        else if (map[i]) {
          const next = {...map[i]};
          delete next.hidden;
          if (next.size === 0) delete next.size;
          map[i] = next;
        }
      }
    }
  });
  return {sheet: si, hidden: on};
}

const LINE_ROWS = s.object({sheet: SHEET, rows: ROWS});
const LINE_COLS = s.object({sheet: SHEET, cols: COLS});

export default defineCommands({
  family: 'format/cells',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'home.rowHeight', label: 'Row Height…', risk: 'edit', dialog: 'dialog.rowHeight',
      description: 'Set the height of rows (default: the selection\'s) in pixels (`height`) or points (`points`, as Excel\'s Row Height box).',
      params: s.object({sheet: SHEET, rows: ROWS, height: s.optional(s.number()), points: s.optional(s.number())}),
      state: ctx => withDoc(ctx, () => { const sel = gridSel(ctx); return {value: Math.round(rowHeight(ctx.doc.sheets[sel.sheet], sel.active.row) * 75) / 100}; }),
      run: rowHeightCmd,
    },
    {
      id: 'home.columnWidth', label: 'Column Width…', risk: 'edit', dialog: 'dialog.columnWidth',
      description: 'Set the width of columns (default: the selection\'s) in pixels (`width`) or characters (`chars`, as Excel\'s Column Width box).',
      params: s.object({sheet: SHEET, cols: COLS, width: s.optional(s.number()), chars: s.optional(s.number())}),
      state: ctx => withDoc(ctx, () => { const sel = gridSel(ctx); return {value: pointsToChars(colWidth(ctx.doc.sheets[sel.sheet], sel.active.col))}; }),
      run: colWidthCmd,
    },
    {id: 'home.autofitRowHeight', label: 'AutoFit Row Height', risk: 'edit', description: 'Fit rows (default: the selection\'s) to their content: user heights are dropped and hidden rows shown.',
      params: LINE_ROWS, state: ctx => withDoc(ctx, () => ({})), run: autofitRows},
    {id: 'home.autofitColumnWidth', label: 'AutoFit Column Width', risk: 'edit', description: 'Fit columns (default: the selection\'s) to the widest value they show.',
      params: LINE_COLS, state: ctx => withDoc(ctx, () => ({})), run: autofitCols},
    {
      id: 'home.defaultWidth', label: 'Default Width…', risk: 'edit', dialog: 'dialog.defaultWidth',
      description: 'Set the standard width (pixels) of the sheet\'s columns that have no width of their own.',
      params: s.object({sheet: SHEET, width: s.number()}),
      state: ctx => withDoc(ctx, () => ({value: ctx.doc.sheets[gridSel(ctx).sheet]?.defaultColWidth ?? 64})),
      run(ctx, p) {
        const si = targetSheet(ctx, p, []);
        requireSchema2(ctx, si);
        const w = Math.max(0, Math.min(1800, p.width));
        ctx.change.set(['sheets', si, 'defaultColWidth'], w);
        return {sheet: si, width: w};
      },
    },
    {id: 'home.hideRows', label: 'Hide Rows', shortcut: 'Mod+9', risk: 'edit', description: 'Hide rows (default: the selection\'s).',
      params: LINE_ROWS, state: ctx => withDoc(ctx, () => ({})), run: (ctx, p) => hide(ctx, p, true, true)},
    {id: 'home.hideColumns', label: 'Hide Columns', shortcut: 'Mod+0', risk: 'edit', description: 'Hide columns (default: the selection\'s).',
      params: LINE_COLS, state: ctx => withDoc(ctx, () => ({})), run: (ctx, p) => hide(ctx, p, false, true)},
    {id: 'home.unhideRows', label: 'Unhide Rows', shortcut: 'Mod+Shift+9', risk: 'edit', description: 'Show hidden rows in (or, for one row, next to) the selection.',
      params: LINE_ROWS, state: ctx => withDoc(ctx, () => ({})), run: (ctx, p) => hide(ctx, p, true, false)},
    {id: 'home.unhideColumns', label: 'Unhide Columns', shortcut: 'Mod+Shift+0', risk: 'edit', description: 'Show hidden columns in (or, for one column, next to) the selection.',
      params: LINE_COLS, state: ctx => withDoc(ctx, () => ({})), run: (ctx, p) => hide(ctx, p, false, false)},
    {
      id: 'home.lockCell', label: 'Lock Cell', risk: 'edit',
      description: 'Lock or unlock cells (default: the selection); locking takes effect when the sheet is protected.',
      params: s.object({range: RANGE, sheet: SHEET, on: ON}),
      state: ctx => withDoc(ctx, () => ({checked: !!activeStyle(ctx).protection.locked})),
      run(ctx, p) {
        const on = p.on ?? !activeStyle(ctx).protection.locked;
        const t = applyStyle(ctx, p, st => { st.protection.locked = on; });
        return {on, ranges: t.areas.map(a => areaAddress(ctx.doc, t.sheet, a))};
      },
    },
  ],
});

export {charsToPixels};
