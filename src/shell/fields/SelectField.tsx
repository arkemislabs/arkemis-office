// SelectField (a fixed list), ComboField (a list you can also type into) and FontField (installed
// fonts, virtualized, each name drawn in its own face).

import {useMemo, useRef, useState} from 'react';
import {FieldShell, fieldData, type FieldProps} from './common';
import {toItems} from './controls';
import {realOptions, isPlaceholder} from '../dialogs/dialogState';
import {Flyout, VirtualList, useFonts} from '../common/Flyout';
import {Glyph} from '../icons/Icon';

const key = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

export function SelectField({field, value, onChange, error, disabled, values}: FieldProps) {
  // Options the model keeps in the dialog's values (`itemsFrom`): the saved templates, the open notebooks.
  const data = fieldData(field, values);
  const options = Array.isArray(data) ? toItems(data).map(o => ({value: o.value, label: o.label})) : realOptions(field);
  if (!Array.isArray(data) && (!options.length || options.some(isPlaceholder) || field.options.some(isPlaceholder))) return <ComboField field={field} value={value} onChange={onChange} error={error} disabled={disabled}/>;
  const current = options.findIndex(o => key(o.value) === key(value));
  return <FieldShell field={field} error={error}>{id => <span className="sf-select">
    <select id={id} disabled={disabled} value={current < 0 ? '' : String(current)} aria-invalid={!!error || undefined}
      onChange={e => onChange(e.target.value === '' ? null : options[Number(e.target.value)].value)}>
      {current < 0 ? <option value="">{value === null || value === undefined ? '' : String(value)}</option> : null}
      {options.map((o, i) => <option key={i} value={String(i)}>{o.label}</option>)}
    </select>
    <Glyph name="chevron-down" size={10}/>
  </span>}</FieldShell>;
}

export function ComboField({field, value, onChange, error, disabled, fonts = false}: FieldProps & {fonts?: boolean}) {
  const installed = useFonts(fonts);
  const options = useMemo(() => (fonts ? installed : realOptions(field).map(o => String(o.label))), [fonts, installed, field]);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const shown = text ?? (value === null || value === undefined ? '' : String(value));
  const filtered = text ? options.filter(o => o.toLowerCase().startsWith(text.toLowerCase())).concat(options.filter(o => !o.toLowerCase().startsWith(text.toLowerCase()) && o.toLowerCase().includes(text.toLowerCase()))) : options;
  const pick = (o: string) => {
    setText(null); setOpen(false);
    const opt = realOptions(field).find(x => String(x.label) === o);
    onChange(opt ? opt.value : o);
  };
  return <FieldShell field={field} error={error}>{id => <span ref={anchor} className={`sf-combo${disabled ? ' is-disabled' : ''}`}>
    <input id={id} role="combobox" aria-expanded={open} aria-autocomplete="list" disabled={disabled} value={shown}
      style={fonts && shown ? {fontFamily: `"${shown}"`} : undefined}
      onChange={e => { setText(e.target.value); setOpen(true); }} onBlur={() => { if (text !== null && !open) { onChange(text); setText(null); } }}
      onKeyDown={e => {
        if (e.key === 'Enter' && text !== null) { e.preventDefault(); pick(filtered[0] && open ? filtered[0] : text); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); }
        else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
      }}/>
    <button type="button" tabIndex={-1} aria-label={`Show ${field.label} list`} disabled={disabled} onClick={() => setOpen(o => !o)}><Glyph name="chevron-down" size={10}/></button>
    <Flyout anchor={anchor} open={open} onClose={() => setOpen(false)} role="listbox" matchWidth initialFocus={false} className="is-combo">
      {filtered.length ? <VirtualList items={filtered} row={fonts ? 28 : 26} height={fonts ? 300 : 240} scrollTo={filtered.indexOf(shown)}
        render={o => <button type="button" role="option" aria-selected={o === shown} className="shell-option" style={fonts ? {fontFamily: `"${o}"`, fontSize: 14} : undefined}
          onMouseDown={e => e.preventDefault()} onClick={() => pick(o)}>{o}</button>}/> : <div className="shell-option is-empty">No matches</div>}
    </Flyout>
  </span>}</FieldShell>;
}

/** Fonts: the installed families, virtualized, each in its own face. */
export function FontField(props: FieldProps) { return <ComboField {...props} fonts/>; }
