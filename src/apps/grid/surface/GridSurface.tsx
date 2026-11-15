// Grid's editing surface (docs/architecture.md 16.2; F:grid), in Excel's layout:
//
//   [Name Box ▾] ⋮ ✕ ✓ fx [ formula bar                                         ]
//   ┌────┬──────┬──────┬──────┬────────────────────────────────────────────────┐▲
//   │    │  A   │  B   │  C   │  …   (canvas: headers, cells, selection)       ││
//   │ 1  │      │      │      │                                                ││
//   └────┴──────┴──────┴──────┴────────────────────────────────────────────────┘▼
//   ◀ ▶  Sheet1  Sheet2  (+)                          ◀━━━━━━━━━━━━━━━━━━━━━━━▶
//
// Translated from gridcraft crates/ui-egui/src/formula_bar.rs (Name Box, the cancel/enter/fx
// buttons, the bar text, editing from the bar), crates/ui-egui/src/grid.rs and grid/* (the grid),
// and crates/ui-egui/src/tabs.rs (sheet tabs: click, double-click to rename in place, drag to
// reorder, New sheet, the scroll arrows) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Controls whose command is not translated yet are not shown (fx needs formulas.insertFunction,
// New sheet needs home.insertSheet, rename needs sheet.rename, reorder needs sheet.move).

import {useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent} from 'react';
import type {SurfaceProps} from '../../../shell/AppHost';
import type {SurfaceHandle} from '../../../shell/engine/ShellController';
import {CommandError, toCommandError} from '../../../../core/kernel/errors.mjs';
import {evaluate as contextFlags} from '../../../../core/grid/context.mjs';
import {useShellState} from '../../../shell/engine/useCommand';
import {GridView} from './view';
import {filterButtonRect} from './dataUi';
import {layout as outlineLayout} from './outline';
import {objectsOf, sheetToScreen} from './objects';
import {GridCanvas, HorizontalBar, editorKey} from './GridCanvas';
import {FormulaInput} from './FormulaInput';
import './grid.css';

/** The panes that follow a document view flag: [flag, pane id, the command that sets the flag]. */
const FLAG_PANES: [string, string, string][] = [['commentsPane', 'pane.comments', 'review.showComments'], ['formatChartPane', 'pane.formatChart', 'chart.formatSelection'], ['pivotPane', 'pane.pivotFields', 'pivot.fieldList'], ['watchPane', 'pane.watch', 'formulas.watchWindow'], ['selectionPane', 'pane.selection', 'arrange.selectionPane']];
function useView(view: GridView) {
  useSyncExternalStore(view.session.subscribe, () => view.session.tick);
  return useSyncExternalStore(c => view.subscribe(c), () => view.version);
}

export default function GridSurface({controller, docId, register}: SurfaceProps) {
  const session = controller.session;
  const view = useMemo(() => new GridView(session, docId, async (id, params) => {
    const r = await controller.run(id, params, {origin: 'ui'});
    return r;
  }), [session, docId, controller]);
  view.openDialog = (id, init) => { try { controller.openDialog(id, {init}); } catch (e) { controller.notify(toCommandError(e).message, 'error'); } };
  view.dialogOpen = id => controller.getState().dialogs.some((d: {id: string}) => d.id === id);
  useEffect(() => () => view.dispose(), [view]);
  useView(view);
  const root = useRef<HTMLDivElement>(null);

  // Panes that follow the document view: Review > Show Comments (view.commentsPane) and Chart Design > Format Pane
  // (view.formatChartPane). The command sets the flag, the shell opens or closes the pane, and a pane closed with its own
  // button turns the flag off again.
  const shell = useShellState();
  const viewFlags = ((session.get(docId) as any)?.view ?? {}) as Record<string, unknown>;
  const paneSeen = useRef<Record<string, boolean>>({});
  useEffect(() => {
    for (const [flag, pane] of FLAG_PANES) {
      const want = !!viewFlags[flag];
      if (paneSeen.current[flag] === want) continue;
      paneSeen.current[flag] = want;
      try { if (controller.paneImplemented(pane) || !want) controller.setPane(pane, want); } catch { /* not translated */ }
    }
  }, [viewFlags.commentsPane, viewFlags.formatChartPane, viewFlags.pivotPane, viewFlags.watchPane, viewFlags.selectionPane, controller]);
  useEffect(() => {
    for (const [flag, pane, command] of FLAG_PANES) {
      const open = shell.panes.some(p => p.id === pane && p.open);
      if (viewFlags[flag] && paneSeen.current[flag] && !open && shell.panes.some(p => p.id === pane)) {
        paneSeen.current[flag] = false;
        void session.execute(docId, command, {on: false}, {origin: 'ui'}).catch(() => {});
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell.panes]);

  // Ink Replay (Draw > Replay): the strokes appear again one by one, a step every 350 ms, until the last.
  const replay = viewFlags.inkReplay as {ids: number[]; n: number} | null | undefined;
  useEffect(() => {
    if (!replay) return undefined;
    const timer = setTimeout(() => { void session.execute(docId, 'draw.inkReplay', {step: replay.n + 1}, {origin: 'ui'}).catch(() => {}); }, 350);
    return () => clearTimeout(timer);
  }, [replay, session, docId]);

  useEffect(() => register({
    focus: () => { root.current?.querySelector<HTMLTextAreaElement>(view.editor ? '.grid-formula-text' : '.grid-keys')?.focus({preventScroll: true}); },
    contextFlags: () => { try { const d = session.get(docId); return contextFlags(d.file.content, d.selection, undefined, d.view); } catch { return {}; } },
    // Right-click (Excel): a cell, row or column outside the selection is selected first.
    contextMenu: async (cx: number, cy: number) => {
      const canvas = root.current?.querySelector<HTMLCanvasElement>('canvas.grid-canvas');
      const g = view.geo;
      if (!canvas || !g) return null;
      const b = canvas.getBoundingClientRect();
      const x = cx - b.left, y = cy - b.top;
      const h = view.hit(x, y);
      if (!h) return null;
      const cell = g.cellAt(Math.max(x, g.cells.x + 1), Math.max(y, g.cells.y + 1));
      const sel = view.sel();
      const inside = sel.ranges.some(r => (h === 'rowHeader' || cell.row >= Math.min(r.start.row, r.end.row) && cell.row <= Math.max(r.start.row, r.end.row))
        && (h === 'colHeader' || cell.col >= Math.min(r.start.col, r.end.col) && cell.col <= Math.max(r.start.col, r.end.col))
        && (h !== 'rowHeader' || r.start.col === 0) && (h !== 'colHeader' || r.start.row === 0));
      if (!inside && h !== 'corner') { await view.pointerDown(x, y, {}, 0, 1); await view.pointerUp(x, y, {}); }
      return h === 'colHeader' ? 'columnHeader' : h === 'rowHeader' ? 'rowHeader' : 'cell';
    },
    // ui.pointer / ui.type / ui.keys (design note F-grid--integrator--ui-input): the same
    // handlers a click, drag or keystroke runs, in canvas coordinates or by cell.
    pointer: async (p: {action?: string; x?: number; y?: number; cell?: string; to?: {x?: number; y?: number; cell?: string}; modifiers?: string[]; target?: string}) => {
      const g = view.geo;
      if (!g) throw new CommandError('unavailable', 'The grid is not shown');
      const at = (q: {x?: number; y?: number; cell?: string}) => {
        if (typeof q.cell === 'string') {
          const m = /^([A-Za-z]{1,3})(\d{1,7})$/.exec(q.cell.trim());
          if (!m) throw new CommandError('invalid_params', `${q.cell} is not a cell`);
          let col = 0; for (const ch of m[1].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64;
          const r = g.cellRect({row: Number(m[2]) - 1, col: col - 1});
          return {x: r.x + r.w / 2, y: r.y + r.h / 2};
        }
        if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) throw new CommandError('invalid_params', 'x and y are canvas coordinates in px (or give cell)');
        return {x: q.x!, y: q.y!};
      };
      const mods = Object.fromEntries((p.modifiers ?? []).map(k => [String(k).toLowerCase(), true]));
      // The Data tab's own parts: the header cell's filter button, the active cell's list arrow, an outline button, and the
      // popups and message boxes they open (the same handlers a click runs; the DOM ones are clicked by their text).
      if (p.target === 'filterButton' || p.target === 'validationArrow' || p.target === 'outline') {
        let r: {x: number; y: number; w: number; h: number} | null = null;
        if (p.target === 'filterButton') { const m = /^([A-Za-z]{1,3})([0-9]{1,7})$/.exec(String(p.cell).trim()); if (!m) throw new CommandError('invalid_params', `${p.cell} is not a cell`); let col = 0; for (const ch of m[1].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64; r = filterButtonRect(g, view.sheet(), {row: Number(m[2]) - 1, col: col - 1}); }
        else if (p.target === 'validationArrow') r = view.listArrow();
        else {
          const rows = (p as any).axis !== 'cols';
          const b = outlineLayout(g, view.sheet()).buttons.find(t => (p as any).level !== undefined ? t.action.kind === 'level' && t.action.rows === rows && t.action.level === (p as any).level
            : t.action.kind === 'toggle' && t.action.rows === rows && t.action.group.start === Number((p as any).start) - 1 && (!(p as any).groupLevel || t.action.group.level === (p as any).groupLevel));
          r = b ? b.rect : null;
        }
        if (!r) throw new CommandError('not_found', `There is no ${p.target} there`);
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        await view.pointerDown(cx, cy, mods, 0, 1);
        await view.pointerUp(cx, cy, mods);
        return {sel: view.sel(), filterMenu: !!view.filterMenu, listPicker: !!view.listPicker};
      }
      if (p.target === 'popup' || p.target === 'messageBox' || p.target === 'dialog' || p.target === 'pivotPane') {
        const q = p as any;
        const sel = p.target === 'popup' ? '.grid-popup' : p.target === 'pivotPane' ? '.pf' : p.target === 'dialog' ? `.gd[data-dialog-id="${String(q.dialog ?? '')}"]` : '.gd[data-dialog-id="message-box"]';
        const roots = [...document.querySelectorAll<HTMLElement>(sel)];
        if (!roots.length) throw new CommandError('not_found', 'No popup is open');
        const buttons = roots.flatMap(rt => [...rt.querySelectorAll<HTMLElement>('button')]);
        const text = (e: Element) => (e.textContent ?? '').split(/\s+/).filter(Boolean).join(' ');
        if (typeof q.search === 'string') {
          const box = roots[0].querySelector<HTMLInputElement>('input[type=search]');
          if (!box) throw new CommandError('not_found', 'The popup has no search box');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, q.search);
          box.dispatchEvent(new Event('input', {bubbles: true}));
        }
        if (typeof q.check === 'string') {
          const label = [...roots[0].querySelectorAll<HTMLElement>('label.grid-menu-check')].find(l => text(l) === q.check);
          if (!label) throw new CommandError('not_found', `No value ${q.check}`);
          label.querySelector<HTMLInputElement>('input')!.click();
        }
        if (typeof q.click === 'string') {
          const b = buttons.find(t => text(t) === q.click) ?? buttons.find(t => t.getAttribute('aria-label') === q.click) ?? buttons.find(t => text(t).startsWith(q.click));
          if (!b) throw new CommandError('not_found', `No button ${q.click}`);
          b.click();
        }
        await new Promise(r => setTimeout(r, 60));
        const open = [...document.querySelectorAll<HTMLElement>(sel)];
        return {buttons: open.flatMap(rt => [...rt.querySelectorAll<HTMLElement>('button')].map(text)), values: [...(open[0]?.querySelectorAll<HTMLElement>('label.grid-menu-check') ?? [])].map(l => ({text: text(l), on: !!l.querySelector<HTMLInputElement>('input')?.checked}))};
      }
      // A floating object, by kind and id: click selects it, a drag moves it (or resizes by `handle`, e.g. 'se'), by `dx`, `dy` pixels.
      if (p.target === 'object') {
        const q = p as any;
        const o = objectsOf(g, view.sheet()).find(e => e.kind === q.kind && e.object.id === q.id);
        if (!o) throw new CommandError('not_found', `There is no ${q.kind} ${q.id} on this sheet`);
        const r = o.rect;
        const hx: Record<string, number> = {w: r.x, e: r.x + r.w}, hy: Record<string, number> = {n: r.y, s: r.y + r.h};
        const handle = typeof q.handle === 'string' ? q.handle : '';
        const from = handle ? {x: handle.includes('w') ? hx.w : handle.includes('e') ? hx.e : r.x + r.w / 2, y: handle.includes('n') ? hy.n : handle.includes('s') ? hy.s : r.y + r.h / 2} : {x: r.x + r.w / 2, y: r.y + Math.min(r.h / 2, 12)};
        if (handle) { await view.pointerDown(r.x + r.w / 2, r.y + Math.min(r.h / 2, 12), mods, 0, 1); await view.pointerUp(r.x + r.w / 2, r.y + Math.min(r.h / 2, 12), mods); }
        await view.pointerDown(from.x, from.y, mods, 0, 1);
        if (p.action === 'drag') {
          const to = {x: from.x + (Number(q.dx) || 0), y: from.y + (Number(q.dy) || 0)};
          view.pointerMove(from.x + Math.sign(to.x - from.x) * 4, from.y + Math.sign(to.y - from.y) * 4);
          view.pointerMove(to.x, to.y);
          await view.pointerUp(to.x, to.y, mods);
        } else await view.pointerUp(from.x, from.y, mods);
        return {selected: view.selectedObject(), rect: objectsOf(g, view.sheet()).find(e => e.kind === q.kind && e.object.id === q.id)?.rect ?? null};
      }
      // The Draw tab's gestures, in sheet pixels: the pen's stroke, the eraser's pass and the lasso's loop, through the same pointer handlers a drag runs (`points`).
      if (p.target === 'draw') {
        const q = p as any;
        const pts: [number, number][] = (Array.isArray(q.points) ? q.points : []).filter((e: unknown) => Array.isArray(e) && Number.isFinite(e[0]) && Number.isFinite(e[1]));
        if (!pts.length) throw new CommandError('invalid_params', 'A drawing gesture needs points (sheet pixels)');
        const scr = pts.map(([x, y]) => sheetToScreen(g, view.sheet(), x, y));
        await view.pointerDown(scr[0].x, scr[0].y, mods, 0, 1);
        for (const s of scr.slice(1)) view.pointerMove(s.x, s.y);
        await view.pointerUp(scr[scr.length - 1].x, scr[scr.length - 1].y, mods);
        return {tool: view.drawState().tool, lasso: view.drawState().lasso, shapes: (view.sheet().shapes ?? []).length};
      }
      if (p.target === 'fillHandle') {
        const sel = view.sel();
        const cur = sel.ranges[sel.ranges.length - 1];
        const r = g.rangeRect(cur);
        const from = {x: r.x + r.w, y: r.y + r.h};
        if (p.action === 'doubleClick') { await view.pointerDown(from.x, from.y, mods, 0, 2); return {sel: view.sel()}; }
        if (!p.to) throw new CommandError('invalid_params', 'A fill drag needs `to`');
        const to = at(p.to);
        await view.pointerDown(from.x, from.y, mods, 0, 1);
        view.pointerMove(to.x, to.y);
        await view.pointerUp(to.x, to.y, mods);
        return {sel: view.sel()};
      }
      const a = at(p);
      if (p.action === 'drag') {
        if (!p.to) throw new CommandError('invalid_params', 'A drag needs `to`');
        const b = at(p.to);
        await view.pointerDown(a.x, a.y, mods, 0, 1);
        view.pointerMove(b.x, b.y);
        await view.pointerUp(b.x, b.y, mods);
      } else {
        await view.pointerDown(a.x, a.y, mods, 0, p.action === 'doubleClick' ? 2 : 1);
        await view.pointerUp(a.x, a.y, mods);
      }
      return {sel: view.sel(), editing: !!view.editor};
    },
    type: (text: string) => {
      const t = String(text ?? '');
      if (!view.editor) { if (!view.typeText(t)) throw new CommandError('disabled', 'Typing into cells needs cell.set'); }
      else view.setEditText(view.editor.text.slice(0, view.editor.caret) + t + view.editor.text.slice(view.editor.caret), view.editor.caret + t.length);
      return {editing: true, text: view.editor?.text ?? ''};
    },
    keys: async (key: string, modifiers: string[] = []) => {
      const mods = Object.fromEntries(modifiers.map(k => [String(k).toLowerCase(), true]));
      if (view.editor) {
        const fake: any = {key, shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, metaKey: !!mods.meta, nativeEvent: {isComposing: false},
          preventDefault() {}, stopPropagation() {}, currentTarget: {selectionStart: view.editor.caret, selectionEnd: view.editor.caret, value: view.editor.text}};
        editorKey(view, fake as KeyboardEvent<HTMLTextAreaElement>);
        return {handled: true, editing: !!view.editor};
      }
      return {handled: await view.key(key, mods), editing: !!view.editor};
    },
  } as SurfaceHandle), [register, session, docId, view]);

  let content: any;
  try { content = view.content(); } catch { return null; }
  if (!Array.isArray(content?.sheets)) return null;

  return <div className="grid-surface" ref={root}>
    {view.formulaBarShown() ? <FormulaBar view={view}/> : null}
    <div className="grid-body"><GridCanvas view={view}/></div>
    <SheetBar view={view}/>
    {view.message ? <div className="grid-message" role="alertdialog" aria-label="Grid">
      <p>{view.message}</p>
      <button type="button" onClick={() => { view.message = null; view.changed(); }}>OK</button>
    </div> : null}
  </div>;
}

// ---------------------------------------------------------------------------------------------
// Formula bar (formula_bar.rs)

function FormulaBar({view}: {view: GridView}) {
  const [name, setName] = useState<string | null>(null);
  const ed = view.editor;
  const nameText = name ?? view.nameBoxText();
  const goName = () => {
    if (name === null) return;
    try { view.goTo(name); setName(null); } catch (e) { view.message = toCommandError(e).message; setName(null); view.changed(); }
  };
  const canEdit = view.canEdit();
  return <div className="grid-formula-bar">
    <input className="grid-name-box" aria-label="Name Box" value={nameText} spellCheck={false}
      onFocus={e => { setName(view.nameBoxText()); e.currentTarget.select(); }}
      onChange={e => setName(e.currentTarget.value)}
      onBlur={() => setName(null)}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') { e.preventDefault(); goName(); (document.querySelector('.grid-keys') as HTMLElement | null)?.focus(); }
        else if (e.key === 'Escape') { e.preventDefault(); setName(null); (document.querySelector('.grid-keys') as HTMLElement | null)?.focus(); }
      }}/>
    <span className="grid-bar-grip" aria-hidden="true"/>
    <div className="grid-bar-buttons">
      {ed ? <>
        <button type="button" title="Cancel" aria-label="Cancel" onMouseDown={e => e.preventDefault()} onClick={() => view.cancelEdit()}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        </button>
        <button type="button" title="Enter" aria-label="Enter" onMouseDown={e => e.preventDefault()} onClick={() => void view.commit(0, 0)}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
      </> : null}
      {view.has('formulas.insertFunction') ? <button type="button" className="grid-fx" title="Insert Function" aria-label="Insert Function"
        onClick={() => void view.run('formulas.insertFunction', {})}><i>fx</i></button> : null}
    </div>
    {ed ? <FormulaInput view={view} where="bar" className="is-bar" onKey={e => editorKey(view, e)}/>
      : <div className={`grid-bar-text${canEdit ? '' : ' is-readonly'}`} role="textbox" aria-label="Formula Bar" aria-readonly={!canEdit} tabIndex={canEdit ? 0 : -1}
        onMouseDown={e => { if (!canEdit) return; e.preventDefault(); if (view.beginEdit(null, true)) requestAnimationFrame(() => (document.querySelector('.grid-formula-input.is-bar textarea') as HTMLTextAreaElement | null)?.focus()); }}>
        {view.barText()}
      </div>}
  </div>;
}

// ---------------------------------------------------------------------------------------------
// Sheet tabs (tabs.rs)

function SheetBar({view}: {view: GridView}) {
  const content = view.content();
  const current = view.sheetIndex();
  const [renaming, setRenaming] = useState<{i: number; text: string} | null>(null);
  const [first, setFirst] = useState(0);
  const [drag, setDrag] = useState<{from: number; over: number | null} | null>(null);
  const canRename = view.has('sheet.rename'), canMove = view.has('sheet.move'), canAdd = view.has('home.insertSheet');
  const sheets: any[] = content.sheets;
  const visible = sheets.map((s, i) => ({s, i})).filter(({s}) => !s.hidden);
  const commitRename = async () => {
    if (!renaming) return;
    const s = sheets[renaming.i];
    const text = renaming.text;
    setRenaming(null);
    if (text !== s.name) await view.run('sheet.rename', {sheet: `/sh:${encodeURIComponent(s.id)}`, name: text});
  };
  return <div className="grid-sheet-bar">
    <div className="grid-tab-nav">
      <button type="button" aria-label="Scroll to the previous sheet" disabled={first <= 0} onClick={() => setFirst(f => Math.max(0, f - 1))}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
      <button type="button" aria-label="Scroll to the next sheet" disabled={first >= visible.length - 1} onClick={() => setFirst(f => Math.min(visible.length - 1, f + 1))}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
    </div>
    <div className="grid-tabs" role="tablist" aria-label="Sheets">
      {visible.slice(first).map(({s, i}) => {
        const on = i === current;
        if (renaming?.i === i) {
          return <input key={s.id} className="grid-tab is-renaming" autoFocus value={renaming.text} aria-label="Sheet name"
            onChange={e => setRenaming({i, text: e.currentTarget.value})} onBlur={() => void commitRename()}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void commitRename(); } else if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); } }}/>;
        }
        return <button key={s.id} type="button" role="tab" aria-selected={on}
          className={`grid-tab${on ? ' is-current' : ''}${drag && drag.over === i ? ' is-drop' : ''}`}
          style={s.tabColor ? {['--tab' as any]: s.tabColor} : undefined}
          draggable={canMove}
          onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; setDrag({from: i, over: null}); }}
          onDragOver={e => { if (drag) { e.preventDefault(); if (drag.over !== i) setDrag({...drag, over: i}); } }}
          onDrop={e => { e.preventDefault(); if (drag && drag.from !== i) void view.run('sheet.move', {sheet: `/sh:${encodeURIComponent(sheets[drag.from].id)}`, to: i}); setDrag(null); }}
          onDragEnd={() => setDrag(null)}
          onClick={() => void view.showSheet(i)}
          onDoubleClick={() => { if (canRename) setRenaming({i, text: s.name}); }}>
          <span>{s.name}</span>
        </button>;
      })}
      {canAdd ? <button type="button" className="grid-tab-add" title="New sheet" aria-label="New sheet" onClick={() => void view.run('home.insertSheet', {})}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.25" fill="none"/><path d="M8 5v6M5 8h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
      </button> : null}
    </div>
    <HorizontalBar view={view}/>
  </div>;
}
