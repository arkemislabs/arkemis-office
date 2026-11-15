// Pieces the Data tab's dialog bodies share: the shell's field components over a dialog's values
// (so every check box, select and text box looks and reads like the generic dialogs), a row of
// buttons, and the tab strip of Data Validation.

import type {ReactNode} from 'react';
import type {SpecField} from '../../../generated/spec-types';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {fieldComponent} from '../../../shell/fields';
import './data.css';

export type SetValue = (field: string, value: unknown) => void;
export interface Opt { value: unknown; label: string }

/** One field of a dialog, drawn by the shell's field library from a small description. */
export function Fld({d, set, id, label, kind, options, disabled, hidden, hint, multiline, wide, masked}: {
  d: DialogState; set: SetValue; id: string; label?: string; kind: 'text' | 'select' | 'checkbox' | 'radio' | 'number';
  options?: Opt[]; disabled?: boolean; hidden?: boolean; hint?: string; multiline?: boolean; wide?: boolean; masked?: boolean;
}) {
  if (hidden) return null;
  const field = {id, label: label ?? '', kind, options: options ?? [], multiline, ...(masked ? {masked: true} : {}), ...(hint ? {hint} : {})} as SpecField;
  const C = fieldComponent(field);
  if (!C) return null;
  const err = d.errors.find(e => e.field === id)?.message ?? null;
  return <C field={field} value={d.values[id]} onChange={v => set(id, v)} error={err} disabled={disabled} wide={wide}/>;
}

export const Buttons = ({children}: {children: ReactNode}) => <div className="gd-buttons">{children}</div>;

export function Btn({children, onClick, disabled, label, icon}: {children: ReactNode; onClick: () => void; disabled?: boolean; label?: string; icon?: boolean}) {
  return <button type="button" className={`gd-button${icon ? ' data-icon-btn' : ''}`} disabled={disabled} aria-label={label} title={label} onClick={onClick}>{children}</button>;
}

/** A tab strip in the dialog's own style (Data Validation: Settings, Input Message, Error Alert). */
export function Tabs({names, current, onPick, label}: {names: string[]; current: number; onPick: (i: number) => void; label: string}) {
  return <div className="gd-tabs" role="tablist" aria-label={label}>
    {names.map((n, i) => <button key={n} type="button" role="tab" aria-selected={i === current} className={i === current ? 'is-active' : undefined} onClick={() => onPick(i)}
      onKeyDown={e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); onPick((i + (e.key === 'ArrowRight' ? 1 : -1) + names.length) % names.length); } }}>{n}</button>)}
  </div>;
}

/** A list box of rows (the shell's `sf-list`) with one selected row. */
export function Rows({items, selected, onPick, onDouble, height = 150, empty, label, id}: {
  items: ReactNode[]; selected: number; onPick: (i: number) => void; onDouble?: (i: number) => void; height?: number; empty?: string; label: string; id?: string;
}) {
  return <div className="sf-list" role="listbox" aria-label={label} data-field-id={id} tabIndex={0} style={{height, overflowY: 'auto'}}
    onKeyDown={e => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      onPick(Math.max(0, Math.min(items.length - 1, selected + (e.key === 'ArrowDown' ? 1 : -1))));
    }}>
    {items.length ? items.map((x, i) => <div key={i} role="option" aria-selected={i === selected} className={`sf-list-item${i === selected ? ' is-selected' : ''}`}
      onClick={() => onPick(i)} onDoubleClick={() => onDouble?.(i)}>{x}</div>) : <div className="sf-list-empty">{empty ?? 'Nothing here'}</div>}
  </div>;
}

/** The label Excel shows for a column of the range: its heading when the data has headers, else "Column B". */
export function columnLabel(letter: string, heads: string[], startCol: number, header: boolean) {
  const i = lettersToIndex(letter) - startCol;
  const h = header ? heads[i] : '';
  return h ? h : `Column ${letter}`;
}
export function lettersToIndex(s: string) { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; }
export function indexToLetters(n: number) { let s = ''; for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; }
