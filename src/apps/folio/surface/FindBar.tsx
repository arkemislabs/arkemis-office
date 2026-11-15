// The find bar (printcraft crates/ui-egui/src/canvas/find.rs find_bar): a floating bar at the top right of the
// document: the query, "c of n" (or "No matches"), Previous and Next, Find options (Whole words only,
// Case-sensitive) and Close. The search runs as the query is typed; Enter goes to the next match (Shift+Enter
// the previous one), Esc closes. It writes through the find commands only (core/folio/commands/find.mjs).

import {useEffect, useRef, useState, type ReactElement} from 'react';
import {Icon} from '../../../shell/icons/Icon';

const OPTIONS = ['Whole words only', 'Case-sensitive'];

export function FindBar({find, run}: {find: any; run: (id: string, args?: Record<string, unknown>) => void}): ReactElement {
  const [text, setText] = useState<string>(find.query ?? '');
  const [menu, setMenu] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const typed = useRef(text);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, [find.focus]);
  useEffect(() => { if ((find.query ?? '') !== typed.current) { typed.current = find.query ?? ''; setText(typed.current); } }, [find.query]);
  // The search follows the typing, a moment after the last key.
  useEffect(() => {
    if (text === (find.query ?? '')) return;
    const t = setTimeout(() => { typed.current = text; run('edit.find', {query: text}); }, 250);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const n = find.matches?.length ?? 0;
  const status = !(find.query ?? '').trim() ? '' : n === 0 ? 'No matches' : `${(find.current ?? 0) + 1} of ${n}${n >= 2000 ? '+' : ''}`;
  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      if (text !== (find.query ?? '')) { typed.current = text; run('edit.find', {query: text}); } else run('find.step', {forward: !e.shiftKey});
    } else if (e.key === 'Escape') { e.preventDefault(); run('find.close'); }
  };
  return <div className="folio-findbar" role="search" aria-label="Find" data-testid="find-bar" onPointerDown={e => e.stopPropagation()}>
    <Icon id="search" size={16}/>
    <input ref={input} type="text" aria-label="Find text" placeholder="Find text" value={text} onChange={e => setText(e.target.value)} onKeyDown={onKey}/>
    <span className="ffb-status" aria-live="polite">{status}</span>
    <button type="button" className="ffb-btn" aria-label="Previous (Shift+Enter)" data-tip="Previous (Ctrl+Shift+G)" disabled={!n} onClick={() => run('find.step', {forward: false})}><Icon id="chevron-up" size={16}/></button>
    <button type="button" className="ffb-btn" aria-label="Next (Enter)" data-tip="Next (Ctrl+G)" disabled={!n} onClick={() => run('find.step', {forward: true})}><Icon id="chevron-down" size={16}/></button>
    <button type="button" className={`ffb-btn${find.caseSensitive || find.wholeWords ? ' is-on' : ''}`} aria-label="Find options" aria-haspopup="menu" aria-expanded={menu} data-tip="Find options" onClick={() => setMenu(m => !m)}><Icon id="settings-2" size={16}/></button>
    <button type="button" className="ffb-btn" aria-label="Advanced search" data-tip="Advanced search (Ctrl+Shift+F)" onClick={() => run('edit.advanced_search')}><Icon id="list" size={16}/></button>
    <button type="button" className="ffb-btn" aria-label="Close (Esc)" data-tip="Close (Esc)" onClick={() => run('find.close')}><Icon id="x" size={16}/></button>
    {menu ? <div className="ffb-menu" role="menu">
      {OPTIONS.map(o => <label key={o}><input type="checkbox" checked={o === OPTIONS[0] ? !!find.wholeWords : !!find.caseSensitive} onChange={() => run('find.option', {option: o})}/>{o}</label>)}
    </div> : null}
  </div>;
}
