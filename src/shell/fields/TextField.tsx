// TextField (single line, multiline, masked for passwords: masked values are never journaled by
// the kernel because their params are declared s.secret), date/time inputs, and FileField (the
// main-process file dialog; `accept` lists the extensions).

import {FieldShell, type FieldProps} from './common';

export function TextField({field, value, onChange, error, disabled}: FieldProps) {
  const v = value === null || value === undefined ? '' : String(value);
  const kind = field.input === 'date' ? 'date' : field.input === 'time' ? 'time' : field.masked ? 'password' : 'text';
  return <FieldShell field={field} error={error}>{id => field.multiline
    ? <textarea id={id} className="sf-textarea" value={v} disabled={disabled || field.readOnly === true} rows={4} onChange={e => onChange(e.target.value)} aria-invalid={!!error || undefined}/>
    : <input id={id} className="sf-text" type={kind} value={v} disabled={disabled} readOnly={field.readOnly === true} autoComplete={field.masked ? 'new-password' : 'off'}
      spellCheck={field.masked ? false : undefined} onChange={e => onChange(e.target.value)} aria-invalid={!!error || undefined}/>}
  </FieldShell>;
}

export function FileField({field, value, onChange, error, disabled}: FieldProps) {
  const v = value === null || value === undefined ? '' : String(value);
  const pick = async () => {
    // The main process owns file dialogs; images go through pickImage, other files through import.
    const path = /image|png|jpe?g|gif|svg/i.test((field.accept ?? []).join(',')) ? await window.studio.pickImage() : null;
    if (path) onChange(path);
  };
  return <FieldShell field={field} error={error}>{id => <span className="sf-file">
    <input id={id} className="sf-text" value={v} disabled={disabled} onChange={e => onChange(e.target.value)} placeholder={(field.accept ?? []).join(', ')}/>
    <button type="button" className="sf-button" disabled={disabled} onClick={pick}>Browse…</button>
  </span>}</FieldShell>;
}
