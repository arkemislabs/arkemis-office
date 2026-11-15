// Colors view (Font Color > More Colors...): the Standard tab's hexagon palette comes from the shell's drawn swatch field; the Custom
// tab's spectrum is drawn here: a hue (across) and saturation (down) box with a luminance bar beside it, Office's 0-255 scales, over
// core/slate/dialogs/colors.mjs. Slate has no ArtCraft upstream.

import {useRef, type ComponentType, type PointerEvent as RPointerEvent} from 'react';
import {FieldShell, type FieldProps} from '../../../shell/fields/common';

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

function SpectrumField({field, onChange, values, disabled}: FieldProps) {
  const h = Number(values?.hue ?? 0), s = Number(values?.saturation ?? 0), l = Number(values?.luminance ?? 128);
  const box = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const pickBox = (e: RPointerEvent<HTMLDivElement>) => {
    const r = box.current!.getBoundingClientRect();
    onChange({hue: clamp(((e.clientX - r.left) / r.width) * 255), saturation: clamp((1 - (e.clientY - r.top) / r.height) * 255), luminance: l});
  };
  const pickBar = (e: RPointerEvent<HTMLDivElement>) => {
    const r = bar.current!.getBoundingClientRect();
    onChange({hue: h, saturation: s, luminance: clamp((1 - (e.clientY - r.top) / r.height) * 255)});
  };
  const mid = `hsl(${Math.round((h / 255) * 360)}, ${Math.round((s / 255) * 100)}%, 50%)`;
  return <FieldShell field={field}>{() => <div className="sf-spectrum" data-field-id={field.id}>
    <div ref={box} className="sf-spectrum-box" role="slider" aria-label="Hue and saturation" aria-valuetext={`hue ${h}, saturation ${s}`} tabIndex={0}
      onPointerDown={e => { if (disabled) return; e.currentTarget.setPointerCapture(e.pointerId); pickBox(e); }} onPointerMove={e => { if (e.buttons && !disabled) pickBox(e); }}>
      <span className="sf-spectrum-cursor" style={{left: `${(h / 255) * 100}%`, top: `${(1 - s / 255) * 100}%`}}/>
    </div>
    <div ref={bar} className="sf-spectrum-bar" role="slider" aria-label="Luminance" aria-valuemin={0} aria-valuemax={255} aria-valuenow={l} tabIndex={0}
      style={{background: `linear-gradient(to bottom, #fff, ${mid}, #000)`}}
      onPointerDown={e => { if (disabled) return; e.currentTarget.setPointerCapture(e.pointerId); pickBar(e); }} onPointerMove={e => { if (e.buttons && !disabled) pickBar(e); }}>
      <span className="sf-spectrum-mark" style={{top: `${(1 - l / 255) * 100}%`}}/>
    </div>
  </div>}</FieldShell>;
}

export default {fields: {spectrum: SpectrumField as ComponentType<FieldProps>}};
