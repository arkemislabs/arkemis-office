// Insert Function as Excel draws it: "Search for a function:" with Go, "Or select a category:",
// "Select a function:" (the list), the selected function's signature and description; a
// double-click (or OK) starts the function and opens Function Arguments.
// Translated from gridcraft crates/ui-egui/src/dialogs/insert_function.rs (search over names and
// descriptions, at most 300 hits, name and category per row, signature and description under the
// list) at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEffect, useMemo, useRef} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {functionsFor, categoryLabel, INSERT_FUNCTION_CATEGORIES} from '../../../../core/grid/lib/formulas-catalog.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import './insertFunction.css';

type Fn = {name: string; category: string; signature: string; description: string};

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const {controller} = useEngine();
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const query = String(d.values.query ?? '');
  const category = String(d.values.category ?? 'Most Recently Used');
  const recent = (Array.isArray(d.values.recent) ? d.values.recent : []) as string[];
  const list = useMemo(() => functionsFor({category, search: query, prefs: {gridRecentFunctions: recent}}) as Fn[], [category, query, recent]);
  const selected = String(d.values.function ?? '');
  const current = list.find(f => f.name === selected) ?? null;
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current?.querySelector('.is-selected') as HTMLElement | null;
    el?.scrollIntoView?.({block: 'nearest'});
  }, [selected]);
  const go = () => {
    // Go: the search's hits, the first selected (Excel puts "Recommended" in the category box).
    const hits = functionsFor({search: String(d.values.search ?? '')}) as Fn[];
    setValue('query', String(d.values.search ?? ''));
    setValue('function', hits[0]?.name ?? null);
  };
  // Double-click / Enter in the list: the function starts in the cell and Function Arguments
  // opens over it (what OK asks the grid to do through the `dialogRequest` view state).
  const ok = () => {
    const name = String(d.values.function ?? '');
    if (!name) return;
    controller.cancelDialog(d.key);
    void controller.run('formulas.insertFunction', {name}, {origin: 'dialog'}).catch(fail);
    try { controller.openDialog('dialog.functionArguments', {init: {function: name, args: [], focus: 0}}); } catch (e) { fail(e); }
  };
  return <div className="gd-fields grid-fx">
    <div className="sf" data-field-id="search" data-kind="text">
      <label className="sf-label" htmlFor="grid-fx-search">Search for a function:</label>
      <div className="sf-control grid-fx-search">
        <input id="grid-fx-search" className="sf-text" type="text" data-autofocus value={String(d.values.search ?? '')}
          placeholder="Type a brief description of what you want to do and then click Go" spellCheck={false}
          onChange={e => setValue('search', e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(); } }}/>
        <button type="button" className="gd-button" data-field-id="go" onClick={go}>Go</button>
      </div>
    </div>
    <div className="sf" data-field-id="category" data-kind="select">
      <label className="sf-label" htmlFor="grid-fx-category">Or select a category:</label>
      <div className="sf-control"><span className="sf-select">
        <select id="grid-fx-category" value={query ? '' : category} onChange={e => setValue('category', e.target.value)}>
          {query ? <option value="">Recommended</option> : null}
          {INSERT_FUNCTION_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </span></div>
    </div>
    <div className="sf" data-field-id="function" data-kind="list">
      <span className="sf-label">Select a function:</span>
      <div className="sf-control">
        <div ref={listRef} className="sf-list grid-fx-list" role="listbox" tabIndex={0} aria-label="Select a function"
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); ok(); return; }
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            const i = list.findIndex(f => f.name === selected);
            const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
            if (next) setValue('function', next.name);
          }}>
          {list.length ? list.map(f => <div key={f.name} role="option" aria-selected={f.name === selected}
            className={`sf-list-item${f.name === selected ? ' is-selected' : ''}`}
            onClick={() => setValue('function', f.name)} onDoubleClick={() => { setValue('function', f.name); ok(); }}>
            <span className="grid-fx-name">{f.name}</span>
            {query || category === 'All' || category === 'Most Recently Used' ? <span className="grid-fx-cat">{categoryLabel(f.category)}</span> : null}
          </div>) : <div className="sf-list-empty">No functions match. Rephrase the search.</div>}
        </div>
      </div>
    </div>
    <div className="grid-fx-help" data-field-id="signature" aria-live="polite">
      <strong>{current?.signature ?? ''}</strong>
      <p data-field-id="description">{current?.description ?? ''}</p>
    </div>
  </div>;
}

export default {Body};
