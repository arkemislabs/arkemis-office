// Borders and Shading dialog view (Design › Page Borders, Home › Borders › Borders and Shading…):
// Word's Borders, Page Border and Shading pages: Setting on the left, Style / Color / Width in the
// middle, the preview on the right whose edges (and the Top/Bottom/Left/Right/Between buttons)
// switch sides, Apply to under it. Over core/quill/dialogs/borders.mjs. Layout from wordcraft
// crates/ui-egui/src/dialogs/dialogs_para.rs `borders`, `lines`, `preview` at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, PageTabs, grid, usePreview, type BodyProps} from './font';
import {toggleSide} from '../../../../core/quill/dialogs/borders.mjs';

type Sides = {top: boolean; bottom: boolean; left: boolean; right: boolean; between: boolean};
type Form = {setting: string; style: string; color: string; width: number; sides: Sides; widths: Record<string, number>};
type Target = 'paragraph' | 'text' | 'page';

const DASH: Record<string, string | undefined> = {dotted: '1 2', dashed: '4 2', dotDash: '4 2 1 2'};

/** A sample page with lines of text, the chosen borders and fill; clicking near an edge switches that side. */
function BorderPreview({f, fill, target, onSide}: {f: Form | null; fill: string | null; target: Target; onSide?: (side: string) => void}) {
  const W = 180, H = 120;
  const para = {x: 22, y: 22, w: W - 44, h: 44};
  const area = target === 'page' ? {x: 10, y: 10, w: W - 20, h: H - 20} : target === 'text' ? {x: para.x, y: para.y, w: para.w * 0.62, h: 14} : para;
  const color = f && /^#[0-9a-f]{6}$/i.test(f.color) ? f.color : '#202124';
  const edges: [string, number, number, number, number][] = [
    ['top', area.x, area.y, area.x + area.w, area.y], ['bottom', area.x, area.y + area.h, area.x + area.w, area.y + area.h],
    ['left', area.x, area.y, area.x, area.y + area.h], ['right', area.x + area.w, area.y, area.x + area.w, area.y + area.h],
    ['between', area.x, area.y + area.h / 2, area.x + area.w, area.y + area.h / 2]];
  const rows = (y0: number, count: number, last: number) => Array.from({length: count}, (_, i) =>
    <rect key={`${y0}-${i}`} x={para.x + 4} y={y0 + i * 9} width={(para.w - 8) * (i + 1 === count ? last : 1)} height={4} rx={1} fill="#c4c6cc"/>);
  const line = (side: string, x1: number, y1: number, x2: number, y2: number) => {
    if (!f?.sides?.[side as keyof Sides] || (side === 'between' && target !== 'paragraph')) return null;
    const w = Math.max(0.75, Math.min(5, (f.widths?.[side] ?? f.width) * 1.2));
    const dbl = f.style === 'double' || f.style === 'triple';
    const off = w + 1;
    const dx = y1 === y2 ? 0 : off, dy = y1 === y2 ? off : 0;
    return <g key={side}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={dbl ? Math.max(0.75, w / 2) : w} strokeDasharray={DASH[f.style]}/>
      {dbl ? <line x1={x1 + dx} y1={y1 + dy} x2={x2 + dx} y2={y2 + dy} stroke={color} strokeWidth={Math.max(0.75, w / 2)}/> : null}
    </g>;
  };
  const click = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!onSide) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) * (W / r.width), py = (e.clientY - r.top) * (H / r.height);
    const dist = ([, x1, y1, x2, y2]: [string, number, number, number, number]) => {
      const cx = Math.max(Math.min(x1, x2), Math.min(Math.max(x1, x2), px)), cy = Math.max(Math.min(y1, y2), Math.min(Math.max(y1, y2), py));
      return Math.hypot(px - cx, py - cy);
    };
    const best = edges.filter(e2 => e2[0] !== 'between' || target === 'paragraph').sort((a, b) => dist(a) - dist(b))[0];
    if (best && dist(best) < 14) onSide(best[0]);
  };
  return <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Border preview" onClick={click}
    style={{cursor: onSide ? 'pointer' : undefined, background: '#fff', border: '1px solid #c4c6cc', borderRadius: 4}}>
    {fill ? <rect x={area.x} y={area.y} width={area.w} height={area.h} fill={fill}/> : null}
    {rows(para.y + 6, 4, 0.6)}
    {rows(para.y + para.h + 10, 3, 0.4)}
    {edges.map(e => line(...e))}
  </svg>;
}

/** A Setting tile (None, Box, Shadow, 3-D, Custom): a small page with the border it makes, as Word draws them. */
function SettingTile({kind, label, on, onPick}: {kind: string; label: string; on: boolean; onPick: () => void}) {
  const x = 6, y = 6, w = 28, h = 24;
  const edge = 'currentColor';
  const art = kind === 'box' ? <rect x={x} y={y} width={w} height={h} fill="none" stroke={edge} strokeWidth={1.6}/>
    : kind === 'shadow' ? <><rect x={x + 3} y={y + 3} width={w} height={h} fill={edge} opacity={0.55}/><rect x={x} y={y} width={w} height={h} fill="#fff" stroke={edge} strokeWidth={1.6}/></>
    : kind === 'threeD' ? <><rect x={x} y={y} width={w} height={h} fill="none" stroke={edge} strokeWidth={1}/><path d={`M${x} ${y + h}H${x + w}V${y}`} fill="none" stroke={edge} strokeWidth={2.4}/><path d={`M${x + 3} ${y + 3}H${x + w - 3}V${y + h - 3}`} fill="none" stroke={edge} strokeWidth={0.9}/></>
    : kind === 'custom' ? <><rect x={x} y={y} width={w} height={h} fill="none" stroke={edge} strokeWidth={1} strokeDasharray="2 2" opacity={0.6}/><path d={`M${x} ${y}H${x + w}M${x} ${y + h}H${x + w}`} stroke={edge} strokeWidth={2}/></>
    : <rect x={x} y={y} width={w} height={h} fill="none" stroke={edge} strokeWidth={1} strokeDasharray="1 3" opacity={0.5}/>;
  return <button type="button" role="radio" aria-checked={on} aria-label={label} title={label} className={`sf-button${on ? ' is-selected' : ''}`} style={{width: 44, height: 44, padding: 0, display: 'grid', placeItems: 'center', ...(on ? {outline: '2px solid #5b9bd5', outlineOffset: -2, background: 'rgba(91,155,213,.22)'} : {})}} onClick={onPick}>
    <svg width={40} height={36} viewBox="0 0 40 36" aria-hidden="true">{art}</svg>
  </button>;
}

/** A side button (Top, Bottom, Left, Right, Between): the page square with that edge drawn heavy. */
function SideButton({side, label, on, onPick}: {side: string; label: string; on: boolean; onPick: () => void}) {
  const heavy: Record<string, string> = {top: 'M4 4H20', bottom: 'M4 20H20', left: 'M4 4V20', right: 'M20 4V20', between: 'M4 12H20'};
  return <button type="button" aria-pressed={on} aria-label={label} title={label} className={`sf-button${on ? ' is-selected' : ''}`} style={{width: 28, height: 28, padding: 0, display: 'grid', placeItems: 'center', ...(on ? {outline: '2px solid #5b9bd5', outlineOffset: -2, background: 'rgba(91,155,213,.22)'} : {})}} onClick={onPick}>
    <svg width={22} height={22} viewBox="0 0 24 24" aria-hidden="true"><rect x={4} y={4} width={16} height={16} fill="none" stroke="currentColor" strokeWidth={0.8} strokeDasharray="1.5 1.5" opacity={0.55}/>
      <path d={heavy[side]} stroke="currentColor" strokeWidth={2.4} strokeLinecap="round"/></svg>
  </button>;
}

function Lines({d, set, p, prefix, target}: {d: BodyProps['dialog']; set: BodyProps['setValue']; p: Record<string, any> | null; prefix: 'para' | 'page'; target: Target}) {
  const f = (p?.[prefix] ?? null) as Form | null;
  const sides = (d.values[`${prefix}Sides`] ?? {}) as Sides;
  const toggle = (side: string) => {
    const form = {setting: d.values[`${prefix}Setting`], sides} as any;
    set(`${prefix}Sides`, toggleSide(form, side).sides);
  };
  const names: [string, string][] = [['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right'], ...(target === 'paragraph' ? [['between', 'Between'] as [string, string]] : [])];
  return <div style={grid('minmax(0, .8fr) minmax(0, 1fr) auto', {alignItems: 'start'})}>
    <div className="sf" data-field-id={`${prefix}Setting`} role="radiogroup" aria-label="Setting">
      <span className="sf-label">Setting</span>
      <div style={{display: 'grid', gap: 4, marginTop: 4}}>
        {[['none', 'None'], ['box', 'Box'], ['shadow', 'Shadow'], ['threeD', '3-D'], ['custom', 'Custom']].map(([k, l]) => <SettingTile key={k} kind={k} label={l} on={d.values[`${prefix}Setting`] === k} onPick={() => set(`${prefix}Setting`, k)}/>)}
      </div>
    </div>
    <div style={{display: 'grid', gap: 10}}>
      <Field d={d} id={`${prefix}Style`} set={set} override="list" style={{marginBottom: 6}}/>
      <Field d={d} id={`${prefix}Color`} set={set}/>
      <Field d={d} id={`${prefix}Width`} set={set}/>
    </div>
    <div className="sf" data-field-id={`${prefix}Sides`} data-kind="preview" style={{display: 'grid', gap: 6}}>
      <span className="sf-label">Preview</span>
      <BorderPreview f={f} fill={prefix === 'para' && !p?.fillText ? (p?.fill ?? null) : null} target={target} onSide={toggle}/>
      <div style={{display: 'flex', flexWrap: 'wrap', gap: 4, maxWidth: 180}}>
        {names.map(([k, label]) => <SideButton key={k} side={k} label={label} on={!!sides[k as keyof Sides]} onPick={() => toggle(k)}/>)}
      </div>
    </div>
  </div>;
}

function Body({dialog: d, setValue: set}: BodyProps) {
  const p = usePreview(d) as Record<string, any> | null;
  const page = d.spec.tabs[d.tab]?.name ?? 'Borders';
  return <div className="gd-fields" data-dialog-page={page}>
    <PageTabs dialog={d}/>
    {page === 'Borders' ? <>
      <Lines d={d} set={set} p={p} prefix="para" target={d.values.paraApplyTo === 'text' ? 'text' : 'paragraph'}/>
      <div style={grid('minmax(0, 1fr) minmax(0, 1fr)', {marginTop: 12})}><div/><Field d={d} id="paraApplyTo" set={set}/></div>
    </> : null}
    {page === 'Page Border' ? <>
      <Lines d={d} set={set} p={p} prefix="page" target="page"/>
      <div style={grid('minmax(0, 1fr) minmax(0, 1fr)', {marginTop: 12})}><div/><Field d={d} id="pageApplyTo" set={set}/></div>
    </> : null}
    {page === 'Shading' ? <div style={grid('minmax(0, 1fr) auto', {alignItems: 'start'})}>
      <div style={{display: 'grid', gap: 12}}><Field d={d} id="fill" set={set}/><Field d={d} id="fillApplyTo" set={set}/></div>
      <div className="sf" data-field-id="fillPreview" data-kind="preview" style={{display: 'grid', gap: 6}}>
        <span className="sf-label">Preview</span>
        <BorderPreview f={null} fill={p?.fill ?? null} target={p?.fillText ? 'text' : 'paragraph'}/>
      </div>
    </div> : null}
  </div>;
}

export default {Body};
