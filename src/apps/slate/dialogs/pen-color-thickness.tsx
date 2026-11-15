// Color & Thickness view (Draw > Pens > Color & Thickness...): the pen's Type, nine Thicknesses drawn
// as lines of their own width, the Color swatches (Galaxy and Rainbow drawn as their gradients) with
// More colors, and a sample stroke in the pen as it will draw, over core/slate/dialogs/pen-color-
// thickness.mjs. Slate has no ArtCraft upstream.

import {Field, grid, type BodyProps} from './shared';
import {MM, PEN_COLORS as COLORS, PEN_FX as FX, THICKNESSES} from '../../../../core/slate/lib/ink.mjs';

const PEN_COLORS: Record<string, string> = COLORS;
const PEN_FX: Record<string, string> = FX;

const GRADIENT: Record<string, string> = {
  Galaxy: 'linear-gradient(135deg, #2a1d7a, #6a3fd0, #c25ad8, #4aa3ff)',
  Rainbow: 'linear-gradient(90deg, #ff3b30, #ff9500, #ffd60a, #34c759, #0a84ff, #af52de)',
  Gold: 'linear-gradient(135deg, #f7e08a, #c9a227, #8a6b12)',
  Silver: 'linear-gradient(135deg, #f1f1f3, #a8a9ad, #6d6e72)',
  Bronze: 'linear-gradient(135deg, #e0a56c, #a0662b, #6a3f14)',
};

function Body({dialog: d, setValue: set}: BodyProps) {
  const v = d.values as {penType?: string; thickness?: string; color?: string | null; customColor?: string};
  const hex = v.color && PEN_COLORS[v.color] ? PEN_COLORS[v.color] : v.customColor ?? '#000000';
  const mm = Number.parseFloat(v.thickness ?? '0.5') || 0.5;
  const fx = v.color && PEN_FX[v.color] ? v.color : null;
  const highlighter = v.penType === 'Highlighter';
  return <div className="gd-fields" data-dialog-page="Pen">
    <Field d={d} id="penType" set={set}/>
    <div className="sf-label" style={{marginTop: 12}}>Thickness</div>
    <div role="radiogroup" aria-label="Thickness" style={{display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6, marginTop: 4}}>
      {THICKNESSES.map(t => {
        const on = Number.parseFloat(v.thickness ?? '') === t;
        return <button key={t} type="button" role="radio" aria-checked={on} aria-label={`${t} mm`} title={`${t} mm`} data-thickness={t} onClick={() => set('thickness', `${t} mm`)}
          style={{height: 34, border: on ? '1.5px solid var(--sh-focus, #aacbff)' : '1px solid var(--sh-field-border, rgba(255,255,255,.16))', borderRadius: 8, background: on ? 'var(--sh-checked, rgba(255,255,255,.14))' : 'transparent', cursor: 'default', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', color: 'inherit'}}>
          <span style={{flex: 1, height: Math.max(1, Math.min(12, t * MM)), borderRadius: 6, background: 'currentColor', opacity: highlighter ? 0.55 : 1}}/>
          <span style={{fontSize: 11, opacity: .75, minWidth: 38, textAlign: 'right'}}>{t} mm</span>
        </button>;
      })}
    </div>
    <div className="sf-label" style={{marginTop: 12}}>Color</div>
    <div role="listbox" aria-label="Color" style={{display: 'grid', gridTemplateColumns: 'repeat(9, 1fr)', gap: 6, marginTop: 4}}>
      {Object.keys(PEN_COLORS).map(name => {
        const on = v.color === name;
        return <button key={name} type="button" role="option" aria-selected={on} aria-label={name} title={name} data-color={name} onClick={() => set('color', name)}
          style={{height: 28, borderRadius: 7, border: on ? '2px solid var(--sh-focus, #aacbff)' : '1px solid rgba(255,255,255,.25)', background: GRADIENT[name] ?? PEN_COLORS[name], cursor: 'default', padding: 0}}/>;
      })}
    </div>
    <div style={grid('minmax(0, 1fr)', {marginTop: 10})}><Field d={d} id="customColor" set={set}/></div>
    <div style={{marginTop: 12, height: 64, borderRadius: 8, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center'}} aria-label="Sample">
      <svg width="260" height="48" viewBox="0 0 260 48" aria-hidden="true">
        <path d="M10 34 C 60 4, 100 44, 150 20 S 230 12, 250 28" fill="none" stroke={fx ? 'url(#pen-sample)' : hex} strokeWidth={Math.max(1, mm * MM)} strokeLinecap="round" opacity={highlighter ? 0.55 : 1}/>
        <defs><linearGradient id="pen-sample" x1="0" x2="1">{(fx === 'Galaxy' ? ['#2a1d7a', '#6a3fd0', '#c25ad8', '#4aa3ff'] : ['#ff3b30', '#ff9500', '#ffd60a', '#34c759', '#0a84ff', '#af52de']).map((c, i, a) => <stop key={i} offset={`${(i / (a.length - 1)) * 100}%`} stopColor={c}/>)}</linearGradient></defs>
      </svg>
    </div>
  </div>;
}

export default {Body};
