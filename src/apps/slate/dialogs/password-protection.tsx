// Password Protection pane (Review > Section > Password): the model's preview carries two texts, the
// current section's state and the notes on passwords; each of the spec's two preview fields shows its own.

import type {ComponentType} from 'react';
import type {SpecField} from '../../../generated/spec-types';

function Preview({preview, field}: {values: Record<string, unknown>; preview: unknown; field: SpecField}) {
  const text = String((preview as Record<string, unknown> | null)?.[field.id] ?? '');
  return <div data-field-id={field.id} data-kind="preview">
    <div className="sf-label">{field.id === 'notes' ? 'Notes on Passwords' : 'Current section'}</div>
    <div className="sf-note" style={{whiteSpace: 'pre-wrap', margin: '2px 0 10px', ...(field.id === 'notes' ? {} : {color: 'var(--sh-text-1, #f2f2f3)', fontWeight: 600})}}>{text}</div>
  </div>;
}

export default {Preview: Preview as ComponentType<{values: Record<string, unknown>; preview: unknown; field: SpecField}>};
