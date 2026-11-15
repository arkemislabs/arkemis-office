// The Revisions pane (Review > Reviewing Pane): the slide-level differences between this presentation
// and a revised copy, each a card (inserted, deleted or changed; what differs) with Accept and
// Reject; Accept All and Reject All; a click on the heading goes to the slide; End Review when none
// are left. The list is review.revisions.
// Translated from deckcraft crates/ui-egui/src/panels/comments.rs (`revisions`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEffect, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import './review.css';

type Any = any;

export default function RevisionsPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const [rev, setRev] = useState<Any>(null);
  useEffect(() => {
    let live = true;
    Promise.resolve(session.execute(docId, 'review.revisions', {}, {origin: 'ui'})).then((r: Any) => { if (live) setRev(r?.result ?? null); }).catch(() => { if (live) setRev(null); });
    return () => { live = false; };
  }, [session, docId, tick]);
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const run = (id: string, params: Record<string, unknown> = {}) => controller.run(id, params, {origin: 'ui'}).catch(fail);
  if (!rev) return <div className="rv"><small className="rv-empty">Compare this presentation with a revised copy from Review &gt; Compare.</small></div>;
  const changes: Any[] = rev.changes ?? [];
  return <div className="rv">
    <small className="rv-empty">Compared with {rev.name}</small>
    {rev.byPosition ? <small className="rv-faint">Not a copy of this presentation: slides are matched by position.</small> : null}
    {!changes.length ? <>
      <p className="rv-text">No differences left.</p>
      <button type="button" className="sf-button" onClick={() => run('review.endCompare')}>End Review</button>
    </> : <>
      <div className="rv-bar">
        <button type="button" className="sf-button" data-pane-action="accept-all" onClick={() => run('review.accept', {all: true})}>Accept All ({changes.length})</button>
        <button type="button" className="sf-button" data-pane-action="reject-all" onClick={() => run('review.reject', {all: true})}>Reject All ({changes.length})</button>
      </div>
      {changes.map((c, i) => {
        const head = c.kind === 'inserted' ? `Slide inserted after ${c.slide}` : c.kind === 'deleted' ? `Slide ${c.slide + 1} deleted` : `Slide ${c.slide + 1} changed`;
        return <div key={i} className="rv-card" data-revision={i}>
          <div className="rv-head">
            <i className={`rv-kind is-${c.kind}`} aria-hidden="true"/>
            <button type="button" className="rv-link" onClick={() => run('slide.go', {index: Math.min(c.slide, Math.max((session.get(docId) as Any).file.content.slides.length - 1, 0))})}>{head}</button>
            <span className="rv-spacer"/>
            <button type="button" className="sf-button rv-small" onClick={() => run('review.accept', {index: i})}>Accept</button>
            <button type="button" className="sf-button rv-small" onClick={() => run('review.reject', {index: i})}>Reject</button>
          </div>
          {(c.details ?? []).slice(0, 8).map((d: string, k: number) => <p key={k} className="rv-reply">• {d}</p>)}
        </div>;
      })}
    </>}
  </div>;
}
