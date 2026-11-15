// Equation: a structures and symbols palette over the linear-form box. A structure (fraction, power, root) or symbol drops its
// linear form at the caret, with the placeholder selected, and the preview shows the prettified result (deckcraft
// `pretty_equation`: ^ superscripts, sqrt, <=, >=, !=, pi, +-, *). Linear form is what deckcraft's dialog takes; the inserted
// text box holds the prettified text.

import {useRef} from 'react';
import {FieldShell, type FieldProps} from '../../../shell/fields/common';

type Item = {label: string; insert: string; select?: [number, number]; title: string};
const STRUCTURES: Item[] = [
  {label: 'a/b', insert: '(a)/(b)', select: [1, 2], title: 'Fraction'},
  {label: 'x²', insert: 'x^2', select: [0, 1], title: 'Superscript'},
  {label: '√x', insert: 'sqrt(x)', select: [5, 6], title: 'Square root'},
  {label: 'x·y', insert: 'x*y', select: [0, 1], title: 'Dot product'},
];
const SYMBOLS: Item[] = [
  {label: 'π', insert: 'pi', title: 'Pi'}, {label: '±', insert: '+-', title: 'Plus or minus'}, {label: '≤', insert: '<=', title: 'Less than or equal'},
  {label: '≥', insert: '>=', title: 'Greater than or equal'}, {label: '≠', insert: '!=', title: 'Not equal'}, {label: '∞', insert: '∞', title: 'Infinity'},
  {label: '∑', insert: '∑', title: 'Sum'}, {label: '∫', insert: '∫', title: 'Integral'}, {label: '°', insert: '°', title: 'Degree'},
  {label: 'θ', insert: 'θ', title: 'Theta'}, {label: 'α', insert: 'α', title: 'Alpha'}, {label: 'β', insert: 'β', title: 'Beta'}, {label: 'Δ', insert: 'Δ', title: 'Delta'},
];

function EquationText({field, value, onChange, error, disabled}: FieldProps) {
  const ref = useRef<HTMLInputElement>(null);
  const text = typeof value === 'string' ? value : '';
  const add = (it: Item) => {
    const el = ref.current;
    const [a, b] = el ? [el.selectionStart ?? text.length, el.selectionEnd ?? text.length] : [text.length, text.length];
    onChange(text.slice(0, a) + it.insert + text.slice(b));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const [s, e] = it.select ? [a + it.select[0], a + it.select[1]] : [a + it.insert.length, a + it.insert.length];
      el.setSelectionRange(s, e);
    });
  };
  const btn = (it: Item, wide = false) => <button key={it.title} type="button" className="sf-button" title={it.title} aria-label={it.title} disabled={disabled}
    onMouseDown={e => e.preventDefault()} onClick={() => add(it)} style={{minWidth: wide ? 52 : 32, height: 30, padding: '0 8px', fontSize: 15, fontFamily: 'Cambria Math, Liberation Serif, serif', fontStyle: 'italic'}}>{it.label}</button>;
  return <div className="sf" data-field-id={field.id} data-kind="text">
    <span className="sf-label">Structures</span>
    <div style={{display: 'flex', gap: 6, flexWrap: 'wrap'}}>{STRUCTURES.map(i => btn(i, true))}</div>
    <span className="sf-label" style={{marginTop: 8}}>Symbols</span>
    <div style={{display: 'flex', gap: 6, flexWrap: 'wrap'}}>{SYMBOLS.map(i => btn(i))}</div>
    <FieldShell field={{...field, label: 'Equation (linear form)'}} error={error}>{id => <input id={id} ref={ref} className="sf-text" value={text} disabled={disabled}
      placeholder="a^2+b^2=c^2" onChange={e => onChange(e.target.value)} aria-invalid={!!error || undefined}/>}</FieldShell>
  </div>;
}

export default {fields: {text: EquationText}};
