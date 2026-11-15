// Paste Special's option groups as gridcraft draws them: Paste and Operation each in two columns,
// filled column by column the way Excel lists them (All, Formulas, Values, Formats... down the
// left, then Validation... down the right).
// Translated from gridcraft crates/ui-egui/src/dialogs/paste.rs (`paste_special`, the
// `paste_special` grids: num_columns(2), options.get(c * rows + r)) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// The letter mnemonics (paste.rs `paste_special_shortcuts`: F, V, T, C, E) select options while
// no text field has focus.

import {useEffect} from 'react';
import type {FieldProps} from '../../../shell/fields';
import {realOptions} from '../../../shell/dialogs/dialogState';
import {fieldLabel} from '../../../shell/fields/common';

type Opt = {value: unknown; label: string};

/** Two columns, column by column (paste.rs: rows = len.div_ceil(2); cell (r, c) = options[c * rows + r]). */
export function columnsOf<T>(options: T[]): (T | null)[][] {
  const rows = Math.ceil(options.length / 2);
  const out: (T | null)[][] = [];
  for (let r = 0; r < rows; r++) out.push([options[r] ?? null, options[rows + r] ?? null]);
  return out;
}

export function TwoColumnRadio({field, value, onChange, error, disabled}: FieldProps) {
  const options = realOptions(field) as Opt[];
  const name = `r-${field.id}`;
  const rows = columnsOf(options);
  return <fieldset className={`sf sf-radio${error ? ' has-error' : ''}`} data-field-id={field.id} data-kind="radio" disabled={disabled}>
    {fieldLabel(field) ? <legend className="sf-label">{fieldLabel(field)}</legend> : null}
    <div className="sf-radio-options is-grid" role="radiogroup" style={{gridTemplateColumns: 'repeat(2, minmax(0, 1fr))'}}>
      {rows.flatMap((row, r) => row.map((o, c) => (o ? <label key={`${r}-${c}`}>
        <input type="radio" name={name} checked={o.value === value} onChange={() => onChange(o.value)}/>
        <span className="sf-radio-dot" aria-hidden="true"/>
        <span>{o.label}</span>
      </label> : <span key={`${r}-${c}`}/>)))}
    </div>
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
  </fieldset>;
}

/** paste.rs `paste_special_shortcuts`: F Formulas, V Values, T Formats, C Comments, E Transpose. */
const MNEMONICS: Record<string, [string, unknown]> = {f: ['what', 'formulas'], v: ['what', 'values'], t: ['what', 'formats'], c: ['what', 'comments']};

function WhatField(props: FieldProps) {
  const {onChange} = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest('input[type=text],input[type=number],textarea,[contenteditable=true]')) return;
      if (!t?.closest('[data-dialog-id="dialog.pasteSpecial"]')) return;
      const m = MNEMONICS[e.key.toLowerCase()];
      if (!m) return;
      e.preventDefault();
      onChange(m[1]);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onChange]);
  return <TwoColumnRadio {...props}/>;
}

export default {fields: {what: WhatField, operation: TwoColumnRadio}};
