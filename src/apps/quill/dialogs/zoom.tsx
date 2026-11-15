// Zoom dialog view (View › Zoom, the status bar's percent): Word's layout. Zoom to in two columns
// (200%, 100%, 75% | Page width, Text width, Whole page, Many pages), Percent, and the Preview: a
// screen with the page at that zoom and a line of sample text at that size. Over the common model
// core/common/dialogs/zoom.mjs (submit view.zoom); upstream wordcraft dispatch.rs:788 (zoom) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, usePreview, type BodyProps} from './font';

const LEFT: [string, string][] = [['200%', '200%'], ['100%', '100%'], ['75%', '75%']];
const RIGHT: [string, string][] = [['pageWidth', 'Page width'], ['textWidth', 'Text width'], ['onePage', 'Whole page'], ['multiplePages', 'Many pages']];

function Radio({value, label, on, set}: {value: string; label: string; on: boolean; set: BodyProps['setValue']}) {
  return <label data-option={value}>
    <input type="radio" name="zoom-preset" checked={on} onChange={() => set('preset', value)}/>
    <span className="sf-radio-dot" aria-hidden="true"/>
    <span>{label}</span>
  </label>;
}

/** Word's preview: the window (a screen) with the page(s) at the zoom, and the sample text at that size. */
function ZoomPreview({p}: {p: {pageW: number; pageH: number; textW: number; percent: number; fit: string | null} | null}) {
  const pageW = p?.pageW ?? 612, pageH = p?.pageH ?? 792, textW = p?.textW ?? 468;
  const pct = p?.percent ?? 100, fit = p?.fit ?? null;
  // The screen shows about 900 pt of width at 100%; the page is drawn at the zoom within it.
  const screenW = 104, screenH = 70;
  const k = screenW / 900;
  const scaleFor = () => {
    if (fit === 'pageWidth') return (screenW - 8) / pageW;
    if (fit === 'textWidth') return (screenW - 4) / textW;
    if (fit === 'onePage') return Math.min((screenW - 8) / pageW, (screenH - 6) / pageH);
    if (fit === 'multiplePages') return Math.min((screenW - 12) / (2 * pageW), (screenH - 6) / pageH);
    return k * pct / 100;
  };
  const s = scaleFor();
  const n = fit === 'multiplePages' ? 2 : 1;
  const pw = pageW * s, ph = pageH * s, gap = 4;
  const x0 = fit === 'textWidth' ? (screenW - textW * s) / 2 - (pageW - textW) / 2 * s : (screenW - (n * pw + (n - 1) * gap)) / 2;
  const sample = Math.max(5, Math.min(26, 10 * (fit ? s / k : pct / 100)));
  return <div className="sf" data-field-id="preview" data-kind="preview" style={{display: 'grid', gap: 6}}>
    <span className="sf-label">Preview</span>
    <div role="img" aria-label="Zoom preview" style={{display: 'grid', gridTemplateColumns: '128px 1fr', alignItems: 'center', gap: 10, height: 104, padding: '0 10px',
      borderRadius: 10, background: '#e6e7ea', overflow: 'hidden'}}>
      <svg width={124} height={96} viewBox="0 0 124 96" aria-hidden="true">
        <rect x={9.5} y={4.5} width={screenW + 1} height={screenH + 1} rx={3} fill="#5a5d66" stroke="#43464d"/>
        <svg x={10} y={5} width={screenW} height={screenH} viewBox={`0 0 ${screenW} ${screenH}`}>
          <rect width={screenW} height={screenH} fill="#c9cbd1"/>
          {Array.from({length: n}, (_, i) => <g key={i}>
            <rect x={x0 + i * (pw + gap)} y={3} width={pw} height={ph} fill="#fff" stroke="#8d9098" strokeWidth={0.5}/>
            {Array.from({length: Math.max(0, Math.min(40, Math.floor((ph - 8 * s * 9) / Math.max(3.2, 14 * s))))}, (_, r) =>
              <line key={r} x1={x0 + i * (pw + gap) + 72 * s} x2={x0 + i * (pw + gap) + (72 + Math.min(textW, (r % 3 === 2 ? 0.7 : 1) * textW)) * s}
                y1={3 + 72 * s + r * Math.max(3.2, 14 * s)} y2={3 + 72 * s + r * Math.max(3.2, 14 * s)} stroke="#9a9ca3" strokeWidth={Math.max(0.6, 2.2 * s)}/>)}
          </g>)}
        </svg>
        <rect x={52} y={77} width={20} height={6} fill="#5a5d66"/>
        <rect x={42} y={83} width={40} height={4} rx={1.5} fill="#5a5d66"/>
      </svg>
      <div style={{minWidth: 0, height: '100%', display: 'flex', alignItems: 'center', background: '#fff', borderRadius: 6, padding: '0 10px', overflow: 'hidden',
        color: '#111', fontFamily: 'Calibri, Carlito, sans-serif', fontSize: sample, whiteSpace: 'nowrap'}}>AaBbCcDdEeXxYyZz</div>
    </div>
  </div>;
}

function Body({dialog: d, setValue: set}: BodyProps) {
  const p = usePreview(d) as {pageW: number; pageH: number; textW: number; percent: number; fit: string | null} | null;
  const preset = String(d.values.preset ?? '');
  return <div className="gd-body" style={{display: 'grid', gap: 12}}>
    <fieldset className="sf sf-radio" data-field-id="preset" data-kind="radio" style={{margin: 0}}>
      <legend className="sf-label">Zoom to</legend>
      <div role="radiogroup" aria-label="Zoom to" style={{display: 'grid', gridTemplateColumns: '1fr 1.3fr', gap: '0 18px'}}>
        <div className="sf-radio-options">{LEFT.map(([v, l]) => <Radio key={v} value={v} label={l} on={preset === v} set={set}/>)}</div>
        <div className="sf-radio-options">{RIGHT.map(([v, l]) => <Radio key={v} value={v} label={l} on={preset === v} set={set}/>)}</div>
      </div>
    </fieldset>
    <div style={{display: 'grid', gridTemplateColumns: '120px minmax(0, 1fr)', gap: 14, alignItems: 'start'}}>
      <Field d={d} id="percent" set={set}/>
      <ZoomPreview p={p}/>
    </div>
  </div>;
}

export default {Body};
