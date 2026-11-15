// Checkbox (tri-state for mixed selections: null shows the dash), RadioGroup and ListField
// (single- or multi-select listbox).

import {useEffect, useRef} from 'react';
import {FieldShell, fieldLabel, fieldData, type FieldProps} from './common';
import {ItemList, toItems} from './controls';
import {realOptions} from '../dialogs/dialogState';
import {Icon} from '../icons/Icon';

export function Checkbox({field, value, onChange, error, disabled}: FieldProps) {
  const ref = useRef<HTMLInputElement>(null);
  const mixed = value === null || value === 'mixed';
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <div className={`sf sf-check${error ? ' has-error' : ''}`} data-field-id={field.id} data-kind="checkbox">
    <label className={disabled ? 'is-disabled' : undefined}>
      <input ref={ref} type="checkbox" checked={value === true} disabled={disabled} aria-checked={mixed ? 'mixed' : value === true}
        onChange={e => onChange(e.target.checked)}/>
      <span className="sf-check-box" aria-hidden="true"/>
      <span>{fieldLabel(field)}</span>
    </label>
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
  </div>;
}

const same = (a: unknown, b: unknown) => (typeof a === 'string' ? a === b : JSON.stringify(a) === JSON.stringify(b));

export function RadioGroup({field, value, onChange, error, disabled}: FieldProps) {
  const options = realOptions(field);
  const name = `r-${field.id}`;
  return <fieldset className={`sf sf-radio${error ? ' has-error' : ''}`} data-field-id={field.id} data-kind="radio" disabled={disabled}>
    {fieldLabel(field) ? <legend className="sf-label">{fieldLabel(field)}</legend> : null}
    <div className={`sf-radio-options${options.some(o => o.icon) ? ' is-pictures' : options.length > 4 && options.every(o => o.label.length < 18) ? ' is-grid' : ''}`} role="radiogroup">
      {options.map((o, i) => o.icon ? <label key={i} className="sf-radio-picture" title={o.label}>
        <input type="radio" name={name} checked={same(o.value, value)} onChange={() => onChange(o.value)}/>
        <span className="sf-radio-tile"><Icon id={o.icon} size={32}/><span>{o.label}</span></span>
      </label> : <label key={i}>
        <input type="radio" name={name} checked={same(o.value, value)} onChange={() => onChange(o.value)}/>
        <span className="sf-radio-dot" aria-hidden="true"/>
        <span>{o.label}</span>
      </label>)}
    </div>
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
  </fieldset>;
}

export function ListField({field, value, onChange, error, disabled, values}: FieldProps) {
  // A list whose records the model keeps in the dialog's values (`source`): a drawn list with icons and details.
  const data = fieldData(field, values);
  if (Array.isArray(data)) {
    return <FieldShell field={field} error={error}>{() => <ItemList items={toItems(data)} selected={value ?? null} onSelect={onChange} disabled={disabled} label={fieldLabel(field)}
      empty={typeof field.empty === 'string' ? field.empty : undefined} height={typeof field.height === 'number' ? field.height : undefined}/>}</FieldShell>;
  }
  const options = realOptions(field);
  const own = typeof field.height === 'number' ? {height: field.height} : undefined;
  const multi = Array.isArray(value) || field.multiple === true;
  const selected = (v: unknown) => (multi ? Array.isArray(value) && value.some(x => same(x, v)) : same(value, v));
  const toggle = (v: unknown) => {
    if (!multi) { onChange(v); return; }
    const list = Array.isArray(value) ? value : [];
    onChange(selected(v) ? list.filter(x => !same(x, v)) : [...list, v]);
  };
  return <FieldShell field={field} error={error}>{id => <div id={id} className={`sf-list${disabled ? ' is-disabled' : ''}`} role="listbox" aria-multiselectable={multi || undefined} tabIndex={0} style={own}
    onKeyDown={e => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const i = options.findIndex(o => selected(o.value));
      const next = options[Math.max(0, Math.min(options.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next && !multi) onChange(next.value);
    }}>
    {options.length ? options.map((o, i) => <div key={i} role="option" aria-selected={selected(o.value)} className={`sf-list-item${selected(o.value) ? ' is-selected' : ''}`}
      onClick={() => !disabled && toggle(o.value)}>{o.label}</div>)
      : <div className="sf-list-empty">{typeof field.note === 'string' && field.note.length < 60 ? field.note : 'No items'}</div>}
  </div>}</FieldShell>;
}
