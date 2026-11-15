// Combine files, in its own workspace (printcraft crates/ui-egui/src/workflows/combine_ui/view.rs, table.rs):
// the files to combine in order, each with the pages to take (all, or a range such as "1-3, 6"), its size,
// and anything that stops it being combined. Rows are selected like files in a file manager (click,
// Ctrl or Command click, Shift click), Delete removes them, and every change to the list can be undone.
// The toolbar is icons (Add files, Remove, Move up, Move down, Unlock, Undo, Redo) and the Combine button.
// It reads the list from the document's view state and writes through the combine.* commands only, so the
// bridge, the keyboard and this view share them. A column heading sorts (a second click reverses it) and drags to a new place; a row drags to a new place.

import {useState, type ReactElement, type KeyboardEvent, type MouseEvent} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {Icon} from '../../../shell/icons/Icon';
import CombineGrid from './CombineGrid';
import './combine.css';

type Any = any;

const size = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
const LOCKED = ['password', 'wrong-password', 'not-permitted'];
/** The columns of the list in their usual order, what each sorts by (printcraft combine_ui/files.rs SortKey) and how wide each is. */
const COLUMNS = ['name', 'pages', 'take', 'size', 'modified', 'warnings'];
const COLUMN_LABELS = {name: 'File name', pages: 'Pages', take: 'Take pages', size: 'Size', modified: 'Modified', warnings: 'Warnings'};
const SORT_OF: Record<string, string | undefined> = {name: 'name', pages: 'pages', size: 'size', modified: 'modified', warnings: 'warnings'};
const WIDTH: Record<string, string> = {name: 'minmax(180px, 3fr)', pages: '70px', take: 'minmax(120px, 1.2fr)', size: '90px', modified: '110px', warnings: 'minmax(160px, 2.4fr)'};

export default function CombineWorkspace(): ReactElement {
  const {controller, session, docId} = useEngine();
  useSessionTick();
  const doc: Any = (() => { try { return session.get(docId); } catch { return null; } })();
  const tab: Any = doc?.view?.combine ?? {files: [], selected: [], undo: [], redo: []};
  const files: Any[] = tab.files ?? [];
  const selected: number[] = tab.selected ?? [];
  const [anchor, setAnchor] = useState<number | null>(null);
  const run = (id: string, args: Any = {}) => { void controller.run(id, args, {origin: 'ui'}).catch(() => {}); };
  const can = (id: string, args: Any = {}) => { try { return session.state(docId, id, args).enabled !== false; } catch { return false; } };
  const hasLocked = files.some(f => LOCKED.includes(f.problem));
  const columns: string[] = Array.isArray(tab.columns) && tab.columns.length === COLUMNS.length && COLUMNS.every(c => tab.columns.includes(c)) ? tab.columns : COLUMNS;
  const rowStyle = {gridTemplateColumns: columns.map(c => WIDTH[c]).join(' ')};
  const [dragRow, setDragRow] = useState<number | null>(null);
  const [overRow, setOverRow] = useState<number | null>(null);
  const [dragColumn, setDragColumn] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);

  const pick = (f: Any, e: MouseEvent) => {
    if (e.shiftKey && anchor !== null) {
      const a = files.findIndex(x => x.id === anchor), b = files.findIndex(x => x.id === f.id);
      const ids = files.slice(Math.min(a, b), Math.max(a, b) + 1).map(x => x.id);
      run('combine.select', {ids, mode: 'replace'});
    } else if (e.ctrlKey || e.metaKey) { run('combine.select', {ids: [f.id], mode: 'toggle'}); setAnchor(f.id); }
    else { run('combine.select', {ids: [f.id]}); setAnchor(f.id); }
  };
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); run('combine.remove'); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); run('combine.select', {mode: 'all'}); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); run(e.shiftKey ? 'combine.redo' : 'combine.undo'); }
    else if (e.key === 'Escape') run('combine.close');
  };
  // An icon with its name beside it (the toolbar is wide enough); `zoom` buttons stay icon-only beside the percentage.
  const btn = (icon: string, tip: string, id: string, args: Any = {}, enabled = can(id, args), label: string | null = tip.replace(/…$/, '')) =>
    <button type="button" className={`cw-icon${label ? ' has-label' : ''}`} aria-label={tip} data-tip={tip} disabled={!enabled} onClick={() => run(id, args)}><Icon id={icon} size={20}/>{label ? <span>{label}</span> : null}</button>;

  return <div className="cw" data-testid="combine-workspace" tabIndex={-1} onKeyDown={onKey}>
    <div className="cw-bar">
      <b className="cw-title">Combine files</b>
      <span className="cw-sep"/>
      {btn('file-plus', 'Add files…', 'combine.add')}
      {btn('folder', 'Add folder…', 'combine.add_folder', {recursive: false}, can('combine.add_folder', {recursive: false}), 'Folder')}
      {btn('trash-2', 'Remove', 'combine.remove')}
      {btn('arrow-up', 'Move up', 'combine.move', {by: -1})}
      {btn('arrow-down', 'Move down', 'combine.move', {by: 1})}
      {btn('lock-open', 'Unlock…', 'combine.unlock', {}, hasLocked)}
      <span className="cw-sep"/>
      {btn('undo-2', 'Undo', 'combine.undo')}
      {btn('redo-2', 'Redo', 'combine.redo')}
      <span className="cw-sep"/>
      <select className="cw-sort" aria-label="Sort files" value="" disabled={files.length < 2} data-tip="Sort the files" onChange={e => { if (e.target.value) run('combine.sort', {key: e.target.value}); }}>
        <option value="">Sort by…</option>{['name', 'pages', 'size', 'modified', 'warnings'].map(k => <option key={k} value={k}>{COLUMN_LABELS[(k === 'pages' ? 'pages' : k) as keyof typeof COLUMN_LABELS]}{tab.sort?.key === k ? (tab.sort.ascending ? ' ▲' : ' ▼') : ''}</option>)}</select>
      {btn(tab.grid ? 'list' : 'layout-grid', tab.grid ? 'List view' : 'Grid view', 'combine.view', {mode: 'toggle'})}
      {tab.grid ? <>
        {btn('maximize-2', 'Expand all', 'combine.view', {expand: 'all'}, undefined, 'Expand')}
        {btn('minimize-2', 'Collapse all', 'combine.view', {expand: 'none'}, undefined, 'Collapse')}
        {btn('zoom-out', 'Smaller pages', 'combine.view', {zoom: 'smaller'}, undefined, null)}
        <button type="button" className="cw-percent" aria-label="Reset page size" data-tip="Reset page size" onClick={() => run('combine.view', {zoom: 'reset'})}>{Math.round((tab.zoom ?? 1) * 100)}%</button>
        {btn('zoom-in', 'Larger pages', 'combine.view', {zoom: 'larger'}, undefined, null)}
      </> : null}
      <span className="cw-grow"/>
      {btn('settings', 'Options…', 'combine.options', {}, undefined, 'Options')}
      <button type="button" className="cw-go" disabled={!can('combine.go')} onClick={() => run('combine.go')}>Combine</button>
      <button type="button" className="cw-icon" aria-label="Close" data-tip="Close" onClick={() => run('combine.close')}><Icon id="x" size={20}/></button>
    </div>
    {files.length && tab.grid ? <CombineGrid docId={docId} files={files} selected={selected} zoom={tab.zoom ?? 1} expanded={tab.expanded ?? []} onPick={pick} run={run}/>
      : files.length ? <div className="cw-table" role="listbox" aria-multiselectable="true" aria-label="Files to combine">
      <div className="cw-row cw-head" style={rowStyle} role="row">
        {columns.map(c => <span key={c} role="columnheader" draggable className={`cw-col${dragColumn === c ? ' is-dragged' : ''}${overColumn === c && dragColumn !== c ? ' is-over' : ''}`} data-column={c}
          aria-sort={(tab.sort && tab.sort.key === SORT_OF[c]) ? (tab.sort.ascending ? 'ascending' : 'descending') : undefined}
          data-tip={SORT_OF[c] ? `Sort by ${COLUMN_LABELS[c as keyof typeof COLUMN_LABELS].toLowerCase()}` : undefined}
          onClick={() => { if (SORT_OF[c]) run('combine.sort', {key: SORT_OF[c]}); }}
          onDragStart={e => { setDragColumn(c); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c); }}
          onDragOver={e => { if (dragColumn) { e.preventDefault(); setOverColumn(c); } }}
          onDragLeave={() => setOverColumn(null)}
          onDrop={e => { e.preventDefault(); if (dragColumn && dragColumn !== c) { const next = columns.filter(x => x !== dragColumn); next.splice(next.indexOf(c) + (columns.indexOf(dragColumn) < columns.indexOf(c) ? 1 : 0), 0, dragColumn); run('combine.columns', {order: next}); } setDragColumn(null); setOverColumn(null); }}
          onDragEnd={() => { setDragColumn(null); setOverColumn(null); }}>
          {COLUMN_LABELS[c as keyof typeof COLUMN_LABELS]}{(tab.sort && tab.sort.key === SORT_OF[c]) ? <Icon id={tab.sort.ascending ? 'chevron-up' : 'chevron-down'} size={16}/> : null}</span>)}
      </div>
      {files.map((f, i) => {
        const on = selected.includes(f.id);
        const warn = f.problem ? `${f.message}` : '';
        const cell: Record<string, ReactElement> = {
          name: <span key="name" className="cw-name" title={f.name}><Icon id={f.problem ? 'lock' : 'file-text'} size={16}/><b>{f.name}</b></span>,
          pages: <span key="pages">{f.pages || '—'}</span>,
          take: <span key="take"><input className="cw-range" aria-label={`Pages of ${f.name}`} placeholder="All" defaultValue={f.range} key={`${f.id}-${f.range}`} disabled={!f.pages}
            draggable={false} onClick={e => e.stopPropagation()} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            onBlur={e => { if (e.target.value.trim() !== f.range) run('combine.range', {id: f.id, range: e.target.value}); }}/></span>,
          size: <span key="size">{size(f.size)}</span>,
          modified: <span key="modified" className="cw-modified">{f.modified ? new Date(f.modified).toLocaleDateString() : '—'}</span>,
          warnings: <span key="warnings" className="cw-status" title={warn}>{warn}{['password', 'wrong-password', 'not-permitted'].includes(f.problem)
            ? <button type="button" className="cw-unlock" onClick={e => { e.stopPropagation(); void controller.run('combine.select', {ids: [f.id], mode: 'replace'}, {origin: 'ui'}).then(() => controller.run('combine.unlock', {}, {origin: 'ui'})).catch(() => {}); }}>Unlock…</button> : null}</span>,
        };
        return <div key={f.id} role="option" aria-selected={on} draggable className={`cw-row${on ? ' is-selected' : ''}${f.problem ? ' has-problem' : ''}${dragRow === f.id ? ' is-dragged' : ''}${overRow === f.id && dragRow !== f.id ? ' is-over' : ''}`}
          style={rowStyle} data-file={f.id} data-index={i} tabIndex={0} onClick={e => pick(f, e)}
          onDragStart={e => { setDragRow(f.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(f.id)); }}
          onDragOver={e => { if (dragRow !== null) { e.preventDefault(); setOverRow(f.id); } }}
          onDragLeave={() => setOverRow(null)}
          onDrop={e => { e.preventDefault(); if (dragRow !== null && dragRow !== f.id) run('combine.drop', {file: dragRow, onto: f.id}); setDragRow(null); setOverRow(null); }}
          onDragEnd={() => { setDragRow(null); setOverRow(null); }}>
          {columns.map(c => cell[c])}
        </div>;
      })}
    </div> : <div className="cw-empty"><Icon id="files" size={32}/><b>Add the files to combine</b><span>Choose the PDFs, put them in order and pick the pages to take from each.</span>
      <button type="button" className="cw-go" onClick={() => run('combine.add')}>Add files…</button></div>}
  </div>;
}
