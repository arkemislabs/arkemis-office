// Name Manager as Excel draws it: New… / Edit… / Delete over the list and Filter on the right;
// the list's columns Name, Value, Refers To, Scope, Comment; "Refers to:" under it for the
// selected name (changing it and pressing the check mark redefines the name); Close.
// Translated from gridcraft crates/ui-egui/src/dialogs/names.rs (`name_manager`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useState} from 'react';
import {Glyph} from '../../../shell/icons/Icon';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {nameManagerList} from '../../../../core/grid/commands/formulas.mjs';
import {filterNames} from '../../../../core/grid/dialogs/nameManager.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import './insertFunction.css';

type Row = {name: string; refersTo: string; scope: string; value: unknown; comment: string};
const FILTERS = ['Clear Filter', 'Names Scoped to Worksheet', 'Names Scoped to Workbook', 'Names with Errors', 'Names without Errors', 'Defined Names', 'Table Names'];

function valueText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return `{${v.map(r => (Array.isArray(r) ? r.map(x => valueText(x)).join(',') : valueText(r))).join(';')}}`;
  if (typeof v === 'object') return String((v as {error?: string}).error ?? '');
  if (typeof v === 'string') return `"${v}"`;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

/** Column widths in pixels (the last column takes what is left); the grips in the header drag them, as Excel's list does. */
const START_WIDTHS = [130, 120, 190, 90];
const HEADS = ['Name', 'Value', 'Refers To', 'Scope', 'Comment'];

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const {controller} = useEngine();
  useSessionTick();
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const ctx = controller.session.readContext(controller.docId) as {doc: any};
  const all = nameManagerList(ctx.doc) as Row[];
  const tables = (ctx.doc.sheets ?? []).flatMap((s: any) => (s.tables ?? []).map((t: any) => String(t.name)));
  const filter = String(d.values.filter ?? 'Clear Filter');
  const rows = filterNames(all, filter, tables) as Row[];
  const key = (r: Row) => `${r.name}|${r.scope}`;
  const selected = rows.find(r => key(r) === d.values.selected) ?? null;
  const [refers, setRefers] = useState<{key: string; text: string} | null>(null);
  const [confirm, setConfirm] = useState<Row | null>(null);
  const [widths, setWidths] = useState(START_WIDTHS);
  const cols = `${widths.map(w => `${w}px`).join(' ')} minmax(60px, 1fr)`;
  const grip = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = widths[i];
    const move = (m: PointerEvent) => setWidths(ws => ws.map((w, k) => (k === i ? Math.max(40, Math.min(420, w0 + m.clientX - x0)) : w)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const refersText = refers && selected && refers.key === key(selected) ? refers.text : selected?.refersTo ?? '';
  const edit = (r: Row | null) => {
    try {
      controller.openDialog('dialog.defineName', {parent: d.key, init: r
        ? {name: r.name, scope: r.scope, comment: r.comment, refersTo: r.refersTo, oldName: r.name, oldScope: r.scope}
        : {}});
    } catch (e) { fail(e); }
  };
  const commitRefers = () => {
    if (!selected) return;
    void controller.run('formulas.defineName', {name: selected.name, scope: selected.scope, comment: selected.comment, refersTo: refersText, oldName: selected.name, oldScope: selected.scope}, {origin: 'dialog'})
      .then(() => setRefers(null)).catch(fail);
  };
  const remove = (r: Row) => {
    setConfirm(null);
    void controller.run('formulas.deleteName', {name: r.name, scope: r.scope}, {origin: 'dialog'}).catch(fail);
  };
  return <div className="gd-fields grid-nm">
    <div className="grid-nm-bar">
      <button type="button" className="gd-button" data-field-id="new" onClick={() => edit(null)}>New…</button>
      <button type="button" className="gd-button" data-field-id="edit" disabled={!selected} onClick={() => edit(selected)}>Edit…</button>
      <button type="button" className="gd-button" data-field-id="delete" disabled={!selected} onClick={() => selected && setConfirm(selected)}>Delete</button>
      <span className="grid-nm-spacer"/>
      <span className="sf-select" data-field-id="filter">
        <select aria-label="Filter" value={filter} onChange={e => setValue('filter', e.target.value)}>
          {FILTERS.map(f => <option key={f} value={f}>{f === 'Clear Filter' ? 'Filter' : f}</option>)}
        </select>
        <Glyph name="chevron-down" size={10}/>
      </span>
    </div>
    {confirm ? <div className="grid-nm-confirm" role="alertdialog">
      <span>Are you sure you want to delete the name {confirm.name}?</span>
      <button type="button" className="gd-button gd-primary" onClick={() => remove(confirm)}>OK</button>
      <button type="button" className="gd-button" onClick={() => setConfirm(null)}>Cancel</button>
    </div> : null}
    <div className="grid-nm-table" role="grid" data-field-id="names" aria-label="Names" style={{'--nm-cols': cols} as React.CSSProperties}>
      <div className="grid-nm-row is-head" role="row">
        {HEADS.map((h, i) => <span key={h} role="columnheader">{h}{i < widths.length ? <i className="grid-nm-grip" aria-hidden onPointerDown={grip(i)}/> : null}</span>)}
      </div>
      <div className="grid-nm-body">
        {rows.length ? rows.map(r => <div key={key(r)} role="row" aria-selected={key(r) === d.values.selected}
          className={`grid-nm-row${key(r) === d.values.selected ? ' is-selected' : ''}`}
          onClick={() => setValue('selected', key(r))} onDoubleClick={() => edit(r)}>
          <span title={r.name}>{r.name}</span><span title={valueText(r.value)}>{valueText(r.value)}</span>
          <span title={r.refersTo}>{r.refersTo}</span><span>{r.scope}</span><span title={r.comment}>{r.comment}</span>
        </div>) : <div className="sf-list-empty">{all.length ? 'No names match the filter' : 'No names defined'}</div>}
      </div>
    </div>
    <div className="sf grid-nm-refers" data-field-id="refersTo" data-kind="text">
      <label className="sf-label" htmlFor="grid-nm-refers">Refers to:</label>
      <div className="sf-control grid-nm-refers-row">
        <input id="grid-nm-refers" className="sf-text" type="text" spellCheck={false} disabled={!selected} value={refersText}
          onChange={e => selected && setRefers({key: key(selected), text: e.target.value})}
          onKeyDown={e => { if (e.key === 'Enter' && refers) { e.preventDefault(); e.stopPropagation(); commitRefers(); } }}/>
        <button type="button" className="gd-button grid-nm-mark" aria-label="Cancel" title="Cancel (Esc)" disabled={!refers} onClick={() => setRefers(null)}><Glyph name="close" size={11}/><span>Cancel</span></button>
        <button type="button" className="gd-button grid-nm-mark" aria-label="Enter" title="Enter" disabled={!refers || !selected} onClick={commitRefers}><Glyph name="check" size={12}/><span>Enter</span></button>
      </div>
    </div>
  </div>;
}

export default {Body};
