// Drop Cap view (Insert › Text › Drop Cap › Drop Cap Options…): Word's Position as three drawn tiles (None, Dropped,
// In margin), then Font, Lines to drop and Distance from text, over core/quill/dialogs/dropCap.mjs.

import {Field, grid, type BodyProps} from './font';
import './dropCap.css';

const TILES: {value: string; label: string}[] = [{value: 'none', label: 'None'}, {value: 'dropped', label: 'Dropped'}, {value: 'margin', label: 'In margin'}];

/** A little page: lines of text, with the big letter dropped into them or out in the margin. */
function Tile({kind}: {kind: string}) {
  const line = (x: number, y: number, w: number) => <rect key={`${x}-${y}`} x={x} y={y} width={w} height={2.4} rx={1.2} fill="currentColor" opacity={0.45}/>;
  const rows = (x: number, from: number, n: number, w: number) => Array.from({length: n}, (_, i) => line(x, from + i * 6, i === n - 1 ? w * 0.6 : w));
  return <svg viewBox="0 0 64 56" width={64} height={56} aria-hidden="true">
    <rect x={1} y={1} width={62} height={54} rx={4} fill="#fff" stroke="currentColor" strokeOpacity={0.35}/>
    <g color="#2b2d33">
      {kind === 'none' ? rows(9, 12, 6, 46) : null}
      {kind === 'dropped' ? <>
        <text x={9} y={31} fontSize={25} fontWeight={700} fill="#2b2d33" fontFamily="Georgia, serif">A</text>
        {rows(29, 11, 3, 26)}{rows(9, 33, 3, 46)}
      </> : null}
      {kind === 'margin' ? <>
        <text x={5} y={29} fontSize={22} fontWeight={700} fill="#2b2d33" fontFamily="Georgia, serif">A</text>
        {rows(24, 11, 6, 32)}
      </> : null}
    </g>
  </svg>;
}

function Body({dialog: d, setValue: set}: BodyProps) {
  const position = String(d.values.position ?? 'none');
  const off = position === 'none';
  return <div className="gd-fields dc-body" data-dialog-page="Drop Cap">
    <div className="sf-label" id="dc-position">Position:</div>
    <div className="dc-tiles" role="radiogroup" aria-labelledby="dc-position" data-field-id="position" data-kind="radio">
      {TILES.map(t => <label key={t.value} className={`dc-tile${position === t.value ? ' is-on' : ''}`} title={t.label}>
        <input type="radio" name="dc-position" checked={position === t.value} onChange={() => set('position', t.value)}/>
        <Tile kind={t.value}/>
        <span>{t.label}</span>
      </label>)}
    </div>
    <div style={grid('minmax(0, 1fr) minmax(0, 1fr)', {marginTop: 14, opacity: off ? 0.5 : 1, pointerEvents: off ? 'none' : undefined})}>
      <Field d={d} id="font" set={set}/>
      <Field d={d} id="lines" set={set}/>
      <Field d={d} id="distance" set={set}/>
    </div>
  </div>;
}

export default {Body};
