// Combine files as a grid (printcraft crates/ui-egui/src/workflows/combine_grid.rs at 8f16855, MIT, see assets/third-party-licenses/artcraft-reference.txt):
// a card for the first page each file contributes, drawn as a stack when it contributes more than one, with its name below; a click selects (as in the
// list), a double click expands the file into one card per page, and the pages outside the range typed for the file are dimmed. The page size is
// `view.combine.zoom` (60 to 500 %). Thumbnails are drawn by pdf.js from the bytes the list holds, one at a time, when a card is in view.
// A card (or an expanded file's header) drags to a new place between the others; the drop is combine.drop with the gap it fell in.

import {useEffect, useRef, useState} from 'react';
import {Icon} from '../../../shell/icons/Icon';
import {heldFile} from '../../../../core/folio/commands/combine.mjs';
import {parseRanges} from '../../../../core/folio/commands/page.mjs';
import {base64 as toBase64} from '../../../../core/folio/lib/page-source.mjs';
import {acquire, release, page as pdfPage, raster} from './pdf';

type Any = any;
/** combine_grid.rs PAPER: the box a page is fitted in at 100 %. */
const PAPER = {w: 132, h: 172};
const LOCKED = ['password', 'wrong-password', 'not-permitted'];

/** One thumbnail: page `index` of a held file, drawn when the card scrolls into view. */
function Thumb({docId, file, index, box}: {docId: string; file: Any; index: number; box: {w: number; h: number}}) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'wait' | 'ok' | 'failed'>('wait');
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let source: ReturnType<typeof acquire> | null = null;
    const abort = new AbortController();
    let started = false;
    const draw = async () => {
      if (started) return;
      started = true;
      try {
        const held = heldFile(docId, file.id);
        if (!held?.bytes || LOCKED.includes(file.problem)) { setState('failed'); return; }
        source = acquire(toBase64(held.bytes));
        const p: Any = await pdfPage(source, index);
        const [w, h] = [p.view[2] - p.view[0], p.view[3] - p.view[1]];
        const turned = p.rotate % 180 !== 0;
        const pw = turned ? h : w, ph = turned ? w : h;
        const scale = Math.max(0.1, Math.min(box.w / pw, box.h / ph) * 2);
        const canvas = await raster(source, index, p.rotate, scale, new Set(), abort.signal);
        if (abort.signal.aborted) return;
        canvas.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#fff;display:block';
        el.replaceChildren(canvas);
        setState('ok');
      } catch (e: any) { if (e?.name !== 'AbortError') setState('failed'); }
    };
    const io = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { io.disconnect(); void draw(); } }, {rootMargin: '200px'});
    io.observe(el);
    return () => { abort.abort(); io.disconnect(); if (source) release(source); };
  }, [docId, file.id, index, box.w, box.h]);
  return <div ref={host} className="cg-thumb" data-state={state} style={{width: box.w, height: box.h}}>
    {state === 'failed' ? <Icon id={LOCKED.includes(file.problem) ? 'lock' : 'file-text'} size={32}/> : null}
  </div>;
}

export default function CombineGrid({docId, files, selected, zoom, expanded, onPick, run}: {docId: string; files: Any[]; selected: number[]; zoom: number; expanded: number[];
  onPick: (f: Any, e: React.MouseEvent) => void; run: (id: string, args?: Any) => void}) {
  const box = {w: Math.round(PAPER.w * zoom), h: Math.round(PAPER.h * zoom)};
  const [drag, setDrag] = useState<number | null>(null);
  const [gap, setGap] = useState<number | null>(null);
  /** The gap a drop at x (left or right half of a card) falls in: before or after file `i`. */
  const gapAt = (i: number, e: React.DragEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); return e.clientX < r.left + r.width / 2 ? i : i + 1; };
  const dragProps = (f: Any, i: number) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => { setDrag(f.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(f.id)); },
    onDragOver: (e: React.DragEvent) => { if (drag !== null) { e.preventDefault(); setGap(gapAt(i, e)); } },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); if (drag !== null && gap !== null) run('combine.drop', {file: drag, gap}); setDrag(null); setGap(null); },
    onDragEnd: () => { setDrag(null); setGap(null); },
  });
  return <div className="cg" role="listbox" aria-multiselectable="true" aria-label="Files to combine" data-zoom={zoom}>
    {files.map((f, i) => {
      const on = selected.includes(f.id);
      const open = expanded.includes(f.id) && f.pages > 1 && !f.problem;
      let inRange = (_i: number) => true;
      if (open && f.range?.trim()) { try { const set = new Set(parseRanges(f.range, f.pages)); inRange = i => set.has(i); } catch { /* an invalid range dims nothing */ } }
      const mark = drag !== null && gap !== null ? (gap === i ? ' drop-before' : gap === i + 1 ? ' drop-after' : '') : '';
      if (open) return <section key={f.id} className={`cg-group${on ? ' is-selected' : ''}${drag === f.id ? ' is-dragged' : ''}${mark}`} data-file={f.id} role="option" aria-selected={on} onClick={e => onPick(f, e)} {...dragProps(f, i)}>
        <header><b title={f.name}>{f.name}</b><span>{f.pages} pages</span>
          <button type="button" className="cw-icon" aria-label={`Fold ${f.name}`} data-tip="Show as one card" onClick={e => { e.stopPropagation(); run('combine.expand', {id: f.id, open: false}); }}><Icon id="minimize-2" size={16}/></button></header>
        <div className="cg-pages">
          {Array.from({length: Math.min(f.pages, 2000)}, (_, i) => <figure key={i} className={inRange(i) ? undefined : 'is-out'} data-page={i + 1}>
            <Thumb docId={docId} file={f} index={i} box={box}/><figcaption>{i + 1}</figcaption></figure>)}
        </div>
      </section>;
      return <figure key={f.id} role="option" aria-selected={on} className={`cg-card${on ? ' is-selected' : ''}${f.problem ? ' has-problem' : ''}${f.pages > 1 ? ' is-stack' : ''}${drag === f.id ? ' is-dragged' : ''}${mark}`} data-file={f.id} {...dragProps(f, i)}
        style={{width: box.w + 24}} onClick={e => onPick(f, e)} onDoubleClick={() => { if (f.pages > 1 && !f.problem) run('combine.expand', {id: f.id, open: true}); }}>
        <div className="cg-paper" style={{width: box.w, height: box.h}}><Thumb docId={docId} file={f} index={0} box={box}/>
          {f.pages > 1 ? <span className="cg-count">{f.pages}</span> : null}</div>
        <figcaption title={f.problem ? `${f.name}: ${f.message}` : f.name}>{f.name}</figcaption>
        {f.problem ? <small className="cg-warn">{f.message}</small> : f.range ? <small>{f.range}</small> : null}
      </figure>;
    })}
  </div>;
}
