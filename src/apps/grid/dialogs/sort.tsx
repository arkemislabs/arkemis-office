// The Sort dialog as Excel draws it and gridcraft builds it: My data has headers, a row per level
// (Sort by / Then by: Column, Sort On, Order) with Add Level, Delete Level, Copy Level, Move Up and Down
// and Options (Case sensitive, Sort top to bottom or left to right, nested).
// Translated from gridcraft crates/ui-egui/src/dialogs/data.rs (`sort`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {Glyph} from '../../../shell/icons/Icon';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Btn, Fld, columnLabel, indexToLetters, type SetValue} from './dataKit';

interface Level { column: string; by: string; order: string }
interface Opts { caseSensitive: boolean; orientation: 'rows' | 'columns' }

function Sel({value, onChange, children, label, width}: {value: string; onChange: (v: string) => void; children: React.ReactNode; label: string; width?: number}) {
  return <span className="sf-select" style={width ? {width} : undefined}>
    <select aria-label={label} value={value} onChange={e => onChange(e.target.value)}>{children}</select>
    <Glyph name="chevron-down" size={10}/>
  </span>;
}

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const {controller} = useEngine();
  const levels = (d.values.levels ?? []) as Level[];
  const selected = Math.min(Math.max(Number(d.values.selected ?? 0), 0), Math.max(levels.length - 1, 0));
  const heads = (d.values.heads ?? []) as string[];
  const rowHeads = (d.values.rowHeads ?? []) as string[];
  const startCol = Number(d.values.startCol ?? 0), startRow = Number(d.values.startRow ?? 0);
  const header = d.values.header === true;
  const opts = (d.values.options ?? {caseSensitive: false, orientation: 'rows'}) as Opts;
  const byRows = opts.orientation === 'columns';
  const lists = (d.values.lists ?? []) as {label: string; list: string[]}[];
  const error = d.errors.find(e => e.field === 'levels')?.message ?? null;

  const put = (next: Level[], sel = selected) => { setValue('levels', next); setValue('selected', Math.min(Math.max(sel, 0), Math.max(next.length - 1, 0))); };
  const choices = byRows
    ? rowHeads.map((h, i) => ({value: String(startRow + i + 1), label: header && i === 0 ? `Row ${startRow + 1}` : h ? `Row ${startRow + i + 1} (${h})` : `Row ${startRow + i + 1}`}))
    : heads.map((_, i) => { const l = indexToLetters(startCol + i); return {value: l, label: columnLabel(l, heads, startCol, header)}; });
  const used = new Set(levels.map(l => l.column));
  const nextFree = choices.find(c => !used.has(c.value))?.value ?? choices[choices.length - 1]?.value ?? 'A';

  const openOptions = () => {
    try { controller.openDialog('dialog.sortOptions', {parent: d.key, target: {dialog: d.key, field: 'options'}, init: {...opts, value: opts}}); }
    catch (e) { controller.notify(toCommandError(e).message, 'error'); }
  };
  const orderOptions = (by: string) => by === 'values'
    ? <>{[['asc', 'A to Z'], ['desc', 'Z to A']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}{lists.map((l, i) => <option key={i} value={`list:${i}`}>{l.label}</option>)}</>
    : <><option value="asc">Ascending</option><option value="desc">Descending</option></>;

  return <div className="gd-fields data-sort">
    <div className="gd-buttons" role="toolbar" aria-label="Sort levels">
      <Btn onClick={() => put([...levels, {column: nextFree, by: 'values', order: 'asc'}], levels.length)}>Add Level</Btn>
      <Btn disabled={levels.length < 2} onClick={() => put(levels.filter((_, i) => i !== selected), selected)}>Delete Level</Btn>
      <Btn onClick={() => put([...levels.slice(0, selected + 1), {...levels[selected], column: nextFree}, ...levels.slice(selected + 1)], selected + 1)}>Copy Level</Btn>
      <Btn icon label="Move Up" disabled={selected <= 0} onClick={() => { const n = [...levels]; [n[selected - 1], n[selected]] = [n[selected], n[selected - 1]]; put(n, selected - 1); }}>
        <Glyph name="chevron-up" size={11}/></Btn>
      <Btn icon label="Move Down" disabled={selected >= levels.length - 1} onClick={() => { const n = [...levels]; [n[selected + 1], n[selected]] = [n[selected], n[selected + 1]]; put(n, selected + 1); }}>
        <Glyph name="chevron-down" size={11}/></Btn>
      <Btn onClick={openOptions}>Options{'…'}</Btn>
    </div>
    <Fld d={d} set={setValue} id="header" kind="checkbox" label={byRows ? 'My data has labels' : 'My data has headers'}/>
    <div className="data-sort-table" role="table" aria-label="Sort levels" data-field-id="levels">
      <div className="data-sort-head" role="row"><span role="columnheader"/><span role="columnheader">{byRows ? 'Row' : 'Column'}</span><span role="columnheader">Sort On</span><span role="columnheader">Order</span></div>
      {levels.map((l, i) => <div key={i} role="row" className={`data-sort-row${i === selected ? ' is-selected' : ''}`} aria-selected={i === selected} onClick={() => setValue('selected', i)}>
        <span role="cell" className="data-sort-name">{i === 0 ? 'Sort by' : 'Then by'}</span>
        <Sel label={`Level ${i + 1} ${byRows ? 'row' : 'column'}`} value={l.column} onChange={v => put(levels.map((x, k) => (k === i ? {...x, column: v} : x)), i)}>
          {choices.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </Sel>
        <Sel label={`Level ${i + 1} sort on`} value={l.by} onChange={v => put(levels.map((x, k) => (k === i ? {...x, by: v, order: 'asc'} : x)), i)}>
          <option value="values">Cell Values</option><option value="cellColor">Cell Color</option><option value="fontColor">Font Color</option>
        </Sel>
        <Sel label={`Level ${i + 1} order`} value={l.order} onChange={v => put(levels.map((x, k) => (k === i ? {...x, order: v} : x)), i)}>{orderOptions(l.by)}</Sel>
      </div>)}
    </div>
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
    <small className="sf-note">{opts.caseSensitive ? 'Case sensitive. ' : ''}{byRows ? 'Sorting left to right.' : 'Sorting top to bottom.'}</small>
  </div>;
}

export default {Body};
