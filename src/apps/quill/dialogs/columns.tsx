// Columns dialog view (Layout › Columns › More Columns…): Word's preset tiles, Number of columns and
// Line between, the Width and spacing grid, Equal column width, the page preview and Apply to,
// over core/quill/dialogs/columns.mjs. Layout from wordcraft crates/ui-egui/src/dialogs/
// dialogs_insert/columns.rs `columns_ui`, `preset_tile`, `columns_preview` at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useState} from 'react';
import {Field, Group, grid, usePreview, type BodyProps} from './font';
import {editColumn, currentPreset, APPLY} from '../../../../core/quill/dialogs/columns.mjs';
import {parseNumber, formatNumber} from '../../../shell/dialogs/dialogState';

type Col = [number, number];
const PRESETS: [string, string, number[]][] = [['one', 'One', [1]], ['two', 'Two', [1, 1]], ['three', 'Three', [1, 1, 1]], ['left', 'Left', [1, 2]], ['right', 'Right', [2, 1]]];

function Tile({label, widths, on, onPick}: {label: string; widths: number[]; on: boolean; onPick: () => void}) {
  const total = widths.reduce((a, b) => a + b, 0);
  const gap = 3.5, inner = 18, avail = inner - gap * (widths.length - 1);
  let x = 4;
  return <button type="button" role="option" aria-selected={on} aria-label={label} onClick={onPick} className={`sf-button${on ? ' is-selected' : ''}`}
    style={{display: 'grid', justifyItems: 'center', gap: 3, padding: '6px 8px', height: 'auto', outline: on ? '2px solid var(--accent, #2f6fdf)' : undefined}}>
    <svg width={26} height={38} viewBox="0 0 26 38" aria-hidden="true">
      <rect x={0.5} y={0.5} width={25} height={37} fill="#fff" stroke="#8d9098"/>
      {widths.map((w, i) => { const cw = avail * w / total; const x0 = x; x += cw + gap;
        return Array.from({length: 9}, (_, r) => <line key={`${i}-${r}`} x1={x0} x2={x0 + cw} y1={5 + r * 3.3} y2={5 + r * 3.3} stroke="#6b6e76" strokeWidth={1}/>); })}
    </svg>
    <span style={{fontSize: 11}}>{label}</span>
  </button>;
}

function ColumnsPreview({p}: {p: {textWidth: number; cols: Col[]; separator: boolean} | null}) {
  const tw = Math.max(0.1, p?.textWidth ?? 6.5);
  const inner = 66, scale = inner / tw;
  let x = 9;
  const cols = p?.cols ?? [];
  return <div className="sf" data-field-id="preview" data-kind="preview">
    <span className="sf-label">Preview</span>
    <div role="img" aria-label="Columns preview" style={{height: 130, display: 'grid', placeItems: 'center', borderRadius: 10, background: '#e6e7ea'}}>
      <svg width={84} height={110} viewBox="0 0 84 110" aria-hidden="true">
        <rect x={0.5} y={0.5} width={83} height={109} fill="#fff" stroke="#9a9ca3"/>
        {cols.map(([w, sp], i) => {
          const cw = Math.max(2, w * scale), x0 = x;
          x += cw;
          const gapX = x; const gap = i + 1 < cols.length ? sp * scale : 0;
          x += gap;
          return <g key={i}>
            {Array.from({length: 23}, (_, r) => <line key={r} x1={x0} x2={Math.min(x0 + cw, 75)} y1={10 + r * 4} y2={10 + r * 4} stroke="#8d9098" strokeWidth={1.2}/>)}
            {p?.separator && i + 1 < cols.length ? <line x1={gapX + gap / 2} x2={gapX + gap / 2} y1={9} y2={100} stroke="#3b3d42" strokeWidth={1}/> : null}
          </g>;
        })}
      </svg>
    </div>
  </div>;
}

/** One width or spacing box of the grid: typed in inches, applied on Enter or leaving the box. */
function LengthBox({value, disabled, label, onCommit}: {value: number; disabled: boolean; label: string; onCommit: (v: number) => void}) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? formatNumber(Math.round(value * 100) / 100, 'in');
  const commit = () => { if (text === null) return; const v = parseNumber(text, 'in'); setText(null); if (v !== null) onCommit(v); };
  return <input className="sf-text" aria-label={label} disabled={disabled} value={shown} style={{width: 86}}
    onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(); } }}/>;
}

function Body({dialog: d, setValue: set}: BodyProps) {
  const p = usePreview(d) as {textWidth: number; cols: Col[]; separator: boolean} | null;
  const v = d.values as Record<string, any>;
  const form = {count: v.count, equal: !!v.equal, cols: (v.cols ?? []) as Col[], separator: !!v.separator, applyTo: v.applyTo, textWidth: v._textWidth};
  const current = currentPreset(form);
  const edit = (i: number, w?: number, sp?: number) => { const f = editColumn(form, i, w, sp); set('cols', f.cols); };
  const choices = (v._applyChoices ?? Object.keys(APPLY)) as string[];
  return <div className="gd-fields" data-dialog-page="Columns">
    <Group title="Presets">
      <div role="listbox" aria-label="Presets" style={{display: 'flex', gap: 8}}>
        {PRESETS.map(([k, label, widths]) => <Tile key={k} label={label} widths={widths} on={current === k} onPick={() => set('presets', k)}/>)}
      </div>
    </Group>
    <div style={grid('minmax(0, 1fr) minmax(0, 1fr)', {marginBottom: 10})}>
      <Field d={d} id="count" set={set}/>
      <Field d={d} id="separator" set={set}/>
    </div>
    <div style={grid('minmax(0, 1.5fr) minmax(0, 1fr)', {alignItems: 'start'})}>
      <Group title="Width and spacing">
        <div className="sf" data-field-id="cols" data-kind="list" style={{maxHeight: 150, overflow: 'auto'}}>
          <div style={{display: 'grid', gridTemplateColumns: '44px 96px 96px', gap: '4px 8px', alignItems: 'center', fontSize: 12}}>
            <span>Col #:</span><span>Width:</span><span>Spacing:</span>
            {form.cols.map(([w, sp], i) => [
              <span key={`n${i}`}>{i + 1}:</span>,
              <LengthBox key={`w${i}-${w}`} label={`Column ${i + 1} width`} value={w} disabled={form.equal && i > 0} onCommit={x => edit(i, x)}/>,
              i + 1 < form.cols.length ? <LengthBox key={`s${i}-${sp}`} label={`Column ${i + 1} spacing`} value={sp} disabled={form.equal && i > 0} onCommit={x => edit(i, undefined, x)}/> : <input key={`s${i}`} className="sf-text" aria-label={`Column ${i + 1} spacing`} disabled value="" readOnly style={{width: 86}}/>,
            ])}
          </div>
        </div>
        <div style={{marginTop: 8}}><Field d={d} id="equal" set={set}/></div>
      </Group>
      <ColumnsPreview p={p}/>
    </div>
    <div style={grid('minmax(0, 1fr) minmax(0, 1fr)')}>
      <Field d={d} id="applyTo" set={set} options={choices.map(c => ({value: c, label: (APPLY as Record<string, string>)[c]}))}/>
      <div/>
    </div>
  </div>;
}

export default {Body};
