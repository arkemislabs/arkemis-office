// Colors as Office draws it: Standard (the honeycomb of colours and the strip of greys) and Custom (the colour
// square, lightness, Hex and RGB), with the New and Current colours side by side. Excel behaviour.

import {useMemo, useState} from 'react';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {ColorPickerField} from '../../../shell/fields';
import {honeycomb} from '../../../../core/grid/dialogs/colors.mjs';
import {Tabs} from './dataKit';
import {sp, type SetValue} from './cfKit';

const R = 9.4, DX = R * 1.732, DY = R * 1.5;

function Honeycomb({value, onPick}: {value: string; onPick: (hex: string) => void}) {
  const {rows, greys} = useMemo(() => honeycomb() as {rows: string[][]; greys: string[]}, []);
  const hexPath = (cx: number, cy: number) => Array.from({length: 6}, (_, k) => { const a = Math.PI / 6 + k * Math.PI / 3; return `${(cx + R * Math.cos(a)).toFixed(1)},${(cy + R * Math.sin(a)).toFixed(1)}`; }).join(' ');
  const W = 13 * DX + 6, H = 13 * DY + R + 4;
  return <div className="co-honey" data-field-id="color">
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="listbox" aria-label="Colors">
      {rows.map((row, r) => row.map((hex, i) => {
        const cx = W / 2 + (i - (row.length - 1) / 2) * DX, cy = R + 2 + r * DY;
        return <polygon key={`${r}-${i}`} points={hexPath(cx, cy)} fill={hex} role="option" aria-selected={hex.toLowerCase() === value.toLowerCase()} aria-label={hex}
          stroke={hex.toLowerCase() === value.toLowerCase() ? '#fff' : 'rgba(0,0,0,.25)'} strokeWidth={hex.toLowerCase() === value.toLowerCase() ? 2 : 0.6} onClick={() => onPick(hex)}/>;
      }))}
    </svg>
    <div className="co-greys" role="listbox" aria-label="Grays">
      {greys.map(hex => <button key={hex} type="button" role="option" aria-selected={hex.toLowerCase() === value.toLowerCase()} aria-label={hex} className={hex.toLowerCase() === value.toLowerCase() ? 'is-selected' : undefined}
        style={{background: hex}} onClick={() => onPick(hex)}/>)}
    </div>
  </div>;
}

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const [tab, setTab] = useState(0);
  const color = String(d.values.color ?? '#000000');
  const current = String(d.values.current ?? '');
  return <div className="gd-fields cf-root">
    <Tabs names={['Standard', 'Custom']} current={tab} onPick={setTab} label="Colors pages"/>
    {tab === 0 ? <Honeycomb value={color} onPick={hex => setValue('color', hex)}/>
      : <ColorPickerField field={sp('color', 'Colors', 'colorPicker')} value={color} onChange={v => setValue('color', v)} error={null} disabled={d.busy}/>}
    <div className="co-compare" data-field-id="preview" aria-label="New and current color">
      <div><span>New</span><i style={{background: color}}/></div>
      <div><span>Current</span><i style={current ? {background: current} : undefined} className={current ? undefined : 'is-none'}/></div>
    </div>
  </div>;
}

export default {Body};
