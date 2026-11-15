// The Thesaurus pane (Review › Proofing › Thesaurus, Shift+F7): a search box with the word looked
// up (the word at the caret), its synonyms, and Insert, which replaces the word at the caret (or
// the selection) with the chosen one. Reads review.thesaurus, writes through select.word and
// text.insert. Upstream's review.thesaurus (crates/engine/src/cmd/review/proofing.rs `thesaurus`,
// its own small word list) at aadb077e072b7de05f724e359d8db82e151f125c, shown as Word's pane.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEffect, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';

export default function ThesaurusPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  const view = (() => { try { return (session.get(docId) as any).view ?? {}; } catch { return {}; } })();
  const [query, setQuery] = useState<string>(view.thesaurusWord ?? '');
  const [result, setResult] = useState<{word: string; synonyms: string[]} | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const look = (w: string) => session.execute(docId, 'review.thesaurus', {word: w, open: false}, {origin: 'ui'})
    .then(r => { setResult(r.result as {word: string; synonyms: string[]}); setPicked(null); }).catch(e => controller.notify(toCommandError(e).message, 'error'));
  useEffect(() => { setQuery(view.thesaurusWord ?? ''); void look(view.thesaurusWord ?? ''); }, [view.thesaurusWord]);
  const insert = async (w: string) => {
    try {
      const sel = (session.get(docId) as any).selection?.ranges?.[0];
      if (!sel || sel.anchor === sel.focus) await controller.run('select.word', {}, {origin: 'dialog'});
      await controller.run('text.insert', {text: w}, {origin: 'dialog'});
    } catch (e) { controller.notify(toCommandError(e).message, 'error'); }
  };
  return <div className="quill-thesaurus-pane" style={{display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0}}>
    <form style={{display: 'flex', gap: 6}} onSubmit={e => { e.preventDefault(); void look(query.trim().toLowerCase()); }}>
      <input className="sf-text" aria-label="Search for" value={query} onChange={e => setQuery(e.target.value)} style={{flex: 1, minWidth: 0}}/>
      <button type="submit" className="sf-button">Search</button>
    </form>
    {result && !result.synonyms.length ? <small style={{color: '#b9bac1'}}>No results found{result.word ? ` for “${result.word}”` : ''}.</small> : null}
    {result?.synonyms.length ? <b style={{fontSize: 12.5}}>{result.word}</b> : null}
    <div role="listbox" aria-label="Synonyms" style={{flex: 1, minHeight: 0, overflow: 'auto'}}>
      {result?.synonyms.map(w => <div key={w} role="option" aria-selected={picked === w} className={`sf-list-item${picked === w ? ' is-selected' : ''}`}
        style={{justifyContent: 'space-between', cursor: 'default'}} onClick={() => setPicked(w)} onDoubleClick={() => void look(w)}>
        <span>{w}</span>
        <button type="button" className="sf-button" onClick={e => { e.stopPropagation(); void insert(w); }}>Insert</button>
      </div>)}
    </div>
  </div>;
}
