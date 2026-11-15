// Presenter View, the second window of a running Slide Show: the current slide, the next slide, the
// notes (the size buttons change them), the elapsed time (pause and reset), the clock and "Slide n of m".
// Previous, Next and End Show drive the show window. It is drawn from what the show window pushes
// (the presentation, where the show is) and only ever shows this app's own slides.
// Translated from deckcraft crates/ui-egui/src/show/presenter.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEffect, useMemo, useRef, useState} from 'react';
import {SlideView} from '../surface/SlideView';
import {Icon} from '../../../shell/icons/Icon';
import {presenterView, PresenterTimer, formatElapsed, NOTES_DEFAULT, NOTES_MIN, NOTES_MAX, NOTES_STEP} from '../../../../core/prism/lib/presenter.mjs';
import './presenter.css';

type Any = any;

export default function PresenterWindow() {
  const studio: Any = (window as Any).studio;
  const [content, setContent] = useState<Any>(null);
  const [custom, setCustom] = useState<string | null>(null);
  const [status, setStatus] = useState<{slide: number; step: number; ended: boolean}>({slide: 0, step: 0, ended: false});
  const [notesSize, setNotesSize] = useState(NOTES_DEFAULT);
  const [now, setNow] = useState(() => performance.now() / 1000);
  const timer = useRef(new PresenterTimer(performance.now() / 1000));
  useEffect(() => {
    const off = studio?.presenter?.onState((m: Any) => {
      if (m?.type === 'content') { setContent(m.content); setCustom(m.custom ?? null); }
      else if (m?.type === 'status') setStatus({slide: m.slide, step: m.step ?? 0, ended: !!m.ended});
    });
    // Ask for the show again in case it was pushed before this window was listening.
    studio?.presenter?.command({kind: 'hello'});
    return () => { if (typeof off === 'function') off(); };
  }, [studio]);
  useEffect(() => { const id = window.setInterval(() => setNow(performance.now() / 1000), 250); return () => window.clearInterval(id); }, []);
  const view = useMemo(() => (content ? presenterView(content, status.slide, custom) : null), [content, status.slide, custom]);
  // Tell the show window which slide this window has drawn.
  useEffect(() => {
    if (content && view) studio?.presenter?.command({kind: 'drawn', index: status.slide, info: {count: status.ended ? 'End of slide show' : `Slide ${view.position} of ${view.total}`, notes: view.notes, next: view.next}});
  }, [content, view, status.slide, status.ended, studio]);
  const send = (kind: string) => studio?.presenter?.command({kind});
  if (!content || !view) return <div className="pv pv-wait" role="status">Waiting for the slide show…</div>;
  const cur = content.slides?.[status.slide], nxt = view.next === null ? null : content.slides?.[view.next];
  const d = new Date();
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const size = content.slideSize ?? {width: 960, height: 540};
  const ratio = `${size.width} / ${size.height}`;
  const btn = (icon: string, label: string, onClick: () => void, disabled = false) =>
    <button type="button" className="pv-btn" aria-label={label} title={label} disabled={disabled} onClick={onClick}><Icon id={icon} size={16}/></button>;
  return <div className="pv" data-presenter-slide={status.slide}>
    <header className="pv-bar">
      <span className="pv-time" role="timer" aria-label="Elapsed time">{formatElapsed(timer.current.elapsed(now))}</span>
      {btn(timer.current.paused ? 'play' : 'pause', timer.current.paused ? 'Resume timer' : 'Pause timer', () => { timer.current.toggle(performance.now() / 1000); setNow(performance.now() / 1000); })}
      {btn('undo', 'Reset timer', () => { timer.current.reset(performance.now() / 1000); setNow(performance.now() / 1000); })}
      <span className="pv-clock" aria-label="Time of day">{clock}</span>
      <span className="pv-count" aria-label="Slide number">{status.ended ? 'End of slide show' : `Slide ${view.position} of ${view.total}`}</span>
      <span className="pv-gap"/>
      {btn('arrow-left', 'Previous', () => send('previous'))}
      {btn('arrow-right', 'Next', () => send('next'))}
      {btn('x', 'End Show', () => send('end'))}
    </header>
    <main className="pv-main">
      <section className="pv-current" aria-label="Current slide">
        <div className="pv-slide" style={{aspectRatio: ratio}}>{cur && !status.ended ? <SlideView content={content} slide={cur} className="pv-svg"/> : <div className="pv-end">End of slide show</div>}</div>
      </section>
      <aside className="pv-side">
        <section aria-label="Next slide">
          <h2>Next</h2>
          <div className="pv-slide pv-next" style={{aspectRatio: ratio}}>{nxt ? <SlideView content={content} slide={nxt} className="pv-svg"/> : <div className="pv-end">End of slide show</div>}</div>
        </section>
        <section className="pv-notes-wrap" aria-label="Notes">
          <h2>Notes
            <span className="pv-gap"/>
            {btn('a-large-small', 'Smaller notes', () => setNotesSize(s => Math.max(NOTES_MIN, s - NOTES_STEP)), notesSize <= NOTES_MIN)}
            {btn('plus', 'Larger notes', () => setNotesSize(s => Math.min(NOTES_MAX, s + NOTES_STEP)), notesSize >= NOTES_MAX)}
          </h2>
          <div className="pv-notes" style={{fontSize: notesSize}} data-notes>{view.notes || <span className="pv-none">No notes for this slide.</span>}</div>
        </section>
      </aside>
    </main>
  </div>;
}
