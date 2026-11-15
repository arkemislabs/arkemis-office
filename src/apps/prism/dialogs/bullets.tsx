// Bullets and Numbering as deckcraft draws it (crates/ui-egui/src/dialogs/body.rs `dlg_bullets` at
// f893f6af7d36a5409fd804e81a34fd895cfefedf): the Bulleted / Numbered pages, a grid of style tiles
// (five bullets or four numbering styles a row, the chosen one pressed), then Custom character or
// Start at, Size (% of text) and Color. The open page is the dialog's `kind` value, so OK applies
// the list of the page the person sees (deckcraft keeps it in the dialog's `tab` field).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import type {DialogState} from '../../../shell/dialogs/dialogState';
import {NumberField, SelectField, TextField} from '../../../shell/fields';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const v = d.values;
  const numbered = v.kind === 'numbered';
  const page = d.spec.tabs[numbered ? 1 : 0] ?? d.spec.tabs[0];
  const field = (id: string) => page.fields.find(f => f.id === id)!;
  const styles = field(numbered ? 'scheme' : 'char');
  const current = v[numbered ? 'scheme' : 'char'];
  const errorOf = (id: string) => d.errors.find(e => e.field === id)?.message ?? null;
  return <div className="gd-fields">
    <div className="gd-tabs" role="tablist" aria-label="Bullets and Numbering pages">
      {(['bulleted', 'numbered'] as const).map((k, i) => <button key={k} type="button" role="tab" aria-selected={(v.kind ?? 'bulleted') === k}
        className={(v.kind ?? 'bulleted') === k ? 'is-active' : undefined} onClick={() => setValue('kind', k)}>{d.spec.tabs[i]?.name ?? k}</button>)}
    </div>
    <div className="sf" data-field-id={styles.id} data-kind="tiles">
      <span className="sf-label">{styles.label}</span>
      <div role="radiogroup" aria-label={styles.label}
        style={{display: 'grid', gridTemplateColumns: `repeat(${numbered ? 4 : 5}, minmax(0, 1fr))`, gap: 6}}>
        <button type="button" role="radio" aria-checked={!!v.none} aria-label="None" data-tile="none" className={`gd-button${v.none ? ' gd-primary' : ''}`} disabled={d.busy}
          style={{height: 44, fontSize: 13, padding: 0}} onClick={() => setValue('none', true)}>None</button>
        {styles.options.map(o => <button key={String(o.value)} type="button" role="radio" aria-checked={!v.none && current === o.value} aria-label={o.label}
          className={`gd-button${!v.none && current === o.value ? ' gd-primary' : ''}`} disabled={d.busy}
          style={{height: 44, fontSize: 16, padding: 0}} onClick={() => setValue(styles.id, o.value)}>{o.label}</button>)}
      </div>
    </div>
    <div className="gd-grid" style={{gridTemplateColumns: 'repeat(2, minmax(0, 1fr))'}}>
      {numbered
        ? <NumberField field={field('start')} value={v.start} onChange={x => setValue('start', x)} error={errorOf('start')} disabled={d.busy}/>
        : <TextField field={field('custom')} value={v.custom} onChange={x => setValue('custom', x)} error={errorOf('custom')} disabled={d.busy}/>}
      <NumberField field={field('size')} value={v.size} onChange={x => setValue('size', x)} error={errorOf('size')} disabled={d.busy}/>
      <SelectField field={field('color')} value={v.color} onChange={x => setValue('color', x)} error={errorOf('color')} disabled={d.busy}/>
    </div>
  </div>;
}

export default {Body};
