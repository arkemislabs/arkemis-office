// The Selection Pane: every object on the slide, front-most first, groups expanded with their
// children. Click selects (Ctrl toggles, Shift selects a run), drag restacks among siblings, the eye
// shows or hides, the padlock locks, double-click or F2 renames, the arrows move through the list.
// Show All and Hide All sit on top with Bring Forward and Send Backward. Everything it changes goes
// through commands (selection.select, shape.visible, shape.lock, shape.rename, arrange.reorder).
// Translated from deckcraft crates/ui-egui/src/panels/selpane.rs (`rows`, `drop_target`, `click`,
// `keys`, the row context menu) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import {currentSlideId, selectedShapeIds, slideById} from '../../../../core/prism/model/doc.mjs';
import {isGroup} from '../../../../core/prism/model/presentation.mjs';
import './selection.css';

type Any = any;
interface Row { id: string; name: string; depth: number; group: boolean; hidden: boolean; dimmed: boolean; locked: boolean; parent: string | null }

/** The rows as listed: front-most first, children under their group unless it is folded (selpane.rs `rows`). */
export function paneRows(shapes: Any[], collapsed: Set<string>): Row[] {
  const out: Row[] = [];
  const rec = (list: Any[], depth: number, parent: string | null, dim: boolean) => {
    if (depth > 64) return;
    for (const sh of [...list].reverse()) {
      const group = isGroup(sh);
      out.push({id: String(sh.id), name: sh.name ?? '', depth, group, hidden: !!sh.hidden, dimmed: dim, locked: !!sh.locked, parent});
      if (group && !collapsed.has(String(sh.id))) rec(sh.kind.children ?? [], depth + 1, String(sh.id), dim || !!sh.hidden);
    }
  };
  rec(shapes, 0, null, false);
  return out;
}

/** Where a dragged row lands among its siblings: the index in the file's order (0 = back) and the gap's slot above which siblings sit (selpane.rs `drop_target`). */
export function dropIndex(siblingIds: string[], dragged: string, gap: number): number {
  const others = siblingIds.filter(id => id !== dragged);
  return others.length - Math.min(Math.max(gap, 0), others.length);
}

const Eye = ({off}: {off: boolean}) => <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
  <circle cx="8" cy="8" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.2"/>{off ? <path d="M2.5 13.5 13.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/> : null}</svg>;
const Lock = ({on}: {on: boolean}) => <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.2"/>
  <path d={on ? 'M5.5 7V5.3a2.5 2.5 0 0 1 5 0V7' : 'M5.5 7V5.3a2.5 2.5 0 0 1 4.8-1'} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>;
const Chevron = ({open}: {open: boolean}) => <svg viewBox="0 0 8 8" width="9" height="9" aria-hidden="true" style={{transform: open ? 'rotate(90deg)' : undefined}}><path d="M2 1.2 5.6 4 2 6.8" fill="none" stroke="currentColor" strokeWidth="1.3"/></svg>;
const Up = () => <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2.5 7.5 6 4l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>;
const Down = () => <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>;

export default function SelectionPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{id: string; text: string} | null>(null);
  const [menu, setMenu] = useState<{id: string; x: number; y: number} | null>(null);
  const [drag, setDrag] = useState<{id: string; gap: number | null; y: number | null} | null>(null);
  const anchor = useRef<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const model = useMemo(() => {
    try {
      const d: Any = session.get(docId);
      const content = d.file.content;
      const slide = slideById(content, currentSlideId(content, d.selection));
      if (!slide) return null;
      return {rows: paneRows(slide.shapes ?? [], collapsed), selected: selectedShapeIds(content, d.selection).map(String), slideId: slide.id};
    } catch { return null; }
  }, [session, docId, tick, collapsed]);

  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const run = (id: string, params: Record<string, unknown> = {}) => controller.run(id, params, {origin: 'ui'}).catch(fail);
  if (!model) return <div className="selp"><small className="selp-note">Open a slide to see its objects.</small></div>;
  const {rows, selected} = model;
  const hasSel = selected.length > 0;

  const click = (k: number, ctrl: boolean, shift: boolean) => {
    const row = rows[k];
    if (!row) return;
    const a = anchor.current ? rows.findIndex(r => r.id === anchor.current) : -1;
    if (shift && a >= 0) {
      const [lo, hi] = a <= k ? [a, k] : [k, a];
      const top = row.parent === null;
      void run('selection.select', {ids: rows.slice(lo, hi + 1).filter(r => (r.parent === null) === top).map(r => r.id), add: ctrl});
      return;
    }
    void run('selection.select', {id: row.id, toggle: ctrl});
    anchor.current = row.id;
  };

  const siblingsOf = (parent: string | null) => rows.filter(r => r.parent === parent).map(r => r.id);
  const focusRow = (id: string) => (list.current?.querySelector(`[data-row="${CSS.escape(id)}"]`) as HTMLElement | null)?.focus();
  const onKey = (e: KeyboardEvent) => {
    if (renaming) return;
    const cur = selected.length ? rows.findIndex(r => r.id === selected[selected.length - 1]) : -1;
    let to: number | null = null;
    if (e.key === 'ArrowUp') to = cur < 0 ? 0 : Math.max(cur - 1, 0);
    else if (e.key === 'ArrowDown') to = cur < 0 ? 0 : Math.min(cur + 1, rows.length - 1);
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = rows.length - 1;
    if (to !== null) {
      e.preventDefault();
      const r = rows[to];
      if (r && to !== cur) { void run('selection.select', {id: r.id}); anchor.current = r.id; window.setTimeout(() => focusRow(r.id), 0); }
    } else if (e.key === 'F2' && selected.length === 1) {
      const r = rows.find(x => x.id === selected[0]);
      if (r) { e.preventDefault(); setRenaming({id: r.id, text: r.name}); }
    } else if (e.key === 'Escape') (document.activeElement as HTMLElement | null)?.blur();
  };

  const commitRename = (row: Row, text: string, keep: boolean) => {
    setRenaming(null);
    if (keep && text.trim() && text.trim() !== row.name) void run('shape.rename', {id: row.id, name: text.trim()});
  };

  const onDragOver = (e: DragEvent, _row: Row) => {
    if (!drag) return;
    e.preventDefault();
    const d = rows.find(r => r.id === drag.id);
    const sibs = siblingsOf(d?.parent ?? null).filter(id => id !== drag.id);
    const box = list.current?.getBoundingClientRect();
    // The gap nearest the pointer among the siblings' blocks: `gap` siblings sit above it.
    const blocks = sibs.map(id => (list.current?.querySelector(`[data-block="${CSS.escape(id)}"]`) as HTMLElement | null)?.getBoundingClientRect()).filter(Boolean) as DOMRect[];
    if (!blocks.length || !box) return;
    const gaps = [blocks[0].top, ...blocks.map(b => b.bottom)];
    let best = 0;
    gaps.forEach((g, i) => { if (Math.abs(g - e.clientY) < Math.abs(gaps[best] - e.clientY)) best = i; });
    setDrag({id: drag.id, gap: best, y: gaps[best] - box.top + (list.current?.scrollTop ?? 0)});
  };
  const onDrop = () => {
    if (drag && drag.gap !== null) {
      const d = rows.find(r => r.id === drag.id);
      void run('arrange.reorder', {id: drag.id, index: dropIndex(siblingsOf(d?.parent ?? null), drag.id, drag.gap)});
    }
    setDrag(null);
  };

  const rowNode = (row: Row, k: number) => {
    const sel = selected.includes(row.id);
    return <div key={row.id} data-block={row.id} className="selp-block">
      <div role="option" aria-selected={sel} tabIndex={sel || (!selected.length && k === 0) ? 0 : -1} data-row={row.id} data-hidden={row.hidden ? 'true' : undefined}
        className={`selp-row${sel ? ' is-selected' : ''}${row.dimmed || row.hidden ? ' is-dim' : ''}`} style={{paddingLeft: 4 + 14 * row.depth}} draggable={!renaming}
        onClick={(e: MouseEvent) => click(k, e.ctrlKey || e.metaKey, e.shiftKey)}
        onDoubleClick={() => setRenaming({id: row.id, text: row.name})}
        onContextMenu={e => { e.preventDefault(); setMenu({id: row.id, x: e.clientX, y: e.clientY}); }}
        onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', row.id); if (!sel) void run('selection.select', {id: row.id}); setDrag({id: row.id, gap: null, y: null}); }}
        onDragOver={e => onDragOver(e, row)} onDrop={onDrop} onDragEnd={() => setDrag(null)}>
        {row.group
          ? <button type="button" className="selp-fold" aria-label={`${collapsed.has(row.id) ? 'Expand' : 'Collapse'} ${row.name}`} onClick={e => { e.stopPropagation(); setCollapsed(s => { const n = new Set(s); if (n.has(row.id)) n.delete(row.id); else n.add(row.id); return n; }); }}>
            <Chevron open={!collapsed.has(row.id)}/></button>
          : <span className="selp-fold"/>}
        {renaming?.id === row.id
          ? <input className="selp-rename" autoFocus value={renaming.text} aria-label="Name" onFocus={e => e.currentTarget.select()} onClick={e => e.stopPropagation()}
            onChange={e => setRenaming({id: row.id, text: e.target.value})} onBlur={e => commitRename(row, e.target.value, true)}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') commitRename(row, renaming.text, true); else if (e.key === 'Escape') commitRename(row, renaming.text, false); }}/>
          : <span className="selp-name">{row.name}</span>}
        <button type="button" className="selp-icon" aria-label={`${row.hidden ? 'Show' : 'Hide'} ${row.name}`} aria-pressed={row.hidden} onClick={e => { e.stopPropagation(); void run('shape.visible', {id: row.id, visible: row.hidden}); }}><Eye off={row.hidden}/></button>
        <button type="button" className="selp-icon" aria-label={`${row.locked ? 'Unlock' : 'Lock'} ${row.name}`} aria-pressed={row.locked} onClick={e => { e.stopPropagation(); void run('shape.lock', {id: row.id}); }}><Lock on={row.locked}/></button>
      </div>
    </div>;
  };

  return <div className="selp" onKeyDown={onKey}>
    <div className="selp-bar">
      <button type="button" className="sf-button selp-small" data-pane-action="show-all" onClick={() => void run('selection.showAll')}>Show All</button>
      <button type="button" className="sf-button selp-small" data-pane-action="hide-all" onClick={() => void run('selection.hideAll')}>Hide All</button>
      <span className="selp-gap"/>
      <button type="button" className="sf-button selp-small selp-sq" aria-label="Bring Forward" title="Bring Forward" disabled={!hasSel} onClick={() => void run('arrange.bringForward')}><Up/></button>
      <button type="button" className="sf-button selp-small selp-sq" aria-label="Send Backward" title="Send Backward" disabled={!hasSel} onClick={() => void run('arrange.sendBackward')}><Down/></button>
    </div>
    {rows.length === 0 ? <small className="selp-note">Nothing on this slide yet.</small> : null}
    <div className="selp-list" role="listbox" aria-label="Objects on this slide" aria-multiselectable="true" ref={list}
      onDragOver={e => { if (drag) e.preventDefault(); }} onDrop={onDrop}>
      {rows.map(rowNode)}
      {drag && drag.y !== null ? <i className="selp-drop" style={{top: drag.y}}/> : null}
    </div>
    {menu ? <>
      <div className="selp-scrim" onClick={() => setMenu(null)} onContextMenu={e => { e.preventDefault(); setMenu(null); }}/>
      <div className="selp-menu" role="menu" style={{left: menu.x, top: menu.y}}>
        {([['Bring to Front', 'arrange.bringToFront'], ['Bring Forward', 'arrange.bringForward'], ['Send Backward', 'arrange.sendBackward'], ['Send to Back', 'arrange.sendToBack']] as const)
          .map(([label, cmd]) => <button key={cmd} type="button" role="menuitem" onClick={() => { void run(cmd, {ids: [menu.id]}); setMenu(null); }}>{label}</button>)}
        <hr/>
        {(() => {
          const r = rows.find(x => x.id === menu.id);
          return r ? <>
            <button type="button" role="menuitem" onClick={() => { setRenaming({id: r.id, text: r.name}); setMenu(null); }}>Rename</button>
            <button type="button" role="menuitem" onClick={() => { void run('shape.visible', {id: r.id, visible: r.hidden}); setMenu(null); }}>{r.hidden ? 'Show' : 'Hide'}</button>
            <button type="button" role="menuitem" onClick={() => { void run('shape.lock', {id: r.id}); setMenu(null); }}>{r.locked ? 'Unlock' : 'Lock'}</button>
          </> : null;
        })()}
      </div>
    </> : null}
  </div>;
}
