// The Spelling pane (Review > Proofing > Spelling, F7): OneNote's: the misspelt word the check stopped on, Ignore, Ignore All and Add (to the dictionary), the
// suggestions, Change and Change All. Each one moves on to the next misspelt word of the page, which is selected. Drawn from `view.pane` ({kind: 'spelling'}) beside
// the page; reads review.spellingList (read again after every change) and writes through commands only. Words are checked against the bundled US English
// dictionary (core/common/lib/spelling.mjs).

import {useEffect, useState} from 'react';
import type {ShellController} from '../../../shell/engine/ShellController';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {spelling, sessionKey} from '../../../../core/common/lib/spelling.mjs';

type Issue = {page: string; block: string; start: number; end: number; from: number; to: number; word: string; key: string; suggestions: string[]};

export function SpellingPane({controller, docId}: {controller: ShellController; docId: string}) {
  const tick = useSessionTick();
  const [items, setItems] = useState<Issue[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.resolve(controller.session.execute(docId, 'review.spellingList', {}, {origin: 'ui'})).then((r: any) => { if (live) setItems(Array.isArray(r?.result) ? r.result : []); }).catch(() => { if (live) setItems([]); });
    return () => { live = false; };
  }, [controller, docId, tick]);

  // The word shown: the first one at or after the caret (the selected word is the current one), else the first of the page.
  const sel = (() => { try { return (controller.session.get(docId) as any).selection?.ranges?.[0]?.anchor ?? ''; } catch { return ''; } })();
  const current: Issue | null = items?.find(it => sel.includes(`/b:${encodeURIComponent(it.block)}/t:${it.start}`)) ?? items?.[0] ?? null;
  const suggestions = current?.suggestions ?? [];
  const key = current?.key ?? null;
  useEffect(() => { setPicked(suggestions[0] ?? null); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = (id: string, params: Record<string, unknown> = {}) => async () => {
    setBusy(true);
    try { await controller.run(id, params, {origin: 'ui'}); } catch (e) { controller.notify(toCommandError(e).message, 'error'); } finally { setBusy(false); }
  };
  const next = () => controller.run('review.spelling', {}, {origin: 'ui'}).catch(() => {});
  const after = (id: string, params: Record<string, unknown>) => async () => { await run(id, params)(); await next(); };
  const close = () => { void controller.run('history.closePane', {}, {origin: 'ui'}); };

  return <aside className="slate-pane" aria-label="Spelling" data-pane="spelling" data-spelling-pane>
    <header><h2>Spelling</h2><button type="button" className="slate-pane-act" aria-label="Close" title="Close" onClick={close}>
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg></button></header>
    <div className="slate-pane-body" style={{display: 'flex', flexDirection: 'column', gap: 10}}>
      {items === null ? <p className="slate-pane-empty">Checking…</p> : null}
      {items && !current ? <div data-spelling-done>
        <p className="slate-pane-empty">The spelling check is complete. No more misspelt words on this page.{spelling().hasIgnored(sessionKey((controller.session as any).host, docId)) ? ' Words you chose to ignore are not marked; Recheck brings them back.' : ''}</p>
        <button type="button" className="slate-pane-chip" onClick={after('review.spellingRecheck', {})}>Recheck</button>
      </div> : null}
      {current ? <>
        <small className="slate-pane-note">Not in dictionary</small>
        <div data-spelling-word style={{border: '1px solid currentColor', borderRadius: 4, padding: '6px 8px', textDecoration: 'underline wavy #e02020', textUnderlineOffset: 3, fontSize: 14}}>{current.word}</div>
        <div style={{display: 'flex', gap: 6, flexWrap: 'wrap'}}>
          <button type="button" className="slate-pane-chip" disabled={busy} onClick={after('review.ignoreOnce', {key: current.key})}>Ignore</button>
          <button type="button" className="slate-pane-chip" disabled={busy} onClick={after('review.ignoreAll', {word: current.word})}>Ignore All</button>
          <button type="button" className="slate-pane-chip" disabled={busy} onClick={after('review.addToDictionary', {word: current.word})}>Add</button>
        </div>
        <b style={{fontSize: 12.5}}>Suggestions</b>
        {suggestions.length ? <div role="listbox" aria-label="Suggestions">
          {suggestions.map(w => <div key={w} role="option" aria-selected={picked === w} data-suggestion={w} className={`slate-pane-row${picked === w ? ' is-viewing' : ''}`} style={{cursor: 'default'}}
            onClick={() => setPicked(w)} onDoubleClick={() => { setPicked(w); void after('review.spellingChange', {from: current.from, to: current.to, word: current.word, text: w})(); }}>
            <span className="slate-pane-main"><b>{w}</b></span></div>)}
        </div> : <p className="slate-pane-empty">(no spelling suggestions)</p>}
        <div style={{display: 'flex', gap: 6}}>
          <button type="button" className="slate-pane-chip" disabled={busy || !picked} onClick={after('review.spellingChange', {from: current.from, to: current.to, word: current.word, text: picked ?? ''})}>Change</button>
          <button type="button" className="slate-pane-chip" disabled={busy || !picked} onClick={after('review.spellingChange', {word: current.word, text: picked ?? '', all: true})}>Change All</button>
        </div>
      </> : null}
    </div>
  </aside>;
}
