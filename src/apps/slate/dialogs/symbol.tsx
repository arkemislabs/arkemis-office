// Symbol view (Insert > Symbols > Symbol > More Symbols...): Font and Subset over a 16-column grid of
// the subset's characters drawn in the chosen font, the 20 recently used symbols, the Unicode
// code point of the selected one and the Character code in Unicode (hex), ASCII (decimal) or ASCII
// (hex), over core/slate/dialogs/symbol.mjs. Slate has no ArtCraft upstream.

import {useState} from 'react';
import {Field, grid, type BodyProps} from './shared';
import {SUBSETS, SPECIAL, NORMAL_TEXT, isControl} from '../../../../core/quill/dialogs/symbol.mjs';

const COLS = 16;
type Subset = [string, number, number];

function Body({dialog: d, setValue: set}: BodyProps) {
  const [page, setPage] = useState<'symbols' | 'special'>('symbols');
  const v = d.values as {font?: string; subset?: string; grid?: number; recent?: {ch: string; font: string}[]; unicodeName?: string};
  const subsets = SUBSETS as Subset[];
  const sub = subsets.find(([n]) => n === v.subset) ?? subsets[0];
  const chars: number[] = [];
  for (let cp = sub[1]; cp <= sub[2] && chars.length < COLS * 64; cp++) if (!isControl(cp)) chars.push(cp);
  const family = v.font && v.font !== NORMAL_TEXT ? `"${v.font}"` : undefined;
  const tabs = <div className="gd-tabs" role="tablist" aria-label="Symbol pages">
    {([['symbols', 'Symbols'], ['special', 'Special Characters']] as const).map(([k, name]) => <button key={k} type="button" role="tab" aria-selected={page === k} className={page === k ? 'is-active' : undefined} onClick={() => setPage(k)}>{name}</button>)}
  </div>;
  // Special Characters: the named characters (Em Dash, Copyright...); picking one selects it, Insert puts it on the page.
  if (page === 'special') return <div className="gd-fields" data-dialog-page="Special Characters">
    {tabs}
    <div role="listbox" aria-label="Special Characters" className="sf-list" style={{height: 280}}>
      {(SPECIAL as [string, string, string | null][]).map(([name, ch]) => {
        const cp = ch.codePointAt(0) ?? 0;
        return <div key={name} role="option" aria-selected={v.grid === cp} className={`sf-list-item${v.grid === cp ? ' is-selected' : ''}`} data-cp={cp} onClick={() => set('grid', cp)}>
          <span style={{width: 34, textAlign: 'center', fontSize: 16, marginRight: 10}}>{/\s/.test(ch) || cp === 0x200b || cp === 0x2060 || cp === 0xad ? '' : ch}</span><span className="sf-list-label">{name}</span>
          <span className="sf-list-detail">U+{cp.toString(16).toUpperCase().padStart(4, '0')}</span></div>;
      })}
    </div>
  </div>;
  return <div className="gd-fields" data-dialog-page="Symbols">
    {tabs}
    <div style={grid('minmax(0, 1fr) minmax(0, 1fr)')}>
      <Field d={d} id="font" set={set}/>
      <Field d={d} id="subset" set={set} options={subsets.map(([n]) => ({value: n, label: n}))}/>
    </div>
    <div role="grid" aria-label="Symbols" style={{display: 'grid', gridTemplateColumns: `repeat(${COLS}, 1fr)`, marginTop: 10, maxHeight: 220, overflowY: 'auto',
      border: '1px solid var(--sh-field-border, rgba(255,255,255,.16))', borderRadius: 8}}>
      {chars.map(cp => <button key={cp} type="button" role="gridcell" aria-selected={v.grid === cp} title={`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`}
        onClick={() => set('grid', cp)} data-cp={cp}
        style={{height: 30, fontSize: 18, fontFamily: family, border: 0, color: 'inherit', background: v.grid === cp ? 'var(--sh-checked, rgba(255,255,255,.18))' : 'transparent', cursor: 'default'}}>
        {String.fromCodePoint(cp)}</button>)}
    </div>
    <div className="sf" style={{marginTop: 10}}>
      <span className="sf-label">Recently used symbols:</span>
      <div style={{display: 'flex', gap: 4, flexWrap: 'wrap'}}>{(v.recent ?? []).map((r, i) => <button key={i} type="button" onClick={() => set('recentlyUsed', r.ch)}
        style={{width: 30, height: 30, fontSize: 18, color: 'inherit', background: 'transparent', border: '1px solid var(--sh-field-border, rgba(255,255,255,.16))', borderRadius: 6, fontFamily: r.font ? `"${r.font}"` : undefined}}>{r.ch}</button>)}</div>
    </div>
    <div className="sf-note" style={{marginTop: 8}}>{v.unicodeName ?? ''}</div>
    <div style={grid('minmax(0, 1fr) minmax(0, 1fr)', {marginTop: 8})}><Field d={d} id="characterCode" set={set}/><Field d={d} id="from" set={set}/></div>
  </div>;
}

export default {Body};
