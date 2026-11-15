// The worksheet's Data popups: the AutoFilter drop-down of a header cell (Sort A to Z / Z to A,
// Clear Filter From, Text / Number / Date Filters, Search, the check list of values with (Select All),
// OK and Cancel), the in-cell drop-down list of a data validation, and a validation's Input Message.
// Translated from gridcraft crates/ui-egui/src/grid/menus.rs (`filter_menu`: sort, search, Select All /
// Select All Search Results, the value check boxes, Clear Filter and Apply; a table gets its autofilter
// on demand) and grid/editor.rs (`list_picker`: at most 8 rows, above the cell when there is no room
// below) at 146161b4b450a56e5e59a083ba0478582d1e602b, with Excel's Clear Filter From, Text / Number /
// Date Filters submenus and OK / Cancel. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEffect, useMemo, useRef, useState} from 'react';
import type {GridView} from './view';
import {colToLetters, parseRange, rangeA1} from '../../../../core/grid/lib/addr.mjs';
import {filterValues, criteriaOf} from '../../../../core/grid/lib/data-filter.mjs';
import {tableAtCell} from '../../../../core/grid/lib/data-common.mjs';
import {listItems, validationAt} from '../../../../core/grid/lib/data-validation.mjs';
import {styleAt} from '../../../../core/grid/model/workbook.mjs';
import {parseFormat} from '../../../../core/grid/lib/numfmt.mjs';
import {engineFor} from '../../../../core/grid/model/calc.mjs';
import {cellAt} from '../../../../core/grid/model/store.mjs';

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** The filter a header cell belongs to: the sheet's AutoFilter, or the table's (installed when its first filter is applied). */
function filterOf(sheet: any, cell: {row: number; col: number}) {
  if (sheet.autofilter) return {af: sheet.autofilter, range: null as string | null};
  const t = tableAtCell(sheet, cell);
  if (!t) return null;
  const r = t.data ? {start: t.range.start, end: t.data.end} : t.range;
  const text = rangeA1(r);
  return {af: {range: text}, range: text};
}

type Kind = 'text' | 'number' | 'date';
/** Excel offers Text Filters, Number Filters or Date Filters by what the column holds. */
function kindOf(content: any, si: number, af: any, col: number): Kind {
  const r = parseRange(af.range) as any;
  const engine = engineFor(content);
  let nums = 0, other = 0, dates = 0;
  for (let row = r.start.row + 1; row <= Math.min(r.end.row, r.start.row + 200); row++) {
    const v = engine.sheetValue(si, row, col);
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'number') { nums++; if (parseFormat(styleAt(content, content.sheets[si], row, col).numFmt).isDate()) dates++; } else other++;
  }
  return nums > other && dates >= nums / 2 && dates > 0 ? 'date' : nums > other ? 'number' : 'text';
}

const PRESETS: Record<Kind, {label: string; op1?: string; op2?: string; direct?: 'above' | 'below'; top10?: true}[]> = {
  number: [{label: 'Equals…', op1: '='}, {label: 'Does Not Equal…', op1: '<>'}, {label: 'Greater Than…', op1: '>'}, {label: 'Greater Than Or Equal To…', op1: '>='},
    {label: 'Less Than…', op1: '<'}, {label: 'Less Than Or Equal To…', op1: '<='}, {label: 'Between…', op1: '>=', op2: '<='}, {label: 'Top 10…', top10: true},
    {label: 'Above Average', direct: 'above'}, {label: 'Below Average', direct: 'below'}, {label: 'Custom Filter…'}],
  text: [{label: 'Equals…', op1: '='}, {label: 'Does Not Equal…', op1: '<>'}, {label: 'Begins With…', op1: 'beginsWith'}, {label: 'Ends With…', op1: 'endsWith'},
    {label: 'Contains…', op1: 'contains'}, {label: 'Does Not Contain…', op1: 'notContains'}, {label: 'Custom Filter…'}],
  date: [{label: 'Equals…', op1: '='}, {label: 'Before…', op1: '<'}, {label: 'After…', op1: '>'}, {label: 'Between…', op1: '>=', op2: '<='}, {label: 'Custom Filter…'}],
};

export function FilterMenu({view}: {view: GridView}) {
  const cell = view.filterMenu;
  const g = view.geo;
  const content = view.content(), si = view.sheetIndex(), sheet = content.sheets[si];
  const info = cell ? filterOf(sheet, cell) : null;
  const [search, setSearch] = useState('');
  const [sub, setSub] = useState(false);
  const [off, setOff] = useState<Set<string> | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const items = useMemo(() => (cell && info ? filterValues(content, si, cell.col, info.af) as {text: string; on: boolean}[] : []), [content, si, cell?.col, info?.af?.range]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setSearch(''); setSub(false); setOff(new Set(items.filter(i => !i.on).map(i => i.text))); searchBox.current?.focus({preventScroll: true}); }, [cell?.row, cell?.col]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!cell || !g || !info) return null;
  const col = colToLetters(cell.col);
  const range = parseRange(info.af.range) as any;
  const offset = cell.col - range.start.col;
  const crit = info.af.criteria?.[offset];
  const kind = kindOf(content, si, info.af, cell.col);
  const title = String(engineFor(content).sheetValue(si, cell.row, cell.col) ?? '') || `Column ${col}`;
  const needle = search.trim().toLowerCase();
  const shown = items.filter(i => !needle || i.text.toLowerCase().includes(needle));
  const checked = (t: string) => !(off ?? new Set()).has(t);
  const allShown = shown.length > 0 && shown.every(i => checked(i.text));
  const close = () => { view.filterMenu = null; view.changed(); };
  const run = async (id: string, params: Record<string, unknown>) => { close(); if (view.has(id)) await view.run(id, id === 'data.filterBy' && info.range ? {...params, range: info.range} : params); };
  const toggleAll = (on: boolean) => { const n = new Set(off ?? []); for (const i of shown) { if (on) n.delete(i.text); else n.add(i.text); } setOff(n); };
  const toggle = (t: string) => { const n = new Set(off ?? []); if (n.has(t)) n.delete(t); else n.add(t); setOff(n); };
  const apply = async () => {
    const on = items.filter(i => checked(i.text) && (!needle || i.text.toLowerCase().includes(needle)));
    if (!on.length) return;
    // Everything checked is no filter at all.
    if (on.length === items.length) { await run('data.filterBy', {column: col, clear: true}); return; }
    await run('data.filterBy', {column: col, values: on.filter(i => i.text !== '(Blanks)').map(i => i.text), blanks: on.some(i => i.text === '(Blanks)')});
  };
  const preset = (p: (typeof PRESETS)[Kind][number]) => {
    if (p.direct) { void run('data.filterBy', {column: col, aboveAverage: p.direct === 'above'}); return; }
    close();
    if (p.top10) { view.openDialog('dialog.top10AutoFilter', {column: col}); return; }
    view.openDialog('dialog.customAutoFilter', {column: col, title, kind, op1: p.op1 ?? '=', op2: p.op2 ?? '', join: 'and'});
  };
  // Placed under the button, its right edge on the cell's, kept inside the sheet.
  const r = g.cellRect(cell);
  const W = 252;
  const host = {w: g.rect.w, h: g.rect.h};
  const left = clamp(r.x + r.w - W, g.cells.x, host.w - W - 16), top = clamp(r.y + r.h, g.cells.y, host.h - 330);
  const presets = PRESETS[kind];
  const heading = kind === 'date' ? 'Date Filters' : kind === 'number' ? 'Number Filters' : 'Text Filters';
  return <div ref={box} className="grid-popup grid-filter-menu" role="dialog" aria-label={`Filter ${title}`} style={{left, top, width: W}}
    onPointerDown={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } else if (e.key === 'Enter' && !(e.target as HTMLElement).closest('button')) { e.preventDefault(); void apply(); } }}>
    <button type="button" className="grid-menu-item" disabled={!view.has('data.sortAscending')} onClick={() => void run('data.sortAscending', {column: col, header: true, range: info.af.range})}><span className="grid-menu-icon">{'A↓'}</span>Sort A to Z</button>
    <button type="button" className="grid-menu-item" disabled={!view.has('data.sortDescending')} onClick={() => void run('data.sortDescending', {column: col, header: true, range: info.af.range})}><span className="grid-menu-icon">{'Z↓'}</span>Sort Z to A</button>
    <hr/>
    <button type="button" className="grid-menu-item" disabled={!crit} onClick={() => void run('data.filterBy', {column: col, clear: true})}><span className="grid-menu-icon">{'✕'}</span>Clear Filter From &ldquo;{title}&rdquo;</button>
    <div className="grid-menu-sub" onMouseEnter={() => setSub(true)} onMouseLeave={() => setSub(false)}>
      <button type="button" className="grid-menu-item" aria-haspopup="menu" aria-expanded={sub} onClick={() => setSub(s => !s)}><span className="grid-menu-icon"/>{heading}<span className="grid-menu-arrow">{'▸'}</span></button>
      {sub ? <div className="grid-popup grid-submenu" role="menu" style={{left: W - 8, top: 0}}>
        {presets.map(p => <button key={p.label} type="button" role="menuitem" className="grid-menu-item" onClick={() => preset(p)}>{p.label}</button>)}
      </div> : null}
    </div>
    <hr/>
    <input ref={searchBox} className="grid-menu-search" type="search" placeholder="Search" aria-label="Search" value={search} onChange={e => setSearch(e.target.value)}/>
    <div className="grid-menu-list" role="group" aria-label="Values">
      <label className="grid-menu-check"><input type="checkbox" checked={allShown} onChange={e => toggleAll(e.target.checked)}/><span>{needle ? '(Select All Search Results)' : '(Select All)'}</span></label>
      {shown.map(i => <label key={i.text} className="grid-menu-check"><input type="checkbox" checked={checked(i.text)} onChange={() => toggle(i.text)}/><span>{i.text}</span></label>)}
    </div>
    <div className="grid-menu-buttons">
      <button type="button" className="is-primary" disabled={!shown.some(i => checked(i.text))} onClick={() => void apply()}>OK</button>
      <button type="button" onClick={close}>Cancel</button>
    </div>
  </div>;
}

/** The drop-down list of a data validation: at most eight rows, above the cell when there is no room below. */
export function ListPicker({view}: {view: GridView}) {
  const c = view.listPicker;
  const g = view.geo;
  const content = view.content(), si = view.sheetIndex();
  const rule = c ? validationAt(content.sheets[si], c) : null;
  const items = useMemo(() => (c && rule ? (listItems(content, si, rule) as string[]) : []), [content, si, c?.row, c?.col]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = c ? engineFor(content).sheetValue(si, c.row, c.col) : null;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus({preventScroll: true}); }, [c?.row, c?.col]);
  if (!c || !g || !rule) return null;
  const r = g.cellRect(c);
  const rowH = 20, shown = Math.min(Math.max(items.length, 1), 8);
  const height = shown * rowH + 6;
  const above = r.y + r.h + height > g.rect.h && r.y - height >= g.cells.y;
  const close = () => { view.listPicker = null; view.changed(); };
  const pick = async (t: string) => { close(); await view.run('cell.set', {cell: view.cellAddress(c), input: t}); };
  const index = items.findIndex(t => String(current ?? '').toLowerCase() === t.toLowerCase());
  return <div ref={ref} tabIndex={-1} className="grid-popup grid-list-picker" role="listbox" aria-label="Choose a value" style={{left: r.x, top: above ? r.y - height : r.y + r.h, minWidth: Math.max(r.w, 100), maxHeight: height}}
    onPointerDown={e => e.stopPropagation()}
    onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const opts = [...(ref.current?.querySelectorAll<HTMLElement>('[role=option]') ?? [])];
        const at = opts.indexOf(document.activeElement as HTMLElement);
        opts[Math.min(Math.max(at + (e.key === 'ArrowDown' ? 1 : -1), 0), opts.length - 1)]?.focus();
      }
    }}>
    {items.length ? items.map((t, i) => <button key={i} type="button" role="option" aria-selected={i === index} className={`grid-menu-item${i === index ? ' is-on' : ''}`} onClick={() => void pick(t)}>{t}</button>)
      : <div className="grid-menu-empty">No items</div>}
  </div>;
}

/** A validation's Input Message, beside the active cell while it is selected. */
export function InputMessage({view}: {view: GridView}) {
  const g = view.geo;
  if (!g || view.editor || view.filterMenu || view.listPicker) return null;
  let sel;
  try { sel = view.sel(); } catch { return null; }
  const sheet = view.sheet();
  const rule = validationAt(sheet, sel.active);
  if (!rule || rule.showInputMessage === false || !(rule.prompt || rule.promptTitle)) return null;
  if (g.hiddenUnderFrozen(sel.active)) return null;
  const r = g.cellRect(sel.active);
  const x = r.x + Math.min(r.w, 40), y = r.y + r.h + 4;
  if (x > g.rect.w || y > g.rect.h) return null;
  return <div className="grid-input-message" role="status" style={{left: x, top: y}}>
    {rule.promptTitle ? <strong>{rule.promptTitle}</strong> : null}
    {rule.prompt ? <span>{rule.prompt}</span> : null}
  </div>;
}

void cellAt; void criteriaOf;
