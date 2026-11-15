// NumberField: units shown and parsed ("12 pt", "2.54 cm"), min/max/step, arrow keys and the wheel
// step the value (Shift for ten steps). SliderField: the same value on a track.

import {useEffect, useState} from 'react';
import {FieldShell, type FieldProps} from './common';
import {formatNumber, parseNumber, stepNumber, primaryUnit} from '../dialogs/dialogState';
import {Glyph} from '../icons/Icon';

export function NumberField({field, value, onChange, error, disabled}: FieldProps) {
  const unit = field.unit ?? null;
  const [text, setText] = useState<string | null>(null);
  useEffect(() => { setText(null); }, [value]);
  const shown = text ?? formatNumber(value, unit);
  const commit = (t: string) => {
    if (t.trim() === '') { onChange(null); setText(null); return; }
    const n = parseNumber(t, unit);
    if (n === null) { setText(t); return; }
    setText(null);
    onChange(n);
  };
  const step = (dir: 1 | -1, big = false) => onChange(stepNumber(typeof value === 'number' ? value : parseNumber(shown, unit), field, dir, big));
  return <FieldShell field={field} error={error}>{id => <span className={`sf-number${disabled ? ' is-disabled' : ''}`}>
    <input id={id} inputMode="decimal" disabled={disabled} value={shown} aria-invalid={!!error || undefined}
      aria-valuemin={field.min} aria-valuemax={field.max} role="spinbutton" aria-valuenow={typeof value === 'number' ? value : undefined}
      placeholder={value === null ? (primaryUnit(unit) ? `— ${primaryUnit(unit)}` : '—') : undefined}
      onChange={e => setText(e.target.value)} onBlur={e => commit(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); step(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey); }
        else if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
      }}
      onWheel={e => { if (document.activeElement === e.currentTarget && !disabled) { e.preventDefault(); step(e.deltaY < 0 ? 1 : -1, e.shiftKey); } }}/>
    <span className="sf-spin">
      <button type="button" tabIndex={-1} aria-label="Increase" disabled={disabled} onClick={() => step(1)}><Glyph name="scroll-up" size={9}/></button>
      <button type="button" tabIndex={-1} aria-label="Decrease" disabled={disabled} onClick={() => step(-1)}><Glyph name="scroll-down" size={9}/></button>
    </span>
  </span>}</FieldShell>;
}

export function SliderField({field, value, onChange, error, disabled}: FieldProps) {
  const min = field.min ?? 0, max = field.max ?? (field.unit === '%' ? 200 : 100), step = field.step ?? 1;
  const v = typeof value === 'number' ? value : (typeof field.default === 'number' ? field.default : min);
  return <FieldShell field={field} error={error}>{id => <span className="sf-slider">
    <input id={id} type="range" min={min} max={max} step={step} value={v} disabled={disabled} onChange={e => onChange(Number(e.target.value))}/>
    <output htmlFor={id}>{formatNumber(v, field.unit)}</output>
  </span>}</FieldShell>;
}
