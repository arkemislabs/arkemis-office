// Recipient List view (Mailings › Select Recipients › Type a New List… and Edit Recipient List): the
// editable table of the fields and records (a field name over each column, × to remove a field or a
// record, New Entry, Add Field), Find in list and Show only records that will be merged, Use an
// Existing List…, and Filter and Sort (conditions joined by And / Or, up to three sort keys), with how
// many recipients will be merged. Over core/quill/dialogs/recipientList.mjs; OK loads the list and
// applies the filter and sort.
//
// Layout from wordcraft crates/ui-egui/src/dialogs/mailings.rs (`recipient_list`, `recipient_filter`)
// at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Long lists draw only the rows in view.

import {useRef, useState} from 'react';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {FILTER_OPS, opHasValue} from '../../../../core/quill/lib/mailings-merge.mjs';
import {mergeOrder, visibleRecipients} from '../../../../core/quill/dialogs/recipientList.mjs';
import './recipientList.css';

type Rule = {field: string; op: string; value: string; or: boolean};
type Sort = {field: string; descending: boolean};
const ROW = 26;
const VIEW_ROWS = 9;

function Check({label, checked, disabled, onChange, id}: {label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; id: string}) {
  return <div className="sf sf-check" data-field-id={id} data-kind="checkbox">
    <label className={disabled ? 'is-disabled' : undefined}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)}/>
      <span className="sf-check-box" aria-hidden="true"/>
      <span>{label}</span>
    </label>
  </div>;
}

function Body({dialog: d, setValue: set}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const {controller} = useEngine();
  const v = d.values as {fields: string[]; rows: string[][]; rules: Rule[]; sort: Sort[]; filterOpen: boolean; find: string; onlyMerged: boolean};
  const fields = v.fields ?? [], rows = v.rows ?? [], rules = v.rules ?? [], sort = v.sort ?? [];
  const [top, setTop] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const order = mergeOrder(v);
  const onlyMerged = !!order && v.onlyMerged;
  const visible: number[] = visibleRecipients(rows, order, v.find ?? '', onlyMerged);
  const first = Math.max(0, Math.floor(top / ROW) - 2);
  const shown = visible.slice(first, first + VIEW_ROWS + 6);
  const names = fields.map(f => f.trim()).filter(Boolean);
  const merged = order ? order.filter((x: number | null) => x !== null).length : rows.length;

  const setCell = (r: number, c: number, text: string) => set('rows', rows.map((row, i) => (i === r ? row.map((x, j) => (j === c ? text : x)) : row)));
  const setField = (c: number, text: string) => set('fields', fields.map((f, j) => (j === c ? text : f)));
  const removeField = (c: number) => { if (fields.length > 1) { set('fields', fields.filter((_, j) => j !== c)); set('rows', rows.map(r => r.filter((_, j) => j !== c))); } };
  const removeRow = (r: number) => set('rows', rows.filter((_, i) => i !== r));
  const addField = () => { set('fields', [...fields, '']); set('rows', rows.map(r => [...r, ''])); };
  const newEntry = () => { set('find', ''); set('onlyMerged', false); set('rows', [...rows, fields.map(() => '')]); setTimeout(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, 0); };
  const setRule = (i: number, patch: Partial<Rule>) => set('rules', rules.map((r, j) => (j === i ? {...r, ...patch} : r)));
  const setSort = (i: number, patch: Partial<Sort>) => set('sort', sort.map((k, j) => (j === i ? {...k, ...patch} : k)));
  const useExisting = async () => {
    try {
      const r = await controller.run('ui.openRecipientList', null, {origin: 'ui'}) as {result?: {fields?: unknown[]}} | null;
      // The list it loaded replaces this one: this dialog is done.
      if (r && (r as any).result?.fields) controller.cancelDialog(d.key);
    } catch (e) { controller.notify(toCommandError(e).message, 'error'); }
  };
  const fieldSelect = (value: string, onChange: (x: string) => void, none: boolean, label: string, id: string) => <select className="rl-select" aria-label={label} data-field-id={id} value={value} onChange={e => onChange(e.target.value)}>
    {none ? <option value="">(none)</option> : null}
    {names.map(n => <option key={n} value={n}>{n}</option>)}
  </select>;
  const width = 34 + fields.length * 130 + 30;

  return <div className="gd-fields rl" data-dialog-page="Recipient List">
    <p className="sf sf-static">Type the recipients, or load them from a file.</p>
    <div className="rl-bar">
      <button type="button" className="sf-button" data-field-id="useExisting" onClick={useExisting}>Use an Existing List…</button>
    </div>
    <Check id="onlyMerged" label="Show only records that will be merged" checked={onlyMerged} disabled={!order} onChange={x => set('onlyMerged', x)}/>
    <div className="rl-bar">
      <label className="sf-label" htmlFor="rl-find">Find in list:</label>
      <input id="rl-find" className="sf-text rl-find" data-field-id="find" placeholder="Any field" value={v.find ?? ''} onChange={e => set('find', e.target.value)}/>
      {(v.find ?? '').trim() ? <span className="rl-weak">Matches: {visible.length}</span> : null}
    </div>
    <div className="rl-table" data-field-id="grid" role="grid" aria-label="Recipients">
      <div className="rl-scroll-x">
        <div style={{minWidth: width}}>
          <div className="rl-row rl-head" role="row">
            <span className="rl-num"/>
            {fields.map((f, c) => <span className="rl-cell" key={c}>
              <input className="sf-text" aria-label={`Field name ${c + 1}`} placeholder="Field name" value={f} onChange={e => setField(c, e.target.value)}/>
              <button type="button" className="rl-x" title="Remove field" aria-label={`Remove field ${c + 1}`} disabled={fields.length < 2} onClick={() => removeField(c)}>×</button>
            </span>)}
            <span className="rl-x-gap"/>
          </div>
          <div ref={scroller} className="rl-body" style={{maxHeight: ROW * VIEW_ROWS}} onScroll={e => setTop((e.target as HTMLDivElement).scrollTop)}>
            <div style={{height: visible.length * ROW, position: 'relative'}}>
              {shown.map((r, k) => {
                const row = rows[r] ?? [];
                const place = order ? order[r] : r + 1;
                return <div className={`rl-row${(first + k) % 2 ? ' is-odd' : ''}`} role="row" key={r} data-record={r + 1} style={{position: 'absolute', top: (first + k) * ROW, left: 0, right: 0}}>
                  <span className={`rl-num${place === null ? ' is-out' : ''}`}>{place === null ? '–' : place}</span>
                  {fields.map((_, c) => <span className="rl-cell" key={c}>
                    <input className="sf-text" aria-label={`${fields[c]}, record ${r + 1}`} value={row[c] ?? ''} onChange={e => setCell(r, c, e.target.value)}/>
                    <span className="rl-x-gap"/>
                  </span>)}
                  <button type="button" className="rl-x" title="Remove recipient" aria-label={`Remove recipient ${r + 1}`} onClick={() => removeRow(r)}>×</button>
                </div>;
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
    <div className="rl-bar">
      <button type="button" className="sf-button" data-field-id="newEntry" onClick={newEntry}>New Entry</button>
      <button type="button" className="sf-button" data-field-id="addField" onClick={addField}>Add Field</button>
      <button type="button" className={`sf-button${v.filterOpen ? ' is-on' : ''}`} data-field-id="filterSort" aria-pressed={!!v.filterOpen} onClick={() => set('filterOpen', !v.filterOpen)}>Filter and Sort</button>
    </div>
    {v.filterOpen ? <fieldset className="gd-section rl-filter" data-field-id="filter">
      <legend>Filter and Sort</legend>
      <div className="rl-rules">
        <div className="rl-rule"><span/><span className="rl-weak">Field</span><span className="rl-weak">Comparison</span><span className="rl-weak">Compare to</span><span/></div>
        {rules.map((r, i) => <div className="rl-rule" key={i} data-rule={i}>
          {i === 0 ? <span/> : <select className="rl-select" aria-label="And or Or" value={r.or ? 'or' : 'and'} onChange={e => setRule(i, {or: e.target.value === 'or'})}>
            <option value="and">And</option><option value="or">Or</option></select>}
          {fieldSelect(r.field, x => setRule(i, {field: x}), false, 'Field', `rule${i}-field`)}
          <select className="rl-select" aria-label="Comparison" value={r.op} onChange={e => setRule(i, {op: e.target.value})}>
            {FILTER_OPS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
          <input className="sf-text" aria-label="Compare to" disabled={!opHasValue(r.op)} value={r.value ?? ''} onChange={e => setRule(i, {value: e.target.value})}/>
          <button type="button" className="rl-x" title="Remove condition" aria-label="Remove condition" onClick={() => set('rules', rules.filter((_, j) => j !== i))}>×</button>
        </div>)}
      </div>
      <div className="rl-bar">
        <button type="button" className="sf-button" data-field-id="addCondition" onClick={() => { if (rules.length < 64) set('rules', [...rules, {field: names[0] ?? '', op: 'equal', value: '', or: false}]); }}>Add Condition</button>
        <button type="button" className="sf-button" data-field-id="clearAll" onClick={() => { set('rules', []); set('sort', sort.map(() => ({field: '', descending: false}))); }}>Clear All</button>
      </div>
      <div className="rl-sorts">
        {sort.map((k, i) => <div className="rl-sort" key={i} data-sort={i}>
          <span>{i === 0 ? 'Sort by' : 'Then by'}</span>
          {fieldSelect(k.field, x => setSort(i, {field: x}), true, i === 0 ? 'Sort by' : 'Then by', `sort${i}-field`)}
          <select className="rl-select" aria-label="Sort order" disabled={!k.field} value={k.descending ? 'desc' : 'asc'} onChange={e => setSort(i, {descending: e.target.value === 'desc'})}>
            <option value="asc">Ascending</option><option value="desc">Descending</option></select>
        </div>)}
      </div>
    </fieldset> : null}
    {order ? <p className="rl-weak" data-field-id="summary">{merged} of {rows.length} recipients will be merged.</p> : null}
  </div>;
}

export default {Body};
