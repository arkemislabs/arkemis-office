// Field Properties' body: the tabs General, Appearance, Position, Options, Format, Validate,
// Calculate and Actions by field kind; Shared Field Properties when several fields are selected.
//
// Translated from printcraft crates/ui-egui/src/tools/prepare/properties.rs (body: the tabs, the
// Options tab per kind, a locked field greys its tabs, Locked at the foot), prepare/tabs.rs
// (format_tab, validate_tab, actions_tab, calculate_tab) and tools/bulk_fields.rs at
// 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see assets/third-party-licenses/artcraft-reference.txt).
// The model is core/folio/dialogs/field-properties.mjs; OK runs form.field.properties.

import {useState} from 'react';
import type {DialogOverride} from '../../../shell/dialogs/DialogHost';
import {FLAG} from '../../../../core/folio/lib/form-read.mjs';
import {formatValue, DATE_PRESETS, TIME_PRESETS, CALC_OPS} from '../../../../core/folio/lib/form-af.mjs';
import {ACTION_KINDS, ACTION_TRIGGERS, THICKNESS, BORDER_STYLES, FONTS, SEPARATORS, NEGATIVES, SPECIALS, CURRENCIES, CHECK_STYLE_NAMES, actionOf, describeAction, editableAction, rgbOfHex, hex} from '../../../../core/folio/lib/form-dialog.mjs';
import {SWATCHES} from '../../../../core/folio/model/types.mjs';
import './field-properties.css';

type Any = any;
type Set = (field: string, value: unknown) => void;

const Row = ({label, children, wide}: {label?: string; children: Any; wide?: boolean}) => <div className={`sf ffp-row${wide ? ' is-wide' : ''}`}>{label ? <span className="sf-label">{label}</span> : null}<div className="sf-control">{children}</div></div>;
const Text = ({id, label, value, set, area, rows}: {id: string; label?: string; value: string; set: (v: string) => void; area?: boolean; rows?: number}) => <div className="sf ffp-row">
  {label ? <label className="sf-label" htmlFor={`ffp-${id}`}>{label}</label> : null}
  <div className="sf-control">{area ? <textarea id={`ffp-${id}`} className="sf-textarea ffp-area" rows={rows ?? 3} value={value} onChange={e => set(e.target.value)} spellCheck={false}/>
    : <input id={`ffp-${id}`} className="sf-text" value={value} onChange={e => set(e.target.value)} data-field-id={id}/>}</div></div>;
const Num = ({id, label, value, set, min, max, step, unit}: {id: string; label: string; value: number; set: (v: number) => void; min?: number; max?: number; step?: number; unit?: string}) => <div className="sf ffp-row">
  <label className="sf-label" htmlFor={`ffp-${id}`}>{label}</label>
  <div className="sf-control"><input id={`ffp-${id}`} className="sf-text ffp-num" type="number" value={Number.isFinite(value) ? value : ''} min={min} max={max} step={step ?? 1} data-field-id={id}
    onChange={e => { const n = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(n)) set(n); }}/>{unit ? <span className="ffp-unit">{unit}</span> : null}</div></div>;
const Select = ({id, label, value, options, set}: {id: string; label?: string; value: string | number; options: readonly (string | [string | number, string])[]; set: (v: string) => void}) => <div className="sf ffp-row">
  {label ? <label className="sf-label" htmlFor={`ffp-${id}`}>{label}</label> : null}
  <div className="sf-control"><span className="sf-select"><select id={`ffp-${id}`} value={String(value)} onChange={e => set(e.target.value)} data-field-id={id}>
    {options.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return <option key={String(v)} value={String(v)}>{l === '' ? '(none)' : l}</option>; })}</select></span></div></div>;
const Check = ({id, label, checked, set, disabled}: {id?: string; label: string; checked: boolean; set: (v: boolean) => void; disabled?: boolean}) => <div className="sf sf-check" data-field-id={id}>
  <label className={disabled ? 'is-disabled' : undefined}><input type="checkbox" checked={checked} disabled={disabled} onChange={e => set(e.target.checked)}/><span className="sf-check-box" aria-hidden="true"/><span>{label}</span></label></div>;
const Radio = ({name, label, checked, set}: {name: string; label: string; checked: boolean; set: () => void}) => <label className="ffp-radio"><input type="radio" name={name} checked={checked} onChange={set}/><span className="sf-radio-dot" aria-hidden="true"/><span>{label}</span></label>;
const Button = ({children, onClick, disabled, primary}: {children: Any; onClick: () => void; disabled?: boolean; primary?: boolean}) => <button type="button" className={`gd-button ffp-btn${primary ? ' gd-primary' : ''}`} disabled={disabled} onClick={onClick}>{children}</button>;

/** Colour swatches (comments.rs swatch_grid) with an optional No color box. */
function Colour({id, label, value, set, none}: {id: string; label: string; value: number[] | null; set: (v: number[] | null) => void; none?: boolean}) {
  const h = hex(value);
  return <div className="sf ffp-row is-wide" data-field-id={id}>
    <span className="sf-label">{label}</span>
    <div className="sf-control ffp-colour">
      {none ? <Check label="No color" checked={value === null} set={on => set(on ? null : [0, 0, 0])}/> : null}
      <div className="ffp-swatches" role="listbox" aria-label={label}>
        {[['White', [1, 1, 1]], ...SWATCHES].map(([name, c]: Any) => {
          const sel = h === hex(c);
          return <button key={name} type="button" role="option" aria-selected={sel} aria-label={name} data-tip={name} className={`ffp-swatch${sel ? ' is-selected' : ''}`} style={{background: hex(c) ?? undefined}} onClick={() => set(c)}/>;
        })}
      </div>
    </div>
  </div>;
}

const flagOn = (v: Any, bit: number, inverted = false) => ((v.flags & bit) !== 0) !== inverted;
const withFlag = (v: Any, set: Set, bit: number, on: boolean, inverted = false) => set('flags', (on !== inverted) ? v.flags | bit : v.flags & ~bit);

function General({v, set}: {v: Any; set: Set}) {
  return <>
    <Text id="name" label="Name:" value={v.name} set={x => set('name', x)}/>
    <Text id="tooltip" label="Tooltip:" value={v.tooltip} set={x => set('tooltip', x)}/>
    <h4 className="ffp-title">Common Properties</h4>
    <Check id="read-only" label="Read Only" checked={flagOn(v, FLAG.READ_ONLY)} set={on => withFlag(v, set, FLAG.READ_ONLY, on)}/>
    <Check id="required" label="Required" checked={flagOn(v, FLAG.REQUIRED)} set={on => withFlag(v, set, FLAG.REQUIRED, on)}/>
  </>;
}

function Appearance({v, set}: {v: Any; set: Set}) {
  const l = v.look;
  const put = (patch: Any) => set('look', {...l, ...patch});
  const thick = l.width <= 1 ? 'Thin' : l.width <= 2 ? 'Medium' : 'Thick';
  return <>
    <div className="ffp-grid">
      <div className="sf ffp-row"><span className="sf-label">Font Size:</span><div className="sf-control">
        <Check label="Auto" checked={v.fontSize === 0} set={on => set('fontSize', on ? 0 : 12)}/>
        <input className="sf-text ffp-num" type="number" min={2} max={100} step={0.5} disabled={v.fontSize === 0} value={v.fontSize || ''} onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n) && n >= 0) set('fontSize', n); }} aria-label="Font size in points"/><span className="ffp-unit">pt</span></div></div>
      <Select id="font" label="Font:" value={l.font} options={FONTS} set={x => put({font: x})}/>
    </div>
    <Colour id="text-color" label="Text Color:" value={l.text} set={c => put({text: c ?? [0, 0, 0]})}/>
    <h4 className="ffp-title">Borders and Colors</h4>
    <Colour id="border-color" label="Border Color:" value={l.border} set={c => put({border: c})} none/>
    <Colour id="fill-color" label="Fill Color:" value={l.fill} set={c => put({fill: c})} none/>
    <div className="ffp-grid">
      <Select id="thickness" label="Line Thickness:" value={thick} options={THICKNESS.map(([n]: Any) => n)} set={x => put({width: THICKNESS.find(([n]: Any) => n === x)?.[1] ?? 1})}/>
      <Select id="line-style" label="Line Style:" value={l.style} options={BORDER_STYLES} set={x => put({style: x})}/>
    </div>
  </>;
}

function Position({v, set}: {v: Any; set: Set}) {
  const [x, y, w, h] = v.position;
  const put = (i: number, n: number) => { const p = [...v.position]; p[i] = n; set('position', p); };
  const rotate = (r: number) => {
    const before = v.rotation;
    set('rotation', r);
    // The same centre when the field turns between horizontal and vertical (properties.rs).
    if ((before % 180 === 0) !== (r % 180 === 0)) { const cx = x + w / 2, cy = y + h / 2; set('position', [cx - h / 2, cy - w / 2, h, w].map(n => Math.round(n * 100) / 100)); }
  };
  return <>
    <div className="ffp-grid">
      <Num id="left" label="Left:" value={x} set={n => put(0, n)} step={0.5} unit="pt"/>
      <Num id="bottom" label="Bottom:" value={y} set={n => put(1, n)} step={0.5} unit="pt"/>
      <Num id="width" label="Width:" value={w} set={n => put(2, n)} min={4} step={0.5} unit="pt"/>
      <Num id="height" label="Height:" value={h} set={n => put(3, n)} min={4} step={0.5} unit="pt"/>
    </div>
    <small className="sf-note">Points from the page&apos;s bottom-left corner.</small>
    <Select id="rotation" label="Rotation:" value={v.rotation} options={[0, 90, 180, 270].map(r => [r, `${r}°`] as [number, string])} set={r => rotate(Number(r))}/>
  </>;
}

function Options({v, set}: {v: Any; set: Set}) {
  const align = <Select id="alignment" label="Alignment:" value={v.quadding} options={[[0, 'Left'], [1, 'Center'], [2, 'Right']]} set={x => set('quadding', Number(x))}/>;
  const box = (bit: number, label: string, inverted = false) => <Check label={label} checked={flagOn(v, bit, inverted)} set={on => withFlag(v, set, bit, on, inverted)}/>;
  if (v.kind === 'pushbutton') return <Text id="label" label="Label" value={v.caption} set={x => set('caption', x)}/>;
  if (v.kind === 'text') {
    const comb = flagOn(v, FLAG.COMB);
    return <>
      <div className="ffp-grid">{align}<Text id="default" label="Default Value:" value={v.defaultValue} set={x => set('defaultValue', x)}/></div>
      <Check label="Multi-line" checked={flagOn(v, FLAG.MULTILINE)} set={on => withFlag(v, set, FLAG.MULTILINE, on)}/>
      {box(FLAG.DO_NOT_SCROLL, 'Scroll long text', true)}
      {box(FLAG.RICH_TEXT, 'Allow Rich Text Formatting')}
      <div className="ffp-inline"><Check id="limit" label="Limit of" checked={v.limit} set={on => set('limit', on)} disabled={comb}/>
        <input className="sf-text ffp-num" type="number" min={0} max={10000} disabled={!v.limit || comb} value={v.maxLen} onChange={e => set('maxLen', Math.max(0, Number(e.target.value) || 0))} aria-label="Character limit"/><span className="ffp-unit">characters</span></div>
      {box(FLAG.PASSWORD, 'Password')}
      {box(FLAG.FILE_SELECT, 'Field is used for file selection')}
      {box(FLAG.DO_NOT_SPELL_CHECK, 'Check spelling', true)}
      <div className="ffp-inline"><Check id="comb" label="Comb of" checked={comb} set={on => {
        const flags = on ? (v.flags | FLAG.COMB) & ~(FLAG.MULTILINE | FLAG.PASSWORD | FLAG.FILE_SELECT) : v.flags & ~FLAG.COMB;
        set('flags', flags);
        if (on) { set('limit', true); if (!v.maxLen) set('maxLen', 10); }
      }}/>
        <input className="sf-text ffp-num" type="number" min={1} max={500} disabled={!comb} value={v.maxLen || ''} onChange={e => set('maxLen', Math.max(1, Number(e.target.value) || 1))} aria-label="Comb cells"/><span className="ffp-unit">characters</span></div>
    </>;
  }
  if (v.kind === 'checkbox' || v.kind === 'radio') {
    const on = v.onState;
    const check = v.kind === 'checkbox';
    return <>
      <p className="sf-label">Export Value: {on}</p>
      <Check label={check ? 'Check box is checked by default' : 'Button is checked by default'} checked={!!v.defaultValue && v.defaultValue === on} set={x => set('defaultValue', x ? on : '')}/>
      <Select id="check-style" label={check ? 'Check Box Style:' : 'Button Style:'} value={v.checkStyle} options={CHECK_STYLE_NAMES} set={x => set('checkStyle', x)}/>
      {v.kind === 'radio' ? box(FLAG.RADIOS_IN_UNISON, 'Buttons with the same name and value are selected in unison') : null}
    </>;
  }
  if (v.kind === 'signature') return <p className="sf-note">A digital signature field has no options. Sign it from the Signatures panel.</p>;
  // Drop-down and list box.
  const add = () => { const t = v.newOption.trim(); if (t) { set('options', [...v.options, t]); set('newOption', ''); } };
  return <>
    {align}
    <div className="sf ffp-row"><label className="sf-label" htmlFor="ffp-item">Item:</label><div className="sf-control">
      <input id="ffp-item" className="sf-text" value={v.newOption} onChange={e => set('newOption', e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); add(); } }} data-field-id="item"/>
      <Button onClick={add}>Add</Button></div></div>
    <h4 className="ffp-title">Item List</h4>
    <div className="sf-list ffp-items" role="list" aria-label="Item list" data-field-id="items">
      {v.options.map((o: string, i: number) => <div key={`${o}-${i}`} role="listitem" className="sf-list-item ffp-item">
        <span>{o}</span>
        <span className="ffp-item-tools">
          <button type="button" className="ffp-link" disabled={i === 0} onClick={() => { const a = [...v.options]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; set('options', a); }}>Up</button>
          <button type="button" className="ffp-link" disabled={i === v.options.length - 1} onClick={() => { const a = [...v.options]; [a[i + 1], a[i]] = [a[i], a[i + 1]]; set('options', a); }}>Down</button>
          <button type="button" className="ffp-link" aria-label={`Delete ${o}`} onClick={() => set('options', v.options.filter((_: unknown, k: number) => k !== i))}>Delete</button>
        </span></div>)}
      {!v.options.length ? <div className="sf-list-empty">Add the choices people pick from.</div> : null}
    </div>
    <Select id="list-default" label="Default:" value={v.defaultValue} options={['', ...v.options]} set={x => set('defaultValue', x)}/>
    {box(FLAG.SORT, 'Sort items')}
    {v.kind === 'combo' ? <>{box(FLAG.EDIT, 'Allow user to enter custom text')}{box(FLAG.DO_NOT_SPELL_CHECK, 'Check spelling', true)}</> : box(FLAG.MULTI_SELECT, 'Multiple selection')}
    {box(FLAG.COMMIT_ON_SEL_CHANGE, 'Commit selected value immediately')}
  </>;
}

const CATEGORIES = ['None', 'Number', 'Percentage', 'Date', 'Time', 'Special'];
const categoryOf = (f: Any) => ({none: 'None', number: 'Number', percent: 'Percentage', date: 'Date', time: 'Time', special: 'Special', mask: 'Special'} as Any)[f?.kind] ?? 'None';
const SAMPLE: Any = {number: '-1234.5', percent: '-1234.5', date: '10/1/2026', time: '14:05'};

function Format({v, set}: {v: Any; set: Set}) {
  const f = v.format ?? {kind: 'none'};
  const cat = categoryOf(f);
  const pick = (c: string) => set('format', ({
    None: {kind: 'none'}, Number: {kind: 'number', decimals: 2, sep: 0, neg: 0, currency: '', prepend: true}, Percentage: {kind: 'percent', decimals: 2, sep: 0},
    Date: {kind: 'date', fmt: 'mm/dd/yyyy'}, Time: {kind: 'time', fmt: 'HH:MM'}, Special: {kind: 'special', n: 0},
  } as Any)[c]);
  const put = (patch: Any) => set('format', {...f, ...patch});
  const sample = f.kind === 'special' ? (f.n === 2 ? '5551234567' : '123456789') : SAMPLE[f.kind] ?? '';
  const presets = f.kind === 'time' ? TIME_PRESETS : [...DATE_PRESETS, 'm/d/yyyy', 'mm/dd/yyyy', 'yyyy-mm-dd', 'dd/mm/yyyy'];
  const special = f.kind === 'mask' ? 4 : f.n;
  return <>
    <Select id="category" label="Select format category:" value={cat} options={CATEGORIES} set={pick}/>
    {cat === 'None' ? <p className="sf-note">The value is shown as typed.</p> : null}
    {f.kind === 'number' ? <div className="ffp-grid">
      <Num id="decimals" label="Decimal places:" value={f.decimals} min={0} max={10} set={n => put({decimals: n})}/>
      <Select id="separator" label="Separator style:" value={f.sep} options={SEPARATORS.map((s: string, i: number) => [i, s] as [number, string])} set={x => put({sep: Number(x)})}/>
      <Select id="currency" label="Currency symbol:" value={f.currency} options={CURRENCIES.map((c: string) => [c, c === '' ? 'None' : c] as [string, string])} set={x => put({currency: x})}/>
      <Check id="position" label="Before the number" checked={f.prepend} set={on => put({prepend: on})}/>
      <Select id="negative" label="Negative number style:" value={f.neg} options={NEGATIVES.map((s: string, i: number) => [i, s] as [number, string])} set={x => put({neg: Number(x)})}/>
    </div> : null}
    {f.kind === 'percent' ? <div className="ffp-grid">
      <Num id="decimals" label="Decimal places:" value={f.decimals} min={0} max={10} set={n => put({decimals: n})}/>
      <Select id="separator" label="Separator style:" value={f.sep} options={SEPARATORS.map((s: string, i: number) => [i, s] as [number, string])} set={x => put({sep: Number(x)})}/>
    </div> : null}
    {f.kind === 'date' || f.kind === 'time' ? <div className="ffp-grid">
      <Select id="format" label="Format:" value={f.fmt} options={presets.includes(f.fmt) ? presets : [f.fmt, ...presets]} set={x => put({fmt: x})}/>
      <Text id="custom" label="Custom:" value={f.fmt} set={x => put({fmt: x})}/>
    </div> : null}
    {f.kind === 'special' || f.kind === 'mask' ? <>
      <Select id="special" label="Special:" value={special} options={SPECIALS.map((s: string, i: number) => [i, s] as [number, string])} set={x => set('format', Number(x) === 4 ? {kind: 'mask', mask: '999-999'} : {kind: 'special', n: Number(x)})}/>
      {f.kind === 'mask' ? <><Text id="mask" label="Mask:" value={f.mask} set={x => put({mask: x})}/><small className="sf-note">9 digit, A letter, O letter or digit, X any character</small></> : null}
    </> : null}
    {sample && f.kind !== 'none' ? <p className="sf-note" data-field-id="example">Example: {formatValue(f, sample)}</p> : null}
    {v.unsupported?.includes('format') ? <p className="sf-note">This field has a custom format script, kept as it is.</p> : null}
  </>;
}

function Validate({v, set}: {v: Any; set: Set}) {
  const r = v.validate?.kind === 'range';
  const val = v.validate;
  return <>
    <Radio name="ffp-validate" label="Field value is not validated" checked={!r} set={() => set('validate', {kind: 'none'})}/>
    <Radio name="ffp-validate" label="Field value is in range:" checked={r} set={() => set('validate', r ? val : {kind: 'range', min: 0, max: 100})}/>
    {r ? <div className="ffp-inline">
      <Check id="from-on" label="From:" checked={val.min !== null} set={on => set('validate', {...val, min: on ? 0 : null})}/>
      <input className="sf-text ffp-num" type="number" disabled={val.min === null} value={val.min ?? ''} onChange={e => set('validate', {...val, min: Number(e.target.value) || 0})} aria-label="From" data-field-id="from"/>
      <Check id="to-on" label="To:" checked={val.max !== null} set={on => set('validate', {...val, max: on ? 100 : null})}/>
      <input className="sf-text ffp-num" type="number" disabled={val.max === null} value={val.max ?? ''} onChange={e => set('validate', {...val, max: Number(e.target.value) || 0})} aria-label="To" data-field-id="to"/>
    </div> : null}
    {v.unsupported?.includes('validate') ? <p className="sf-note">This field has a custom validation script, kept as it is.</p> : null}
  </>;
}

function Calculate({v, set}: {v: Any; set: Set}) {
  const c = v.calculate ?? {kind: 'none'};
  return <>
    <Radio name="ffp-calc" label="Value is not calculated" checked={c.kind === 'none'} set={() => set('calculate', {kind: 'none'})}/>
    <Radio name="ffp-calc" label="Value is the" checked={c.kind === 'simple'} set={() => set('calculate', c.kind === 'simple' ? c : {kind: 'simple', op: 'SUM', fields: []})}/>
    {c.kind === 'simple' ? <div className="ffp-indent">
      <div className="ffp-inline"><Select id="op" value={c.op} options={CALC_OPS.map(([label, code]: Any) => [code, label] as [string, string])} set={x => set('calculate', {...c, op: x})}/><span className="ffp-unit">of the following fields:</span></div>
      <div className="sf-list ffp-fields" role="group" aria-label="Fields">
        {v.others.map((n: string) => <Check key={n} label={n} checked={c.fields.includes(n)} set={on => set('calculate', {...c, fields: on ? [...c.fields, n] : c.fields.filter((x: string) => x !== n)})}/>)}
        {!v.others.length ? <div className="sf-list-empty">There are no other fields.</div> : null}
      </div>
    </div> : null}
    <Radio name="ffp-calc" label="Simplified field notation:" checked={c.kind === 'notation'} set={() => set('calculate', c.kind === 'notation' ? c : {kind: 'notation', expr: ''})}/>
    {c.kind === 'notation' ? <div className="ffp-indent">
      <Text id="sfn" value={c.expr} area rows={2} set={x => set('calculate', {kind: 'notation', expr: x})}/>
      <small className="sf-note">Field names with + - * / and parentheses; put \ before spaces in names.</small>
    </div> : null}
    {v.unsupported?.includes('calculate') ? <p className="sf-note">This field has a custom calculation script, kept as it is.</p> : null}
  </>;
}

function Actions({v, set}: {v: Any; set: Set}) {
  const [trigger, setTrigger] = useState('mouse_up');
  const [kind, setKind] = useState(0);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hint = ['JavaScript', 'https://…', 'Fields to reset (comma-separated; empty: all)', 'Print, NextPage, PrevPage, FirstPage or LastPage', 'Page number', 'Field names (comma-separated)', 'Field names (comma-separated)', 'URL to submit to'][kind];
  const commit = () => {
    const r = actionOf(kind, text);
    if (r.error) { setError(r.error); return; }
    setError(null);
    const rest = v.actions.filter(([t]: Any) => t !== trigger);
    set('actions', [...rest, [trigger, r.action]].sort((a: Any, b: Any) => ACTION_TRIGGERS.findIndex(([id]: Any) => id === a[0]) - ACTION_TRIGGERS.findIndex(([id]: Any) => id === b[0])));
    setText(''); setEditing(null);
  };
  return <>
    <h4 className="ffp-title">{editing ? 'Edit Action' : 'Add an Action'}</h4>
    <div className="ffp-grid">
      <Select id="trigger" label="Select Trigger:" value={trigger} options={ACTION_TRIGGERS as Any} set={setTrigger}/>
      <Select id="action" label="Select Action:" value={kind} options={ACTION_KINDS.map((k: string, i: number) => [i, k] as [number, string])} set={x => setKind(Number(x))}/>
    </div>
    <Text id="action-text" label={kind === 0 ? 'Script:' : 'Value:'} value={text} area={kind === 0} rows={3} set={setText}/>
    {error ? <small className="sf-error" role="alert">{error}</small> : <small className="sf-note">{hint}</small>}
    <div className="ffp-inline"><Button onClick={commit}>{editing ? 'Update' : 'Add'}</Button>{editing ? <Button onClick={() => { setEditing(null); setText(''); setError(null); }}>Discard</Button> : null}</div>
    <h4 className="ffp-title">Actions</h4>
    <div className="sf-list ffp-items" role="list" aria-label="Actions" data-field-id="actions">
      {v.actions.map(([t, a]: Any) => <div key={t} role="listitem" className="sf-list-item ffp-item">
        <span><b>{ACTION_TRIGGERS.find(([id]: Any) => id === t)?.[1]}</b> {describeAction(a)}</span>
        <span className="ffp-item-tools">
          {a.kind === 'javascript' ? <button type="button" className="ffp-link" disabled={!!editing} onClick={() => { const [k, tx] = editableAction(a); setTrigger(t); setKind(k); setText(tx); setEditing(t); }}>Edit</button> : null}
          <button type="button" className="ffp-link" onClick={() => { set('actions', v.actions.filter(([x]: Any) => x !== t)); if (editing === t) { setEditing(null); setText(''); } }}>Delete</button>
        </span></div>)}
      {!v.actions.length ? <div className="sf-list-empty">No actions</div> : null}
    </div>
  </>;
}

function Bulk({v, set}: {v: Any; set: Set}) {
  const tri = (id: string, label: string) => <Select id={id} label={label} value={v[id]} options={['Mixed', 'Yes', 'No']} set={x => set(id, x)}/>;
  const colour = (id: string, label: string, none: boolean) => <Colour id={id} label={label} value={rgbOfHex(v[id])} none={none} set={c => set(id, hex(c))}/>;
  return <div className="ffp">
    <p className="sf-label" data-field-id="count">{v.count}</p>
    <Text id="tooltip" label="Tooltip" value={v.tooltip} set={x => set('tooltip', x)}/>
    <div className="ffp-grid">{tri('read-only', 'Read Only')}{tri('required', 'Required')}{tri('locked', 'Locked')}
      <Num id="font-size" label="Font size (0 = auto)" value={v['font-size'] ?? NaN} min={0} max={100} step={0.5} set={n => set('font-size', n)}/>
      <Num id="limit" label="Character limit (0 = none)" value={v.limit ?? NaN} min={0} max={10000} set={n => set('limit', n)}/>
      <Select id="comb" label="Comb of characters" value={v.comb === null ? 'Mixed' : v.comb ? 'Yes' : 'No'} options={['Mixed', 'Yes', 'No']} set={x => set('comb', x === 'Mixed' ? null : x === 'Yes')}/></div>
    {colour('text-color', 'Text color', false)}{colour('border', 'Border color', true)}{colour('fill', 'Fill color', true)}
    <small className="sf-note">Only the properties you change are applied to every selected field.</small>
  </div>;
}

function Body({dialog, setValue}: {dialog: Any; setValue: Set}) {
  const v = dialog.values;
  const tab: string = v.__tab ?? 'General';
  const setTab = (t: string) => setValue('__tab', t);
  if (v.__bulk) return <Bulk v={v} set={setValue}/>;
  const locked = !!v.__orig?.locked && !!v.locked;
  const errors = dialog.errors ?? [];
  const body = {General, Appearance, Position, Options, Format, Validate, Calculate, Actions}[tab as 'General'] ?? General;
  const Tab = body as Any;
  return <div className="ffp" data-kind={v.kind}>
    <div className="gd-tabs" role="tablist" aria-label={`${v.__title} pages`}>
      {v.tabs.map((t: string, i: number) => <button key={t} type="button" role="tab" aria-selected={t === tab} className={t === tab ? 'is-active' : undefined} onClick={() => setTab(t)}
        onKeyDown={e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); setTab(v.tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + v.tabs.length) % v.tabs.length]); } }}>{t}</button>)}
    </div>
    {locked ? <p className="sf-note" role="note">This field is locked. Unlock it to change its properties.</p> : null}
    <fieldset className="ffp-tab" disabled={locked}><Tab v={v} set={setValue}/></fieldset>
    <div className="ffp-foot"><Check id="locked" label="Locked" checked={!!v.locked} set={on => setValue('locked', on)}/>
      {errors.length ? <small className="sf-error" role="alert">{errors[0].message}</small> : null}</div>
  </div>;
}

const override: DialogOverride = {Body};
export default override;
