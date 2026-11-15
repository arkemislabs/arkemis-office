// The Search panel (spec pane `search`, printcraft crates/ui-egui/src/panels/search_ui.rs): the query, Whole words
// only and Case-sensitive, "N instances", and every match with its context, page by page; a click goes to it.
// It shares the find bar's search (view.find) and writes through the find commands only.

import {useEffect, useRef, useState, type ReactElement} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import './search.css';

type Any = any;
const OPTIONS = ['Whole words only', 'Case-sensitive'];

export default function SearchPane(_: PaneProps): ReactElement {
  const {controller, session, docId} = useEngine();
  useSessionTick();
  const doc: Any = (() => { try { return session.get(docId); } catch { return null; } })();
  const find: Any = doc?.view?.find ?? null;
  const [text, setText] = useState<string>(find?.query ?? '');
  const input = useRef<HTMLInputElement>(null);
  const typed = useRef(text);
  const run = (id: string, args: Any = {}) => { void controller.run(id, args, {origin: 'ui'}).catch(() => {}); };
  useEffect(() => { input.current?.focus(); input.current?.select(); }, [find?.focus]);
  useEffect(() => { if ((find?.query ?? '') !== typed.current) { typed.current = find?.query ?? ''; setText(typed.current); } }, [find?.query]);
  useEffect(() => {
    if (text === (find?.query ?? '')) return;
    const t = setTimeout(() => { typed.current = text; run('edit.find', {query: text}); }, 250);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const matches: Any[][] = find?.matches ?? [];
  const n = matches.length;
  let last = -1;
  return <div className="sp-pane" data-testid="search-pane">
    <label className="sp-ask" htmlFor="sp-input">What word or phrase would you like to search for?</label>
    <input id="sp-input" ref={input} className="sp-input" type="text" placeholder="Search" value={text} onChange={e => setText(e.target.value)}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { typed.current = text; run('edit.find', {query: text}); } }}/>
    <div className="sp-options">{OPTIONS.map(o => <label key={o}><input type="checkbox" checked={o === OPTIONS[0] ? !!find?.wholeWords : !!find?.caseSensitive} onChange={() => run('find.option', {option: o})}/>{o}</label>)}</div>
    <div className="sp-status">{!(find?.query ?? '').trim() ? '' : n === 0 ? 'No matches.' : `${n === 1 ? '1 instance' : `${n} instances`}${n >= 2000 ? ' (the first 2000)' : ''}`}</div>
    <div className="sp-list" role="listbox" aria-label="Search results">
      {matches.map((m, i) => {
        const head = m[0] !== last ? <div className="sp-page" key={`p${m[0]}-${i}`}>Page {m[0] + 1}</div> : null;
        last = m[0];
        return <div key={i}>{head}<button type="button" role="option" aria-selected={find.current === i} className={`sp-hit${find.current === i ? ' is-current' : ''}`} title="Go to this result" onClick={() => run('find.goto', {match: i + 1})}>
          <span>…{m[3]} </span><mark>{m[4]}</mark><span> {m[5]}…</span></button></div>;
      })}
    </div>
  </div>;
}
