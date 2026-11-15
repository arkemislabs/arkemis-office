// Task panes (docs/architecture.md section 10): docked left or right, or floating; widths from the
// spec (upstream panes.rs), resizable by the inner edge; dock and order kept for the session. A
// pane is a lazy module src/apps/<app>/panes/<paneId>.tsx that reads through queries and writes
// through commands only. Dialogs whose presentation is `pane` render here too.

import {Suspense, lazy, useMemo, useRef, type ComponentType, type LazyExoticComponent} from 'react';
import {useEngine} from '../engine/EngineProvider';
import {useShellState} from '../engine/useCommand';
import {Glyph} from '../icons/Icon';
import {DialogBody, DialogFooter} from '../dialogs/DialogHost';
import type {PaneState} from '../engine/ShellController';
import {SHOW_PENDING} from '../env';

export interface PaneProps { paneId: string; close: () => void }
const cache = new Map<string, LazyExoticComponent<ComponentType<PaneProps>>>();
/** Pane modules already loaded: drawn at once, without the Suspense fallback a lazy component shows first. */
const loaded = new Map<string, ComponentType<PaneProps>>();
const paneOf = (m: any) => (m.default ?? m.Pane) as ComponentType<PaneProps>;

/** Load a pane's module ahead (an app chrome whose toggles open panes), so opening it draws it at once. */
export async function preloadPane(loader: (() => Promise<any>) | null, id: string): Promise<void> {
  if (!loader || loaded.has(id)) return;
  try { loaded.set(id, paneOf(await loader())); } catch { /* the pane opens through Suspense instead */ }
}

export function PaneHost({side}: {side: 'left' | 'right'}) {
  const state = useShellState();
  const {controller} = useEngine();
  const panes = state.panes.filter(p => p.open && (p.dock === side || (p.dock === 'float' && side === 'right')));
  const dialogs = side === 'right' ? state.dialogs.filter(d => d.spec.presentation === 'pane') : [];
  if (!panes.length && !dialogs.length) return null;
  return <aside className={`shell-panes is-${side}`} aria-label={side === 'left' ? 'Left panes' : 'Right panes'}>
    {panes.map(p => <Pane key={p.id} pane={p} side={side}/>)}
    {dialogs.map(d => <section key={d.key} className="shell-pane is-dialog" aria-label={d.spec.title} style={{width: 320}}>
      <header className="shell-pane-head"><h2>{d.spec.title}</h2>
        <button type="button" className="shell-pane-btn" aria-label={`Close ${d.spec.title}`} onClick={() => controller.cancelDialog(d.key)}><Glyph name="close" size={11}/></button></header>
      <div className="shell-pane-body"><DialogBody dialog={d}/></div>
      <footer className="shell-pane-foot"><DialogFooter dialog={d}/></footer>
    </section>)}
  </aside>;
}

function Pane({pane, side}: {pane: PaneState; side: 'left' | 'right'}) {
  const {controller} = useEngine();
  const spec = controller.paneSpec(pane.id);
  const loader = controller.paneModule(pane.id);
  // One component per pane for the life of the window: once a pane is drawn through its lazy wrapper it keeps that
  // wrapper (never swapped for the loaded module), so a later render can't remount it. A remount re-ran its effects:
  // the Research pane undocked and re-docked the browser and showed "Loading…" again.
  const hasLoader = !!loader;
  const Body = useMemo(() => {
    if (!loader) return null;
    const lazyBody = cache.get(pane.id);
    if (lazyBody) return lazyBody;
    const ready = loaded.get(pane.id);
    if (ready) return ready;
    const made = lazy(async () => { const body = paneOf(await loader()); loaded.set(pane.id, body); return {default: body}; });
    cache.set(pane.id, made);
    return made;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasLoader, pane.id]);
  const start = useRef<{x: number; w: number} | null>(null);
  // The spec describes the pane for translators ("Comments panel (search, add, filter...)"): the name only.
  const label = spec?.label?.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+(pane|panel)$/i, '') ?? pane.id;
  const close = () => controller.setPane(pane.id, false);
  return <section className={`shell-pane${pane.dock === 'float' ? ' is-float' : ''}${!Body ? ' is-pending' : ''}`} aria-label={label} style={{width: pane.width}} data-pane-id={pane.id}>
    <div className={`shell-pane-grip is-${side}`} role="separator" aria-orientation="vertical" aria-label={`Resize ${label}`} tabIndex={0}
      onPointerDown={e => { start.current = {x: e.clientX, w: pane.width}; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={e => { const s = start.current; if (s) controller.resizePane(pane.id, s.w + (side === 'left' ? e.clientX - s.x : s.x - e.clientX)); }}
      onPointerUp={() => { start.current = null; }}
      onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); controller.resizePane(pane.id, pane.width + ((e.key === 'ArrowRight') === (side === 'left') ? 16 : -16)); } }}/>
    <header className="shell-pane-head">
      <h2>{label}</h2>
      <button type="button" className="shell-pane-btn" aria-label={pane.dock === 'left' ? 'Dock right' : 'Dock left'} data-tip={pane.dock === 'left' ? 'Dock right' : 'Dock left'}
        onClick={() => controller.dockPane(pane.id, pane.dock === 'left' ? 'right' : 'left')}><Glyph name={pane.dock === 'left' ? 'dock-right' : 'dock-left'} size={12}/></button>
      <button type="button" className="shell-pane-btn" aria-label={`Close ${label}`} onClick={close}><Glyph name="close" size={11}/></button>
    </header>
    <div className="shell-pane-body">
      {Body ? <Suspense fallback={<div className="shell-pane-empty">Loading…</div>}><Body paneId={pane.id} close={close}/></Suspense>
        : SHOW_PENDING ? <PendingPane id={pane.id}/> : null}
    </div>
  </section>;
}

/** Development preview of a pane that is not translated yet: what the spec says it holds. */
function PendingPane({id}: {id: string}) {
  const {controller} = useEngine();
  const spec = controller.paneSpec(id) as any;
  const list = (k: string) => (Array.isArray(spec?.[k]) ? spec[k].filter((x: unknown) => typeof x === 'string') as string[] : []);
  return <div className="shell-pane-empty is-pending">
    <p>Not translated yet: {id}</p>
    {list('tabs').length ? <div className="shell-pane-tabs">{list('tabs').map(t => <span key={t}>{t}</span>)}</div> : null}
    <ul>{[...list('contents'), ...list('fields')].slice(0, 12).map((x, i) => <li key={i}>{x}</li>)}</ul>
  </div>;
}
