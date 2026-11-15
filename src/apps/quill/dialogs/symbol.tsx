// Symbol view (Insert › Symbols › Symbol › More Symbols…): Font and Subset over a 16-column grid of
// the subset's characters drawn in the chosen font, Recently used symbols, Character code; the
// Special Characters page lists Word's, over core/quill/dialogs/symbol.mjs (wordcraft
// dialogs_insert/symbol.rs `symbol_ui`, `special_ui`). MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, PageTabs, grid, type BodyProps} from './font';
import {SUBSETS, NORMAL_TEXT, isControl} from '../../../../core/quill/dialogs/symbol.mjs';

const COLS = 16;
type Subset = [string, number, number];

function Body({dialog: d, setValue: set}: BodyProps) {
  const v = d.values as {font?: string; subset?: string; grid?: number; recentSymbols?: {ch: string; font: string}[]};
  const subsets = SUBSETS as Subset[];
  const sub = subsets.find(([n]) => n === v.subset) ?? subsets[0];
  const chars: number[] = [];
  for (let cp = sub[1]; cp <= sub[2] && chars.length < COLS * 64; cp++) if (!isControl(cp)) chars.push(cp);
  const family = v.font && v.font !== NORMAL_TEXT ? `"${v.font}"` : undefined;
  if (d.tab === 1) return <div className="gd-fields"><PageTabs dialog={d}/><Field d={d} id="list" set={set}/></div>;
  return <div className="gd-fields">
    <PageTabs dialog={d}/>
    <div style={grid('minmax(0, 1fr) minmax(0, 1fr)')}>
      <Field d={d} id="font" set={set}/>
      <Field d={d} id="subset" set={set} options={subsets.map(([n]) => ({value: n, label: n}))}/>
    </div>
    <div role="grid" aria-label="Symbols" style={{display: 'grid', gridTemplateColumns: `repeat(${COLS}, 1fr)`, marginTop: 10, maxHeight: 240, overflowY: 'auto',
      border: '1px solid var(--glass-border, rgba(0,0,0,.15))', borderRadius: 8}}>
      {chars.map(cp => <button key={cp} type="button" role="gridcell" aria-selected={v.grid === cp} title={`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`}
        onClick={() => set('grid', cp)}
        style={{height: 30, fontSize: 18, fontFamily: family, border: 0, background: v.grid === cp ? 'var(--accent-soft, rgba(80,120,255,.25))' : 'transparent', cursor: 'default'}}>
        {String.fromCodePoint(cp)}</button>)}
    </div>
    <div className="sf" style={{marginTop: 10}}>
      <span className="sf-label">Recently used symbols:</span>
      <div style={{display: 'grid', gridTemplateColumns: `repeat(${COLS}, 1fr)`, gap: 3}} role="group" aria-label="Recently used symbols">
        {Array.from({length: COLS}, (_, i) => {
          const r = (v.recentSymbols ?? [])[i];
          const box = {height: 30, borderRadius: 5, border: '1px solid var(--glass-border, rgba(255,255,255,.16))'};
          return r ? <button key={i} type="button" onClick={() => set('recent', r.ch)}
            style={{...box, fontSize: 18, fontFamily: r.font ? `"${r.font}"` : undefined, background: 'transparent', color: 'inherit'}}>{r.ch}</button>
            : <span key={i} aria-hidden="true" style={box}/>;
        })}
      </div>
    </div>
    <div style={grid('minmax(0, 1fr) minmax(0, 1fr)', {marginTop: 10})}><Field d={d} id="code" set={set}/><Field d={d} id="from" set={set}/></div>
  </div>;
}

export default {Body};
