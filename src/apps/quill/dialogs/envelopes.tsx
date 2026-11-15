// Envelopes view (Mailings › Create › Envelopes): the delivery and return addresses on the left, a drawn Preview of the
// envelope (its size's proportions, the return address at the top left and the delivery address in the middle, a stamp
// box at the top right) on the right, and the Envelope size under both, over core/quill/dialogs/envelopes.mjs.
// No Feed or printing options: nothing prints from here (the model builds the envelope document only).

import {Field, grid, type BodyProps} from './font';
import {ENVELOPE_SIZES} from '../../../../core/quill/lib/mailings-labels.mjs';

const lines = (t: unknown, max: number) => String(t ?? '').split(/\r?\n/).filter(l => l.trim()).slice(0, max);

function Preview({d}: {d: BodyProps['dialog']}) {
  const sz = ENVELOPE_SIZES[Number(d.values.size) || 0] ?? ENVELOPE_SIZES[0];
  const [, w, h] = sz as unknown as [string, number, number];
  const W = 190, H = Math.max(70, Math.min(150, Math.round(W * (h / w))));
  const ret = d.values.omit ? [] : lines(d.values.ret, 4);
  const to = lines(d.values.delivery, 5);
  return <div className="sf" data-field-id="preview" data-kind="preview">
    <span className="sf-label">Preview</span>
    <div role="img" aria-label="Envelope preview" style={{height: 160, display: 'grid', placeItems: 'center', borderRadius: 10, background: '#e6e7ea'}}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <rect x={0.5} y={0.5} width={W - 1} height={H - 1} rx={3} fill="#fff" stroke="#9a9ca3"/>
        <rect x={W - 28} y={8} width={18} height={22} fill="none" stroke="#b4b6bd" strokeDasharray="2 2"/>
        {ret.length ? ret.map((l, i) => <text key={i} x={9} y={16 + i * 9} fontSize={7} fill="#3b3d42">{l.slice(0, 26)}</text>)
          : null}
        {to.length ? to.map((l, i) => <text key={i} x={W * 0.34} y={H * 0.5 + i * 10} fontSize={8} fill="#2b2d33">{l.slice(0, 28)}</text>)
          : [0, 1, 2].map(i => <rect key={i} x={W * 0.34} y={H * 0.5 - 4 + i * 10} width={i === 2 ? 40 : 70} height={3} rx={1.5} fill="#cfd1d6"/>)}
      </svg>
    </div>
  </div>;
}

function Body({dialog: d, setValue: set}: BodyProps) {
  return <div className="gd-fields" data-dialog-page="Envelopes">
    <div style={grid('minmax(0, 1.5fr) minmax(0, 1fr)', {alignItems: 'start'})}>
      <div style={{display: 'grid', gap: 8}}>
        <Field d={d} id="delivery" set={set}/>
        <Field d={d} id="omit" set={set}/>
        <Field d={d} id="ret" set={set}/>
      </div>
      <Preview d={d}/>
    </div>
    <div style={{marginTop: 12}}><Field d={d} id="size" set={set}/></div>
  </div>;
}

export default {Body};
