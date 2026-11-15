// ButtonField (runs the model's handler, the field's command, or opens its nested dialog),
// LabelField (static text, `{name}` filled from the values) and MessageField (message boxes).

import type {FieldProps} from './common';
import {resolveText} from '../dialogs/templates';

export function ButtonField({field, onPress, disabled, values}: FieldProps) {
  return <div className="sf sf-btn" data-field-id={field.id} data-kind="button">
    <button type="button" className="sf-button" disabled={disabled} onClick={() => onPress?.(field.id)}>{resolveText(field.label, values ?? {})}</button>
  </div>;
}


export function LabelField({field, values}: {field: FieldProps['field']; values: Record<string, unknown>}) {
  const v = values[field.id];
  return <p className="sf sf-static" data-field-id={field.id}>{typeof v === 'string' && v ? v : resolveText(field.label, values)}</p>;
}

/** The message layout (section 9.4): a heading and the detail under it. */
export function MessageField({values}: {values: Record<string, unknown>}) {
  return <div className="sf sf-message" data-field-id="message">
    <strong>{String(values.message ?? '')}</strong>
    {values.detail ? <p>{String(values.detail)}</p> : null}
  </div>;
}
