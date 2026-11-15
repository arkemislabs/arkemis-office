// The outline band of grouped rows and columns (Data > Group), as in Excel: a strip left of the row
// headers and one above the column headers, one lane per outline level, with a bracket per expanded
// group, a - / + button on its summary line (below / right of the detail, or above / left of it when the
// sheet's outline settings say so) and the level buttons 1..n+1 in the corner. The bands exist only
// while the sheet has an outline.
// Translated from gridcraft crates/ui-egui/src/outline.rs (`lane`, `band`, `Action`, `layout`,
// `group_bracket`, `hit`, `paint`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Layout and hit-testing are pure functions of the geometry. A click runs a command (data.showLevels,
// data.hideDetail, data.showDetail), so it undoes like any edit.

import type {Geo, Rect} from './geo';
import {outlineLane} from './geo';
import {colToLetters} from '../../../../core/grid/lib/addr.mjs';
import {axisOf, groupSummary, groupHasSummary} from '../../../../core/grid/lib/data-outline.mjs';

export interface Group { level: number; start: number; end: number; collapsed: boolean; summaryBefore: boolean }
export type Action = {kind: 'level'; rows: boolean; level: number} | {kind: 'toggle'; rows: boolean; group: Group};
export interface Button { rect: Rect; action: Action }
export interface Bracket { line: [number, number, number, number]; tick: [number, number, number, number] | null }
export interface Layout { buttons: Button[]; brackets: Bracket[] }

/** The command and params a button runs. */
export function actionCommand(a: Action): {command: string; params: Record<string, unknown>} {
  if (a.kind === 'level') return {command: 'data.showLevels', params: {[a.rows ? 'rows' : 'cols']: a.level}};
  const g = a.group;
  const lines = a.rows ? {rows: `${g.start + 1}:${g.end + 1}`} : {cols: `${colToLetters(g.start)}:${colToLetters(g.end)}`};
  return {command: g.collapsed ? 'data.showDetail' : 'data.hideDetail', params: {...lines, level: g.level}};
}
export const actionLabel = (a: Action) => (a.kind === 'level' ? String(a.level) : a.group.collapsed ? '+' : '−');

interface Dir {
  rows: boolean; geo: Geo; sheet: any; lo: number; hi: number; split: number; frozen: number; lane0: number; levelAlong: number;
}
const start = (d: Dir, line: number) => (d.rows ? d.geo.y(line) : d.geo.x(line));
const size = (d: Dir, line: number) => d.geo.z * (d.rows ? d.geo.rowHeight(line) : d.geo.colWidth(line));
const lane = (d: Dir, step: number, k: number) => d.lane0 + (k - 0.5) * step;
/** The visible extent of a line along: clipped to its pane, null when hidden or off screen. */
function visible(d: Dir, line: number): [number, number] | null {
  const a = start(d, line), sz = size(d, line);
  const top = line >= d.frozen ? d.split : d.lo;
  const a0 = Math.max(a, top), a1 = Math.min(a + sz, d.hi);
  return sz > 0 && a1 > a0 ? [a0, a1] : null;
}
/** The first on-screen line in start..end: the frozen ones first, then the scrolling ones from the pane's edge. */
function firstVisible(d: Dir, s0: number, e: number): [number, [number, number]] | null {
  const at = d.rows ? d.geo.rowAt(d.split) : d.geo.colAt(d.split);
  const scrolled = Math.max(s0, d.frozen, at);
  for (let l = s0; l < Math.min(d.frozen, e + 1); l++) { const v = visible(d, l); if (v) return [l, v]; }
  for (let l = scrolled; l <= e && l < scrolled + 400; l++) { const v = visible(d, l); if (v) return [l, v]; }
  return null;
}
const point = (d: Dir, along: number, across: number): [number, number] => (d.rows ? [across, along] : [along, across]);
const rectAt = (d: Dir, along: number, across: number, side: number): Rect => { const [x, y] = point(d, along, across); return {x: x - side / 2, y: y - side / 2, w: side, h: side}; };

function groupBracket(out: Layout, d: Dir, g: Group, button: number | null, across: number, side: number) {
  const first = firstVisible(d, g.start, g.end);
  if (!first) return;
  const [firstLine, [a00]] = first;
  const seg = (a: number, b: number): [number, number, number, number] => { const p = point(d, a, across), q = point(d, b, across); return [p[0], p[1], q[0], q[1]]; };
  const tickAt = (a: number): [number, number, number, number] => { const p = point(d, a, across), q = point(d, a, across + side / 2); return [p[0], p[1], q[0], q[1]]; };
  if (g.summaryBefore) {
    // From the button down (or across) to the last detail line, with the tick there.
    const a0 = button !== null ? button + side / 2 : a00;
    const end = start(d, g.end) + size(d, g.end);
    const a1 = Math.min(end, d.hi);
    if (a1 <= a0) return;
    out.brackets.push({line: seg(a0, a1 - 0.5), tick: end <= d.hi ? tickAt(a1 - 0.5) : null});
    return;
  }
  const a1 = button !== null ? button - side / 2 : Math.min(start(d, groupSummary(g)), d.hi);
  if (a1 <= a00) return;
  const startShown = firstLine === g.start && Math.abs(a00 - start(d, g.start)) < 0.5;
  out.brackets.push({line: seg(a00 + 0.5, a1), tick: startShown ? tickAt(a00 + 0.5) : null});
}

/** The band's buttons and brackets for this frame. */
export function layout(geo: Geo, sheet: any): Layout {
  const out: Layout = {buttons: [], brackets: []};
  if (geo.bandW <= 0 && geo.bandH <= 0) return out;
  const zoom = Math.max(geo.z, 0.1);
  const step = outlineLane(zoom);
  const side = Math.max(step - 4, 7);
  const cornerH = geo.headerH > 0 ? geo.headerH : geo.bandH, cornerW = geo.headerW > 0 ? geo.headerW : geo.bandW;
  const rows: Dir = {rows: true, geo, sheet, lo: geo.cells.y, hi: geo.cells.y + geo.cells.h, split: geo.cells.y + geo.frozenH, frozen: geo.fr, lane0: geo.rect.x + 2, levelAlong: geo.cells.y - cornerH / 2};
  const cols: Dir = {rows: false, geo, sheet, lo: geo.cells.x, hi: geo.cells.x + geo.cells.w, split: geo.cells.x + geo.frozenW, frozen: geo.fc, lane0: geo.rect.y + 2, levelAlong: geo.cells.x - cornerW / 2};
  for (const d of [rows, cols]) {
    const axis = axisOf(sheet, d.rows) as {levels: number; groups: Group[]};
    if (axis.levels === 0) continue;
    for (let k = 1; k <= axis.levels + 1; k++) out.buttons.push({rect: rectAt(d, d.levelAlong, lane(d, step, k), side), action: {kind: 'level', rows: d.rows, level: k}});
    for (const g of axis.groups) {
      const across = lane(d, step, g.level);
      // The button on the summary line, if that line is on screen.
      const v = groupHasSummary(g) ? visible(d, groupSummary(g)) : null;
      const mid = v ? (v[0] + v[1]) / 2 : null;
      if (mid !== null) out.buttons.push({rect: rectAt(d, mid, across, side), action: {kind: 'toggle', rows: d.rows, group: g}});
      if (g.collapsed) continue;
      groupBracket(out, d, g, mid, across, side);
    }
  }
  return out;
}

/** The band rectangles: left of the row headers and above the column headers. */
export function bands(geo: Geo): [Rect, Rect] {
  const r = geo.rect;
  return [{x: r.x, y: r.y, w: geo.bandW, h: r.h}, {x: r.x, y: r.y, w: r.w, h: geo.bandH}];
}

/** The button under (x, y), if any. */
export function hit(geo: Geo, sheet: any, x: number, y: number): Action | null {
  if (geo.bandW <= 0 && geo.bandH <= 0) return null;
  const [rb, cb] = bands(geo);
  const inside = (r: Rect) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  if (!inside(rb) && !inside(cb)) return null;
  const b = layout(geo, sheet).buttons.find(t => x >= t.rect.x - 1.5 && x <= t.rect.x + t.rect.w + 1.5 && y >= t.rect.y - 1.5 && y <= t.rect.y + t.rect.h + 1.5);
  return b ? b.action : null;
}

/** Paints the bands. */
export function paint(ctx: CanvasRenderingContext2D, geo: Geo, sheet: any, colors: {bg: string; line: string; text: string; button: string}) {
  if (geo.bandW <= 0 && geo.bandH <= 0) return;
  const [rb, cb] = bands(geo);
  ctx.save();
  for (const b of [rb, cb]) if (b.w > 0 && b.h > 0) { ctx.fillStyle = colors.bg; ctx.fillRect(b.x, b.y, b.w, b.h); }
  ctx.strokeStyle = colors.line; ctx.lineWidth = 1;
  if (geo.bandW > 0) { ctx.beginPath(); ctx.moveTo(rb.x + rb.w - 0.5, rb.y); ctx.lineTo(rb.x + rb.w - 0.5, rb.y + rb.h); ctx.stroke(); }
  if (geo.bandH > 0) { ctx.beginPath(); ctx.moveTo(cb.x, cb.y + cb.h - 0.5); ctx.lineTo(cb.x + cb.w, cb.y + cb.h - 0.5); ctx.stroke(); }
  const l = layout(geo, sheet);
  // Brackets stay out of the corner, where the level buttons are.
  const rowClip: Rect = {x: rb.x, y: geo.cells.y, w: rb.w, h: rb.h - (geo.cells.y - rb.y)};
  const colClip: Rect = {x: geo.cells.x, y: cb.y, w: cb.w - (geo.cells.x - cb.x), h: cb.h};
  ctx.strokeStyle = colors.text;
  for (const b of l.brackets) {
    const clip = b.line[0] === b.line[2] ? rowClip : colClip;
    ctx.save(); ctx.beginPath(); ctx.rect(clip.x, clip.y, clip.w, clip.h); ctx.clip();
    ctx.beginPath(); ctx.moveTo(b.line[0], b.line[1]); ctx.lineTo(b.line[2], b.line[3]);
    if (b.tick) { ctx.moveTo(b.tick[0], b.tick[1]); ctx.lineTo(b.tick[2], b.tick[3]); }
    ctx.stroke();
    ctx.restore();
  }
  const fontPx = Math.max(10 * geo.z, 7.5);
  ctx.font = `400 ${fontPx}px "Segoe UI", system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const b of l.buttons) {
    const clip = b.action.kind === 'level' ? geo.rect : b.action.rows ? rowClip : colClip;
    ctx.save(); ctx.beginPath(); ctx.rect(clip.x, clip.y, clip.w, clip.h); ctx.clip();
    ctx.fillStyle = colors.button; ctx.fillRect(b.rect.x, b.rect.y, b.rect.w, b.rect.h);
    ctx.strokeStyle = colors.text; ctx.strokeRect(Math.round(b.rect.x) + 0.5, Math.round(b.rect.y) + 0.5, Math.round(b.rect.w) - 1, Math.round(b.rect.h) - 1);
    ctx.fillStyle = colors.text;
    ctx.fillText(actionLabel(b.action), b.rect.x + b.rect.w / 2, b.rect.y + b.rect.h / 2 + 0.5);
    ctx.restore();
  }
  ctx.restore();
}
