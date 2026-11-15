// The slide thumbnail pane of Normal view: numbered thumbnails grouped by section (a header row
// "Name  (n)" before each section's first slide), the current and selected slides outlined in the
// accent, hidden slides dimmed with their number struck, a star for slides with animations or a
// transition, drag to reorder with an insertion line, and "+ New Slide" in the space below.
// Clicks: plain → slide.go, Ctrl → slide.selectSlides {add}, Shift → slide.selectRange {to, add:
// Ctrl}. Only rows in view (plus a margin) draw their slide, so a 500-slide deck scrolls lightly.
// Follows deckcraft crates/ui-egui/src/panels/thumbs.rs (list, section headers, selection, drag
// reorder → slide.move {from, to}, click below → slide.new, scroll the current slide into view
// minimally) at f893f6af7d36a5409fd804e81a34fd895cfefedf. F:prism surface.

import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import type {SurfaceProps} from '../../../shell/AppHost';
import {selectSlides, selectedSlideIds} from '../../../../core/prism/model/doc.mjs';
import {SlideView} from './SlideView';
import {platform} from '../../../shell/env';

type Any = any;
const OVERSCAN = 3;

interface Row { kind: 'section' | 'slide'; index: number; top: number; height: number; section?: Any }

export function Thumbnails({controller, docId, content, selection, current, width, folded = [], hideInk = false}: {
  controller: SurfaceProps['controller']; docId: string; content: Any; selection: Any; current: number; width: number; folded?: string[]; hideInk?: boolean;
}) {
  const session = controller.session;
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({top: 0, height: 600});
  const [drag, setDrag] = useState<{from: number; to: number; y0: number; active: boolean} | null>(null);
  const slides: Any[] = content.slides ?? [];
  const tw = Math.max(width - 40, 60);
  const th = tw * (content.slideSize.height / Math.max(content.slideSize.width, 1));
  const rowH = th + 16;

  const rows = useMemo(() => {
    const out: Row[] = [];
    const starts = new Map<number, Any>();
    for (const sec of content.sections ?? []) {
      const i = slides.findIndex(s => s.id === sec.slides?.[0]);
      if (i >= 0) starts.set(i, sec);
    }
    let y = 4;
    // Slides of a section folded shut (Home › Section › Collapse All) leave only the section's header.
    const shut = new Set<string>();
    for (const sec of content.sections ?? []) if (folded.includes(String(sec.slides?.[0] ?? sec.name ?? ''))) for (const id of sec.slides ?? []) shut.add(String(id));
    slides.forEach((sl, i) => {
      const sec = starts.get(i);
      if (sec) { y += 4; out.push({kind: 'section', index: i, top: y, height: 22, section: sec}); y += 22; }
      if (shut.has(String(sl.id))) return;
      out.push({kind: 'slide', index: i, top: y, height: rowH});
      y += rowH;
    });
    return {rows: out, height: y + 40};
  }, [slides, content.sections, rowH, folded]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const read = () => setView({top: el.scrollTop, height: el.clientHeight});
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Scroll the current slide's thumbnail into view when the slide changes (minimal scroll).
  const lastCurrent = useRef(-1);
  useEffect(() => {
    const el = scroller.current;
    if (!el || lastCurrent.current === current) return;
    const first = lastCurrent.current < 0;
    lastCurrent.current = current;
    if (first) return;
    const r = rows.rows.find(x => x.kind === 'slide' && x.index === current);
    if (!r) return;
    if (r.top < el.scrollTop) el.scrollTop = r.top - 4;
    else if (r.top + r.height > el.scrollTop + el.clientHeight) el.scrollTop = r.top + r.height - el.clientHeight + 4;
  }, [current, rows]);

  const multi = new Set<string>(selectedSlideIds(content, selection));
  const visible = rows.rows.filter(r => r.top + r.height >= view.top - OVERSCAN * rowH && r.top <= view.top + view.height + OVERSCAN * rowH);

  const run = (id: string, params: Any, fallback: () => void) => {
    if (controller.hasCommand(id)) void controller.run(id, params, {origin: 'ui'}).catch((e: Any) => controller.notify(String(e?.message ?? e), 'error'));
    else fallback();
  };
  const go = (i: number, e: {shiftKey: boolean; ctrlKey: boolean; metaKey: boolean}) => {
    const cmd = platform() === 'mac' ? e.metaKey : e.ctrlKey;
    const id = slides[i]?.id;
    if (!id) return;
    // slide.go / slide.selectSlides / slide.selectRange only change the selection; without the
    // slide family the same selection is set directly.
    if (e.shiftKey) {
      const from = Math.min(current, i), to = Math.max(current, i);
      const ids = slides.slice(from, to + 1).map(s => s.id);
      run('slide.selectRange', {to: i, add: cmd}, () => session.setSelection(docId, selectSlides(cmd ? [...new Set([...multi, ...ids])] : ids), {origin: 'ui'}));
    } else if (cmd) {
      run('slide.selectSlides', {ids: [id], add: true}, () => session.setSelection(docId, selectSlides([...multi, id].filter((x, k, a) => a.indexOf(x) === k)), {origin: 'ui'}));
    } else {
      run('slide.go', {index: i}, () => session.setSelection(docId, selectSlides([id]), {origin: 'ui'}));
    }
  };

  const indexAtY = (y: number) => {
    for (const r of rows.rows) if (r.kind === 'slide' && y < r.top + r.height / 2) return r.index;
    return slides.length;
  };
  const localY = (e: {clientY: number}) => { const el = scroller.current!; return e.clientY - el.getBoundingClientRect().top + el.scrollTop; };
  const canMove = controller.hasCommand('slide.move');
  const canNew = controller.hasCommand('slide.new');

  return <div className="prism-thumbs" ref={scroller} role="listbox" aria-label="Slides" aria-multiselectable="true"
    onScroll={e => setView({top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight})}
    onPointerMove={e => {
      if (!drag) return;
      const y = localY(e);
      if (!drag.active && Math.abs(y - drag.y0) < 4) return;
      setDrag({...drag, active: true, to: indexAtY(y)});
    }}
    onPointerUp={() => {
      if (!drag) return;
      setDrag(null);
      const {from, to, active} = drag;
      if (!active || to === from || to === from + 1) return;
      const dest = to > from ? to - 1 : to;
      void controller.run('slide.move', {from, to: dest}, {origin: 'ui'}).catch((err: Any) => controller.notify(String(err?.message ?? err), 'error'));
    }}>
    <div className="prism-thumbs-inner" style={{height: rows.height}}>
      {visible.map(r => {
        if (r.kind === 'section') {
          const si = (content.sections ?? []).indexOf(r.section);
          const shutNow = folded.includes(String(r.section.slides?.[0] ?? r.section.name ?? ''));
          return <div key={`s${r.index}`} className="prism-thumb-section" style={{top: r.top, height: r.height}} data-section-folded={shutNow ? 'true' : undefined}
            onClick={() => { if (si >= 0 && controller.hasCommand('section.toggleFold')) void controller.run('section.toggleFold', {index: si}, {origin: 'ui'}).catch(() => {}); }}>
            <svg viewBox="0 0 8 8" aria-hidden="true" style={{transform: shutNow ? undefined : 'rotate(90deg)'}}><path d="M2 1.5 5.5 4 2 6.5" fill="none" stroke="currentColor" strokeWidth="1.2"/></svg>
            <span>{r.section.name}  ({r.section.slides?.length ?? 0})</span>
          </div>;
        }
        const sl = slides[r.index];
        const selected = r.index === current || multi.has(sl.id);
        const anim = (sl.animations ?? []).length > 0 || (sl.transition && sl.transition.kind && sl.transition.kind !== 'none');
        return <div key={sl.id} role="option" aria-selected={selected} aria-label={`Slide ${r.index + 1}`} data-slide={sl.id}
          className={`prism-thumb${selected ? ' is-selected' : ''}${sl.hidden ? ' is-hidden' : ''}`} style={{top: r.top, height: r.height}}
          onPointerDown={e => {
            if (e.button !== 0) return;
            go(r.index, e);
            if (canMove && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
              scroller.current?.setPointerCapture?.(e.pointerId);
              setDrag({from: r.index, to: r.index, y0: localY(e), active: false});
            }
          }}>
          <span className="prism-thumb-num">{r.index + 1}</span>
          {sl.hidden ? <svg className="prism-thumb-hidden" viewBox="0 0 12 12" aria-label="Hidden slide"><path d="M0 12 12 0" stroke="currentColor" strokeWidth="1"/></svg> : null}
          {anim ? <svg className="prism-thumb-star" viewBox="0 0 12 12" role="img" aria-label="Has animations or a transition"><path d="M6 1.2 7.4 4.3 10.8 4.7 8.3 7 9 10.4 6 8.7 3 10.4 3.7 7 1.2 4.7 4.6 4.3Z" fill="currentColor" stroke="currentColor" strokeWidth=".8" strokeLinejoin="round"/></svg> : null}
          <div className="prism-thumb-img" style={{width: tw, height: th}}>
            <SlideView content={content} slide={sl} hideInk={hideInk}/>
          </div>
        </div>;
      })}
      {drag?.active ? <div className="prism-thumb-drop" style={{top: (rows.rows.find(x => x.kind === 'slide' && x.index === drag.to)?.top ?? rows.height - 40) + 2}}/> : null}
      {canNew ? <button type="button" className="prism-thumb-new" style={{top: rows.height - 40}} onClick={() => run('slide.new', {}, () => {})}>+ New Slide</button> : null}
    </div>
  </div>;
}
