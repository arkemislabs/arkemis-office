// The Animation Pane (Animations › Advanced Animation › Animation Pane): Play All / Play From, one
// row per effect in the slide's order (click number, the effect's picture, the shape's name, a
// timing bar), the seconds ruler; click a row to pick it, drag a bar to change its Delay and its
// right edge to change its Duration, right-click for Start On Click / With Previous / After
// Previous, Move Up / Down, Remove. Reads the slide, writes through the animation commands only.
// Translated from deckcraft crates/ui-egui/src/panels/animation.rs and animtimeline.rs at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEffect, useMemo, useRef, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {Icon, hasIcon} from '../../../shell/icons/Icon';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import {currentSlideId} from '../../../../core/prism/model/doc.mjs';
import {paneRows} from '../../../../core/prism/commands/animation.mjs';
import {rulerSeconds, pixelsPerSecond, draggedDelay, draggedDuration, barLabel} from '../../../../core/prism/lib/anim-pane.mjs';
import {selectedShapeIds} from '../../../../core/prism/model/doc.mjs';
import './animation.css';

type Any = any;
const START_ITEMS: [string, string][] = [['Start On Click', 'onClick'], ['Start With Previous', 'withPrevious'], ['Start After Previous', 'afterPrevious']];

export default function AnimationPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(300);
  const [menu, setMenu] = useState<{index: number; x: number; y: number} | null>(null);
  const [drag, setDrag] = useState<{index: number; kind: 'body' | 'edge'; x0: number; dx: number} | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const read = () => setWidth(el.clientWidth);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [menu]);

  const model = useMemo(() => {
    try {
      const d: Any = session.get(docId);
      const content = d.file.content;
      const sid = currentSlideId(content, d.selection);
      const slide = (content.slides ?? []).find((s: Any) => s.id === sid);
      if (!slide) return null;
      return {rows: paneRows(content, slide, d.view ?? {}), selected: new Set<string>(selectedShapeIds(content, d.selection)), playing: !!d.view?.animPreview?.on, anims: slide.animations ?? []};
    } catch { return null; }
  }, [session, docId, tick]);

  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const run = (id: string, params: Record<string, unknown> = {}) => controller.run(id, params, {origin: 'ui'}).catch(fail);

  if (!model) return <div className="anim-pane"><small className="anim-empty">Open a slide to see its animations.</small></div>;
  const {rows, selected, playing, anims} = model;
  // Play From starts at the row last clicked here, or else the first effect of the selected shape; with nothing selected it is Play All.
  const pickedRow = rows.find((r: Any) => r.picked && selected.has(r.shape) && r.canPlayFrom);
  const from = pickedRow ?? rows.find((r: Any) => selected.has(r.shape) && r.canPlayFrom);
  const playLabel = playing ? 'Stop' : from ? 'Play From' : 'Play All';
  const play = () => run('animation.preview', playing ? {on: false} : from ? {on: true, from: from.index} : {on: true});

  const trackW = Math.max(width * 0.45, 60);
  const seconds = rulerSeconds(rows.map((r: Any) => ({start: r.startAt, span: r.span})));
  const pps = pixelsPerSecond(trackW, seconds);
  const px = (sec: number) => Math.min(sec * pps, trackW);
  const ticks: number[] = [];
  for (let s = 0; s <= seconds; s += Math.max(Math.floor(seconds / 6), 1)) if (s * pps <= trackW + 0.5) ticks.push(s);

  const onBarDown = (e: React.PointerEvent, index: number, kind: 'body' | 'edge') => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDrag({index, kind, x0: e.clientX, dx: 0});
  };
  const onBarMove = (e: React.PointerEvent) => { if (drag) setDrag({...drag, dx: e.clientX - drag.x0}); };
  const onBarUp = () => {
    if (!drag) return;
    const a = anims[drag.index];
    const r = rows[drag.index];
    if (a && r) {
      const factor = a.durationMs > 0 && r.span > 0 ? r.span / (a.durationMs / 1000) : 1;
      if (drag.kind === 'edge') { const d = draggedDuration(a.durationMs, drag.dx, pps, factor); if (d !== a.durationMs) void run('animation.timing', {index: drag.index, duration: d}); }
      else { const d = draggedDelay(a.delayMs, drag.dx, pps); if (d !== a.delayMs) void run('animation.timing', {index: drag.index, delay: d}); }
    }
    setDrag(null);
  };

  return <div className="anim-pane" ref={wrap}>
    <div className="anim-toolbar">
      <button type="button" className="sf-button anim-play" data-pane-action="play" aria-pressed={playing} onClick={play}>
        {playing ? <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx="1" fill="currentColor"/></svg>
          : <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M3 1.8 10 6 3 10.2Z" fill="currentColor"/></svg>}
        <span>{playLabel}</span>
      </button>
    </div>
    {!rows.length ? <small className="anim-empty">Select an object on the slide and add an animation from the Animations tab.</small> : <div className="anim-list" role="list" aria-label="Animations">
      {rows.map((r: Any) => {
        const a = anims[r.index];
        const live = drag && drag.index === r.index ? drag : null;
        let x0 = px(r.startAt), x1 = Math.max(px(r.startAt + r.span), x0 + 4);
        if (live && a) {
          const factor = a.durationMs > 0 && r.span > 0 ? r.span / (a.durationMs / 1000) : 1;
          if (live.kind === 'edge') x1 = Math.max(px(r.startAt + (draggedDuration(a.durationMs, live.dx, pps, factor) / 1000) * factor), x0 + 4);
          else { const shift = (draggedDelay(a.delayMs, live.dx, pps) - a.delayMs) / 1000; const w = x1 - x0; x0 = px(Math.max(r.startAt + shift, 0)); x1 = x0 + w; }
        }
        const bar = {start: r.startAt, span: r.span};
        return <div key={r.index} role="listitem" className={`anim-row${selected.has(r.shape) ? ' is-selected' : ''}${r.picked ? ' is-picked' : ''}`} data-anim-row={r.index}
          onClick={() => run('animation.pick', {index: r.index})}
          onContextMenu={e => { e.preventDefault(); const b = wrap.current!.getBoundingClientRect(); setMenu({index: r.index, x: e.clientX - b.left, y: e.clientY - b.top}); }}>
          <span className="anim-num">{r.click ?? ''}</span>
          {hasIcon(`anim-${r.effect}`) ? <Icon id={`anim-${r.effect}`} size={20} className={`anim-icon is-${r.class}`}/> : <span className="anim-icon"/>}
          <span className="anim-name" title={r.name}>{r.name}</span>
          <span className="anim-track" style={{width: trackW}}>
            <span className={`anim-bar is-${r.class}`} style={{left: x0, width: x1 - x0}} title={barLabel(bar)} data-anim-bar={r.index}
              onPointerDown={e => onBarDown(e, r.index, 'body')} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={() => setDrag(null)}>
              {r.repeatUntilClick ? <i className="anim-repeat" aria-label="Repeats until the next click"/> : null}
              <span className="anim-edge" data-anim-edge={r.index} onPointerDown={e => onBarDown(e, r.index, 'edge')} onPointerMove={onBarMove} onPointerUp={onBarUp}/>
            </span>
          </span>
        </div>;
      })}
      <div className="anim-ruler" style={{marginLeft: 'auto', width: trackW}} aria-hidden="true">
        {ticks.map(s => <span key={s} style={{left: s * pps}}><i/>{s}s</span>)}
      </div>
    </div>}
    {menu ? <div className="anim-menu" role="menu" style={{left: menu.x, top: menu.y}} onPointerDown={e => e.stopPropagation()}>
      {START_ITEMS.map(([label, v]) => <button key={v} type="button" role="menuitem" onClick={() => { setMenu(null); void run('animation.timing', {index: menu.index, start: v}); }}>{label}</button>)}
      <hr/>
      <button type="button" role="menuitem" disabled={menu.index === 0} onClick={() => { setMenu(null); void run('animation.move', {index: menu.index, to: menu.index - 1}); }}>Move Up</button>
      <button type="button" role="menuitem" disabled={menu.index >= rows.length - 1} onClick={() => { setMenu(null); void run('animation.move', {index: menu.index, to: menu.index + 1}); }}>Move Down</button>
      <button type="button" role="menuitem" onClick={() => { setMenu(null); void run('animation.remove', {index: menu.index}); }}>Remove</button>
    </div> : null}
  </div>;
}
