// Shared pieces of the dialog field library (docs/architecture.md section 9.3).

import {useId, type ReactNode} from 'react';
import type {SpecField} from '../../generated/spec-types';
import {clean} from '../dialogs/dialogState';

export interface FieldProps<V = unknown> {
  field: SpecField;
  value: V;
  onChange: (value: unknown) => void;
  error?: string | null;
  disabled?: boolean;
  /** Runs a `button` field or opens its nested dialog. */
  onPress?: (fieldId: string) => void;
  /** Opens a nested dialog that returns a value into this field (More Colors). */
  onNested?: (dialogId: string, fieldId: string, init: Record<string, unknown>) => void;
  /** Data the model's preview() produced (preview fields). */
  preview?: unknown;
  /** Whether the field spans the full width of its section. */
  wide?: boolean;
  /** The dialog's values (a field that draws data the model keeps beside the fields: a tree, a palette, an item list). */
  values?: Record<string, unknown>;
}

/** The records a list, tree or palette field draws: `values[field.itemsFrom]` when the model keeps them there, else the field's own options. */
export function fieldData(field: FieldProps['field'], values?: Record<string, unknown>): unknown {
  const key = typeof field.itemsFrom === 'string' ? field.itemsFrom : null;
  return key && values && values[key] !== undefined ? values[key] : null;
}

export const fieldLabel = (f: SpecField) => clean(f.label);

/** Label above the control, the unit or hint after it, the error under it. */
export function FieldShell({field, children, error, inline = false, id, after}: {field: SpecField; children: (id: string) => ReactNode; error?: string | null; inline?: boolean; id?: string; after?: ReactNode}) {
  const auto = useId();
  const fid = id ?? `f-${auto}`;
  const label = fieldLabel(field);
  return <div className={`sf${inline ? ' sf-inline' : ''}${error ? ' has-error' : ''}`} data-field-id={field.id} data-kind={field.kind}>
    {label ? <label className="sf-label" htmlFor={fid}>{label}</label> : null}
    <div className="sf-control">{children(fid)}{after}</div>
    {typeof field.hint === 'string' && field.hint.length <= 90 && !error ? <small className="sf-note">{field.hint}</small> : null}
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
  </div>;
}

