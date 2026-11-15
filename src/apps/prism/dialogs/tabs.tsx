// The Tabs dialog's stop list as deckcraft draws it (crates/ui-egui/src/dialogs/tabs.rs at
// f893f6af7d36a5409fd804e81a34fd895cfefedf): one row per stop, its position in inches, its
// alignment and Clear; under it Tab stop position with Left / Center / Right / Decimal and Set, then
// Clear All. Values only change the dialog; OK sends format.tabs {set, defaultTab}.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useState} from 'react';
import type {FieldProps} from '../../../shell/fields';
import {setStop} from '../../../../core/prism/dialogs/tabs.mjs';

type Stop = {pos: number; align: 'l' | 'ctr' | 'r' | 'dec'};
const ALIGNS: [Stop['align'], string][] = [['l', 'Left'], ['ctr', 'Center'], ['r', 'Right'], ['dec', 'Decimal']];
const label = (a: string) => ALIGNS.find(x => x[0] === a)?.[1] ?? 'Left';
const inches = (v: number) => `${Math.round(v * 100) / 100}"`;
const row = {display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto', gap: 12, alignItems: 'center'} as const;

function Stops({field, value, onChange, disabled}: FieldProps) {
  const stops = (Array.isArray(value) ? value : []) as Stop[];
  const [pos, setPos] = useState('');
  const [align, setAlign] = useState<Stop['align']>('l');
  const [error, setError] = useState<string | null>(null);
  const set = () => {
    const n = Number.parseFloat(pos.replace(/["in\s]+$/i, ''));
    if (!Number.isFinite(n) || n < 0) { setError('Tab stop position must be a number of inches'); return; }
    setError(null);
    onChange(setStop(stops, n, align));
    setPos('');
  };
  return <div className="sf" data-field-id={field.id} data-kind="list" style={{gap: 10}}>
    <span className="sf-label">Tab stops:</span>
    <div className="sf-list" role="listbox" aria-label="Tab stops" tabIndex={0} style={{minHeight: 112, maxHeight: 168, overflowY: 'auto'}}>
      {stops.length ? stops.map((s, i) => <div key={`${s.pos}-${i}`} role="option" aria-selected={false} className="sf-list-item" data-stop={s.pos} style={row}>
        <span>{inches(s.pos)}</span><span>{label(s.align)}</span>
        <button type="button" className="gd-button" disabled={disabled} onClick={() => onChange(stops.filter((_, j) => j !== i))}>Clear</button>
      </div>) : <div className="sf-list-item" aria-disabled="true" style={{opacity: 0.6}}>No tab stops</div>}
    </div>
    <div style={{display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'end'}}>
      <div className="sf">
        <label className="sf-label" htmlFor="prism-tab-pos">{field.label.replace(/:?$/, ' (in):')}</label>
        <input id="prism-tab-pos" className="sf-text" value={pos} disabled={disabled} onChange={e => setPos(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); set(); } }}/>
      </div>
      <button type="button" className="gd-button" disabled={disabled} onClick={set}>Set</button>
    </div>
    <fieldset className="sf sf-radio">
      <legend className="sf-label">Alignment:</legend>
      <div className="sf-radio-options is-grid" role="radiogroup">
        {ALIGNS.map(([k, l]) => <label key={k}><input type="radio" name="prism-tab-align" checked={align === k} disabled={disabled} onChange={() => setAlign(k)}/>
          <span className="sf-radio-dot" aria-hidden="true"/><span>{l}</span></label>)}
      </div>
    </fieldset>
    <div><button type="button" className="gd-button" disabled={disabled || !stops.length} onClick={() => onChange([])}>Clear All</button></div>
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
  </div>;
}

export default {fields: {stops: Stops}};
