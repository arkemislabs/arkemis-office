// The signature pad's body: Type (the name in the script face, previewed), Draw (a 4:1 pad;
// strokes x 0–1 across, y up, in pad widths; Undo removes the last stroke, Clear all) and Image
// (Browse… a PNG or JPEG up to 4 MB). Apply / Cancel are the dialog's own buttons.
//
// Translated from printcraft crates/ui-egui/src/tools/fill_sign.rs (signature_pad, the pad's
// `norm`, undo_stroke, pad_buttons, script_preview, image_preview) at
// 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see assets/third-party-licenses/artcraft-reference.txt).
// The Scan tab is not translated (core/folio/dialogs/signature-pad.mjs).

import {useEffect, useRef, useState} from 'react';
import type {DialogOverride} from '../../../shell/dialogs/DialogHost';
import {resolved} from '../../../../core/folio/dialogs/signature-pad.mjs';
import {scriptOutline, outlineBounds} from '../../../../core/folio/lib/sign-script.mjs';

import './signature-pad.css';

type Any = any;
const TABS: [string, string][] = [['type', 'Type'], ['draw', 'Draw'], ['image', 'Image']];

function ScriptPreview({text}: {text: string}) {
  const o = scriptOutline(text);
  const [l, b, r, t] = outlineBounds(o);
  const w = Math.max(r - l, 0.01), h = Math.max(t - b, 0.01);
  const d = o.contours.map((c: number[][]) => c.map((p, i) => `${i ? 'L' : 'M'}${(p[0] - l).toFixed(4)} ${(t - p[1]).toFixed(4)}`).join(' ') + 'Z').join(' ');
  return <svg className="fsp-preview" viewBox={`${-0.05 * w} ${-0.05 * h} ${w * 1.1} ${h * 1.1}`} preserveAspectRatio="xMidYMid meet" aria-label="Signature preview"><path d={d} fill="currentColor"/></svg>;
}

function Pad({strokes, onChange}: {strokes: number[][][]; onChange: (s: number[][][]) => void}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef<number[][][] | null>(null);
  const draw = (list: number[][][]) => {
    const c = ref.current; if (!c) return;
    const g = c.getContext('2d')!; const W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    g.strokeStyle = getComputedStyle(c).color; g.lineWidth = 2.5; g.lineCap = 'round'; g.lineJoin = 'round';
    for (const s of list) { if (!s.length) continue; g.beginPath(); s.forEach(([x, y], i) => { const px = x * W, py = H - y * W; if (i) g.lineTo(px, py); else g.moveTo(px, py); }); if (s.length === 1) g.lineTo(s[0][0] * W + 0.1, H - s[0][1] * W); g.stroke(); }
  };
  useEffect(() => draw(strokes), [strokes]);
  const norm = (e: React.PointerEvent) => { const r = ref.current!.getBoundingClientRect(); const x = Math.min(Math.max(e.clientX - r.left, 0), r.width), y = Math.min(Math.max(e.clientY - r.top, 0), r.height); return [x / r.width, (r.height - y) / r.width]; };
  return <canvas ref={ref} className="fsp-pad" width={480} height={120} aria-label="Draw your signature below"
    onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); live.current = [...strokes, [norm(e)]]; draw(live.current); }}
    onPointerMove={e => { if (!live.current) return; live.current[live.current.length - 1].push(norm(e)); draw(live.current); }}
    onPointerUp={() => { if (live.current) onChange(live.current); live.current = null; }}/>;
}

function Body({dialog, setValue}: {dialog: Any; setValue: (f: string, v: unknown) => void}) {
  const v = resolved(dialog.values);
  const [error, setError] = useState<string | null>(null);
  const browse = async () => {
    try {
      const picked: Any = await (window as Any).studio?.pickImage?.();
      const url: string | null = typeof picked === 'string' ? picked : picked?.dataUrl ?? null;
      if (!url) return;
      const b64 = url.replace(/^data:[^,]+,/, '');
      if (b64.length * 0.75 > 4 << 20) { setError('Choose a PNG or JPEG image of up to 4 MB.'); return; }
      setError(null); setValue('image', b64); setValue('mode', 'image');
    } catch (e: Any) { setError(String(e?.message ?? e)); }
  };
  return <div className="fsp">
    <div className="gd-tabs" role="tablist" aria-label="Signature">
      {TABS.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={v.mode === k} className={v.mode === k ? 'is-active' : undefined} onClick={() => setValue('mode', k)}>{label}</button>)}
    </div>
    {v.mode === 'type' ? <div className="fsp-type">
      <label className="sf-label" htmlFor="fsp-typed">Type your {v.what}.</label>
      <input id="fsp-typed" className="sf-input" value={v.typed} maxLength={256} onChange={e => setValue('typed', e.target.value)}/>
      {v.typed.trim() ? <ScriptPreview text={v.typed.trim()}/> : null}
    </div> : null}
    {v.mode === 'draw' ? <div className="fsp-draw">
      <span className="sf-label">Draw your {v.what} below.</span>
      <Pad strokes={v.strokes} onChange={s => setValue('strokes', s)}/>
      <div className="fsp-buttons">
        <button type="button" className="gd-button" disabled={!v.strokes.length} onClick={() => { const s = [...v.strokes]; while (s.length) { const last = s.pop()!; if (last.length > 1) break; } setValue('strokes', s); }}>Undo</button>
        <button type="button" className="gd-button" disabled={!v.strokes.length} onClick={() => setValue('strokes', [])}>Clear</button>
      </div>
    </div> : null}
    {v.mode === 'image' ? <div className="fsp-image">
      {v.image ? <img className="fsp-picture" alt="Signature image" src={`data:image/${v.image.startsWith('/9j') ? 'jpeg' : 'png'};base64,${v.image}`}/> : <p className="sf-note">PNG or JPEG up to 4 MB.</p>}
      <button type="button" className="gd-button" onClick={() => void browse()}>Browse…</button>
      {error ? <small className="sf-error" role="alert">{error}</small> : null}
    </div> : null}
  </div>;
}

const override: DialogOverride = {Body};
export default override;
