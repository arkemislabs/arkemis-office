// Enclose Characters view (Home › Font): Style (None / Shrink text / Enlarge symbol), Text, the
// Enclosure list and a preview of the enclosed characters, over core/quill/dialogs/enclose.mjs.
// Translated from wordcraft crates/ui-egui/src/dialogs/dispatch.rs `enclose_dialog` /
// `enclose_preview` at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import type {ReactElement} from 'react';
import {Field, grid, usePreview, type BodyProps} from './font';

const SHAPES: Record<string, (s: number) => ReactElement> = {
  circle: s => <circle cx={s / 2} cy={s / 2} r={s / 2 - 2} fill="none" stroke="#1b1b1d" strokeWidth={1.5}/>,
  square: s => <rect x={2} y={2} width={s - 4} height={s - 4} fill="none" stroke="#1b1b1d" strokeWidth={1.5}/>,
  triangle: s => <polygon points={`${s / 2},2 ${s - 2},${s - 3} 2,${s - 3}`} fill="none" stroke="#1b1b1d" strokeWidth={1.5}/>,
  diamond: s => <polygon points={`${s / 2},2 ${s - 2},${s / 2} ${s / 2},${s - 2} 2,${s / 2}`} fill="none" stroke="#1b1b1d" strokeWidth={1.5}/>,
};

function Body({dialog: d, setValue: set}: BodyProps) {
  const p = usePreview(d) ?? {};
  const shape = typeof p.shape === 'string' ? p.shape : null;
  const text = String(p.text ?? '');
  const size = 58;
  const scale = p.style === 'enlarge' ? 1 : 0.62;
  return <div className="gd-fields">
    <Field d={d} id="style" set={set}/>
    <div style={grid('minmax(0, 1fr) minmax(0, 1fr)', {alignItems: 'start', marginTop: 12})}>
      <div style={{display: 'grid', gap: 12}}>
        <Field d={d} id="text" set={set}/>
        <div className="sf" data-field-id="preview" data-kind="preview">
          <span className="sf-label">Preview</span>
          <div role="img" aria-label={`Preview: ${text} in a ${shape ?? 'no'} enclosure`} style={{display: 'grid', placeItems: 'center', height: 84, borderRadius: 10, background: '#fff', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.25)'}}>
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
              {shape && SHAPES[shape] ? SHAPES[shape](size) : null}
              <text x={size / 2} y={size / 2} textAnchor="middle" dominantBaseline="central" fontSize={(shape ? 30 * scale : 30) * (p.style === 'enlarge' ? 0.8 : 1)} fill="#1b1b1d">{text}</text>
            </svg>
          </div>
        </div>
      </div>
      <div style={{opacity: d.values.style === 'none' ? 0.5 : 1, pointerEvents: d.values.style === 'none' ? 'none' : undefined}}>
        <Field d={d} id="enclosure" set={set}/>
      </div>
    </div>
  </div>;
}

export default {Body};
