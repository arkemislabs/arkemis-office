// Keyboard shortcuts: every key of the spec and the command it runs (printcraft crates/ui-egui/src/dialogs.rs, Help > Keyboard shortcuts, at 8f16855;
// MIT, see assets/third-party-licenses/artcraft-reference.txt). The label is the command's own label; a key whose command this window does not have
// is not listed.

import {useState, type ReactElement} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import type {FieldProps} from '../../../shell/fields/common';

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform ?? '');

function ShortcutList(_: FieldProps): ReactElement {
  const {controller} = useEngine();
  const [query, setQuery] = useState('');
  const rows = (controller.model?.spec.shortcuts ?? []).map(k => {
    const cmd = k.command ? controller.command(k.command) : null;
    return {keys: isMac ? (k as any).mac ?? k.keys : k.keys, label: cmd?.label ?? null, command: k.command};
  }).filter(r => r.label && (!query || `${r.label} ${r.keys}`.toLowerCase().includes(query.toLowerCase())));
  return <div className="sc-list" data-testid="shortcut-list">
    <input type="search" aria-label="Find a shortcut" placeholder="Find a shortcut" value={query} onChange={e => setQuery(e.target.value)}
      style={{width: '100%', boxSizing: 'border-box', height: 30, marginBottom: 8, padding: '0 10px', borderRadius: 8, border: '1px solid var(--sh-field-border)', background: 'var(--sh-field)', color: 'inherit', font: 'inherit'}}/>
    <div role="list" style={{maxHeight: 360, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 2}}>
      {rows.map((r, i) => <div key={i} role="listitem" data-command={r.command} style={{display: 'flex', justifyContent: 'space-between', gap: 24, padding: '5px 8px', borderRadius: 7}}>
        <span>{r.label}</span><kbd style={{font: '12px var(--ark-font)', color: 'var(--sh-text-2)'}}>{r.keys}</kbd></div>)}
      {!rows.length ? <div style={{padding: 12, color: 'var(--sh-text-3)'}}>No shortcut matches.</div> : null}
    </div>
  </div>;
}

export default {fields: {list: ShortcutList}};
