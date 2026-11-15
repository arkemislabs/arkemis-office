// The Comments pane (Review > Show Comments): every comment of the deck by slide, each a card with the
// author's initials, name, date, the text and its replies, a Reply box, Resolve / Reopen and Delete;
// "+ New Comment" opens the New Comment dialog. A click on a card goes to its slide and marks it, so
// Next / Previous and Delete on the ribbon continue from it.
// Translated from deckcraft crates/ui-egui/src/panels/comments.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useMemo, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import './review.css';

type Any = any;
const when = (c: Any) => `${String(c.date ?? '').replace('T', ' ').replace(/Z$/, '')}${c.resolved ? ' · Resolved' : ''}`;

function Card({c, slide, index, focused, run}: {c: Any; slide: number; index: number; focused: boolean; run: (id: string, p?: Record<string, unknown>) => Promise<unknown>}) {
  const [reply, setReply] = useState('');
  const focus = () => run('comment.focus', {slide, index});
  return <div className={`rv-card${focused ? ' is-focus' : ''}`} data-comment={`${slide}:${index}`} onClick={focus}>
    <div className="rv-head">
      <span className="rv-avatar" aria-hidden="true">{c.initials || String(c.author ?? '?').slice(0, 1)}</span>
      <span className="rv-who"><b>{c.author}</b><small>{when(c)}</small></span>
    </div>
    <p className="rv-text">{c.text}</p>
    {(c.replies ?? []).map((r: Any, i: number) => <p key={i} className="rv-reply">↳ {r.author}: {r.text}</p>)}
    <div className="rv-actions" onClick={e => e.stopPropagation()}>
      <input className="rv-input" value={reply} placeholder="Reply…" aria-label="Reply" onChange={e => setReply(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && reply.trim()) { void focus(); void run('comment.reply', {index, text: reply}); setReply(''); } }}/>
      <button type="button" className="sf-button rv-small" onClick={() => { void focus(); void run('comment.resolve', {index, resolved: !c.resolved}); }}>{c.resolved ? 'Reopen' : 'Resolve'}</button>
      <button type="button" className="sf-button rv-small rv-icon" aria-label="Delete comment" title="Delete comment" onClick={async () => { await run('slide.go', {index: slide}); await run('comment.delete', {index}); }}>
        <svg viewBox="0 0 14 14" width="13" height="13" aria-hidden="true"><path d="M3 4h8M5.5 4V2.7h3V4M4 4l.5 7.3h5L10 4M6 6v3.5M8 6v3.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
    </div>
  </div>;
}

export default function CommentsPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const model = useMemo(() => {
    try {
      const d: Any = session.get(docId);
      const threads = (d.file.content.slides ?? []).map((s: Any, i: number) => [i, s.comments ?? []]).filter((t: Any) => t[1].length);
      return {threads, focus: d.view?.commentFocus ?? null};
    } catch { return null; }
  }, [session, docId, tick]);
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const run = (id: string, params: Record<string, unknown> = {}) => controller.run(id, params, {origin: 'ui'}).catch(fail);
  return <div className="rv">
    <button type="button" className="sf-button rv-new" data-pane-action="new-comment" onClick={() => { try { controller.openDialog('dialog.comment', {}); } catch (e) { fail(e); } }}>+ New Comment</button>
    {!model || !model.threads.length ? <small className="rv-empty">No comments.</small> : model.threads.map(([si, list]: [number, Any[]]) => <section key={si} className="rv-slide">
      <h4>Slide {si + 1}</h4>
      {list.map((c, i) => <Card key={i} c={c} slide={si} index={i} focused={model.focus?.slide === si && model.focus?.index === i} run={run}/>)}
    </section>)}
  </div>;
}
