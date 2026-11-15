// Home › Fill › Series… and Flash Fill for Grid (U:grid/edit; other units may import, not edit).
// Translated from gridcraft crates/engine/src/fill.rs (`SeriesOptions`, `series`, `flash_fill`,
// `Piece`, `Case`, `Program`, `tokens`, `apply_case`, `learn`, `synthesize`, `add_months_clamped`,
// `round15`) at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Excel's Series dialog adds two things upstream leaves out: the AutoFill type (the selection
// filled as the fill handle would, from the cells already in it) and Trend (a best-fit line for
// Linear, a best-fit exponential curve for Growth, through the selection's starting values).
// No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {datetimeFromSerial, daysInMonth, serialFromYmd} from './date.mjs';
import {cellAt, writeCell} from '../model/store.mjs';
import {styleIdAt} from '../model/workbook.mjs';
import {engineFor} from '../model/calc.mjs';
import {round15, fill} from '../model/fill.mjs';
import {cellText} from './edit-clip.mjs';

function addMonthsClamped(sys, serial, months) {
  const d = datetimeFromSerial(sys, serial);
  if (!d) return null;
  const total = d.year * 12 + d.month - 1 + months;
  const year = Math.floor(total / 12), month = (((total % 12) + 12) % 12) + 1;
  const day = serialFromYmd(sys, year, month, Math.min(d.day, daysInMonth(year, month)));
  return day === null ? null : day + serial - Math.floor(serial);
}
const truncI64 = x => Math.trunc(x);

/**
 * fill.rs `series`: {range, rows, kind: linear|growth|date|autofill, step, stop, unit: day|weekday|month|year, trend}.
 * Writes through the kernel change API; returns the cells written.
 */
export function series(change, content, si, {range: r, rows, kind, step, stop, unit, trend}) {
  const sys = content.dateSystem === 1904 ? 1904 : 1900;
  const sheet = content.sheets[si];
  if (!sheet) return 0;
  const eng = engineFor(content);
  const lanes = [];
  if (rows) for (let l = r.start.row; l <= r.end.row; l++) lanes.push(l); else for (let l = r.start.col; l <= r.end.col; l++) lanes.push(l);
  const len = rows ? r.end.col - r.start.col + 1 : r.end.row - r.start.row + 1;
  const at = (lane, i) => (rows ? {row: lane, col: r.start.col + i} : {row: r.start.row + i, col: lane});
  if (kind === 'autofill') {
    // Excel: the selection filled as the fill handle fills it, from the cells at its start.
    let n = 0;
    for (const lane of lanes) {
      let k = 0;
      while (k < len) { const c = at(lane, k); const v = eng.sheetValue(si, c.row, c.col); if (v === null || v === undefined || v === '') break; k++; }
      if (k === 0 || k === len) continue;
      const src = rows ? {start: at(lane, 0), end: at(lane, k - 1)} : {start: at(lane, 0), end: at(lane, k - 1)};
      const target = rows ? {start: at(lane, 0), end: at(lane, len - 1)} : {start: at(lane, 0), end: at(lane, len - 1)};
      n += fill(change, content, si, src, target, 'series');
    }
    return n;
  }
  const writes = [];
  for (const lane of lanes) {
    const first = at(lane, 0);
    const v0 = eng.sheetValue(si, first.row, first.col);
    if (typeof v0 !== 'number') continue;
    const style = styleIdAt(sheet, first.row, first.col);
    if (trend && (kind === 'linear' || kind === 'growth')) {
      // Excel's Trend: a best fit through the starting values (the numbers at the lane's start).
      const ys = [];
      for (let i = 0; i < len; i++) { const c = at(lane, i); const v = eng.sheetValue(si, c.row, c.col); if (typeof v !== 'number') break; ys.push(v); }
      if (kind === 'growth' && ys.some(y => y <= 0)) throw new CommandError('failed', 'A growth trend needs positive starting values.');
      const n = ys.length, xs = ys.map((_, i) => i);
      const ty = kind === 'growth' ? ys.map(Math.log) : ys;
      const mx = (n - 1) / 2, my = ty.reduce((a, b) => a + b, 0) / n;
      let num = 0, den = 0;
      xs.forEach((x, i) => { num += (x - mx) * (ty[i] - my); den += (x - mx) ** 2; });
      const slope = den === 0 ? 0 : num / den, icpt = my - slope * mx;
      for (let i = 0; i < len; i++) {
        const y = kind === 'growth' ? Math.exp(icpt + slope * i) : icpt + slope * i;
        writes.push([at(lane, i), {v: round15(y), ...(style ? {s: style} : {})}]);
      }
      continue;
    }
    let v = v0;
    for (let i = 1; i < len; i++) {
      const prev = v;
      if (kind === 'growth') v = v * step;
      else if (kind === 'date') {
        const d = datetimeFromSerial(sys, v);
        if (unit === 'month' && d) { const m = addMonthsClamped(sys, v0, truncI64(step) * i); v = m ?? v; }
        else if (unit === 'year' && d) { const m = addMonthsClamped(sys, v0, truncI64(step) * i * 12); v = m ?? v; }
        else if (unit === 'weekday' && d) {
          let n = v, left = Math.abs(truncI64(step));
          while (left > 0) {
            n += Math.sign(step);
            const day = datetimeFromSerial(sys, n);
            if (!day) throw new CommandError('failed', 'The weekday series runs past the supported date range.');
            if (day.weekday !== 0 && day.weekday !== 6) left--;
          }
          v = n;
        } else v = v + step;
      } else v = v + step;
      // The stop value bounds the series in the direction it runs (a growth by 0.5 falls).
      if (stop !== null && stop !== undefined && ((v >= prev && v > stop) || (v < prev && v < stop))) break;
      writes.push([at(lane, i), {v: round15(v), ...(style ? {s: style} : {})}]);
    }
  }
  for (const [c, cell] of writes) writeCell(change, content, si, c.row, c.col, cell);
  return writes.length;
}

// ---------------------------------------------------------------------------------------------
// Flash Fill (fill.rs)

const CASES = ['same', 'upper', 'lower', 'proper'];
/** Words of a text: runs of letters, digits and apostrophes. */
export const tokens = s => String(s).split(/[^\p{L}\p{N}']+/u).filter(Boolean);
export function applyCase(s, c) {
  switch (c) {
    case 'upper': return s.toUpperCase();
    case 'lower': return s.toLowerCase();
    case 'proper': return [...s].map((ch, i) => (i === 0 ? ch.toUpperCase() : ch.toLowerCase())).join('');
    default: return s;
  }
}
/** A learned transformation: literals, tokens (negative = from the end) and initials, each with a case. */
export class Program {
  constructor(pieces) { this.pieces = pieces; }
  apply(src) {
    const toks = tokens(src);
    const get = i => (i >= 0 ? toks[i] : toks.length + i >= 0 ? toks[toks.length + i] : undefined);
    let out = '';
    for (const p of this.pieces) {
      if (p.k === 'lit') out += p.s;
      else if (p.k === 'tok') { const t = get(p.i); if (t === undefined) return null; out += applyCase(t, p.c); }
      else { const t = get(p.i); const ch = t === undefined ? undefined : [...t][0]; if (ch === undefined) return null; out += applyCase(ch, p.c); }
    }
    return out;
  }
}
/** Candidate programs for one example, by greedy segmentation of the output (two index conventions). */
export function synthesize(src, dst) {
  const toks = tokens(src);
  const n = toks.length;
  const out = [];
  for (const preferNeg of [false, true]) {
    const pieces = [];
    let rest = dst, guard = 0;
    while (rest && guard < 64) {
      guard++;
      let best = null;
      toks.forEach((t, i) => {
        const idx = preferNeg ? i - n : i;
        for (const c of CASES) {
          const cand = applyCase(t, c);
          if (cand && rest.startsWith(cand) && (!best || cand.length > best.len)) best = {len: cand.length, piece: {k: 'tok', i: idx, c}};
        }
      });
      if (!best || best.len <= 1) {
        toks.forEach((t, i) => {
          const idx = preferNeg ? i - n : i;
          const ch = [...t][0];
          if (ch === undefined) return;
          for (const c of ['same', 'upper', 'lower']) {
            const cand = applyCase(ch, c);
            if (rest.startsWith(cand) && !best) best = {len: cand.length, piece: {k: 'init', i: idx, c}};
          }
        });
      }
      if (best) { pieces.push(best.piece); rest = rest.slice(best.len); }
      else {
        const ch = [...rest][0];
        const last = pieces[pieces.length - 1];
        if (last?.k === 'lit') last.s += ch; else pieces.push({k: 'lit', s: ch});
        rest = rest.slice(ch.length);
      }
    }
    out.push(new Program(pieces));
  }
  return out;
}
/** A program consistent with every example, or null. */
export function learn(examples) {
  if (!examples.length) return null;
  const [src, dst] = examples[0];
  return synthesize(src, dst).find(p => examples.every(([s, d]) => p.apply(s) === d)) ?? null;
}

/**
 * fill.rs `flash_fill`: learns from the examples typed in the column of `at` (the rows of the
 * data region in the column to its left that have one) and fills the empty rows. Returns the count.
 */
export function flashFill(change, content, si, at) {
  const sheet = content.sheets[si];
  if (!sheet || at.col === 0) return 0;
  const eng = engineFor(content);
  const empty = (row, col) => { const v = eng.sheetValue(si, row, col); return v === null || v === undefined || v === ''; };
  const srcCol = at.col - 1;
  let top = at.row;
  while (top > 0 && !empty(top - 1, srcCol)) top--;
  let bottom = at.row;
  while (bottom + 1 < 1_048_576 && !empty(bottom + 1, srcCol) && bottom - top < 1_000_000) bottom++;
  const examples = [], todo = [];
  // Flash Fill works on the text cells show (a date as formatted, not its serial number).
  for (let r = top; r <= bottom; r++) {
    const src = cellText(content, si, r, srcCol);
    if (empty(r, at.col)) todo.push([r, src]); else examples.push([src, cellText(content, si, r, at.col)]);
  }
  if (!examples.length) return 0;
  const program = learn(examples);
  if (!program) return 0;
  const style = styleIdAt(sheet, top, at.col);
  const writes = [];
  for (const [r, src] of todo) { const out = program.apply(src); if (out !== null) writes.push([r, out]); }
  for (const [r, out] of writes) writeCell(change, content, si, r, at.col, {v: out, ...(style ? {s: style} : {})});
  void cellAt;
  return writes.length;
}
