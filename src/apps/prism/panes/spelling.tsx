// The Spelling pane (Review › Proofing › Spelling, F7): PowerPoint's: the misspelt word the check stopped on, Ignore, Ignore All and Add (to the
// dictionary), the suggestions, Change and Change All. Each one moves on to the next word of the deck, going to its slide and selecting its
// shape. A repeated word offers Delete. Reads review.spellingList (live, read again after every change) and writes through commands only.
// Words are checked against the bundled US English dictionary (core/common/lib/spelling.mjs).

import {useEffect, useRef, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import {spelling, sessionKey} from '../../../../core/common/lib/spelling.mjs';
import {currentSlideIndex} from '../../../../core/prism/model/doc.mjs';
import './review.css';

type Any = any;

export default function SpellingPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const [items, setItems] = useState<Any[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const here: number = (() => { try { const d = session.get(docId) as Any; return currentSlideIndex(d.file.content, d.selection); } catch { return 0; } })();

  useEffect(() => {
    let live = true;
    Promise.resolve(session.execute(docId, 'review.spellingList', {}, {origin: 'ui'})).then((r: Any) => { if (live) setItems(Array.isArray(r?.result) ? r.result : []); }).catch(() => { if (live) setItems([]); });
    return () => { live = false; };
  }, [session, docId, tick]);

  // The word shown: the first one on or after the slide the person is on, else the first of the deck.
  const current = items ? items.find(i => i.slide >= here) ?? items[0] ?? null : null;
  const suggestions: string[] = current && !current.repeated ? current.suggestions ?? [] : [];
  const key = current?.key ?? null;
  useEffect(() => { setPicked(suggestions[0] ?? null); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const went = useRef<string | null>(null);
  useEffect(() => {
    if (!current || went.current === current.key) return;
    went.current = current.key;
    void (async () => {
      try {
        await controller.run('slide.go', {index: current.slide}, {origin: 'ui'});
        if (current.shape !== undefined) await controller.run('edit.select', {ids: [current.shape]}, {origin: 'ui'});
      } catch { /* the word is still shown */ }
    })();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const act = (id: string, params: Record<string, unknown> = {}) => async () => {
    setBusy(true);
    try { await controller.run(id, params, {origin: 'ui'}); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const change = (it: Any, to: string, all: boolean) => {
    if (it.notes) {
      const sl = (session.get(docId) as Any).file.content.slides[it.slide];
      const lines = (sl?.notes?.paragraphs ?? []).map((p: Any) => (p.runs ?? []).map((r: Any) => r.text ?? '').join(''));
      lines[it.para] = lines[it.para].slice(0, it.start) + to + lines[it.para].slice(it.end);
      return act('slide.notes', {text: lines.join('\n'), index: it.slide})();
    }
    const p: Record<string, unknown> = all ? {word: it.word, to, all: true} : {shape: it.shape, word: it.word, to, para: it.para, start: it.start};
    if (!all && it.row !== undefined) { p.row = it.row; p.col = it.col; }
    return act('review.spellingChange', p)();
  };
  const deleteRepeat = (it: Any) => {
    const sh = (function find(list: Any[]): Any { for (const x of list ?? []) { if (x.id === it.shape) return x; const r = x.kind?.children ? find(x.kind.children) : null; if (r) return r; } return null; })((session.get(docId) as Any).file.content.slides[it.slide]?.shapes);
    const para = it.row !== undefined ? sh?.kind?.rows?.[it.row]?.cells?.[it.col]?.text?.paragraphs?.[it.para] : sh?.text?.paragraphs?.[it.para];
    const text = (para?.runs ?? []).map((r: Any) => r.text ?? '').join('').slice(it.deleteFrom, it.end);
    if (!text) return undefined;
    const p: Record<string, unknown> = {shape: it.shape, para: it.para, start: it.deleteFrom, word: text, to: ''};
    if (it.row !== undefined) { p.row = it.row; p.col = it.col; }
    return act('review.spellingChange', p)();
  };

  return <div className="prism-spelling-pane" data-spelling-pane style={{display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0}}>
    {items === null ? <small style={{color: '#b9bac1'}}>Checking…</small> : null}
    {items && !current ? <div data-spelling-done style={{display: 'flex', flexDirection: 'column', gap: 8}}>
      <span>The spelling check is complete. No more misspelt words.</span>
      {spelling().hasIgnored(sessionKey((session as Any).host, docId)) ? <small style={{color: '#b9bac1'}}>Words you chose to ignore are not marked. Recheck brings them back.</small> : null}
      <button type="button" className="sf-button" onClick={act('review.spellingRecheck')} style={{alignSelf: 'flex-start'}}>Recheck</button>
    </div> : null}
    {current ? <>
      <small style={{color: '#b9bac1'}}>{current.repeated ? 'Repeated word' : 'Not in dictionary'} · Slide {current.slide + 1}{current.notes ? ' (notes)' : ''}</small>
      <div data-spelling-word style={{border: '1px solid #3a3b42', borderRadius: 6, padding: '8px 10px', color: '#ff6b6b', textDecoration: 'underline wavy #e02020', textUnderlineOffset: 3, fontSize: 14}}>{current.word}</div>
      <div style={{display: 'flex', gap: 6, flexWrap: 'wrap'}}>
        {current.repeated ? <button type="button" className="sf-button" disabled={busy || !!current.notes} onClick={() => deleteRepeat(current)}>Delete</button> : null}
        <button type="button" className="sf-button" disabled={busy} onClick={act('review.ignoreOnce', {key: current.key})}>Ignore</button>
        <button type="button" className="sf-button" disabled={busy} onClick={act('review.ignoreAll', {word: current.word})}>Ignore All</button>
        {!current.repeated ? <button type="button" className="sf-button" disabled={busy} onClick={act('review.addToDictionary', {word: current.word})}>Add</button> : null}
      </div>
      {!current.repeated ? <>
        <b style={{fontSize: 12.5}}>Suggestions</b>
        {suggestions.length ? <div role="listbox" aria-label="Suggestions" style={{flex: 1, minHeight: 60, overflow: 'auto'}}>
          {suggestions.map(w => <div key={w} role="option" aria-selected={picked === w} data-suggestion={w} className={`sf-list-item${picked === w ? ' is-selected' : ''}`} style={{cursor: 'default'}}
            onClick={() => setPicked(w)} onDoubleClick={() => { setPicked(w); void change(current, w, false); }}>{w}</div>)}
        </div> : <small style={{color: '#b9bac1'}}>(no spelling suggestions)</small>}
        <div style={{display: 'flex', gap: 6}}>
          <button type="button" className="sf-button" disabled={busy || !picked} onClick={() => picked && change(current, picked, false)}>Change</button>
          <button type="button" className="sf-button" disabled={busy || !picked || !!current.notes} onClick={() => picked && change(current, picked, true)}>Change All</button>
        </div>
      </> : null}
    </> : null}
  </div>;
}
