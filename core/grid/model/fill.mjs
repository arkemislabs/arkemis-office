// Fill: copy, AutoFill series (numbers, dates, weekdays, months, text with numbers, custom lists),
// the fill handle's target rectangle and the double-click fill extent.
// Translated from gridcraft crates/engine/src/fill.rs (`FillMode`, `DateUnit`, `fill`, `Pattern`,
// `holds_source_in_corner`, `starts_with_date`, `add_weekdays`, `weekdays_between`,
// `add_months_clamped`, `round15`, `ordinal_suffix`, `split_num`), crates/ui-egui/src/grid/interact.rs
// (`fill_target`) and crates/model/src/sheet.rs (`last_contiguous_nonempty`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// `fill(change, content, si, src, target, mode)` writes through the kernel change API; U:grid/edit's
// `edit.autoFill` / `edit.fillDown`... call it through ctx.model. Formulas move their relative
// references exactly as gridcraft's `shift_relative`. No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {MONTHS, WEEKDAYS, datetimeFromSerial, daysInMonth, serialFromYmd} from '../lib/date.mjs';
import {parse, print, shiftRelative} from '../lib/formula.mjs';
import {parseFormat} from '../lib/numfmt.mjs';
import {MAX_ROWS, a1, height, width, containsRange} from '../lib/addr.mjs';
import {cellAt, rawCellAt, isLegacySheet, writeCell, writeLegacyCell} from './store.mjs';
import {resolveStyle, styleById} from './style.mjs';

/** Fill modes (gridcraft FillMode). `dates:<unit>` is Fill Days/Weekdays/Months/Years. */
export const FILL_MODES = Object.freeze(['series', 'alternate', 'copy', 'formats', 'valuesOnly', 'extend', 'dates:day', 'dates:weekday', 'dates:month', 'dates:year']);
const extendsSeries = mode => mode === 'series' || mode === 'extend' || mode === 'valuesOnly' || mode.startsWith('dates:');

/** The most cells one fill may write. */
export const MAX_FILL_CELLS = 5_000_000;

const fmtKind = code => parseFormat(code ?? 'General').kind();
const isDateFormat = code => fmtKind(code) === 'Date';

/** Built-in custom lists. */
function lists() {
  return [WEEKDAYS.map(d => d.slice(0, 3)), [...WEEKDAYS], MONTHS.map(m => m.slice(0, 3)), [...MONTHS], ['Q1', 'Q2', 'Q3', 'Q4']];
}

const isNum = c => !!c && c.f === undefined && typeof c.v === 'number';
const isText = c => !!c && c.f === undefined && typeof c.v === 'string';
const numFmtOf = (content, c) => (c?.style ? resolveStyle(c.style).numFmt : c?.autoFmt && !c.s ? c.autoFmt : resolveStyle(styleById(content, c?.s ?? 0)).numFmt);

/** Whether the first cell of `src` holds a date (a number, not a formula, in a date format). */
export function startsWithDate(content, si, src) {
  const c = cellAt(content.sheets[si], src.start.row, src.start.col);
  return !!c && c.f === undefined && typeof c.v === 'number' && isDateFormat(numFmtOf(content, c));
}

/** Whether `target` contains `src` with the source in one of its corners (Excel's AutoFill shape). */
export function holdsSourceInCorner(src, target) {
  return containsRange(target, src)
    && (target.start.row === src.start.row || target.end.row === src.end.row)
    && (target.start.col === src.start.col || target.end.col === src.end.col);
}

/** The range the fill handle covers when dragged from `src` to the pointer cell `pc`. */
export function fillTarget(src, pc) {
  const below = pc.row - src.end.row, above = src.start.row - pc.row;
  const right = pc.col - src.end.col, left = src.start.col - pc.col;
  const vert = Math.max(below, above), horiz = Math.max(right, left);
  if (vert <= 0 && horiz <= 0) return src;
  if (vert >= horiz) {
    return below > 0 ? {start: {...src.start}, end: {row: pc.row, col: src.end.col}} : {start: {row: pc.row, col: src.start.col}, end: {...src.end}};
  }
  return right > 0 ? {start: {...src.start}, end: {row: src.end.row, col: pc.col}} : {start: {row: src.start.row, col: pc.col}, end: {...src.end}};
}

/** Last row of the run of non-empty cells in `col` starting at `from` (up to `to`); from - 1 when empty. */
export function lastContiguousNonempty(sheet, col, from, to) {
  let last = from - 1;
  for (let r = from; r <= to; r++) {
    const c = cellAt(sheet, r, col);
    if (!c || (c.f === undefined && (c.v === undefined || c.v === null || c.v === ''))) break;
    last = r;
  }
  return last;
}
/** The double-click fill target: down as far as the neighbouring column goes, or null. */
export function doubleClickFillTarget(sheet, src) {
  const neighbour = src.start.col > 0 ? src.start.col - 1 : src.end.col + 1;
  const cap = Math.min(src.end.row + 1_000_000, MAX_ROWS - 1);
  const last = src.end.row < cap ? lastContiguousNonempty(sheet, neighbour, src.end.row + 1, cap) : src.end.row;
  return last > src.end.row ? {start: {...src.start}, end: {row: last, col: src.end.col}} : null;
}

// ---------------------------------------------------------------------------------------------
// Date helpers

const isWeekday = (sys, serial) => { const d = datetimeFromSerial(sys, serial); return d ? d.weekday !== 0 && d.weekday !== 6 : null; };

function addWeekdays(sys, serial, n) {
  if (n === 0) return serial;
  const dir = Math.sign(n);
  let d = serial;
  const nextWeekday = () => {
    for (;;) { d += dir; const w = isWeekday(sys, d); if (w === null) return false; if (w) return true; }
  };
  if (!nextWeekday()) return null;
  const rest = Math.abs(n) - 1;
  d += dir * Math.floor(rest / 5) * 7;
  for (let i = 0; i < rest % 5; i++) if (!nextWeekday()) return null;
  return datetimeFromSerial(sys, d) ? d : null;
}

function weekdaysBetween(sys, a, b) {
  const [lo, hi, sign] = b >= a ? [Math.floor(a), Math.floor(b), 1] : [Math.floor(b), Math.floor(a), -1];
  const days = hi - lo;
  let count = Math.floor(days / 7) * 5;
  let d = lo + Math.floor(days / 7) * 7;
  for (let i = 0; i < days % 7; i++) {
    d += 1;
    const w = isWeekday(sys, d);
    if (w === null) return null;
    if (w) count++;
  }
  return count * sign;
}

function addMonthsClamped(sys, serial, months) {
  const d = datetimeFromSerial(sys, serial);
  if (!d) return null;
  const total = d.year * 12 + d.month - 1 + months;
  const year = Math.floor(total / 12), month = (((total % 12) + 12) % 12) + 1;
  const last = daysInMonth(year, month);
  const day = serialFromYmd(sys, year, month, Math.min(d.day, last));
  return day === null ? null : day + serial - Math.floor(serial);
}

export function round15(x) {
  if (x === 0 || !Number.isFinite(x)) return x;
  const mag = Math.floor(Math.log10(Math.abs(x)));
  const p = 10 ** (14 - mag);
  if (!Number.isFinite(p) || p === 0) return x;
  return Math.round(x * p) / p;
}

/** `1st Period` → `2nd Period`. */
export function ordinalSuffix(n, suffix) {
  if (suffix.length < 2) return suffix;
  const end = suffix.slice(0, 2), rest = suffix.slice(2);
  if (!['st', 'nd', 'rd', 'th'].includes(end.toLowerCase()) || /^[\p{L}\p{N}]/u.test(rest)) return suffix;
  const n10 = n % 10, n100 = n % 100;
  let w = n100 >= 11 && n100 <= 13 ? 'th' : n10 === 1 ? 'st' : n10 === 2 ? 'nd' : n10 === 3 ? 'rd' : 'th';
  if (/^[A-Z]+$/.test(end)) w = w.toUpperCase();
  return w + rest;
}

const I64_MAX = 9223372036854775807n, I64_MIN = -9223372036854775808n;
const checked = x => (x > I64_MAX || x < I64_MIN ? null : x);

/** `Item 007` → ['Item ', 7n, '', 3]; `3rd` → ['', 3n, 'rd', 1] (the number is a BigInt within i64). */
export function splitNum(t) {
  const chars = [...t];
  let end = -1;
  for (let i = chars.length - 1; i >= 0; i--) if (chars[i] >= '0' && chars[i] <= '9') { end = i; break; }
  if (end < 0) return null;
  let start = end;
  while (start > 0 && chars[start - 1] >= '0' && chars[start - 1] <= '9') start--;
  const digits = chars.slice(start, end + 1).join('');
  // i64 like upstream: numbers beyond it don't parse; series arithmetic is checked (BigInt).
  const n = BigInt(digits);
  if (n > I64_MAX) return null;
  const width = digits.startsWith('0') && digits.length > 1 ? digits.length : 1;
  return [chars.slice(0, start).join(''), n, chars.slice(end + 1).join(''), width];
}

// ---------------------------------------------------------------------------------------------
// Patterns

const COPY = Object.freeze({k: 'copy'});

function datesPattern(cells, unit, sys, fmt) {
  if (!isDateFormat(fmt)) return null;
  const nums = [];
  for (const [, c] of cells) { if (!isNum(c)) return null; nums.push(c.v); }
  if (!nums.length) return null;
  const first = nums[0], last = nums[nums.length - 1], second = nums[1];
  const atLeastOne = n => (n === 0 ? 1 : n);
  switch (unit) {
    case 'day': {
      const days = second === undefined ? 1 : Math.floor(second) - Math.floor(first);
      return {k: 'linear', last, first, step: days === 0 ? 1 : days};
    }
    case 'weekday': {
      let step = 1;
      if (second !== undefined) { const w = weekdaysBetween(sys, first, second); if (w === null) return null; step = atLeastOne(w); }
      return {k: 'weekdays', last, first, step, sys};
    }
    default: {
      let months;
      if (second !== undefined) {
        const a = datetimeFromSerial(sys, first), b = datetimeFromSerial(sys, second);
        if (!a || !b) return null;
        const years = b.year - a.year;
        months = unit === 'year' ? atLeastOne(years) * 12 : atLeastOne(years * 12 + b.month - a.month);
      } else months = unit === 'year' ? 12 : 1;
      return {k: 'months', last, first, months, sys};
    }
  }
}

function detect(cells, custom, sys, fmt) {
  if (cells.some(([, c]) => c && c.f !== undefined)) return COPY;
  const vals = cells.map(([, c]) => (c ? c.v ?? null : null));
  if (vals.length && vals.every(v => typeof v === 'number')) {
    const nums = vals;
    const first = nums[0], last = nums[nums.length - 1];
    const f = fmt ?? 'General';
    const isDate = f.includes('d') || f.includes('y') || (f.includes('m') && !f.includes('h'));
    if (nums.length === 1) {
      if (isDate) return {k: 'linear', last, first, step: 1};
      if (fmtKind(f) === 'Time') return {k: 'linear', last, first, step: 1 / 24};
      return COPY;
    }
    if (isDate) {
      const a = datetimeFromSerial(sys, first), b = datetimeFromSerial(sys, nums[1] ?? first);
      if (a && b && a.day === b.day && (a.month !== b.month || a.year !== b.year)) {
        return {k: 'months', last, first, months: (b.year - a.year) * 12 + b.month - a.month, sys};
      }
    }
    const n = nums.length, meanX = (n - 1) / 2, meanY = nums.reduce((s, y) => s + y, 0) / n;
    let num = 0, den = 0;
    nums.forEach((y, i) => { num += (i - meanX) * (y - meanY); den += (i - meanX) ** 2; });
    const step = den === 0 ? 0 : num / den;
    return {k: 'linear', last: meanY + step * (n - 1 - meanX), first: meanY - step * meanX, step};
  }
  if (vals.length && vals.every(v => typeof v === 'string')) {
    const texts = vals;
    for (const list of [...custom, ...lists()]) {
      const idx = texts.map(t => list.findIndex(l => l.toLowerCase() === t.toLowerCase()));
      if (idx.every(i => i >= 0)) {
        const t0 = texts[0] ?? '';
        const upper = !/\p{Ll}/u.test(t0) && /\p{L}/u.test(t0) && t0.length > 1;
        const lower = !/\p{Lu}/u.test(t0);
        return {k: 'list', list, last: idx[idx.length - 1], first: idx[0], step: idx.length >= 2 ? idx[1] - idx[0] : 1, upper, lower};
      }
    }
    const split = texts.map(splitNum);
    if (split.every(Boolean) && split.every(p => p[0] === split[0][0] && p[2] === split[0][2]) && (split.length < 2 || checked(split[1][1] - split[0][1]) !== null)) {
      return {k: 'textNum', prefix: split[0][0], suffix: split[0][2], last: split[split.length - 1][1], first: split[0][1],
        step: split.length >= 2 ? checked(split[1][1] - split[0][1]) : 1n, width: split[0][3]};
    }
  }
  return COPY;
}

/** Ctrl+drag swaps copying and extending: a lone number counts up by 1, anything else copies. */
function alternate(pattern, cells) {
  if (pattern.k === 'copy' && cells.length === 1 && isNum(cells[0][1])) {
    const n = cells[0][1].v;
    return {k: 'linear', last: n, first: n, step: 1};
  }
  return COPY;
}

const padNum = (n, w) => String(n).padStart(w, '0');

/** The value `k` steps beyond the source (forward) or before it (backward); undefined when none. */
function patternValue(p, k, forward) {
  const sign = forward ? 1 : -1;
  switch (p.k) {
    case 'copy': return undefined;
    case 'linear': return round15((forward ? p.last : p.first) + p.step * (k * sign));
    case 'textNum': {
      const base = forward ? p.last : p.first;
      const a = checked(p.step * BigInt(k)), b = a === null ? null : checked(a * BigInt(sign));
      let n = b === null ? null : checked(b + base);
      if (n === null) return undefined;
      const quarter = p.suffix === '' && base >= 1n && base <= 4n && ['q', 'qtr', 'quarter'].includes(p.prefix.trimEnd().toLowerCase());
      if (quarter) n = ((((n - 1n) % 4n) + 4n) % 4n) + 1n;
      else { if (n === I64_MIN) return undefined; if (n < 0n) n = -n; }
      return `${p.prefix}${padNum(n, p.width)}${ordinalSuffix(Number(n % 1000n), p.suffix)}`;
    }
    case 'list': {
      const len = p.list.length;
      if (!len) return undefined;
      const base = forward ? p.last : p.first;
      const i = (((base + p.step * k * sign) % len) + len) % len;
      const s = p.list[i];
      if (p.upper) return s.toUpperCase();
      if (p.lower && !/^\p{Lu}/u.test(s)) return s.toLowerCase();
      return s;
    }
    case 'months': return addMonthsClamped(p.sys, forward ? p.last : p.first, p.months * k * sign) ?? undefined;
    case 'weekdays': return addWeekdays(p.sys, forward ? p.last : p.first, p.step * k * sign) ?? undefined;
    default: return undefined;
  }
}

const isBlankCell = c => !c || (c.v === undefined && c.f === undefined && !c.s);

/**
 * Fills `target` (which contains `src` at one edge) from the pattern in `src` on sheet `si`.
 * Returns the number of cells written.
 */
export function fill(change, content, si, src, target, mode = 'series') {
  if (!FILL_MODES.includes(mode)) throw new CommandError('invalid_params', `Unknown fill mode ${mode}`);
  const sheet = content.sheets[si];
  if (!sheet) throw new CommandError('not_found', 'No such sheet');
  const sys = content.dateSystem === 1904 ? 1904 : 1900;
  const custom = Array.isArray(content.customLists) ? content.customLists : [];
  const vertical = height(target) !== height(src) || width(target) === width(src);
  const forward = vertical ? target.end.row > src.end.row || target.start.row === src.start.row
    : target.end.col > src.end.col || target.start.col === src.start.col;
  const steps = vertical ? (forward ? target.end.row - src.end.row : src.start.row - target.start.row)
    : (forward ? target.end.col - src.end.col : src.start.col - target.start.col);
  const laneCount = vertical ? width(src) : height(src);
  if (laneCount * Math.max(steps, 0) > MAX_FILL_CELLS) throw new CommandError('failed', 'The fill is too large.');
  const legacy = isLegacySheet(sheet);
  const srcLen = vertical ? height(src) : width(src);
  const writes = [];
  const lanes = [];
  if (vertical) for (let c = src.start.col; c <= src.end.col; c++) lanes.push(c); else for (let r = src.start.row; r <= src.end.row; r++) lanes.push(r);
  for (const lane of lanes) {
    const srcCells = [];
    for (let i = 0; i < srcLen; i++) {
      const at = vertical ? {row: src.start.row + i, col: lane} : {row: lane, col: src.start.col + i};
      srcCells.push([at, cellAt(sheet, at.row, at.col)]);
    }
    const targets = [];
    if (vertical) {
      if (forward) for (let r = src.end.row + 1; r <= target.end.row; r++) targets.push({row: r, col: lane});
      else for (let r = src.start.row - 1; r >= target.start.row; r--) targets.push({row: r, col: lane});
    } else if (forward) for (let c = src.end.col + 1; c <= target.end.col; c++) targets.push({row: lane, col: c});
    else for (let c = src.start.col - 1; c >= target.start.col; c--) targets.push({row: lane, col: c});
    const fmt = entry => numFmtOf(content, entry[1]);
    let pattern = COPY;
    if (extendsSeries(mode) || mode === 'alternate') {
      const firstFmt = srcCells.length ? fmt(srcCells[0]) : 'General';
      const dates = mode.startsWith('dates:') ? datesPattern(srcCells, mode.slice(6), sys, firstFmt) : null;
      const detected = dates ?? detect(srcCells, custom, sys, firstFmt);
      pattern = mode === 'alternate' || (mode === 'extend' && detected.k === 'copy') ? alternate(detected, srcCells) : detected;
    }
    const perCell = extendsSeries(mode) && pattern.k === 'copy' && srcCells.length > 1
      ? srcCells.map(c => detect([c], custom, sys, fmt(c))) : [];
    targets.forEach((t, k) => {
      const step = k + 1;
      const idx = k % Math.max(srcCells.length, 1);
      const srcI = forward ? idx : srcCells.length - 1 - idx;
      const [sc, scell] = srcCells[srcI] ?? [src.start, null];
      const raw = legacy ? rawCellAt(sheet, sc.row, sc.col) : null;
      if (mode === 'formats') {
        const existing = cellAt(sheet, t.row, t.col);
        if (legacy) {
          const old = rawCellAt(sheet, t.row, t.col);
          const {value: _v, ...styleKeys} = raw ?? {};
          writes.push([t, null, {value: old?.value ?? '', ...styleKeys}]);
        } else writes.push([t, {...(existing ?? {}), s: scell?.s}]);
        return;
      }
      const cell = scell ? {...scell} : {};
      delete cell.style; delete cell.autoFmt;
      const style = mode === 'valuesOnly' ? cellAt(sheet, t.row, t.col)?.s : scell?.s;
      let text = null;
      if (cell.f !== undefined) {
        let expr = null;
        try { expr = parse(cell.f); } catch { expr = null; }
        if (expr) {
          cell.f = print(shiftRelative(expr, t.row - sc.row, t.col - sc.col));
          delete cell.v;
        }
        text = `=${cell.f}`;
      } else {
        const v = perCell[srcI] ? patternValue(perCell[srcI], Math.floor(k / srcCells.length) + 1, forward) : patternValue(pattern, step, forward);
        if (v !== undefined) cell.v = v;
      }
      if (style) cell.s = style; else delete cell.s;
      if (legacy) {
        const old = rawCellAt(sheet, t.row, t.col);
        const base = mode === 'valuesOnly' ? (old ?? {}) : (raw ?? {});
        const {value: _v, valueType: _t, ...keep} = base;
        const value = text ?? (cell.v === undefined || cell.v === null ? '' : typeof cell.v === 'object' ? String(cell.v.e) : String(cell.v));
        writes.push([t, null, value === '' && !Object.keys(keep).length ? null : {...keep, value, ...(raw?.valueType === 'text' && text === null ? {valueType: 'text'} : {})}]);
        return;
      }
      writes.push([t, isBlankCell(cell) ? null : cell]);
    });
  }
  for (const [c, cell, legacyCell] of writes) {
    if (legacy) writeLegacyCell(change, si, c.row, c.col, legacyCell);
    else writeCell(change, content, si, c.row, c.col, cell);
  }
  return writes.length;
}

export {a1};
