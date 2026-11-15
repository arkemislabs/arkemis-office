// Add Header and Footer: the preview page with the marks laid out on it (marks_ui.rs `preview`:
// header boxes hang from the top margin, footers sit on the bottom margin, the shrink band shaded),
// and the Insert Page Number / Insert Date buttons, which type the chosen token into the box last
// typed in (the model's derive does the typing). The watermark and background dialogs reuse the
// preview. Translated from printcraft crates/ui-egui/src/dialogs/marks_ui.rs (`preview`, `body`)
// at 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import type {ReactElement} from 'react';
import type {FieldProps} from '../../../shell/fields/common';
import './header-footer.css';

type Frame = {size: [number, number]; label: string; applies: string; replace?: boolean; back?: number | null; next?: number | null; shown?: number};
type MarksPreview = Frame & {
  kind: 'HeaderFooter' | 'Watermark' | 'Background';
  boxes?: string[]; margins?: number[]; size?: [number, number]; font?: string; color?: string | null; underline?: boolean; shrink?: {top: number; bottom: number} | null;
  text?: string | null; file?: string | null; fit?: boolean; scale?: number; opacity?: number; rotation?: number; behind?: boolean; offset?: [number, number];
} & {size: [number, number]; fontSize?: number};

const SIDE = 190;

/** The preview page (marks_ui.rs PREVIEW_SIDE: the longer side is 190 px). */
export function MarksPreview({preview, values, setValue}: {preview: unknown; values: Record<string, unknown>; setValue?: (f: string, v: unknown) => void}) {
  const p = preview as MarksPreview | null;
  if (!p || !Array.isArray(p.size)) return null;
  const [w, h] = p.size;
  const s = SIDE / Math.max(w, h, 1);
  const pw = w * s, ph = h * s;
  const face = p.font === 'Courier' ? 'Courier New, monospace' : p.font === 'Times' ? 'Times New Roman, serif' : 'Helvetica, Arial, sans-serif';
  const marks: ReactElement[] = [];
  let tint = '#ffffff';
  if (p.kind === 'HeaderFooter') {
    const m = p.margins ?? [36, 36, 72, 72];
    const size = Math.max(5, Number(values.size ?? 8) * s);
    if (p.shrink) {
      const k = Math.max(0, Math.min(1, (h - p.shrink.top - p.shrink.bottom) / h));
      const bandTop = p.shrink.top * s, bandH = Math.max(0, ph - bandTop - p.shrink.bottom * s);
      marks.push(<rect key="band" x={(pw - pw * k) / 2} y={bandTop} width={pw * k} height={bandH} fill="#e8e8e8"/>);
    }
    (p.boxes ?? []).forEach((t, k) => {
      if (!t.trim()) return;
      const y = k < 3 ? m[0] * s + size * 0.8 : ph - m[1] * s;
      const [x, anchor]: [number, 'start' | 'middle' | 'end'] = k % 3 === 0 ? [m[2] * s, 'start'] : k % 3 === 1 ? [pw / 2, 'middle'] : [pw - m[3] * s, 'end'];
      marks.push(<text key={k} x={x} y={y} fontSize={size} fontFamily={face} textAnchor={anchor} fill={p.color ?? '#000'}
        textDecoration={p.underline ? 'underline' : undefined}>{t.split('\n')[0]}</text>);
    });
  } else if (p.kind === 'Watermark') {
    const off = p.offset ?? [0, 0];
    const cx = pw / 2 + off[0] * s, cy = ph / 2 - off[1] * s;
    if (p.file) {
      const side = Math.min(pw, ph) * (p.scale ?? 0.5);
      marks.push(<g key="pic" transform={`rotate(${-(p.rotation ?? 0)} ${cx} ${cy})`}>
        <rect x={cx - side / 2} y={cy - side / 2} width={side} height={side} fill="none" stroke="#888"/>
        <text x={cx} y={cy + 3} fontSize={10} textAnchor="middle" fill="#888">{p.file}</text></g>);
    } else {
      const text = p.text ?? 'CONFIDENTIAL';
      const size = p.fit ? Math.max(6, Math.min(80, Math.hypot(pw, ph) * 0.5 / (Math.max(1, text.length) * 0.55))) : Math.max(5, Number(values.size ?? 72) * s);
      marks.push(<text key="wm" x={cx} y={cy} fontSize={size} fontFamily="Helvetica, Arial, sans-serif" textAnchor="middle" dominantBaseline="central"
        fill={p.color ?? '#999'} fillOpacity={p.opacity ?? 0.5} transform={`rotate(${-(p.rotation ?? 0)} ${cx} ${cy})`}>{text.split('\n')[0]}</text>);
    }
  } else if (p.kind === 'Background') {
    if (p.file) marks.push(<g key="pic"><rect x={6} y={6} width={pw - 12} height={ph - 12} fill="none" stroke="#888"/>
      <text x={pw / 2} y={ph / 2} fontSize={10} textAnchor="middle" fill="#888">{p.file}</text></g>);
    else if (p.color) tint = p.color;
  }
  const step = (to: number | null | undefined) => { if (to !== null && to !== undefined && setValue) setValue('__preview', to); };
  return <div className="folio-marks-preview" style={{display: 'flex', gap: 14, alignItems: 'flex-start'}}>
    <svg width={pw + 2} height={ph + 2} viewBox={`-1 -1 ${pw + 2} ${ph + 2}`} role="img" aria-label={p.label} style={{flex: 'none', boxShadow: '0 1px 4px rgba(0,0,0,.25)'}}>
      <rect x={0} y={0} width={pw} height={ph} fill="#fff"/>
      {p.kind === 'Background' && !p.file ? <rect x={0} y={0} width={pw} height={ph} fill={tint} fillOpacity={p.opacity ?? 1}/> : null}
      {[0.18, 0.26, 0.34, 0.42, 0.5, 0.58, 0.66, 0.74].map(f => <rect key={f} x={pw * 0.14} y={ph * f} width={pw * (f === 0.5 ? 0.5 : 0.72)} height={Math.max(1, ph * 0.012)} fill="#d0d0d0"/>)}
      {marks}
    </svg>
    <div style={{display: 'grid', gap: 6, fontSize: 12}}>
      <div style={{display: 'flex', gap: 6, alignItems: 'center'}}>
        <button type="button" className="sf-button" disabled={p.back === null || p.back === undefined || !setValue} aria-label="Previous page" onClick={() => step(p.back)}>‹</button>
        <span className="sf-label">{p.label}</span>
        <button type="button" className="sf-button" disabled={p.next === null || p.next === undefined || !setValue} aria-label="Next page" onClick={() => step(p.next)}>›</button>
      </div>
      <span className="sf-label">{p.applies}</span>
      {p.replace ? <span className="sf-label">Replaces the existing one on those pages.</span> : null}
    </div>
  </div>;
}

/** A button field that sets its own value (a press count) so the model's derive can act on it. */
export function CountButton({field, value, onChange, disabled}: FieldProps) {
  return <div className="sf sf-btn" data-field-id={field.id} data-kind="button">
    <button type="button" className="sf-button" disabled={disabled} onClick={() => onChange((Number(value) || 0) + 1)}>{field.label}</button>
  </div>;
}

function Preview({values, preview}: {values: Record<string, unknown>; preview: unknown}) {
  return <MarksPreview preview={preview} values={values}/>;
}

export default {Preview, fields: {'insert-page': CountButton, 'insert-date': CountButton}};
