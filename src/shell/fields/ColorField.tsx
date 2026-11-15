// ColorField: a swatch button opening the Office palette; More Colors… opens the nested color
// dialog (section 9.2: a field's dialog opens on the stack and returns its value here).
// ColorPickerField: the More Colors body (hue/saturation square, lightness, hex and RGB).

import {useRef, useState, type PointerEvent as RPointerEvent} from 'react';
import {FieldShell, type FieldProps} from './common';
import {ColorPalette, hexToHsl, hslToHex} from '../common/ColorPalette';
import {Flyout} from '../common/Flyout';
import {Glyph} from '../icons/Icon';

const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

export function ColorField({field, value, onChange, error, disabled, onNested}: FieldProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const auto = field.options.some(o => /automatic/i.test(String(o.value))) ? 'Automatic' : field.options.some(o => /no color|none/i.test(String(o.value))) ? 'No Color' : 'Automatic';
  // `swatch`: Office's colour button with no name beside it (Set Up Show's Pen color, Laser pointer color): the chip and the arrow.
  const swatch = (field as {swatch?: unknown}).swatch === true;
  const text = isHex(value) ? value.toUpperCase() : value === null || value === undefined || value === 'auto' ? auto : String(value);
  return <FieldShell field={field} error={error}>{id => <>
    <button ref={anchor} id={id} type="button" className={`sf-color${swatch ? ' is-swatch' : ''}`} title={isHex(value) ? value.toUpperCase() : undefined} disabled={disabled} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(o => !o)}>
      <span className={`sf-color-chip${isHex(value) ? '' : ' is-auto'}`} style={isHex(value) ? {background: value} : undefined}/>
      {swatch ? <span className="sf-color-text" style={{flex: 1}}/> : <span className="sf-color-text">{text}</span>}
      <Glyph name="chevron-down" size={10}/>
    </button>
    <Flyout anchor={anchor} open={open} onClose={() => setOpen(false)} label={field.label} role="dialog">
      <ColorPalette value={isHex(value) ? value : null} automatic={auto} onPick={hex => { setOpen(false); onChange(hex ?? 'auto'); }}
        onMore={onNested ? () => { setOpen(false); onNested('shell.moreColors', field.id, {color: isHex(value) ? value : '#4472C4'}); } : undefined}/>
    </Flyout>
  </>}</FieldShell>;
}

export function ColorPickerField({field, value, onChange}: FieldProps) {
  const hex = isHex(value) ? value.toUpperCase() : '#4472C4';
  const [h, s, l] = hexToHsl(hex);
  const square = useRef<HTMLDivElement>(null);
  const [initial] = useState(hex);
  const drag = (e: RPointerEvent<HTMLDivElement>) => {
    const r = square.current!.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    onChange(hslToHex(Math.round(x * 360), Math.round((1 - y) * 100), l || 50));
  };
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const setRgb = (i: number, v: string) => { const n = Math.max(0, Math.min(255, Number(v) || 0)); const next = [...rgb]; next[i] = n; onChange('#' + next.map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase()); };
  return <div className="sf sf-picker" data-field-id={field.id} data-kind="colorPicker">
    <div className="sf-picker-main">
      <div ref={square} className="sf-picker-square" role="slider" aria-label="Hue and saturation" aria-valuetext={`hue ${h}, saturation ${s}%`} tabIndex={0}
        onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); drag(e); }} onPointerMove={e => { if (e.buttons) drag(e); }}
        onKeyDown={e => {
          const d = e.shiftKey ? 10 : 2;
          if (e.key === 'ArrowLeft') onChange(hslToHex((h - d + 360) % 360, s, l)); else if (e.key === 'ArrowRight') onChange(hslToHex((h + d) % 360, s, l));
          else if (e.key === 'ArrowUp') onChange(hslToHex(h, Math.min(100, s + d), l)); else if (e.key === 'ArrowDown') onChange(hslToHex(h, Math.max(0, s - d), l));
        }}>
        <span className="sf-picker-cursor" style={{left: `${(h / 360) * 100}%`, top: `${100 - s}%`}}/>
      </div>
      <input className="sf-picker-light" type="range" min={0} max={100} value={l} aria-label="Lightness" onChange={e => onChange(hslToHex(h, s, Number(e.target.value)))}
        style={{background: `linear-gradient(to top, #000, ${hslToHex(h, s, 50)}, #fff)`}}/>
    </div>
    <div className="sf-picker-values">
      <label>Hex<input className="sf-text" value={hex} onChange={e => { const v = e.target.value.trim(); if (/^#?[0-9a-f]{6}$/i.test(v)) onChange((v.startsWith('#') ? v : '#' + v).toUpperCase()); }}/></label>
      {['Red', 'Green', 'Blue'].map((name, i) => <label key={name}>{name}<input className="sf-text" inputMode="numeric" value={rgb[i]} onChange={e => setRgb(i, e.target.value)}/></label>)}
      <div className="sf-picker-compare" aria-label="New and current color"><span style={{background: hex}}>New</span><span style={{background: initial}}>Current</span></div>
    </div>
  </div>;
}
