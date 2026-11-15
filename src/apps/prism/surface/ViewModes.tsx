// The views of View › Presentation Views other than Normal: Slide Sorter (every slide as a thumbnail,
// in its sections, drag to reorder, double-click to open), Notes Page (the slide above its notes on a
// Letter page, as the notes pages print) and the Outline pane (each slide's title and text as editable
// lines beside the slide).
// Translated from deckcraft crates/ui-egui/src/sorter.rs (`show`, `groups`, `notes_page`,
// `outline_pane`, `outline_slide`) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEffect, useMemo, useRef, useState} from 'react';
import type {SurfaceProps} from '../../../shell/AppHost';
import {SlideView} from './SlideView';
import {NotesPane} from './NotesPane';
import {selectedSlideIds, selectSlides} from '../../../../core/prism/model/doc.mjs';
import {notesFrames} from '../../../../core/prism/formats/pdf-write.mjs';
import {bodyText} from '../../../../core/prism/model/text.mjs';
import {slideTitle, isTitlePh, isFooterPh} from '../../../../core/prism/model/presentation.mjs';
import {platform} from '../../../shell/env';

type Any = any;
type Ctl = SurfaceProps['controller'];

const fail = (c: Ctl) => (e: Any) => c.notify(String(e?.message ?? e), 'error');

/** One section's slides in the section's order, then any slide that belongs to none (sorter.rs `groups`). */
export function sorterGroups(content: Any): {section: Any | null; indices: number[]}[] {
  const slides: Any[] = content.slides ?? [];
  if (!(content.sections ?? []).length) return [{section: null, indices: slides.map((_, i) => i)}];
  const seen = new Set<number>();
  const out: {section: Any | null; indices: number[]}[] = [];
  for (const sec of content.sections) {
    const indices: number[] = [];
    for (const id of sec.slides ?? []) { const i = slides.findIndex(s => s.id === id); if (i >= 0 && !seen.has(i)) { seen.add(i); indices.push(i); } }
    out.push({section: sec, indices});
  }
  const rest = slides.map((_, i) => i).filter(i => !seen.has(i));
  if (rest.length) out.push({section: null, indices: rest});
  return out;
}

export function SorterView({controller, content, selection, current}: {controller: Ctl; content: Any; selection: Any; current: number}) {
  const slides: Any[] = content.slides ?? [];
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<{from: number; to: number; active: boolean; x0: number; y0: number} | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => sorterGroups(content), [content]);
  const multi = new Set<string>(selectedSlideIds(content, selection));
  const cmdKey = (e: {ctrlKey: boolean; metaKey: boolean}) => (platform() === 'mac' ? e.metaKey : e.ctrlKey);
  const run = (id: string, params: Any) => controller.run(id, params, {origin: 'ui'}).catch(fail(controller));
  const pick = (i: number, e: {shiftKey: boolean; ctrlKey: boolean; metaKey: boolean}) => {
    const id = slides[i]?.id;
    if (!id) return;
    if (e.shiftKey) void run('slide.selectRange', {to: i, add: cmdKey(e)});
    else if (cmdKey(e)) void run('slide.selectSlides', {ids: [id], add: true});
    else void run('slide.go', {index: i});
  };
  // The slide a drop at (x, y) lands before: the nearest thumbnail centre in reading order.
  const slotAt = (x: number, y: number) => {
    const cells = [...(grid.current?.querySelectorAll<HTMLElement>('[data-sorter-slide]') ?? [])];
    let best = slides.length, bestD = Infinity;
    for (const el of cells) {
      const r = el.getBoundingClientRect();
      const cy = (r.top + r.bottom) / 2;
      if (y < r.top - 4 || y > r.bottom + 4) continue;
      const before = x < (r.left + r.right) / 2;
      const d = Math.abs(x - (r.left + r.right) / 2) + Math.abs(y - cy);
      if (d < bestD) { bestD = d; best = Number(el.dataset.sorterSlide) + (before ? 0 : 1); }
    }
    return best;
  };
  const canMove = controller.hasCommand('slide.move');
  return <div className="prism-sorter" ref={grid} role="listbox" aria-label="Slide Sorter" aria-multiselectable="true"
    onPointerMove={e => {
      if (!drag) return;
      if (!drag.active && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
      setDrag({...drag, active: true, to: slotAt(e.clientX, e.clientY)});
    }}
    onPointerUp={() => {
      if (!drag) return;
      const d = drag;
      setDrag(null);
      if (!d.active || d.to === d.from || d.to === d.from + 1) return;
      void run('slide.move', {from: d.from, to: d.to > d.from ? d.to - 1 : d.to});
    }}>
    {groups.map((g, gi) => {
      const key = g.section ? String(g.section.slides?.[0] ?? g.section.name) : '';
      const open = !g.section || !folded.has(key);
      return <section key={gi} className="prism-sorter-section">
        {g.section ? <button type="button" className="prism-sorter-head" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${g.section.name}`}
          onClick={() => setFolded(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; })}>
          <svg viewBox="0 0 8 8" aria-hidden="true" style={{transform: open ? 'rotate(90deg)' : undefined}}><path d="M2 1.5 5.5 4 2 6.5" fill="none" stroke="currentColor" strokeWidth="1.2"/></svg>
          <b>{g.section.name}</b><small>({g.indices.length})</small></button> : null}
        {open ? <div className="prism-sorter-grid">
          {g.indices.map(i => {
            const sl = slides[i];
            const selected = i === current || multi.has(sl.id);
            const anim = (sl.animations ?? []).length > 0 || (sl.transition && sl.transition.kind && sl.transition.kind !== 'none');
            return <div key={sl.id} role="option" aria-selected={selected} aria-label={`Slide ${i + 1}`} data-sorter-slide={i} data-slide={sl.id}
              className={`prism-sorter-slide${selected ? ' is-selected' : ''}${sl.hidden ? ' is-hidden' : ''}${drag?.active && drag.to === i ? ' is-drop-before' : ''}${drag?.active && drag.to === i + 1 && i === slides.length - 1 ? ' is-drop-after' : ''}`}
              onPointerDown={e => {
                if (e.button !== 0) return;
                pick(i, e);
                if (canMove && !e.shiftKey && !cmdKey(e)) { grid.current?.setPointerCapture?.(e.pointerId); setDrag({from: i, to: i, active: false, x0: e.clientX, y0: e.clientY}); }
              }}
              onDoubleClick={() => { void run('slide.go', {index: i}).then(() => run('view.normal', {})); }}>
              <div className="prism-sorter-img"><SlideView content={content} slide={sl}/></div>
              <div className="prism-sorter-meta"><span>{i + 1}</span>
                {anim ? <svg viewBox="0 0 12 12" role="img" aria-label="Has animations or a transition"><path d="M6 1.2 7.4 4.3 10.8 4.7 8.3 7 9 10.4 6 8.7 3 10.4 3.7 7 1.2 4.7 4.6 4.3Z" fill="currentColor"/></svg> : null}
                {sl.hidden ? <small>Hidden</small> : null}</div>
            </div>;
          })}
        </div> : null}
      </section>;
    })}
    {!slides.length ? <small className="prism-sorter-empty">No slides.</small> : null}
  </div>;
}

/** Notes Page: a Letter page (the notes master's frames in points) with the slide on top and the notes under it. */
export function NotesPageView({controller, content, slide, index}: {controller: Ctl; content: Any; slide: Any; index: number}) {
  const box = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(700);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => setH(el.clientHeight);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const paper: [number, number] = [612, 792];
  const [sb, nb] = notesFrames(content, paper) as Any[];
  const pageH = Math.max(h - 40, 200), k = pageH / paper[1];
  const at = (r: Any) => ({left: r.x0 * k, top: r.y0 * k, width: (r.x1 - r.x0) * k, height: (r.y1 - r.y0) * k});
  return <div className="prism-notespage" ref={box}>
    <div className="prism-notespage-sheet" role="group" aria-label={`Notes page for slide ${index + 1}`} style={{width: paper[0] * k, height: pageH}}>
      <div className="prism-notespage-slide" style={at(sb)}><SlideView content={content} slide={slide}/></div>
      <div className="prism-notespage-notes" style={at(nb)}><NotesPane controller={controller} slide={slide} index={index}/></div>
    </div>
  </div>;
}

/** The outline pane: slide number, title line, then the text of the other shapes, each editable; a blur saves with text.set. */
export function OutlinePane({controller, content, current}: {controller: Ctl; content: Any; current: number}) {
  const slides: Any[] = content.slides ?? [];
  const run = (id: string, params: Any) => controller.run(id, params, {origin: 'ui'}).catch(fail(controller));
  return <div className="prism-outline" role="list" aria-label="Outline">
    {slides.map((sl, i) => {
      const title = (sl.shapes ?? []).find((x: Any) => x.ph && isTitlePh(x.ph.kind));
      const others = (sl.shapes ?? []).filter((x: Any) => x !== title && !(x.ph && isFooterPh(x.ph.kind)) && x.text && bodyText(x.text).trim() !== '');
      return <div key={sl.id} className={`prism-outline-slide${i === current ? ' is-current' : ''}`} role="listitem" data-outline-slide={i}>
        <div className="prism-outline-title">
          <span className="prism-outline-num">{i + 1}</span><i aria-hidden="true"/>
          <OutlineLine key={`${sl.id}:${slideTitle(sl)}`} className="is-title" placeholder="Slide title" value={slideTitle(sl)} disabled={!title}
            onFocus={() => { if (i !== current) void run('slide.go', {index: i}); }}
            onCommit={v => { if (title) void run('text.set', {id: title.id, text: v}); }}/>
        </div>
        {others.map((sh: Any) => {
          const text = (sh.text.paragraphs ?? []).map((p: Any) => `${'\t'.repeat(p.level ?? 0)}${(p.runs ?? []).map((r: Any) => r.text ?? '').join('')}`).join('\n');
          return <OutlineLine key={`${sh.id}:${text}`} className="is-body" multiline value={text} onFocus={() => { if (i !== current) void run('slide.go', {index: i}); }}
            onCommit={v => { void run('text.set', {id: sh.id, text: v}); }}/>;
        })}
      </div>;
    })}
  </div>;
}

function OutlineLine({value, onCommit, onFocus, className, placeholder, multiline, disabled}: {value: string; onCommit: (v: string) => void; onFocus: () => void; className: string; placeholder?: string; multiline?: boolean; disabled?: boolean}) {
  const [v, setV] = useState(value);
  const done = () => { if (v !== value) onCommit(v); };
  return multiline
    ? <textarea className={`prism-outline-line ${className}`} value={v} rows={Math.max(v.split('\n').length, 1)} aria-label="Slide text" onChange={e => setV(e.target.value)} onFocus={onFocus} onBlur={done}/>
    : <input className={`prism-outline-line ${className}`} value={v} placeholder={placeholder} aria-label={placeholder} disabled={disabled} onChange={e => setV(e.target.value)} onFocus={onFocus} onBlur={done}
      onKeyDown={e => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}/>;
}

void selectSlides;
