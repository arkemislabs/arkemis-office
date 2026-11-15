// Insert Hyperlink: the Address field with Browse beside it. Browse asks for a file (the document picker with every type allowed) and puts its
// name in the field, as PowerPoint's Existing File does; a typed address works as before.

import {FieldShell, type FieldProps} from '../../../shell/fields/common';

function Address({field, value, onChange, error, disabled}: FieldProps) {
  const browse = async () => {
    const studio = (window as any).studio;
    if (!studio?.pickDocument) return;
    try {
      const doc = await studio.pickDocument({all: true});
      if (doc?.name) onChange(String(doc.name));
    } catch { /* cancelled */ }
  };
  return <FieldShell field={field} error={error}>{id => <span style={{display: 'flex', gap: 8}}>
    <input id={id} className="sf-text" style={{flex: 1}} value={typeof value === 'string' ? value : ''} disabled={disabled} aria-invalid={!!error || undefined} onChange={e => onChange(e.target.value)}/>
    <button type="button" className="sf-button" disabled={disabled} onClick={browse} title="Browse for a file">Browse…</button>
  </span>}</FieldShell>;
}

export default {fields: {url: Address}};
