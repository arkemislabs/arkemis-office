// Immersive Reader (View > Immersive Reader; U:slate/view): the page's text alone, large and spaced,
// with a toolbar drawn as icons: text size, spacing, theme, Line Focus (one, three or five paragraphs
// lit, the rest dimmed; the arrow keys move it) and Read Aloud (the system's speech voices, one
// paragraph at a time, the one being read lit). Its settings are the view state `immersive`, set by
// the view.immersiveReader command (so the bridge and the keyboard do the same); leaving is Esc or Close.

import {useEffect, useMemo, useRef, useState} from 'react';
import type {ShellController} from '../../../shell/engine/ShellController';
import {nodeOf} from '../../../../core/slate/schema.mjs';

interface Reader { size: number; spacing: boolean; theme: string; lineFocus: number }
const SIZES = [17, 22, 28, 36];

const path: Record<string, string> = {
  smaller: 'M4 12 7.5 3.5 11 12M5.2 9.5h4.6M12 5.5h3', larger: 'M3 13 7.5 2.5 12 13M4.7 10h5.6M12.5 5.5h4M14.5 3.5v4', spacing: 'M3 3h10M3 13h10M8 5.5v5M6 7.5 8 5.5l2 2M6 8.5l2 2 2-2',
  theme: 'M8 2.5a5.5 5.5 0 1 0 0 11V2.5z', focus: 'M2 5.5h12M2 10.5h12M5 8h6', play: 'M5 3.5v9l7.5-4.5z', pause: 'M5 3.5v9M11 3.5v9', stop: 'M4.5 4.5h7v7h-7z', close: 'M4 4l8 8M12 4l-8 8',
};
const Icon = ({name}: {name: string}) => <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d={path[name]} fill={name === 'theme' || name === 'play' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>;

const leaf = (n: any) => (n.type.name === 'equation' ? n.attrs.linear : n.type.name === 'image' ? n.attrs.alt ?? '' : '');

export function ImmersiveReader({page, reader, controller}: {page: {title: string; body: any}; reader: Reader; controller: ShellController}) {
  const run = (params: Record<string, unknown>) => { void controller.run('view.immersiveReader', params, {origin: 'ui'}); };
  const paras = useMemo(() => {
    const out: string[] = [];
    nodeOf(page.body).descendants((n: any) => { if (n.isTextblock) { const t = n.textBetween(0, n.content.size, ' ', leaf).trim(); if (t) out.push(t); return false; } return true; });
    return out;
  }, [page.body]);
  const [at, setAt] = useState(0);
  const [reading, setReading] = useState<number | null>(null);
  const speech = typeof window !== 'undefined' ? (window as any).speechSynthesis : null;
  const stopped = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const stop = () => { stopped.current = true; try { speech?.cancel(); } catch { /* no voices */ } setReading(null); };
  const speakFrom = (i: number) => {
    if (!speech || i >= paras.length || stopped.current) { setReading(null); return; }
    setReading(i); setAt(i);
    const u = new (window as any).SpeechSynthesisUtterance(paras[i]);
    u.onend = () => speakFrom(i + 1);
    u.onerror = () => setReading(null);
    try { speech.speak(u); } catch { setReading(null); }
  };
  const play = () => { if (reading !== null) { stop(); return; } stopped.current = false; speakFrom(at); };
  useEffect(() => () => { try { speech?.cancel(); } catch { /* none */ } }, [speech]);
  useEffect(() => { root.current?.focus(); }, []);
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); stop(); run({value: false}); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setAt(a => Math.min(paras.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt(a => Math.max(0, a - 1)); }
  };
  const lit = (i: number) => {
    if (reading !== null) return i === reading;
    if (!reader.lineFocus) return true;
    const from = Math.max(0, Math.min(at - Math.floor(reader.lineFocus / 2), paras.length - reader.lineFocus));
    return i >= from && i < from + reader.lineFocus;
  };
  return <div ref={root} className={`slate-reader is-${reader.theme}${reader.spacing ? ' is-spaced' : ''}`} role="dialog" aria-label="Immersive Reader" tabIndex={-1} onKeyDown={key} data-immersive-reader>
    <div className="slate-reader-bar" role="toolbar" aria-label="Immersive Reader">
      <button type="button" title="Read Aloud" aria-label={reading === null ? 'Read Aloud' : 'Pause'} disabled={!speech} onClick={play}><Icon name={reading === null ? 'play' : 'pause'}/></button>
      <button type="button" title="Stop" aria-label="Stop" disabled={reading === null} onClick={stop}><Icon name="stop"/></button>
      <span className="slate-reader-sep" aria-hidden="true"/>
      <button type="button" title="Text size: smaller" aria-label="Smaller text" disabled={reader.size <= 1} onClick={() => run({textSize: reader.size - 1})}><Icon name="smaller"/></button>
      <button type="button" title="Text size: larger" aria-label="Larger text" disabled={reader.size >= 4} onClick={() => run({textSize: reader.size + 1})}><Icon name="larger"/></button>
      <button type="button" title="Text spacing" aria-label="Text spacing" aria-pressed={reader.spacing} className={reader.spacing ? 'is-on' : ''} onClick={() => run({spacing: !reader.spacing})}><Icon name="spacing"/></button>
      <span className="slate-reader-sep" aria-hidden="true"/>
      {(['white', 'sepia', 'dark'] as const).map(t => <button key={t} type="button" title={`${t[0].toUpperCase()}${t.slice(1)} theme`} aria-label={`${t} theme`} aria-pressed={reader.theme === t}
        className={`slate-reader-theme is-${t}${reader.theme === t ? ' is-on' : ''}`} onClick={() => run({theme: t})}><i/></button>)}
      <span className="slate-reader-sep" aria-hidden="true"/>
      <button type="button" title={reader.lineFocus ? `Line Focus: ${reader.lineFocus}` : 'Line Focus'} aria-label="Line Focus" aria-pressed={reader.lineFocus > 0} className={reader.lineFocus ? 'is-on' : ''}
        onClick={() => run({lineFocus: ({0: 1, 1: 3, 3: 5, 5: 0} as Record<number, number>)[reader.lineFocus]})}><Icon name="focus"/>{reader.lineFocus ? <b>{reader.lineFocus}</b> : null}</button>
      <span className="slate-reader-grow"/>
      <button type="button" title="Close (Esc)" aria-label="Close Immersive Reader" onClick={() => { stop(); run({value: false}); }}><Icon name="close"/></button>
    </div>
    <article className="slate-reader-page" style={{fontSize: SIZES[reader.size - 1]}}>
      <h1>{page.title || 'Untitled page'}</h1>
      {paras.length ? paras.map((t, i) => <p key={i} className={lit(i) ? '' : 'is-dim'} onClick={() => setAt(i)}>{t}</p>) : <p className="is-empty">This page has no text.</p>}
    </article>
  </div>;
}
