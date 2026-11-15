// The grid surface's state machine: which sheet is shown, scroll per sheet, the selection (kept in
// the kernel session as view state), the cell editor, and what pointer and keyboard input do.
// Translated from gridcraft crates/ui-egui/src/grid/interact.rs (press, drag, release, header
// selection, resize, autofit, fill handle, `fill_target`, `select_to_pointer`, `point_header`),
// crates/ui-egui/src/grid/keyboard.rs (arrows, Ctrl+arrows, Home/End, Page keys, Enter/Tab, F2,
// Delete, typing), crates/ui-egui/src/grid/selection.rs (`toggled_ranges`, `select_ranges`),
// crates/ui-egui/src/app/editing.rs (`begin_edit`, `commit_edit`, `move_after_enter`, tab runs)
// and crates/engine/src/cmd/edit/selection.rs (`selection.move`, `selection.next`,
// `edit.selectAll`, `selection.row`, `selection.column`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Every document change runs a command by its upstream id (cell.set, range.fill, edit.autoFill,
// edit.clearContents, home.columnWidth, home.rowHeight, home.autofitColumnWidth,
// home.autofitRowHeight, home.insertSheet, sheet.rename, sheet.move, sheet.activate). A gesture
// whose command is not registered does nothing and its affordance is not shown (behaviour
// fidelity: no stand-ins). Selection and scrolling are view state.

import type {Session} from '../../../../core/kernel/session.mjs';
import {CommandError} from '../../../../core/kernel/errors.mjs';
import {MAX_ROWS, MAX_COLS, a1, rangeA1, parseRange, quoteSheet, colToLetters} from '../../../../core/grid/lib/addr.mjs';
import {Geo, type Cell, type Range, type Rect} from './geo';
import {hit as outlineHit, actionCommand, type Action as OutlineAction} from './outline';
import {filterButtonAt, pivotButtonAt, validationArrow as validationArrowAt} from './dataUi';
import {pivotButtons} from '../../../../core/grid/lib/pivot.mjs';
import {checkValidation} from '../../../../core/grid/lib/data-validation.mjs';
import {openMessageBox} from '../../../shell/dialogs/MessageBox';
import {hitObject, cursorOf, dragRect, itemsOfSlicer, periodsOfTimeline, screenToSheet, sheetToScreen, objectsOf, type ObjectHit, type Handle, type LiveRect, type Live, type InkOverlay} from './objects';
import {slicerLayout, slicerHit} from '../../../../core/grid/lib/slicer.mjs';
import {timelineLayout, timelineHit} from '../../../../core/grid/lib/timeline.mjs';
import {objectSelection, objectsSelection, withGroup, selectedObject as selectedObjectOf, selectedObjects as selectedObjectsOf} from '../../../../core/grid/lib/objects.mjs';
import {classify} from '../../../../core/grid/lib/links.mjs';
import {inkHit} from '../../../../core/grid/lib/ink.mjs';
import {
  fromKernelSelection, toKernelSelection, currentArea, movingEnd, extendTo, expandMerges, cycle, jump, currentRegion,
  isSingleCell, selectionAt, sheetIndex, activeSheetIndex,
} from '../../../../core/grid/model/workbook.mjs';
import {usedBounds, cellAt, hasContent} from '../../../../core/grid/model/store.mjs';
import {styleAt} from '../../../../core/grid/model/workbook.mjs';
import {mergeAt, defaultRowHeight, tableByName, definedName} from '../../../../core/grid/model/sheet.mjs';
import {editText} from '../../../../core/grid/model/input.mjs';
import {fillTarget, doubleClickFillTarget} from '../../../../core/grid/model/fill.mjs';
import {engineFor} from '../../../../core/grid/model/calc.mjs';
import {allFunctions} from '../../../../core/grid/model/index.mjs';
import {
  editState, isFormula, canPoint, insertRef, appendRef, setText, updateAutocomplete, acceptAutocomplete, formulaRefs, refIsOnSheet,
} from '../../../../core/grid/lib/editor.mjs';

export interface Sel { sheet: number; active: Cell; anchor: Cell; ranges: Range[] }
export interface EditState {
  sheet: number; cell: Cell; text: string; caret: number; enterMode: boolean; fromFormulaBar: boolean;
  point: [number, number] | null; autocomplete: string[]; acIndex: number; original: string;
}
export interface Mods { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean }
type Drag =
  | {kind: 'select'}
  | {kind: 'rows'; anchor: number}
  | {kind: 'cols'; anchor: number}
  | {kind: 'resizeCol'; col: number; start: number; orig: number; size: number}
  | {kind: 'resizeRow'; row: number; start: number; orig: number; size: number}
  | {kind: 'fill'; target: Range | null}
  | {kind: 'point'; anchor: Cell}
  | {kind: 'outline'; action: OutlineAction}
  | {kind: 'object'; hit: ObjectHit; handle: Handle | null; start: {x: number; y: number}; live: Rect | null; moved: boolean; set?: {kind: string; id: number; rect: Rect}[]; liveSet?: LiveRect[]; delta?: {dx: number; dy: number}}
  | {kind: 'ink'; tool: 'pen' | 'eraser' | 'lasso' | 'lassoMove'; pts: [number, number][]; start: {x: number; y: number}; offset: {dx: number; dy: number}};

const FULL_ROWS = (r0: number, r1: number): Range => ({start: {row: Math.min(r0, r1), col: 0}, end: {row: Math.max(r0, r1), col: MAX_COLS - 1}});
const FULL_COLS = (c0: number, c1: number): Range => ({start: {row: 0, col: Math.min(c0, c1)}, end: {row: MAX_ROWS - 1, col: Math.max(c0, c1)}});
const isFullRows = (r: Range) => r.start.col === 0 && r.end.col === MAX_COLS - 1;
const isFullCols = (r: Range) => r.start.row === 0 && r.end.row === MAX_ROWS - 1;
const same = (a: Range, b: Range) => a.start.row === b.start.row && a.start.col === b.start.col && a.end.row === b.end.row && a.end.col === b.end.col;
const clampCell = (c: Cell): Cell => ({row: Math.min(Math.max(c.row, 0), MAX_ROWS - 1), col: Math.min(Math.max(c.col, 0), MAX_COLS - 1)});
const mkRange = (a: Cell, b: Cell): Range => ({start: {row: Math.min(a.row, b.row), col: Math.min(a.col, b.col)}, end: {row: Math.max(a.row, b.row), col: Math.max(a.col, b.col)}});

let FUNCTION_NAMES: string[] | null = null;
const functionNames = () => (FUNCTION_NAMES ??= (allFunctions() as any[]).map(f => String(f.name).toUpperCase()).concat(
  ['IF', 'IFS', 'IFERROR', 'IFNA', 'CHOOSE', 'SWITCH', 'ROW', 'COLUMN', 'ROWS', 'COLUMNS', 'INDEX', 'OFFSET', 'INDIRECT', 'LET', 'LAMBDA', 'SUBTOTAL', 'AGGREGATE'],
).filter((n, i, a) => a.indexOf(n) === i).sort());

export class GridView {
  readonly session: Session;
  readonly docId: string;
  run: (id: string, params: Record<string, unknown>) => Promise<unknown>;
  editor: EditState | null = null;
  drag: Drag | null = null;
  /** Active cell moved inside a multi-cell selection by Enter/Tab (selection.next). */
  private cycled: {sel: string; active: Cell} | null = null;
  private scroll = new Map<string, {x: number; y: number}>();
  private remembered = new Map<string, unknown>();
  /** Tab run: the column the first Tab of a run left from (Enter returns there). */
  private tabRun: {sheet: number; col: number; at: Cell} | null = null;
  private listeners = new Set<() => void>();
  geo: Geo | null = null;
  private lastClick: {cell: Cell; t: number} | null = null;
  message: string | null = null;
  version = 0;
  /** The header cell whose AutoFilter drop-down is open, and the cell whose validation list is open. */
  filterMenu: Cell | null = null;
  listPicker: Cell | null = null;
  private noticeSeen: string | null = null;
  private urlSeen = 0;
  private dialogSeen = 0;
  /** Opens a dialog of the app (the filter menu's Custom Filter and Top 10); set by the surface. */
  openDialog: (id: string, init: Record<string, unknown>) => void = () => {};
  /** Whether a dialog is open (a data notice is shown only for the dialog that ran its command). */
  dialogOpen: (id: string) => boolean = () => false;

  constructor(session: Session, docId: string, run: (id: string, params: Record<string, unknown>) => Promise<unknown>) {
    this.session = session; this.docId = docId; this.run = run;
    // Data commands run from a dialog leave a notice in the view (Remove Duplicates' result, Goal Seek's status): shown as Excel's message box.
    this.stopNotices = session.subscribe((ev: any) => {
      if (ev?.doc !== docId || ev.type !== 'view.changed') return;
      // A command that needs a dialog of its own (the second password box, the Insert Hyperlink dialog) asks for it through the view.
      const dr = ev.view?.dialogRequest;
      if (dr && dr.seq !== this.dialogSeen) { this.dialogSeen = dr.seq; try { this.openDialog(String(dr.id), dr.init ?? {}); } catch { /* the dialog is not translated */ } }
      const u = ev.view?.openUrlRequest;
      if (u && u.seq !== this.urlSeen) { this.urlSeen = u.seq; void this.openUrl(String(u.url)); }
      const n = ev.view?.dataNotice;
      if (n && n.id !== this.noticeSeen) { this.noticeSeen = n.id; if (this.dialogOpen(n.kind === 'goalSeek' ? 'dialog.goalSeek' : 'dialog.removeDuplicates')) void this.showNotice(n); }
    });
  }
  private stopNotices: () => void;
  dispose() { this.stopNotices(); }

  private async showNotice(n: any) {
    if (n.kind === 'removeDuplicates') {
      const {removed, remaining} = n;
      await openMessageBox({title: 'Remove Duplicates', type: 'info', message: `${removed} duplicate value${removed === 1 ? '' : 's'} found and removed; ${remaining} unique value${remaining === 1 ? '' : 's'} remain${remaining === 1 ? 's' : ''}.`, buttons: ['OK'], defaultId: 0, cancelId: 0});
    } else if (n.kind === 'goalSeek') {
      const found = n.converged;
      const pick = await openMessageBox({title: 'Goal Seek Status', type: 'info', message: `Goal Seeking with Cell ${n.set} ${found ? 'found a solution.' : 'may not have found a solution.'}`, detail: `Target value: ${n.to}
Current value: ${n.result}`, buttons: ['OK', 'Cancel'], defaultId: 0, cancelId: 1});
      // Cancel keeps the sheet as it was.
      if (pick === 1 && this.has('edit.undo')) await this.run('edit.undo', {});
    }
  }
  /** Follows an external link after asking, as gridcraft does: only http, https and mailto get here (link.open checked). */
  private async openUrl(url: string) {
    const pick = await openMessageBox({title: 'Open hyperlink', type: 'question', message: 'Open this link?', detail: url, buttons: ['Open', 'Cancel'], defaultId: 1, cancelId: 1});
    if (pick !== 0) return;
    const studio = (window as any).studio;
    if (classify(url).kind === 'external' && typeof studio?.openExternal === 'function') void studio.openExternal(url);
  }
  /** The floating object the kernel selection names on this sheet: {kind, id} or null. */
  selectedObject(): {kind: string; id: number} | null {
    const d = this.doc();
    const s = selectedObjectOf(d.file.content, d.selection) as {si: number; kind: string; id: number} | null;
    return s ? {kind: s.kind, id: s.id} : null;
  }
  /** The Draw tab's tool now ('' when none), its colour and width, and the ink strokes the lasso holds (view.draw). */
  drawState(): {tool: string; color: string; width: number; lasso: number[]} {
    const d = ((this.doc().view as any)?.draw ?? {}) as Record<string, any>;
    return {tool: typeof d.tool === 'string' ? d.tool : '', color: typeof d.color === 'string' ? d.color : '#1F5FC9', width: Number.isFinite(d.width) ? d.width : 2, lasso: Array.isArray(d.lasso) ? d.lasso : []};
  }
  /** The eraser at a point (sheet pixels): when a stroke is there, delete it (nothing under the pointer is no error). */
  private eraseAt(p: [number, number]) {
    if (this.has('draw.erase') && inkHit(this.sheet(), p[0], p[1], 4)) void this.run('draw.erase', {x: p[0], y: p[1]}).catch(() => {});
  }
  /** What the Draw tab paints over the sheet: the stroke being drawn and the lasso's selection. */
  inkOverlay(): InkOverlay | null {
    const d = this.drag, st = this.drawState();
    const live = d?.kind === 'ink' && d.tool !== 'lassoMove' ? {pts: d.pts, color: st.color, width: st.width, kind: d.tool} : null;
    if (!live && !st.lasso.length) return null;
    return {live, lassoIds: st.lasso, lassoDrag: d?.kind === 'ink' && d.tool === 'lassoMove' ? d.offset : null};
  }
  /** The strokes Ink Replay has not reached yet. */
  hiddenInk(): Set<number> | null {
    // Review > Hide Ink: every stroke of the sheet.
    if ((this.doc().view as any)?.hideInk === true) return new Set<number>(((this.sheet().shapes ?? []) as any[]).filter(x => x.kind === 'ink').map(x => x.id));
    const r = (this.doc().view as any)?.inkReplay;
    return r && Array.isArray(r.ids) ? new Set<number>(r.ids.slice(r.n)) : null;
  }
  /** Whether Crop is on for the picture `hit` (Picture Format > Crop): its handles cut a side instead of resizing. */
  cropping(hit: {kind: string}): boolean { return hit.kind === 'image' && !!(this.doc().view as any)?.cropMode; }
  /** The rectangle a dragged object is shown at. */
  liveObject(): Live {
    const d = this.drag;
    if (d?.kind === 'object' && d.liveSet) return d.liveSet;
    return d?.kind === 'object' && d.live ? {kind: d.hit.kind, id: d.hit.id, rect: d.live} : null;
  }
  /** Every floating object the kernel selection names on this sheet (several when picked together or a group). */
  selectedObjects(): {kind: string; id: number}[] {
    const d = this.doc();
    return (selectedObjectsOf(d.file.content, d.selection) as {si: number; kind: string; id: number}[]).map(o => ({kind: o.kind, id: o.id}));
  }
  /** Snap to Grid / Snap to Shape (Page Layout > Align) are window settings. */
  snapFlag(which: 'snapToGrid' | 'snapToShape'): boolean { return (this.doc().view as any)?.[which] === true; }
  /** Selects a floating object (the kernel selection names it). */
  selectObject(kind: string, id: number, mode?: 'add' | 'toggle') {
    const sheet = this.sheet();
    // Picking one of a group picks the whole group; Shift adds to the objects picked, Ctrl toggles them.
    const members = kind === 'slicer' ? [{kind, id}] : (withGroup(sheet, kind, id) as {kind: string; id: number}[]);
    const has = (list: {kind: string; id: number}[], m: {kind: string; id: number}) => list.some(o => o.kind === m.kind && o.id === m.id);
    const now = this.selectedObjects().filter(o => o.kind !== 'slicer');
    let items = members;
    if (mode === 'add') items = [...now.filter(o => !has(members, o)), ...members];
    else if (mode === 'toggle') items = has(now, members[0]) ? now.filter(o => !has(members, o)) : [...now, ...members];
    if (!items.length) { void this.run('object.select', {}).catch(() => {}); return; }
    this.session.setSelection(this.docId, items.length === 1 ? objectSelection(sheet, items[0].kind, items[0].id) : objectsSelection(sheet, items), {origin: 'ui'});
    this.changed();
  }
  /** Runs a command and throws its error (a refused entry keeps the editor open with the message, as Excel). */
  runStrict(id: string, params: Record<string, unknown>) {
    return this.session.execute(this.docId, id, params, {origin: 'ui'});
  }

  // -- state ---------------------------------------------------------------------------------
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  changed() { this.version++; for (const l of [...this.listeners]) l(); }
  doc() { return this.session.get(this.docId) as any; }
  content(): any { return this.doc().file.content; }
  has(id: string) { return !!(this.session.registry as any).get(id); }
  can(id: string) { if (!this.has(id)) return false; try { return this.session.state(this.docId, id).enabled !== false; } catch { return false; } }

  /** The grid selection (kernel selection), with an Enter/Tab-cycled active cell. */
  sel(): Sel {
    const d = this.doc();
    // Merged cells are selected whole (Selection::expand_merges), however the selection was set.
    const raw = fromKernelSelection(d.file.content, d.selection) as Sel;
    const s = expandMerges(raw, d.file.content.sheets[raw.sheet]) as Sel;
    if (this.cycled && this.cycled.sel === JSON.stringify(d.selection)) return {...s, active: this.cycled.active};
    return s;
  }
  sheetIndex() { return this.sel().sheet; }
  sheet() { return this.content().sheets[this.sheetIndex()]; }
  sheetId() { return this.sheet().id as string; }
  engine() { return engineFor(this.content()); }

  setSel(next: Sel, {reveal = true, movingEnd: revealEnd = false}: {reveal?: boolean; movingEnd?: boolean} = {}) {
    const content = this.content();
    const sheet = content.sheets[next.sheet];
    const merged = expandMerges(next, sheet) as Sel;
    const ksel = toKernelSelection(content, merged);
    const activeIsAnchor = merged.active.row === merged.anchor.row && merged.active.col === merged.anchor.col;
    this.session.setSelection(this.docId, ksel, {origin: 'ui'});
    this.cycled = activeIsAnchor ? null : {sel: JSON.stringify(this.doc().selection), active: merged.active};
    if (reveal) this.reveal(revealEnd ? movingEnd(merged) : merged.active);
    this.changed();
  }

  // -- scrolling -----------------------------------------------------------------------------
  scrollOf(): {x: number; y: number} { return this.scroll.get(this.sheetId()) ?? {x: 0, y: 0}; }
  setScroll(x: number, y: number) {
    this.scroll.set(this.sheetId(), {x: Math.max(0, x), y: Math.max(0, y)});
    this.changed();
  }
  /** Scrolls so `c` is fully visible (ensure_visible). */
  reveal(c: Cell) {
    const g = this.geo;
    if (!g) return;
    const s = this.scrollOf();
    let {x, y} = s;
    if (c.row >= g.fr) {
      const top = g.scrollTopOf(c.row), h = g.rowHeight(c.row);
      const room = (g.cells.h - g.frozenH) / g.z;
      if (top < y) y = top; else if (top + h > y + room) y = Math.max(0, top + h - room);
    }
    if (c.col >= g.fc) {
      const left = g.scrollLeftOf(c.col), w = g.colWidth(c.col);
      const room = (g.cells.w - g.frozenW) / g.z;
      if (left < x) x = left; else if (left + w > x + room) x = Math.max(0, left + w - room);
    }
    if (x !== s.x || y !== s.y) this.setScroll(x, y);
  }

  // -- sheets --------------------------------------------------------------------------------
  /** Shows another sheet: sheet.activate when it exists, its remembered selection either way. */
  async showSheet(i: number) {
    const content = this.content();
    if (i === this.sheetIndex() || !content.sheets[i]) return;
    if (this.editor && !(await this.commit(0, 0))) return;
    this.remembered.set(this.sheetId(), this.doc().selection);
    if (this.has('sheet.activate')) await this.run('sheet.activate', {sheet: content.sheets[i].id});
    const prev = this.remembered.get(content.sheets[i].id) as any;
    const now = this.content();
    const ok = prev && fromKernelSelection(now, prev).sheet === i;
    this.session.setSelection(this.docId, ok ? prev : toKernelSelection(now, selectionAt(i, {row: 0, col: 0})), {origin: 'ui'});
    this.cycled = null;
    this.changed();
  }

  // -- addresses for commands ----------------------------------------------------------------
  cellAddress(c: Cell, si = this.sheetIndex()) { return `/sh:${encodeURIComponent(this.content().sheets[si].id)}/${a1(c.row, c.col)}`; }
  rangeAddress(r: Range, si = this.sheetIndex()) { return `/sh:${encodeURIComponent(this.content().sheets[si].id)}/${rangeA1(r)}`; }

  // -- values --------------------------------------------------------------------------------
  valueAt(row: number, col: number) { return this.engine().sheetValue(this.sheetIndex(), row, col); }
  usedRange(): Range | null {
    const r = this.engine().usedRange(this.sheetIndex());
    return r ?? null;
  }
  /** What the formula bar shows for the active cell when not editing. */
  barText(): string {
    const sel = this.sel();
    const sheet = this.content().sheets[sel.sheet];
    const at = (mergeAt(sheet, sel.active.row, sel.active.col)?.start ?? sel.active) as Cell;
    const c = cellAt(sheet, at.row, at.col);
    if (c?.a && c.f !== undefined) return `{=${c.f}}`;
    if (!c) {
      // A spilled value shows its anchor's formula, greyed (formula_bar.rs active_spill_anchor).
      const anchor = this.engine().spillAnchorOf(sel.sheet, at.row, at.col);
      if (anchor) { const ac = cellAt(sheet, anchor.row, anchor.col); return ac?.f !== undefined ? `=${ac.f}` : ''; }
      return '';
    }
    return editText(this.content(), sel.sheet, at.row, at.col);
  }
  /** Name Box text: a defined name or table exactly covering the selection, else the A1 of the current area. */
  nameBoxText(): string {
    if (this.editor && isFormula(this.editor)) return '';
    const sel = this.sel();
    const content = this.content();
    const cur = currentArea(sel) as Range;
    for (const n of content.names ?? []) {
      const f = String(n.formula ?? '');
      const m = /^(?:(?:'((?:[^']|'')+)'|([^!]+))!)?\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/.exec(f);
      if (!m) continue;
      const sheetName = m[1]?.replace(/''/g, "'") ?? m[2];
      if (sheetName && sheetIndex(content, sheetName) !== sel.sheet) continue;
      const r = parseRange(`${m[3]}${m[4]}${m[5] ? `:${m[5]}${m[6]}` : ''}`) as Range | null;
      if (r && sel.ranges.length === 1 && same(r, cur)) return n.name;
    }
    if (sel.ranges.length === 1 && isSingleCell(sel)) return a1(sel.active.row, sel.active.col);
    if (this.drag?.kind === 'select' || this.drag?.kind === 'rows' || this.drag?.kind === 'cols') {
      // While dragging, Excel shows the size: 3R x 2C.
      const h = cur.end.row - cur.start.row + 1, w = cur.end.col - cur.start.col + 1;
      return `${h}R x ${w}C`;
    }
    return a1(sel.active.row, sel.active.col);
  }

  /** Name Box: go to a reference, a defined name or a table (edit.goTo semantics). */
  goTo(text: string) {
    const t = text.trim();
    if (!t) return;
    const content = this.content();
    let si = this.sheetIndex();
    let body = t;
    const bang = t.lastIndexOf('!');
    if (bang > 0) {
      const name = t.slice(0, bang).replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
      si = sheetIndex(content, name);
      if (si < 0) throw new CommandError('not_found', `There is no sheet named ${name}.`);
      body = t.slice(bang + 1);
    }
    const parts = body.split(',').map(p => parseRange(p.trim()) as Range | null);
    if (parts.length && parts.every(Boolean)) {
      const ranges = parts as Range[];
      const last = ranges[ranges.length - 1];
      const go = () => this.setSel({sheet: si, active: {...last.start}, anchor: {...last.start}, ranges});
      if (si !== this.sheetIndex()) void this.showSheet(si).then(go); else go();
      return;
    }
    const table = tableByName(content, body);
    if (table) {
      const r = parseRange(table[1].range) as Range;
      const go = () => this.setSel({sheet: table[0], active: {...r.start}, anchor: {...r.start}, ranges: [r]});
      if (table[0] !== this.sheetIndex()) void this.showSheet(table[0]).then(go); else go();
      return;
    }
    const n = definedName(content, body, si);
    if (n) {
      const m = /^(?:(?:'((?:[^']|'')+)'|([^!]+))!)?(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)$/.exec(String(n.formula));
      if (m) {
        const target = m[1] || m[2] ? `${quoteSheet(m[1]?.replace(/''/g, "'") ?? m[2])}!${m[3]}` : m[3];
        this.goTo(target.replace(/\$/g, ''));
        return;
      }
    }
    throw new CommandError('invalid_params', 'Reference isn’t valid.');
  }

  // -- selection gestures ----------------------------------------------------------------------
  /** Ctrl adds the area, or removes it when already selected (never leaving nothing). */
  selectRanges(r: Range, add: boolean, active: Cell) {
    const sel = this.sel();
    if (add) {
      const idx = sel.ranges.findIndex(x => same(x, r));
      if (idx >= 0 && sel.ranges.length > 1) {
        const ranges = sel.ranges.filter((_, i) => i !== idx);
        const last = ranges[ranges.length - 1];
        this.setSel({...sel, ranges, active: {...last.start}, anchor: {...last.start}});
        return;
      }
      this.setSel({...sel, ranges: [...sel.ranges, r], active, anchor: active}, {reveal: false});
      return;
    }
    this.setSel({sheet: sel.sheet, ranges: [r], active, anchor: active}, {reveal: false});
  }

  /** selection.move: arrows (extend with Shift, jump with Ctrl). */
  move(dr: number, dc: number, extend: boolean, jumpEdge: boolean) {
    const sel = this.sel();
    const sheet = this.sheet();
    const from = extend ? movingEnd(sel) as Cell : sel.active;
    let to: Cell;
    if (jumpEdge) {
      const si = sel.sheet;
      const used = this.usedRange();
      to = jump((r: number, c: number) => this.engine().sheetValue(si, r, c), used, from, Math.sign(dr), Math.sign(dc)) as Cell;
    } else {
      // Moving off a merged cell skips its whole area.
      const m = !extend ? mergeAt(sheet, from.row, from.col) as Range | null : null;
      const base = m ? {row: dr > 0 ? m.end.row : dr < 0 ? m.start.row : from.row, col: dc > 0 ? m.end.col : dc < 0 ? m.start.col : from.col} : from;
      to = clampCell({row: base.row + dr, col: base.col + dc});
      // Hidden lines are skipped.
      const g = this.geo;
      if (g) {
        let guard = 0;
        while (dr && g.rowHeight(to.row) === 0 && to.row > 0 && to.row < MAX_ROWS - 1 && guard++ < 100000) to = {...to, row: to.row + Math.sign(dr)};
        while (dc && g.colWidth(to.col) === 0 && to.col > 0 && to.col < MAX_COLS - 1 && guard++ < 100000) to = {...to, col: to.col + Math.sign(dc)};
      }
    }
    this.tabRun = null;
    if (extend) this.setSel(extendTo(sel, to) as Sel, {movingEnd: true});
    else {
      const m = mergeAt(sheet, to.row, to.col) as Range | null;
      const at = m ? m.start : to;
      this.setSel(selectionAt(sel.sheet, at) as Sel);
    }
  }

  /** Enter/Tab: inside a multi-cell selection the active cell cycles; otherwise it moves. */
  moveAfterEnter(dr: number, dc: number) {
    const sel = this.sel();
    if (!isSingleCell(sel)) {
      const next = cycle(sel, dr > 0 || dc > 0, dc !== 0) as Sel;
      this.session.setSelection(this.docId, this.doc().selection, {origin: 'ui'});
      this.cycled = {sel: JSON.stringify(this.doc().selection), active: next.active};
      this.reveal(next.active);
      this.changed();
      return;
    }
    const run = this.tabRun && this.tabRun.sheet === sel.sheet && this.tabRun.at.row === sel.active.row && this.tabRun.at.col === sel.active.col ? this.tabRun : null;
    this.tabRun = null;
    if (run && dr === 1 && dc === 0) {
      this.setSel(selectionAt(sel.sheet, clampCell({row: sel.active.row + 1, col: run.col})) as Sel);
      return;
    }
    const to = clampCell({row: sel.active.row + dr, col: sel.active.col + dc});
    this.setSel(selectionAt(sel.sheet, to) as Sel);
    if (dr === 0 && dc !== 0) this.tabRun = {sheet: sel.sheet, col: run?.col ?? sel.active.col, at: to};
  }

  selectAll() {
    const sel = this.sel();
    const sheet = this.sheet();
    const filled = (r: number, c: number) => hasContent(cellAt(sheet, r, c)) || this.engine().spillAnchorOf(sel.sheet, r, c) !== null;
    // Ctrl+A: the current region first (when the active cell is in data), then the whole sheet.
    const region = currentRegion(filled, sel.active) as Range;
    const all: Range = {start: {row: 0, col: 0}, end: {row: MAX_ROWS - 1, col: MAX_COLS - 1}};
    const cur = currentArea(sel) as Range;
    const regionIsCell = region.start.row === region.end.row && region.start.col === region.end.col;
    const target = !regionIsCell && !same(cur, region) ? region : all;
    this.setSel({sheet: sel.sheet, active: sel.active, anchor: sel.active, ranges: [target]}, {reveal: false});
  }

  // -- editing ---------------------------------------------------------------------------------
  canEdit() { return this.has('cell.set'); }

  beginEdit(text: string | null, fromFormulaBar = false) {
    if (!this.canEdit()) return false;
    const sel = this.sel();
    const sheet = this.sheet();
    const at = (mergeAt(sheet, sel.active.row, sel.active.col)?.start ?? sel.active) as Cell;
    // A spilled value can't be edited from the formula bar (display only).
    if (fromFormulaBar && !cellAt(sheet, at.row, at.col) && this.engine().spillAnchorOf(sel.sheet, at.row, at.col)) return false;
    const current = editText(this.content(), sel.sheet, at.row, at.col);
    const replace = text !== null;
    const st = editState({sheet: sel.sheet, cell: at, text: replace ? text : current, enterMode: replace, fromFormulaBar, caret: undefined}) as unknown as EditState;
    st.original = current;
    this.editor = updateAutocomplete(st, functionNames()) as EditState;
    this.changed();
    return true;
  }
  setEditText(text: string, caret: number) {
    if (!this.editor) return;
    const next = setText(this.editor, text, caret) as EditState;
    this.editor = updateAutocomplete(next, functionNames()) as EditState;
    this.changed();
  }
  setCaret(caret: number) {
    if (!this.editor) return;
    this.editor = {...this.editor, caret, point: this.editor.point && this.editor.point[1] === caret ? this.editor.point : null};
    this.editor = updateAutocomplete(this.editor, functionNames()) as EditState;
    this.changed();
  }
  toggleEditMode() { if (this.editor) { this.editor = {...this.editor, enterMode: !this.editor.enterMode}; this.changed(); } }
  acceptAutocomplete() {
    if (!this.editor) return false;
    const next = acceptAutocomplete(this.editor);
    if (!next) return false;
    this.editor = next as EditState;
    this.changed();
    return true;
  }
  moveAutocomplete(d: number) {
    if (!this.editor?.autocomplete.length) return false;
    const n = this.editor.autocomplete.length;
    this.editor = {...this.editor, acIndex: (this.editor.acIndex + d + n) % n};
    this.changed();
    return true;
  }
  cancelEdit() { this.editor = null; this.drag = null; this.changed(); }

  /** Commits the edit (cell.set, or range.fill with Ctrl+Enter), then moves. False keeps editing. */
  async commit(dr: number, dc: number, {fillSelection = false, array = false}: {fillSelection?: boolean; array?: boolean} = {}) {
    const ed = this.editor;
    if (!ed) return true;
    const text = ed.text;
    if (!fillSelection && !array && text === ed.original) {
      this.editor = null;
      if (dr || dc) this.moveAfterEnter(dr, dc); else this.changed();
      return true;
    }
    const content = this.content();
    const sheet = content.sheets[ed.sheet];
    const unchanged = !fillSelection && !array && text === '' && !hasContent(cellAt(sheet, ed.cell.row, ed.cell.col));
    // Data validation: what is typed is checked against the cell's rule before it is entered (a formula is checked by its result, not here).
    if (!unchanged && !fillSelection && !array && !text.startsWith('=')) {
      const bad = checkValidation(content, ed.sheet, ed.cell, text);
      if (bad) {
        const answer = await this.validationAlert(bad);
        if (answer === 'retry') return false;
        if (answer === 'cancel') { this.editor = null; this.changed(); return true; }
      }
    }
    try {
      if (!unchanged) {
        if (fillSelection) {
          if (!this.has('range.fill')) throw new CommandError('unavailable', 'Fill selection is not available yet.');
          await this.runStrict('range.fill', {input: text});
        } else {
          await this.runStrict('cell.set', {cell: this.cellAddress(ed.cell, ed.sheet), input: text, ...(array ? {array: true} : {})});
        }
      }
    } catch (e) {
      this.message = (e as Error)?.message ?? String(e);
      this.changed();
      return false;
    }
    this.editor = null;
    if (ed.sheet !== this.sheetIndex()) await this.showSheet(ed.sheet);
    if (dr || dc) this.moveAfterEnter(dr, dc); else this.changed();
    return true;
  }

  /** Excel's alert for a value that breaks its rule: Stop (Retry, Cancel), Warning (Yes, No, Cancel) or Information (OK, Cancel). */
  private async validationAlert(bad: {message: string; title: string; style: string}): Promise<'accept' | 'retry' | 'cancel'> {
    const title = bad.title || 'Grid';
    if (bad.style === 'warning') {
      const i = await openMessageBox({title, type: 'warning', message: bad.message, detail: 'Do you want to continue?', buttons: ['Yes', 'No', 'Cancel'], defaultId: 1, cancelId: 2});
      return i === 0 ? 'accept' : i === 1 ? 'retry' : 'cancel';
    }
    if (bad.style === 'information') {
      const i = await openMessageBox({title, type: 'info', message: bad.message, buttons: ['OK', 'Cancel'], defaultId: 0, cancelId: 1});
      return i === 0 ? 'accept' : 'cancel';
    }
    const i = await openMessageBox({title, type: 'error', message: bad.message, buttons: ['Retry', 'Cancel'], defaultId: 0, cancelId: 1});
    return i === 0 ? 'retry' : 'cancel';
  }

  /** Alt+Down on the active cell: its filter drop-down, or its validation list. */
  openDropdownAtActive(): boolean {
    const sel = this.sel(), sheet = this.sheet();
    const c = sel.active;
    const g = this.geo;
    if (g && filterButtonAt(g, sheet, g.cellRect(c).x + g.cellRect(c).w - 4, g.cellRect(c).y + g.cellRect(c).h - 4)) { this.filterMenu = {...c}; this.listPicker = null; this.changed(); return true; }
    if (this.listArrow()) { this.listPicker = {...c}; this.filterMenu = null; this.changed(); return true; }
    return false;
  }

  /** References the editor shows on the sheet in view (outlines and editor colours). */
  editorRefs(): {start: number; end: number; range: Range; sheet: string | null; color: number}[] {
    if (!this.editor || !isFormula(this.editor)) return [];
    return formulaRefs(this.editor.text) as any;
  }
  refsOnSheet(): {range: Range; color: number}[] {
    const ed = this.editor;
    if (!ed) return [];
    const content = this.content();
    const origin = content.sheets[ed.sheet]?.name ?? '';
    const shown = this.sheet().name;
    return this.editorRefs().filter(r => refIsOnSheet(r.sheet, origin, shown)).map(r => ({range: r.range, color: r.color}));
  }
  /** Point mode: a click or arrow inserts (or replaces) a reference at the caret. */
  pointRef(range: Range, add: boolean) {
    if (!this.editor) return;
    let text = range.start.row === range.end.row && range.start.col === range.end.col ? a1(range.start.row, range.start.col) : rangeA1(range);
    if (this.sheetIndex() !== this.editor.sheet) text = `${quoteSheet(this.sheet().name)}!${text}`;
    this.editor = (add ? appendRef(this.editor, text) : insertRef(this.editor, text)) as EditState;
    this.editor = {...this.editor, autocomplete: []};
    this.changed();
  }
  canPoint() { return !!this.editor && canPoint(this.editor); }

  // -- pointer -----------------------------------------------------------------------------------
  /** Where a point is: 'corner', 'colHeader', 'rowHeader', 'cells', or null. */
  hit(x: number, y: number) {
    const g = this.geo;
    if (!g) return null;
    const inX = x >= g.cells.x && x < g.cells.x + g.cells.w, inY = y >= g.cells.y && y < g.cells.y + g.cells.h;
    if (x < g.cells.x && y < g.cells.y && x >= g.cells.x - g.headerW && y >= g.cells.y - g.headerH) return 'corner' as const;
    if (y < g.cells.y && y >= g.cells.y - g.headerH && inX) return 'colHeader' as const;
    if (x < g.cells.x && x >= g.cells.x - g.headerW && inY) return 'rowHeader' as const;
    if (inX && inY) return 'cells' as const;
    return null;
  }
  onFillHandle(x: number, y: number) {
    const g = this.geo;
    if (!g || !this.has('edit.autoFill')) return false;
    const sel = this.sel();
    if (sel.ranges.length !== 1) return false;
    const r = g.rangeRect(currentArea(sel) as Range);
    const hx = r.x + r.w, hy = r.y + r.h;
    return Math.abs(x - hx) <= 5 && Math.abs(y - hy) <= 5;
  }
  /** The cell border or other object's edge within a few pixels of `v` that Snap to Grid or Snap to Shape pulls it to, else null. */
  private snapEdge(g: Geo, axis: 'x' | 'y', v: number, others: number[]): number | null {
    let best: number | null = null, bestD = 6.5;
    const consider = (c: number) => { const d = Math.abs(c - v); if (d < bestD) { bestD = d; best = c; } };
    if (this.snapFlag('snapToGrid')) {
      if (axis === 'x') { const col = g.colAt(v); consider(g.x(col)); consider(g.x(col + 1)); } else { const row = g.rowAt(v); consider(g.y(row)); consider(g.y(row + 1)); }
    }
    if (this.snapFlag('snapToShape')) for (const c of others) consider(c);
    return best;
  }
  /** The edges of the objects other than `skip`, on screen, on each axis. */
  private otherEdges(g: Geo, skip: (kind: string, id: number) => boolean) {
    const xs: number[] = [], ys: number[] = [];
    for (const o of objectsOf(g, this.sheet())) if (!skip(o.kind, o.object.id)) { xs.push(o.rect.x, o.rect.x + o.rect.w); ys.push(o.rect.y, o.rect.y + o.rect.h); }
    return {xs, ys};
  }
  /** A rectangle being moved or sized by `handle` with its moving edges pulled to what Snap to Grid and Snap to Shape name. */
  private snapRect(g: Geo, hit: ObjectHit, r: Rect, handle: Handle | null): Rect {
    if (!this.snapFlag('snapToGrid') && !this.snapFlag('snapToShape')) return r;
    const others = this.otherEdges(g, (k, i) => k === hit.kind && i === hit.id);
    let {x, y, w, h} = r;
    const left = !handle || handle.includes('w'), right = !handle || handle.includes('e'), top = !handle || handle.includes('n'), bottom = !handle || handle.includes('s');
    const sl = left ? this.snapEdge(g, 'x', x, others.xs) : null, sr = right ? this.snapEdge(g, 'x', x + w, others.xs) : null;
    const st = top ? this.snapEdge(g, 'y', y, others.ys) : null, sb = bottom ? this.snapEdge(g, 'y', y + h, others.ys) : null;
    const nearer = (a: number | null, ea: number, b: number | null, eb: number) => (a !== null && (b === null || Math.abs(a - ea) <= Math.abs(b - eb)) ? 'a' : b !== null ? 'b' : '');
    if (!handle) {
      const px = nearer(sl, x, sr, x + w), py = nearer(st, y, sb, y + h);
      if (px === 'a') x = sl!; else if (px === 'b') x = sr! - w;
      if (py === 'a') y = st!; else if (py === 'b') y = sb! - h;
      return {x, y, w, h};
    }
    if (handle.includes('w') && sl !== null) { w += x - sl; x = sl; }
    if (handle.includes('e') && sr !== null) w = sr - x;
    if (handle.includes('n') && st !== null) { h += y - st; y = st; }
    if (handle.includes('s') && sb !== null) h = sb - y;
    return {x, y, w: Math.max(4, w), h: Math.max(0, h)};
  }
  /** The move (dx, dy) of several objects together pulled so their joint bounds meet what Snap names. */
  private snapDelta(g: Geo, rects: Rect[], dx: number, dy: number): {dx: number; dy: number} {
    if (!this.snapFlag('snapToGrid') && !this.snapFlag('snapToShape')) return {dx, dy};
    const picked = new Set(this.selectedObjects().map(o => `${o.kind}:${o.id}`));
    const others = this.otherEdges(g, (k, i) => picked.has(`${k}:${i}`));
    const x0 = Math.min(...rects.map(r => r.x)) + dx, x1 = Math.max(...rects.map(r => r.x + r.w)) + dx;
    const y0 = Math.min(...rects.map(r => r.y)) + dy, y1 = Math.max(...rects.map(r => r.y + r.h)) + dy;
    const a = this.snapEdge(g, 'x', x0, others.xs), b = this.snapEdge(g, 'x', x1, others.xs), c = this.snapEdge(g, 'y', y0, others.ys), d = this.snapEdge(g, 'y', y1, others.ys);
    if (a !== null && (b === null || Math.abs(a - x0) <= Math.abs(b - x1))) dx += a - x0; else if (b !== null) dx += b - x1;
    if (c !== null && (d === null || Math.abs(c - y0) <= Math.abs(d - y1))) dy += c - y0; else if (d !== null) dy += d - y1;
    return {dx, dy};
  }
  /** The cursor a point shows. */
  cursorAt(x: number, y: number): string {
    const g = this.geo;
    if (!g) return 'default';
    if (this.drag?.kind === 'resizeCol') return 'col-resize';
    if (this.drag?.kind === 'resizeRow') return 'row-resize';
    if (outlineHit(g, this.sheet(), x, y)) return 'pointer';
    if (this.hit(x, y) === 'cells' && ['pen', 'eraser', 'lasso'].includes(this.drawState().tool)) return 'crosshair';
    const oh = this.hit(x, y) === 'cells' ? hitObject(g, this.sheet(), x, y, this.selectedObject(), this.liveObject()) : null;
    if (oh) return cursorOf(oh);
    const h = this.hit(x, y);
    if (h === 'cells' && (filterButtonAt(g, this.sheet(), x, y) || (() => { const a = this.listArrow(); return !!a && x >= a.x && x < a.x + a.w && y >= a.y && y < a.y + a.h; })())) return 'pointer';
    if (h === 'colHeader') return g.colEdge(x) && this.has('home.columnWidth') ? 'col-resize' : 's-resize';
    if (h === 'rowHeader') return g.rowEdge(y) && this.has('home.rowHeight') ? 'row-resize' : 'e-resize';
    if (h === 'cells') return this.onFillHandle(x, y) || this.drag?.kind === 'fill' ? 'crosshair' : 'cell';
    return 'default';
  }

  async pointerDown(x: number, y: number, mods: Mods, button = 0, clickCount = 1) {
    const g = this.geo;
    if (!g || button !== 0) return;
    // The outline bands: their buttons act on release.
    const band = outlineHit(g, this.sheet(), x, y);
    const prevFilter = this.filterMenu, prevList = this.listPicker;
    if (prevFilter || prevList) { this.filterMenu = null; this.listPicker = null; this.changed(); }
    if (band) {
      if (this.editor && !(await this.commit(0, 0))) return;
      this.drag = {kind: 'outline', action: band};
      return;
    }
    const h = this.hit(x, y);
    if (!h) return;
    const sel = this.sel();
    const ctrl = !!(mods.ctrl || mods.meta);
    // A Draw tool takes the drag: a pen draws a stroke, the eraser takes the strokes it passes over, the lasso draws a loop (or, started
    // inside what it holds, moves it).
    if (h === 'cells' && !this.editor) {
      const st = this.drawState();
      const sheet = this.sheet();
      if (st.tool === 'pen' || st.tool === 'eraser' || st.tool === 'lasso') {
        const p = screenToSheet(g, sheet, x, y);
        if (st.tool === 'lasso' && st.lasso.length) {
          const boxes = objectsOf(g, sheet).filter(o => o.kind === 'shape' && o.object.kind === 'ink' && st.lasso.includes(o.object.id)).map(o => o.rect);
          const inside = boxes.some(r => x >= r.x - 3 && x <= r.x + r.w + 3 && y >= r.y - 3 && y <= r.y + r.h + 3);
          if (inside) { this.drag = {kind: 'ink', tool: 'lassoMove', pts: [], start: {x, y}, offset: {dx: 0, dy: 0}}; this.changed(); return; }
        }
        this.drag = {kind: 'ink', tool: st.tool, pts: [p], start: {x, y}, offset: {dx: 0, dy: 0}};
        if (st.tool === 'eraser') this.eraseAt(p);
        this.changed();
        return;
      }
    }
    if (h === 'cells' && !(this.editor && this.canPoint())) {
      const oh = hitObject(g, this.sheet(), x, y, this.selectedObject(), null);
      if (oh) {
        if (this.editor && !(await this.commit(0, 0))) return;
        // A click on a slicer's tile shows that value (Ctrl adds or removes it); its clear button shows every value.
        // A timeline: a click on a period picks it (Shift extends), on the level button changes the level, on an arrow scrolls, on the clear button shows every period.
        if (oh.kind === 'slicer' && oh.object.timeline && !oh.handle && this.has('timeline.select')) {
          const hitT = timelineHit(timelineLayout(oh.rect, oh.object, periodsOfTimeline(this.content(), oh.object), g.z), x, y) as any;
          if (hitT) {
            if (hitT.clear) await this.run('slicer.clear', {slicer: oh.id});
            else if (hitT.level) await this.run('timeline.level', {slicer: oh.id});
            else if (hitT.scroll) await this.run('timeline.scroll', {slicer: oh.id, by: hitT.scroll * 3});
            else await this.run('timeline.select', {slicer: oh.id, index: hitT.period, extend: mods.shift});
            this.changed();
            return;
          }
        }
        if (oh.kind === 'slicer' && !oh.object.timeline && !oh.handle && this.has('slicer.toggle')) {
          const tile = slicerHit(slicerLayout(oh.rect, oh.object, itemsOfSlicer(this.content(), this.sheetIndex(), oh.object), g.z), oh.rect, x, y);
          if (tile) {
            if (!this.selectedObject() || this.selectedObject()!.id !== oh.id || this.selectedObject()!.kind !== oh.kind) this.selectObject(oh.kind, oh.id);
            if (tile.clear) await this.run('slicer.clear', {slicer: oh.id});
            else await this.run('slicer.toggle', {slicer: oh.id, value: tile.value, multi: ctrl});
            this.changed();
            return;
          }
        }
        const mode = mods.shift ? 'add' : ctrl ? 'toggle' : undefined;
        const inSet = this.selectedObjects().some(o => o.kind === oh.kind && o.id === oh.id);
        if (mode || !inSet) this.selectObject(oh.kind, oh.id, mode);
        if (mode === 'toggle' && inSet) { this.changed(); return; }
        // Several picked: dragging one moves them all (no handles).
        const picked = this.selectedObjects();
        const set = picked.length > 1 && !oh.handle ? objectsOf(g, this.sheet()).filter(o => picked.some(q => q.kind === o.kind && q.id === o.object.id)).map(o => ({kind: o.kind, id: o.object.id as number, rect: o.rect})) : undefined;
        this.drag = {kind: 'object', hit: oh, handle: oh.handle, start: {x, y}, live: null, moved: false, ...(set && set.length > 1 ? {set} : {})};
        this.changed();
        return;
      }
    }
    if (h === 'cells') {
      // The +/- button of a PivotTable item expands or collapses it.
      const pb = pivotButtonAt(g, pivotButtons(this.content(), this.sheetIndex()), x, y);
      if (pb && this.has('pivot.toggleItem')) {
        if (this.editor && !(await this.commit(0, 0))) return;
        await this.run('pivot.toggleItem', {pivot: pb.pivot, cell: a1(pb.row, pb.col)});
        this.changed();
        return;
      }
      // A filter drop-down button in a header cell, or the arrow of the active cell's validation list.
      const fb = filterButtonAt(g, this.sheet(), x, y);
      const ar = this.listArrow();
      const onArrow = !!ar && x >= ar.x && x < ar.x + ar.w && y >= ar.y && y < ar.y + ar.h;
      if (fb || onArrow) {
        if (this.editor && !(await this.commit(0, 0))) return;
        if (fb) { if (!(prevFilter && prevFilter.row === fb.row && prevFilter.col === fb.col)) this.filterMenu = fb; }
        else if (!(prevList && prevList.row === sel.active.row && prevList.col === sel.active.col)) this.listPicker = {...sel.active};
        this.changed();
        return;
      }
    }
    if (h === 'corner') {
      if (this.editor && !(await this.commit(0, 0))) return;
      this.setSel({sheet: sel.sheet, active: sel.active, anchor: sel.active, ranges: [{start: {row: 0, col: 0}, end: {row: MAX_ROWS - 1, col: MAX_COLS - 1}}]}, {reveal: false});
      return;
    }
    if (h === 'colHeader') {
      const edge = g.colEdge(x);
      if (clickCount >= 2 && edge) {
        const [col] = edge;
        const selected = sel.ranges.some(r => isFullCols(r) && col >= r.start.col && col <= r.end.col);
        if (this.has('home.autofitColumnWidth')) await this.run('home.autofitColumnWidth', selected ? {} : {cols: `/sh:${encodeURIComponent(this.sheetId())}/col:${colToLetters(col)}`});
        this.drag = null;
        return;
      }
      if (edge && this.has('home.columnWidth')) {
        const [col, ex] = edge;
        const orig = (ex - g.x(col)) / g.z;
        this.drag = {kind: 'resizeCol', col, start: x, orig, size: orig};
        this.changed();
        return;
      }
      if (this.editor && !this.canPoint() && !(await this.commit(0, 0))) return;
      const c = g.colAt(x);
      const range = mods.shift ? FULL_COLS(sel.anchor.col, c) : FULL_COLS(c, c);
      if (this.editor && this.canPoint()) { this.pointRef(range, ctrl); return; }
      this.selectRanges(range, ctrl, {row: g.rowAt(g.cells.y + 1), col: mods.shift ? sel.anchor.col : c});
      this.drag = {kind: 'cols', anchor: mods.shift ? sel.anchor.col : c};
      return;
    }
    if (h === 'rowHeader') {
      const edge = g.rowEdge(y);
      if (clickCount >= 2 && edge) {
        const [row] = edge;
        const selected = sel.ranges.some(r => isFullRows(r) && row >= r.start.row && row <= r.end.row);
        if (this.has('home.autofitRowHeight')) await this.run('home.autofitRowHeight', selected ? {} : {rows: `/sh:${encodeURIComponent(this.sheetId())}/row:${row + 1}`});
        this.drag = null;
        return;
      }
      if (edge && this.has('home.rowHeight')) {
        const [row, ey] = edge;
        const orig = (ey - g.y(row)) / g.z;
        this.drag = {kind: 'resizeRow', row, start: y, orig, size: orig};
        this.changed();
        return;
      }
      if (this.editor && !this.canPoint() && !(await this.commit(0, 0))) return;
      const r = g.rowAt(y);
      const range = mods.shift ? FULL_ROWS(sel.anchor.row, r) : FULL_ROWS(r, r);
      if (this.editor && this.canPoint()) { this.pointRef(range, ctrl); return; }
      this.selectRanges(range, ctrl, {row: mods.shift ? sel.anchor.row : r, col: g.colAt(g.cells.x + 1)});
      this.drag = {kind: 'rows', anchor: mods.shift ? sel.anchor.row : r};
      return;
    }
    // Cells.
    const c = g.cellAt(x, y);
    if (this.editor && this.canPoint()) {
      this.pointRef(mkRange(c, c), ctrl);
      this.drag = {kind: 'point', anchor: c};
      return;
    }
    if (this.onFillHandle(x, y)) {
      if (this.editor && !(await this.commit(0, 0))) return;
      if (clickCount >= 2) {
        const target = doubleClickFillTarget(this.sheet(), currentArea(sel)) as Range | null;
        if (target) await this.runFill(currentArea(sel) as Range, target, 'series');
        return;
      }
      this.drag = {kind: 'fill', target: null};
      this.changed();
      return;
    }
    // A checkbox cell toggles when its box is clicked; Ctrl+click follows a hyperlink.
    {
      const sheetNow = this.sheet();
      const rect = g.cellRect(c);
      if (!this.editor && this.has('cell.toggleCheckbox') && styleAt(this.content(), sheetNow, c.row, c.col).numFmt === 'checkbox'
        && Math.abs(x - (rect.x + rect.w / 2)) <= 9 * g.z && Math.abs(y - (rect.y + rect.h / 2)) <= 9 * g.z) {
        this.setSel(selectionAt(sel.sheet, c) as Sel, {reveal: false});
        await this.run('cell.toggleCheckbox', {cell: a1(c.row, c.col)});
        return;
      }
      if (ctrl && !mods.shift && sheetNow.hyperlinks?.[a1(c.row, c.col)] && this.has('link.open')) {
        this.setSel(selectionAt(sel.sheet, c) as Sel, {reveal: false});
        await this.run('link.open', {cell: a1(c.row, c.col)});
        return;
      }
    }
    const now = Date.now();
    const dbl = clickCount >= 2 || (this.lastClick && this.lastClick.cell.row === c.row && this.lastClick.cell.col === c.col && now - this.lastClick.t < 500 && clickCount !== 1);
    if (this.editor) {
      const ed = this.editor;
      if (ed.cell.row === c.row && ed.cell.col === c.col && ed.sheet === sel.sheet) return;
      if (!(await this.commit(0, 0))) return;
    }
    if (dbl) {
      this.lastClick = null;
      this.setSel(selectionAt(sel.sheet, c) as Sel, {reveal: false});
      // A PivotTable's value cell shows its source records on a new sheet (Excel's Show Details); its labels and headers still edit
      // (gridcraft interact.rs `handle_cell_double_click`).
      if (!mods.shift && this.has('pivot.showDetails') && (this.sheet().pivots ?? []).some((pt: any) => { const r = pt.lastRange ? parseRange(pt.lastRange) : null; return !!r && c.row >= r.start.row && c.row <= r.end.row && c.col >= r.start.col && c.col <= r.end.col; })) {
        let st: any = null;
        try { st = this.session.state(this.docId, 'pivot.showDetails'); } catch { /* none */ }
        if (st?.enabled) { await this.run('pivot.showDetails', {cell: a1(c.row, c.col)}); this.changed(); return; }
        if (st?.reason && st.reason !== 'select a value cell in a PivotTable') { await openMessageBox({title: 'Show Details', type: 'warning', message: st.reason, buttons: ['OK'], defaultId: 0, cancelId: 0}); return; }
      }
      this.beginEdit(null);
      return;
    }
    this.lastClick = {cell: c, t: now};
    if (mods.shift) {
      const next = {...sel, ranges: [...sel.ranges.slice(0, -1), mkRange(sel.anchor, c)]};
      this.setSel(next, {reveal: false});
    } else if (ctrl) this.selectRanges(mkRange(c, c), true, c);
    else {
      const m = mergeAt(this.sheet(), c.row, c.col) as Range | null;
      this.setSel(selectionAt(sel.sheet, m ? m.start : c) as Sel, {reveal: false});
    }
    this.drag = {kind: 'select'};
  }

  pointerMove(x: number, y: number) {
    const g = this.geo;
    const d = this.drag;
    if (!g || !d) return;
    const pc = {row: g.rowAt(Math.min(Math.max(y, g.cells.y + 1), g.cells.y + g.cells.h - 1)), col: g.colAt(Math.min(Math.max(x, g.cells.x + 1), g.cells.x + g.cells.w - 1))};
    // Auto-scroll near the edges.
    const edge = 24;
    let ax = 0, ay = 0;
    if (d.kind !== 'resizeCol' && d.kind !== 'resizeRow' && d.kind !== 'object' && d.kind !== 'ink') {
      if (y > g.cells.y + g.cells.h - edge) ay = 20;
      if (y < g.cells.y + edge * 0.5) ay = -20;
      if (x > g.cells.x + g.cells.w - edge) ax = 30;
      if (x < g.cells.x + edge * 0.5) ax = -30;
    }
    const sel = this.sel();
    switch (d.kind) {
      case 'select': {
        const ranges = sel.ranges.slice(0, -1);
        ranges.push(mkRange(sel.anchor, pc));
        this.setSel({...sel, ranges}, {reveal: false});
        break;
      }
      case 'point': {
        if (!this.editor) break;
        this.pointRef(mkRange(d.anchor, pc), false);
        break;
      }
      case 'rows': {
        const r = g.rowAt(y);
        this.setSel({...sel, ranges: [...sel.ranges.slice(0, -1), FULL_ROWS(d.anchor, r)]}, {reveal: false});
        ay = ay; ax = 0;
        break;
      }
      case 'cols': {
        const c = g.colAt(x);
        this.setSel({...sel, ranges: [...sel.ranges.slice(0, -1), FULL_COLS(d.anchor, c)]}, {reveal: false});
        ay = 0;
        break;
      }
      case 'object': {
        const dx = x - d.start.x, dy = y - d.start.y;
        if (!d.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) break;
        if (d.set) {
          const s = this.snapDelta(g, d.set.map(o => o.rect), dx, dy);
          this.drag = {...d, moved: true, delta: s, liveSet: d.set.map(o => ({kind: o.kind, id: o.id, rect: {x: o.rect.x + s.dx, y: o.rect.y + s.dy, w: o.rect.w, h: o.rect.h}}))};
          this.changed();
          ay = 0; ax = 0;
          break;
        }
        const keep = (d.hit.kind === 'image' && !this.cropping(d.hit)) || d.hit.object.kind === 'icon';
        this.drag = {...d, moved: true, live: this.snapRect(g, d.hit, dragRect(d.hit.rect, d.handle, dx, dy, keep), d.handle)};
        this.changed();
        ay = 0; ax = 0;
        break;
      }
      case 'ink': {
        if (d.tool === 'lassoMove') { this.drag = {...d, offset: {dx: x - d.start.x, dy: y - d.start.y}}; this.changed(); break; }
        const p = screenToSheet(g, this.sheet(), Math.min(Math.max(x, g.cells.x + 1), g.cells.x + g.cells.w - 1), Math.min(Math.max(y, g.cells.y + 1), g.cells.y + g.cells.h - 1));
        const last = d.pts[d.pts.length - 1];
        if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 1 / g.z) break;
        if (d.tool === 'eraser') this.eraseAt(p);
        this.drag = {...d, pts: d.tool === 'eraser' ? [p] : [...d.pts, p]};
        this.changed();
        break;
      }
      case 'resizeCol': this.drag = {...d, size: Math.max(0, d.orig + (x - d.start) / g.z)}; this.changed(); break;
      case 'resizeRow': this.drag = {...d, size: Math.max(0, d.orig + (y - d.start) / g.z)}; this.changed(); break;
      case 'fill': {
        const target = fillTarget(currentArea(sel), pc) as Range;
        this.drag = {kind: 'fill', target};
        this.changed();
        break;
      }
    }
    if (ax || ay) { const s = this.scrollOf(); this.setScroll(s.x + ax, s.y + ay); }
  }

  async pointerUp(_x: number, _y: number, mods: Mods) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const sel = this.sel();
    const sid = encodeURIComponent(this.sheetId());
    switch (d.kind) {
      case 'outline': {
        const g = this.geo;
        const now = g ? outlineHit(g, this.sheet(), _x, _y) : null;
        const same = (a: OutlineAction, b: OutlineAction) => a.kind === b.kind && a.rows === b.rows && (a.kind === 'level' ? a.level === (b as any).level : a.group.start === (b as any).group.start && a.group.end === (b as any).group.end && a.group.level === (b as any).group.level);
        if (now && same(now, d.action)) { const {command, params} = actionCommand(d.action); if (this.has(command)) await this.run(command, params); }
        break;
      }
      case 'object': {
        const g = this.geo;
        if (g && d.moved && d.set && d.delta && this.has('arrange.moveBy')) {
          await this.run('arrange.moveBy', {dx: Math.round(d.delta.dx / g.z), dy: Math.round(d.delta.dy / g.z)});
          break;
        }
        if (!g || !d.moved || !d.live) break;
        const r = d.live;
        const col = g.colAt(Math.max(g.cells.x + 1, r.x)), row = g.rowAt(Math.max(g.cells.y + 1, r.y));
        // Crop turned on: dragging a handle cuts that side of the picture instead of resizing it.
        if (d.handle && this.cropping(d.hit) && this.has('picture.crop')) {
          const o = d.hit.rect, c = {l: 0, t: 0, r: 0, b: 0, ...(d.hit.object.crop ?? {})};
          const fx = (1 - c.l - c.r) / Math.max(1, o.w), fy = (1 - c.t - c.b) / Math.max(1, o.h);
          await this.run('picture.crop', {id: d.hit.id, left: c.l + (r.x - o.x) * fx, right: c.r + (o.x + o.w - (r.x + r.w)) * fx, top: c.t + (r.y - o.y) * fy, bottom: c.b + (o.y + o.h - (r.y + r.h)) * fy});
          break;
        }
        if (this.has('object.move')) {
          await this.run('object.move', {kind: d.hit.kind, id: d.hit.id, at: a1(row, col), dx: Math.round((r.x - g.x(col)) / g.z), dy: Math.round((r.y - g.y(row)) / g.z),
            width: Math.max(1, Math.round(r.w / g.z)), height: Math.max(0, Math.round(r.h / g.z))});
        }
        break;
      }
      case 'ink': {
        const g = this.geo;
        if (d.tool === 'pen' && this.has('draw.stroke')) {
          // A click draws a dot: the point twice.
          const pts = d.pts.length === 1 ? [d.pts[0], [d.pts[0][0] + 0.1, d.pts[0][1]] as [number, number]] : d.pts;
          await this.run('draw.stroke', {points: pts});
        } else if (d.tool === 'lasso' && this.has('draw.lasso')) {
          await this.run('draw.lasso', d.pts.length >= 3 ? {points: d.pts} : {clear: true});
        } else if (d.tool === 'lassoMove' && g && this.has('draw.lassoMove') && (Math.abs(d.offset.dx) >= 1 || Math.abs(d.offset.dy) >= 1)) {
          await this.run('draw.lassoMove', {dx: Math.round(d.offset.dx / g.z), dy: Math.round(d.offset.dy / g.z)});
        }
        break;
      }
      case 'resizeCol': {
        const cols = sel.ranges.some(r => isFullCols(r) && d.col >= r.start.col && d.col <= r.end.col)
          ? sel.ranges.filter(isFullCols).map(r => `/sh:${sid}/${r.start.col === r.end.col ? `col:${colToLetters(r.start.col)}` : `cols:${colToLetters(r.start.col)}-${colToLetters(r.end.col)}`}`).join(',')
          : `/sh:${sid}/col:${colToLetters(d.col)}`;
        if (Math.round(d.size) !== Math.round(d.orig)) await this.run('home.columnWidth', {cols, width: Math.round(d.size)});
        break;
      }
      case 'resizeRow': {
        const rows = sel.ranges.some(r => isFullRows(r) && d.row >= r.start.row && d.row <= r.end.row)
          ? sel.ranges.filter(isFullRows).map(r => `/sh:${sid}/${r.start.row === r.end.row ? `row:${r.start.row + 1}` : `rows:${r.start.row + 1}-${r.end.row + 1}`}`).join(',')
          : `/sh:${sid}/row:${d.row + 1}`;
        if (Math.round(d.size) !== Math.round(d.orig)) await this.run('home.rowHeight', {rows, height: Math.round(d.size)});
        break;
      }
      case 'fill': {
        const src = currentArea(sel) as Range;
        if (d.target && !same(d.target, src)) await this.runFill(src, d.target, mods.ctrl || mods.meta ? 'alternate' : 'series');
        break;
      }
      case 'select': {
        // Home > Borders > Draw Border (and Grid, Erase): the cells just dragged over take the pen's border.
        if ((this.doc().view as any)?.drawBorder && this.has('home.drawBorder')) await this.run('home.drawBorder', {apply: true});
        break;
      }
      default: break;
    }
    this.changed();
  }

  async runFill(src: Range, target: Range, mode: string) {
    if (!this.has('edit.autoFill')) return;
    await this.run('edit.autoFill', {source: this.rangeAddress(src), target: this.rangeAddress(target), mode});
    const sel = this.sel();
    this.setSel({sheet: sel.sheet, active: sel.active, anchor: sel.active, ranges: [target]}, {reveal: false});
  }

  // -- keyboard (grid focused, no editor) ------------------------------------------------------
  /** Returns true when the key was handled. */
  async key(key: string, mods: Mods): Promise<boolean> {
    const g = this.geo;
    const ctrl = !!(mods.ctrl || mods.meta);
    const shift = !!mods.shift;
    const page = g ? Math.max(1, Math.floor((g.cells.h / g.z) / defaultRowHeight(this.sheet()))) : 20;
    // Ink the lasso holds: Delete removes it, Escape lets it go.
    const held = this.drawState().lasso;
    if (held.length && (key === 'Delete' || key === 'Backspace') && this.has('draw.lassoDelete')) { await this.run('draw.lassoDelete', {}); return true; }
    if (held.length && key === 'Escape' && this.has('draw.lasso')) { await this.run('draw.lasso', {clear: true}); return true; }
    const obj = this.selectedObject();
    if (obj) {
      if (key === 'Delete' || key === 'Backspace') { if (this.has('object.delete')) await this.run('object.delete', {kind: obj.kind, id: obj.id}); return true; }
      if (key === 'Escape') { if (this.has('object.select')) await this.run('object.select', {}); return true; }
      if (key.startsWith('Arrow')) {
        const o = (this.sheet()[({chart: 'charts', image: 'images', shape: 'shapes', slicer: 'slicers'} as Record<string, string>)[obj.kind]] ?? []).find((q: any) => q.id === obj.id);
        const step = mods.shift ? 1 : 8;
        if (o && this.has('object.move')) {
          const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0, dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
          await this.run('object.move', {kind: obj.kind, id: obj.id, dx: (o.anchor.dx ?? 0) + dx, dy: (o.anchor.dy ?? 0) + dy});
        }
        return true;
      }
    }
    if (key === ' ' && !obj && !mods.ctrl && !mods.shift && this.has('cell.toggleCheckbox')) {
      const sel = this.sel();
      const c = cellAt(this.sheet(), sel.active.row, sel.active.col);
      if (c && styleAt(this.content(), this.sheet(), sel.active.row, sel.active.col).numFmt === 'checkbox') { await this.run('cell.toggleCheckbox', {}); return true; }
    }
    if (key === 'ArrowDown' && mods.alt && this.openDropdownAtActive()) return true;
    switch (key) {
      case 'ArrowUp': this.move(-1, 0, shift, ctrl); return true;
      case 'ArrowDown': this.move(1, 0, shift, ctrl); return true;
      case 'ArrowLeft': this.move(0, -1, shift, ctrl); return true;
      case 'ArrowRight': this.move(0, 1, shift, ctrl); return true;
      case 'PageDown':
        if (ctrl) { const i = this.sheetIndex(); if (i + 1 < this.content().sheets.length) await this.showSheet(i + 1); return true; }
        this.move(page, 0, shift, false); return true;
      case 'PageUp':
        if (ctrl) { const i = this.sheetIndex(); if (i > 0) await this.showSheet(i - 1); return true; }
        this.move(-page, 0, shift, false); return true;
      case 'Home': {
        const sel = this.sel();
        const f = g ? {row: g.fr, col: g.fc} : {row: 0, col: 0};
        const to = ctrl ? f : {row: sel.active.row, col: 0};
        if (shift) this.setSel(extendTo(sel, to) as Sel); else this.setSel(selectionAt(sel.sheet, to) as Sel);
        return true;
      }
      case 'End': {
        if (!ctrl) return false;
        const sel = this.sel();
        const u = usedBounds(this.sheet());
        const to = u ? {row: u.r1, col: u.c1} : {row: 0, col: 0};
        if (shift) this.setSel(extendTo(sel, to) as Sel); else this.setSel(selectionAt(sel.sheet, to) as Sel);
        return true;
      }
      case 'Enter':
        if (mods.alt || ctrl) { this.beginEdit(null); return true; }
        this.moveAfterEnter(shift ? -1 : 1, 0); return true;
      case 'Tab': this.moveAfterEnter(0, shift ? -1 : 1); return true;
      case 'F2': this.beginEdit(null); return true;
      case 'Delete':
        if (this.has('edit.clearContents')) await this.run('edit.clearContents', {});
        return true;
      case 'Backspace':
        if (this.has('edit.clearContents')) await this.run('edit.clearContents', {});
        if (isSingleCell(this.sel())) this.beginEdit('');
        return true;
      case ' ':
        if (ctrl && !shift) { const s = this.sel(); this.setSel({...s, ranges: [FULL_COLS(s.active.col, s.active.col)]}, {reveal: false}); return true; }
        if (shift && !ctrl) { const s = this.sel(); this.setSel({...s, ranges: [FULL_ROWS(s.active.row, s.active.row)]}, {reveal: false}); return true; }
        if (ctrl && shift) { this.selectAll(); return true; }
        return false;
      case 'a': case 'A':
        if (ctrl && !mods.alt) { this.selectAll(); return true; }
        return false;
      default: return false;
    }
  }

  /** Printable text typed on the grid starts an edit that replaces the cell (Enter mode). */
  typeText(text: string) {
    if (!text || /[\u0000-\u001f]/.test(text)) return false;
    if (this.editor) { const ed = this.editor; this.setEditText(ed.text.slice(0, ed.caret) + text + ed.text.slice(ed.caret), ed.caret + text.length); return true; }
    return this.beginEdit(text);
  }

  /** Arrow keys while editing: Enter mode commits and moves; pointing inserts a reference. */
  editorArrow(key: string, mods: Mods): boolean {
    const ed = this.editor;
    if (!ed) return false;
    const d: Record<string, [number, number]> = {ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1]};
    const [dr, dc] = d[key] ?? [0, 0];
    if (!dr && !dc) return false;
    if (ed.autocomplete.length && (key === 'ArrowUp' || key === 'ArrowDown')) return this.moveAutocomplete(dr);
    if (!ed.enterMode) return false;
    if (canPoint(ed)) {
      // Pointing: the reference moves (Shift extends it).
      const sel = this.sel();
      const prev = ed.point ? (formulaRefs(ed.text) as any[]).find(r => r.start === ed.point![0] && r.end === ed.point![1])?.range as Range | undefined : undefined;
      const base: Cell = prev ? (mods.shift ? prev.end : prev.start) : ed.cell;
      const next = clampCell({row: base.row + dr, col: base.col + dc});
      const range = mods.shift && prev ? mkRange(prev.start, next) : mkRange(next, next);
      this.pointRef(range, false);
      void sel;
      return true;
    }
    void this.commit(dr, dc).then(ok => { if (ok) this.tabRun = null; });
    return true;
  }

  /** Circle Invalid Data: the circled cells of this sheet that still break their rule. */
  circles(): Cell[] {
    const c = (this.doc().view as any)?.circles;
    if (!c || c.sheet !== this.sheetId()) return [];
    const content = this.content(), si = this.sheetIndex();
    const out: Cell[] = [];
    for (const ref of c.cells as string[]) {
      const r = parseRange(ref) as Range | null;
      if (!r) continue;
      const cell = r.start;
      if (checkValidation(content, si, cell, editText(content, si, cell.row, cell.col))) out.push(cell);
    }
    return out;
  }
  /** The in-cell list arrow of the active cell (not while editing). */
  listArrow() {
    const g = this.geo;
    if (!g || this.editor) return null;
    return validationArrowAt(g, this.sheet(), this.sel().active);
  }

  /** The cell the pointer is over (a note or comment shows its box there). */
  hoverCell: Cell | null = null;
  setHover(c: Cell | null) {
    const h = this.hoverCell;
    if ((h?.row ?? -1) === (c?.row ?? -1) && (h?.col ?? -1) === (c?.col ?? -1)) return;
    this.hoverCell = c;
    this.changed();
  }
  /** Review > Show All Notes: every note shows its box. */
  showAllNotes(): boolean { return !!(this.doc().view as any)?.showAllNotes; }
  /** The zoom the window shows, in percent (View > Zoom; the shared view.zoom commands set it). */
  zoomPercent(): number | undefined { const z = Number((this.doc().view as any)?.zoom); return Number.isFinite(z) && z > 0 ? z : undefined; }
  /** The view of the window: Normal, or Page Break Preview. */
  pageBreakPreview(): boolean { return (this.doc().view as any)?.mode === 'pageBreakPreview'; }
  /** Whether the formula bar is shown (View > Formula Bar, an application option). */
  formulaBarShown(): boolean { return (this.session as any).prefs?.formulaBar !== false; }

  /** The text the in-cell editor would show as AutoComplete suggestion for the column (not used: off). */
  geoFor(sheet: any, w: number, h: number) {
    const s = this.scrollOf();
    this.geo = new Geo(sheet, {x: 0, y: 0, w, h}, s.x, s.y, this.zoomPercent());
    return this.geo;
  }
}

export {activeSheetIndex};
