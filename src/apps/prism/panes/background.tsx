// The Format Background pane (Design > Format Background): the current slide's background as a
// Solid, Gradient, Picture or texture, or Pattern fill, or Follow the layout; Color, Transparency,
// the gradient editor (preset gradients, type, direction, stops), the pattern gallery drawn in the
// chosen colours, the picture's tile options, Hide background graphics, Apply to All and Reset
// Background. Reads the slide, writes through design.background and design.hideBackgroundGraphics.
// Translated from deckcraft crates/ui-egui/src/panels/background.rs and fillui.rs
// (`gradient_editor`, `pattern_editor`) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useMemo, useRef, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {Flyout} from '../../../shell/common/Flyout';
import {ColorPalette} from '../../../shell/common/ColorPalette';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import {currentSlideId} from '../../../../core/prism/model/doc.mjs';
import {ctxForSlide, ctxColor} from '../../../../core/prism/model/resolve.mjs';
import {css as cssColor} from '../../../../core/prism/model/color.mjs';
import {gradientToParam, currentBackgroundParams, colorToParam, masterBackgroundTarget} from '../../../../core/prism/commands/design.mjs';
import {masterContent} from '../surface/MasterView';
import {GALLERY, patternLabel, runs as patternRuns} from '../../../../core/prism/lib/pattern.mjs';
import './background.css';

type Any = any;
const KINDS: [string, string][] = [['solid', 'Solid fill'], ['gradient', 'Gradient fill'], ['picture', 'Picture or texture fill'], ['pattern', 'Pattern fill'], ['auto', 'Follow the layout']];
export const LINEAR: [string, number][] = [['Linear Down', 90], ['Linear Up', 270], ['Linear Left', 180], ['Linear Right', 0], ['Linear Diagonal - Top Left to Bottom Right', 45],
  ['Linear Diagonal - Top Right to Bottom Left', 135], ['Linear Diagonal - Bottom Left to Top Right', 315], ['Linear Diagonal - Bottom Right to Top Left', 225]];
export const PATH: [string, number[]][] = [['From Center', [0.5, 0.5, 0.5, 0.5]], ['From Top Left Corner', [0, 0, 1, 1]], ['From Top Right Corner', [1, 0, 0, 1]],
  ['From Bottom Left Corner', [0, 1, 1, 0]], ['From Bottom Right Corner', [1, 1, 0, 0]]];
export const ALIGN: [string, string][] = [['tl', 'Top Left'], ['t', 'Top'], ['tr', 'Top Right'], ['l', 'Left'], ['ctr', 'Center'], ['r', 'Right'], ['bl', 'Bottom Left'], ['b', 'Bottom'], ['br', 'Bottom Right']];
export const MIRROR: [string, string][] = [['none', 'None'], ['x', 'Horizontal'], ['y', 'Vertical'], ['xy', 'Both']];

export const alphaOf = (c: Any) => (c?.mods ?? []).reduce((a: number, m: Any) => (m.op === 'alpha' ? m.val / 100000 : a), 1);
export const withAlpha = (c: Any, a: number) => { const mods = (c.mods ?? []).filter((m: Any) => m.op !== 'alpha'); if (a < 1) mods.push({op: 'alpha', val: Math.round(a * 100000)}); return {...c, mods}; };

export function ColorButton({label, color, onPick}: {label: string; color: string; onPick: (hex: string) => void}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={anchor} type="button" className="bgp-color" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
      <i style={{background: color}}/><svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.3"/></svg>
    </button>
    <Flyout anchor={anchor} open={open} onClose={() => setOpen(false)} label={label}>
      <ColorPalette value={color} automatic={null} onPick={hex => { setOpen(false); if (hex) onPick(hex); }} label={label}/>
    </Flyout>
  </>;
}

export function Slider({label, value, onCommit}: {label: string; value: number; onCommit: (v: number) => void}) {
  const [live, setLive] = useState<number | null>(null);
  const shown = live ?? value;
  return <label className="bgp-row"><span>{label}</span>
    <input type="range" min={0} max={100} value={shown} aria-label={label} onChange={e => setLive(Number(e.target.value))}
      onPointerUp={() => { if (live !== null) onCommit(live); setLive(null); }} onKeyUp={() => { if (live !== null) onCommit(live); setLive(null); }}/>
    <output>{shown}%</output></label>;
}

export function Num({label, value, step = 1, min, max, suffix, onCommit}: {label: string; value: number; step?: number; min?: number; max?: number; suffix?: string; onCommit: (v: number) => void}) {
  return <label className="bgp-row"><span>{label}</span>
    <input type="number" value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0} step={step} min={min} max={max} aria-label={label}
      onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) onCommit(v); }}/>{suffix ? <small>{suffix}</small> : null}</label>;
}

export default function BackgroundPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const [stop, setStop] = useState(0);
  const model = useMemo(() => {
    try {
      const d: Any = session.get(docId);
      const content = d.file.content;
      const sl = (content.slides ?? []).find((s: Any) => s.id === currentSlideId(content, d.selection));
      // In a master view the pane formats the open master, layout, handout or notes page.
      const mt = masterBackgroundTarget({doc: content, view: d.view});
      const open: Any = d.view?.master;
      const layout = open?.kind === 'slide' && open.layout !== null && open.layout !== undefined ? content.masters?.[open.master]?.layouts?.[open.layout] : null;
      const base = open ? masterContent(content, open) : null;
      if (!sl && !base) return null;
      const ctx = open && base ? ctxForSlide(base.content, base.slide) : ctxForSlide(content, sl);
      const hexOf = (c: Any) => (ctx && c ? cssColor({...ctxColor(ctx, c, null), a: 255}) : '#000000');
      if (mt) return {bg: mt.bg, hide: layout ? layout.showMasterShapes === false : false, hexOf};
      return {bg: sl.background ?? null, hide: sl.showMasterShapes === false, hexOf};
    } catch { return null; }
  }, [session, docId, tick]);
  if (!model) return <div className="bgp"><small className="bgp-empty">Open a slide to format its background.</small></div>;
  const {bg, hide, hexOf} = model;
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const run = (id: string, params: Record<string, unknown> = {}) => controller.run(id, params, {origin: 'ui'}).catch(fail);
  const set = (params: Record<string, unknown>) => run('design.background', params);
  const fill = bg?.kind === 'fill' ? bg.fill : null;
  const kind = fill?.kind === 'solid' || fill?.kind === 'gradient' || fill?.kind === 'picture' || fill?.kind === 'pattern' ? fill.kind : 'auto';
  const current = currentBackgroundParams(bg);
  const choose = (k: string) => {
    if (k === kind) return;
    if (k === 'solid') void set({color: 'bg1'});
    else if (k === 'gradient') void set({gradient: {stops: [[0, 'bg2'], [1, 'bg1']], kind: 'linear', angle: 90}});
    else if (k === 'picture') void set({pick: true});
    else if (k === 'pattern') void set({pattern: {preset: 'pct20', fg: 'accent1', bg: 'bg1'}});
    else void set({reset: true});
  };
  const g = fill?.kind === 'gradient' ? fill : null;
  const sel = g ? Math.min(stop, g.stops.length - 1) : 0;
  const gset = (ng: Any) => set({gradient: gradientToParam(ng)});
  const baseColor = g?.stops?.[0]?.color ?? {base: {kind: 'scheme', slot: 'accent1'}};
  const lighter = {...baseColor, mods: [...(baseColor.mods ?? []), {op: 'lumMod', val: 40000}, {op: 'lumOff', val: 60000}]};
  const darker = {...baseColor, mods: [...(baseColor.mods ?? []), {op: 'lumMod', val: 50000}]};
  const lin = (angle: number) => ({shape: {kind: 'linear', angle, scaled: false}, rotateWithShape: false});
  const presets: Any[] = g ? [
    {...g, ...lin(90), stops: [{pos: 0, color: baseColor}, {pos: 1, color: baseColor}]},
    {...g, ...lin(90), stops: [{pos: 0, color: lighter}, {pos: 1, color: baseColor}]},
    {...g, ...lin(0), stops: [{pos: 0, color: baseColor}, {pos: 1, color: darker}]},
    {...g, ...lin(45), stops: [{pos: 0, color: lighter}, {pos: 0.5, color: baseColor}, {pos: 1, color: darker}]},
    {...g, shape: {kind: 'path', path: 'circle', focus: [0.5, 0.5, 0.5, 0.5]}, rotateWithShape: false, stops: [{pos: 0, color: lighter}, {pos: 1, color: darker}]},
    {...g, ...lin(90), stops: [{pos: 0, color: baseColor}, {pos: 1, color: withAlpha(baseColor, 0)}]},
  ] : [];
  const barCss = (gr: Any) => `linear-gradient(90deg, ${gr.stops.map((s: Any) => `${hexOf(s.color)} ${Math.round(s.pos * 100)}%`).join(', ')})`;
  const shapeKind = g?.shape?.kind === 'path' ? (g.shape.path === 'rect' ? 'rectangular' : g.shape.path === 'shape' ? 'path' : 'radial') : 'linear';
  const pic = fill?.kind === 'picture' ? fill : null;
  const tile = pic?.mode?.kind === 'tile' ? pic.mode : null;
  const pp = (props: Record<string, unknown>) => set({pictureProps: props});
  const pt = fill?.kind === 'pattern' ? fill : null;

  return <div className="bgp">
    <h3 className="bgp-h">Fill</h3>
    <div className="bgp-radios" role="radiogroup" aria-label="Fill">
      {KINDS.map(([k, l]) => <label key={k} className="bgp-radio"><input type="radio" name="bgp-kind" checked={kind === k} onChange={() => choose(k)} data-bg-kind={k}/><span>{l}</span></label>)}
    </div>
    {fill?.kind === 'solid' ? <>
      <div className="bgp-row"><span>Color</span><ColorButton label="Color" color={hexOf(fill.color)} onPick={hex => set({color: hex, ...(alphaOf(fill.color) < 1 ? {transparency: 1 - alphaOf(fill.color)} : {})})}/></div>
      <Slider label="Transparency" value={Math.round((1 - alphaOf(fill.color)) * 100)} onCommit={v => set({transparency: v / 100})}/>
    </> : null}
    {g ? <>
      <div className="bgp-label">Preset gradients</div>
      <div className="bgp-presets">{presets.map((p, i) => <button key={i} type="button" className="bgp-bar" style={{background: barCss(p)}} aria-label={`Preset gradient ${i + 1}`} onClick={() => gset(p)}/>)}</div>
      <label className="bgp-row"><span>Type</span>
        <select value={shapeKind} aria-label="Gradient type" onChange={e => {
          const k = e.target.value;
          const focus = g.shape.kind === 'path' ? g.shape.focus : [0.5, 0.5, 0.5, 0.5];
          gset({...g, shape: k === 'linear' ? {kind: 'linear', angle: 90, scaled: false} : {kind: 'path', path: k === 'rectangular' ? 'rect' : k === 'path' ? 'shape' : 'circle', focus}});
        }}>{['linear', 'radial', 'rectangular', 'path'].map(k => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}</select></label>
      <label className="bgp-row"><span>Direction</span>
        <select aria-label="Gradient direction" value={g.shape.kind === 'linear' ? String(LINEAR.find(([, a]) => Math.abs(a - g.shape.angle) < 0.5)?.[1] ?? '') : String(PATH.findIndex(([, f]) => f.every((v, i) => Math.abs(v - g.shape.focus[i]) < 1e-3)))}
          onChange={e => {
            if (g.shape.kind === 'linear') gset({...g, shape: {kind: 'linear', angle: Number(e.target.value), scaled: false}});
            else gset({...g, shape: {...g.shape, focus: PATH[Number(e.target.value)]?.[1] ?? g.shape.focus}});
          }}>
          {g.shape.kind === 'linear' ? <>{LINEAR.map(([l, a]) => <option key={a} value={a}>{l}</option>)}<option value="">Custom</option></> : PATH.map(([l], i) => <option key={l} value={i}>{l}</option>)}
        </select></label>
      {g.shape.kind === 'linear' ? <Num label="Angle" value={g.shape.angle} step={15} suffix="°" onCommit={v => gset({...g, shape: {kind: 'linear', angle: ((v % 360) + 360) % 360, scaled: false}})}/> : null}
      <div className="bgp-label">Gradient stops</div>
      <div className="bgp-stops" style={{background: barCss(g)}} role="group" aria-label="Gradient bar"
        onClick={e => {
          if (g.stops.length >= 10) return;
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const pos = Math.round(Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * 1000) / 1000;
          const near = g.stops.reduce((a: Any, b: Any) => (Math.abs(b.pos - pos) < Math.abs(a.pos - pos) ? b : a));
          const stops = [...g.stops, {pos, color: near.color}].sort((a: Any, b: Any) => a.pos - b.pos);
          setStop(stops.findIndex((s: Any) => s.pos === pos));
          gset({...g, stops});
        }}>
        {g.stops.map((s: Any, i: number) => <button key={i} type="button" className={`bgp-stop${i === sel ? ' is-on' : ''}`} style={{left: `${s.pos * 100}%`, color: hexOf(s.color)}} aria-label={`Gradient stop ${i + 1}`}
          onClick={e => { e.stopPropagation(); setStop(i); }}/>)}
      </div>
      {g.stops[sel] ? <>
        <div className="bgp-row"><span>Color</span><ColorButton label="Stop color" color={hexOf(g.stops[sel].color)} onPick={hex => {
          const stops = g.stops.map((s: Any, i: number) => (i === sel ? {...s, color: {...withAlpha({base: {kind: 'rgb', rgb: {r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a: 255}}}, alphaOf(s.color))}} : s));
          gset({...g, stops});
        }}/>
          <button type="button" className="sf-button bgp-small" disabled={g.stops.length <= 2} onClick={() => { setStop(Math.max(sel - 1, 0)); gset({...g, stops: g.stops.filter((_: Any, i: number) => i !== sel)}); }}>Remove stop</button></div>
        <Num label="Position" value={Math.round(g.stops[sel].pos * 100)} step={5} min={0} max={100} suffix="%" onCommit={v => gset({...g, stops: g.stops.map((s: Any, i: number) => (i === sel ? {...s, pos: Math.min(Math.max(v / 100, 0), 1)} : s)).sort((a: Any, b: Any) => a.pos - b.pos)})}/>
        <Slider label="Transparency" value={Math.round((1 - alphaOf(g.stops[sel].color)) * 100)} onCommit={v => gset({...g, stops: g.stops.map((s: Any, i: number) => (i === sel ? {...s, color: withAlpha(s.color, 1 - v / 100)} : s))})}/>
      </> : null}
    </> : null}
    {pt ? <>
      <div className="bgp-label">Pattern</div>
      <div className="bgp-patterns" role="listbox" aria-label="Pattern">
        {GALLERY.map(name => <button key={name} type="button" role="option" aria-selected={pt.preset === name} aria-label={patternLabel(name)} title={patternLabel(name)} className={`bgp-pat${pt.preset === name ? ' is-on' : ''}`}
          onClick={() => set({pattern: {preset: name, fg: colorToParam(pt.fg), bg: colorToParam(pt.bg)}})}>
          <svg viewBox="0 0 8 8" width="22" height="22" shapeRendering="crispEdges" aria-hidden="true"><rect width="8" height="8" fill={hexOf(pt.bg)}/>
            {patternRuns(name).map(([x, y, n]: number[], i: number) => <rect key={i} x={x} y={y} width={n} height={1} fill={hexOf(pt.fg)}/>)}</svg></button>)}
      </div>
      <div className="bgp-row"><span>Foreground color</span><ColorButton label="Foreground color" color={hexOf(pt.fg)} onPick={hex => set({pattern: {preset: pt.preset, fg: hex, bg: colorToParam(pt.bg)}})}/></div>
      <div className="bgp-row"><span>Background color</span><ColorButton label="Background color" color={hexOf(pt.bg)} onPick={hex => set({pattern: {preset: pt.preset, fg: colorToParam(pt.fg), bg: hex}})}/></div>
    </> : null}
    {pic ? <>
      <div className="bgp-row"><button type="button" className="sf-button" onClick={() => set({pick: true})}>Insert picture from file…</button></div>
      <Slider label="Transparency" value={Math.round((1 - (pic.alpha ?? 1)) * 100)} onCommit={v => set({transparency: v / 100})}/>
      <label className="bgp-check"><input type="checkbox" checked={!!tile} onChange={e => pp({tile: e.target.checked})}/><span>Tile picture as texture</span></label>
      {tile ? <>
        <Num label="Offset X" value={tile.tx} suffix="pt" onCommit={v => pp({offsetX: v})}/>
        <Num label="Offset Y" value={tile.ty} suffix="pt" onCommit={v => pp({offsetY: v})}/>
        <Num label="Scale X" value={tile.sx * 100} step={5} suffix="%" onCommit={v => pp({scaleX: v / 100})}/>
        <Num label="Scale Y" value={tile.sy * 100} step={5} suffix="%" onCommit={v => pp({scaleY: v / 100})}/>
        <label className="bgp-row"><span>Alignment</span><select value={tile.align} aria-label="Alignment" onChange={e => pp({align: e.target.value})}>{ALIGN.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="bgp-row"><span>Mirror</span><select value={tile.flip} aria-label="Mirror" onChange={e => pp({mirror: e.target.value})}>{MIRROR.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      </> : null}
    </> : null}
    <label className="bgp-check"><input type="checkbox" checked={hide} data-bg-hide onChange={e => run('design.hideBackgroundGraphics', {hide: e.target.checked})}/><span>Hide background graphics</span></label>
    <div className="bgp-actions">
      <button type="button" className="sf-button" data-bg-apply-all disabled={!current && !pic} onClick={() => set(current ? {...current, all: true} : {copy: true})}>Apply to All</button>
      <button type="button" className="sf-button" data-bg-reset onClick={() => set({reset: true})}>Reset Background</button>
    </div>
  </div>;
}
