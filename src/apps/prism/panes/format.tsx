// The Format Shape pane (the ribbon's More Options… and Format Pane): Fill & Line, Effects, Size &
// Properties, Text Options and, for a picture, Picture. It reads the selected shape and writes through
// shape.fill, shape.line, shape.effects, shape.resize / rotate / move / sizePosition / altText, format.*
// and picture.adjust, so everything it does is an ordinary undoable command.
// Translated from deckcraft crates/ui-egui/src/panels/format_shape.rs (tabs, fill kinds, line details,
// effect sliders, size fields, text options, picture sliders), effect_presets.rs (the drawn shadow, glow
// and soft-edge tiles) and fillui.rs (gradient and pattern editors, shared with the background pane)
// at f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEffect, useMemo, useState, type ReactNode} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import {currentSlideId, selectedShapeIds, slideById, xfrmOf} from '../../../../core/prism/model/doc.mjs';
import {findShape, isGroup} from '../../../../core/prism/model/presentation.mjs';
import {ctxForSlide, ctxColor} from '../../../../core/prism/model/resolve.mjs';
import {css as cssColor} from '../../../../core/prism/model/color.mjs';
import {gradientToParam, colorToParam} from '../../../../core/prism/commands/design.mjs';
import {GALLERY, patternLabel, runs as patternRuns} from '../../../../core/prism/lib/pattern.mjs';
import {BEVELS, BEVEL_LABELS, parse3d} from '../../../../core/prism/lib/three-d.mjs';
import {ColorButton, Slider, Num, LINEAR, PATH, ALIGN, MIRROR, alphaOf, withAlpha} from './background';
import './background.css';
import './format.css';

type Any = any;
const TABS: [string, string][] = [['fill', 'Fill & Line'], ['effects', 'Effects'], ['size', 'Size & Properties'], ['text', 'Text Options'], ['picture', 'Picture']];
const KINDS: [string, string][] = [['none', 'No fill'], ['solid', 'Solid fill'], ['gradient', 'Gradient fill'], ['picture', 'Picture or texture fill'], ['pattern', 'Pattern fill'], ['auto', 'Automatic']];
const COMPOUND: [string, string][] = [['single', 'Single'], ['double', 'Double'], ['thickThin', 'Thick Thin'], ['thinThick', 'Thin Thick'], ['triple', 'Triple']];
const CAPS: [string, string][] = [['flat', 'Flat'], ['round', 'Round'], ['square', 'Square']];
const JOINS: [string, string][] = [['round', 'Round'], ['bevel', 'Bevel'], ['miter', 'Miter']];
const ARROWS: [string, string][] = [['none', 'None'], ['triangle', 'Arrow'], ['arrow', 'Open Arrow'], ['stealth', 'Stealth'], ['diamond', 'Diamond'], ['oval', 'Oval']];
const ARROW_SIZES: [string, string][] = [['sm', 'Small'], ['med', 'Medium'], ['lg', 'Large']];
const DASHES: [string, string][] = [['solid', 'Solid'], ['sysDot', 'Round Dot'], ['sysDash', 'Square Dot'], ['dash', 'Dash'], ['dashDot', 'Dash Dot'], ['lgDash', 'Long Dash']];
const SHADOWS: [string, string][] = [['none', 'No shadow'], ['outer', 'Outer shadow'], ['bottom', 'Bottom shadow'], ['center', 'Centered shadow'], ['inner', 'Inner shadow'], ['perspective', 'Perspective shadow']];
const GLOWS = [0, 5, 8, 11, 18];
const SOFTS = [0, 1, 2.5, 5, 10, 25];
const IN = 72;

const TabIcon = ({id}: {id: string}) => {
  const p = {fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">{id === 'fill' ? <><path d="M3 12.5 8 3l5 9.5Z" {...p}/><path d="M5.2 12.5h5.6" {...p}/></>
    : id === 'effects' ? <><rect x="3" y="3" width="8" height="8" rx="1.5" {...p}/><path d="M13 6v6.5H6.5" {...p}/></>
    : id === 'size' ? <><rect x="2.5" y="2.5" width="11" height="11" rx="1" {...p}/><path d="M2.5 6h11M6 2.5v11" {...p} opacity=".55"/></>
    : id === 'text' ? <><rect x="2.5" y="3" width="11" height="10" rx="1" {...p}/><path d="M5.5 6h5M8 6v4.5" {...p}/></>
    : <><rect x="2.5" y="3" width="11" height="10" rx="1.2" {...p}/><circle cx="6" cy="6.6" r="1.1" {...p}/><path d="m3 12 3.5-3.2 2.5 2 2-1.8 2.5 2.4" {...p}/></>}</svg>;
};

/** A labelled drop-down that runs `onPick(value)`. */
function Choice({label, value, items, onPick}: {label: string; value: string; items: [string, string][]; onPick: (v: string) => void}) {
  return <label className="bgp-row"><span>{label}</span>
    <select value={items.some(([v]) => v === value) ? value : ''} aria-label={label} onChange={e => onPick(e.target.value)}>
      {items.some(([v]) => v === value) ? null : <option value="">{value || 'Mixed'}</option>}
      {items.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>;
}

const Heading = ({children}: {children: ReactNode}) => <h3 className="bgp-h fmt-h">{children}</h3>;

/** The sample card of an effect tile, drawn in its own SVG filter. */
function EffectTile({label, on, onPick, kind, amount = 0}: {label: string; on: boolean; onPick: () => void; kind: 'shadow' | 'glow' | 'soft'; amount?: number; id?: string}) {
  const id = `fx${kind}${label.replace(/\W/g, '')}`;
  const none = (kind === 'shadow' && label === 'No shadow') || amount === 0 && kind !== 'shadow';
  return <button type="button" className={`fmt-tile${on ? ' is-on' : ''}`} aria-label={label} title={label} aria-pressed={on} onClick={onPick}>
    <svg viewBox="0 0 46 38" width="46" height="38" aria-hidden="true">
      <defs>
        <filter id={id} x="-50%" y="-50%" width="200%" height="200%">
          {kind === 'shadow' ? <><feGaussianBlur in="SourceAlpha" stdDeviation="2"/><feOffset dx={label.startsWith('Outer') ? 3 : label.startsWith('Bottom') ? 0 : 0} dy={label.startsWith('Outer') ? 3 : label.startsWith('Bottom') ? 4 : 0} result="o"/>
            <feFlood floodColor="#000" floodOpacity=".5"/><feComposite in2="o" operator="in"/></>
            : kind === 'glow' ? <><feMorphology in="SourceAlpha" operator="dilate" radius={amount / 5}/><feGaussianBlur stdDeviation={amount / 6}/><feFlood floodColor="#e8774e" floodOpacity=".8"/><feComposite in2="SourceAlpha" operator="in"/></> : null}
        </filter>
      </defs>
      {kind === 'shadow' && label.startsWith('Perspective') ? <path d="M7 27h18l8 5H1Z" fill="#000" opacity=".35"/> : null}
      {kind === 'shadow' && !label.startsWith('No') && !label.startsWith('Inner') && !label.startsWith('Perspective') ? <rect x="12" y="11" width="22" height="16" rx="2" filter={`url(#${id})`}/> : null}
      {kind === 'glow' && amount > 0 ? <rect x="12" y="11" width="22" height="16" rx="2" fill="#e8774e" filter={`url(#${id})`}/> : null}
      <rect x="12" y="11" width="22" height="16" rx="2" fill="#e8774e" style={kind === 'soft' && amount > 0 ? {filter: `blur(${Math.min(amount / 6, 3)}px)`} : undefined}/>
      {kind === 'shadow' && label.startsWith('Inner') ? <rect x="12.5" y="11.5" width="21" height="15" rx="2" fill="none" stroke="#000" strokeOpacity=".5" strokeWidth="2"/> : null}
      {none ? <path d="M7 31 39 7" stroke="#85858c" strokeWidth="1.5"/> : null}
    </svg>
  </button>;
}

export default function FormatPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const [tab, setTab] = useState('fill');
  const [stop, setStop] = useState(0);
  const [lock, setLock] = useState(false);
  const [center, setCenter] = useState(false);
  const [alt, setAlt] = useState<{id: string; text: string} | null>(null);
  const request = (session.get(docId) as Any)?.view?.paneRequest;
  const wanted = (session.get(docId) as Any)?.view?.formatTab;
  useEffect(() => { if (wanted && TABS.some(([k]) => k === wanted)) setTab(wanted); }, [request?.n, wanted]); // eslint-disable-line react-hooks/exhaustive-deps

  const model = useMemo(() => {
    try {
      const d: Any = session.get(docId);
      const content = d.file.content;
      const slide = slideById(content, currentSlideId(content, d.selection));
      if (!slide) return null;
      const ids = selectedShapeIds(content, d.selection);
      const sh = ids.length ? findShape(slide.shapes, ids[0]) : null;
      if (!sh) return {sh: null as Any};
      const ctx = ctxForSlide(content, slide);
      const hexOf = (c: Any) => (ctx && c ? cssColor({...ctxColor(ctx, c, null), a: 255}) : '#000000');
      return {sh, count: ids.length, x: xfrmOf(content, slide.id, sh), hexOf, ctx};
    } catch { return null; }
  }, [session, docId, tick]);

  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const run = (id: string, params: Record<string, unknown> = {}) => controller.run(id, params, {origin: 'ui'}).catch(fail);
  if (!model || !model.sh) return <div className="bgp"><small className="bgp-empty">Select a shape to format it.</small></div>;
  const {sh, x, hexOf} = model as Any;
  const isPic = sh.kind?.type === 'picture';
  const tabs = TABS.filter(([k]) => k !== 'picture' || isPic);
  const cur = tabs.some(([k]) => k === tab) ? tab : 'fill';
  const single = (model as Any).count === 1;

  const fill = (params: Record<string, unknown>) => run('shape.fill', params);
  const line = (params: Record<string, unknown>) => run('shape.line', params);
  const fx = (params: Record<string, unknown>) => run('shape.effects', params);
  const f = sh.fill;
  const kind = f == null ? 'auto' : f.kind === 'none' ? 'none' : f.kind === 'solid' ? 'solid' : f.kind === 'gradient' ? 'gradient' : f.kind === 'picture' ? 'picture' : f.kind === 'pattern' ? 'pattern' : 'auto';
  const chooseKind = (k: string) => {
    if (k === kind) return;
    if (k === 'none') void fill({none: true});
    else if (k === 'solid') void fill({color: 'accent1'});
    else if (k === 'gradient') void fill({gradient: {stops: [[0, 'accent1'], [1, {scheme: 'accent1', lumMod: 50000}]], angle: 90}});
    else if (k === 'pattern') void fill({pattern: {preset: 'pct25', fg: 'accent1', bg: 'bg1'}});
    else if (k === 'picture') void fill({pick: true});
    else void fill({reset: true});
  };

  const fillTab = () => {
    const g = f?.kind === 'gradient' ? f : null;
    const sel = g ? Math.min(stop, g.stops.length - 1) : 0;
    const gset = (ng: Any) => fill({gradient: gradientToParam(ng)});
    const base = g?.stops?.[0]?.color ?? {base: {kind: 'scheme', slot: 'accent1'}};
    const lighter = {...base, mods: [...(base.mods ?? []), {op: 'lumMod', val: 40000}, {op: 'lumOff', val: 60000}]};
    const darker = {...base, mods: [...(base.mods ?? []), {op: 'lumMod', val: 50000}]};
    const lin = (angle: number) => ({shape: {kind: 'linear', angle, scaled: false}, rotateWithShape: true});
    const presets: Any[] = g ? [
      {...g, ...lin(90), stops: [{pos: 0, color: base}, {pos: 1, color: base}]},
      {...g, ...lin(90), stops: [{pos: 0, color: lighter}, {pos: 1, color: base}]},
      {...g, ...lin(0), stops: [{pos: 0, color: base}, {pos: 1, color: darker}]},
      {...g, ...lin(45), stops: [{pos: 0, color: lighter}, {pos: 0.5, color: base}, {pos: 1, color: darker}]},
      {...g, shape: {kind: 'path', path: 'circle', focus: [0.5, 0.5, 0.5, 0.5]}, rotateWithShape: true, stops: [{pos: 0, color: lighter}, {pos: 1, color: darker}]},
      {...g, ...lin(90), stops: [{pos: 0, color: base}, {pos: 1, color: withAlpha(base, 0)}]},
    ] : [];
    const bar = (gr: Any) => `linear-gradient(90deg, ${gr.stops.map((s: Any) => `${hexOf(s.color)} ${Math.round(s.pos * 100)}%`).join(', ')})`;
    const shapeKind = g?.shape?.kind === 'path' ? (g.shape.path === 'rect' ? 'rectangular' : g.shape.path === 'shape' ? 'path' : 'radial') : 'linear';
    const pic = f?.kind === 'picture' ? f : null;
    const tile = pic?.mode?.kind === 'tile' ? pic.mode : null;
    const pp = (props: Record<string, unknown>) => fill({pictureProps: props});
    const pt = f?.kind === 'pattern' ? f : null;
    const l = sh.line;
    const lineNone = l?.fill?.kind === 'none';
    const lineSolid = !lineNone && !!l;
    const dashName = l?.dash?.name ?? 'solid';
    return <>
      <Heading>Fill</Heading>
      <div className="bgp-radios" role="radiogroup" aria-label="Fill">
        {KINDS.map(([k, label]) => <label key={k} className="bgp-radio"><input type="radio" name="fmt-fill" checked={kind === k} onChange={() => chooseKind(k)} data-fill-kind={k}/><span>{label}</span></label>)}
      </div>
      {f?.kind === 'solid' ? <>
        <div className="bgp-row"><span>Color</span><ColorButton label="Fill color" color={hexOf(f.color)} onPick={hex => fill({color: hex, ...(alphaOf(f.color) < 1 ? {transparency: 1 - alphaOf(f.color)} : {})})}/></div>
        <Slider label="Transparency" value={Math.round((1 - alphaOf(f.color)) * 100)} onCommit={v => fill({transparency: v / 100})}/>
      </> : null}
      {kind === 'auto' ? <div className="bgp-row"><span>Color</span><ColorButton label="Fill color" color="#4472c4" onPick={hex => fill({color: hex})}/></div> : null}
      {g ? <>
        <div className="bgp-label">Preset gradients</div>
        <div className="bgp-presets">{presets.map((p, i) => <button key={i} type="button" className="bgp-bar" style={{background: bar(p)}} aria-label={`Preset gradient ${i + 1}`} onClick={() => gset(p)}/>)}</div>
        <label className="bgp-row"><span>Type</span>
          <select value={shapeKind} aria-label="Gradient type" onChange={e => {
            const k = e.target.value;
            const focus = g.shape.kind === 'path' ? g.shape.focus : [0.5, 0.5, 0.5, 0.5];
            gset({...g, shape: k === 'linear' ? {kind: 'linear', angle: 90, scaled: false} : {kind: 'path', path: k === 'rectangular' ? 'rect' : k === 'path' ? 'shape' : 'circle', focus}});
          }}>{['linear', 'radial', 'rectangular', 'path'].map(k => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}</select></label>
        <label className="bgp-row"><span>Direction</span>
          <select aria-label="Gradient direction" value={g.shape.kind === 'linear' ? String(LINEAR.find(([, a]) => Math.abs(a - g.shape.angle) < 0.5)?.[1] ?? '') : String(PATH.findIndex(([, p]) => p.every((v, i) => Math.abs(v - g.shape.focus[i]) < 1e-3)))}
            onChange={e => {
              if (g.shape.kind === 'linear') gset({...g, shape: {kind: 'linear', angle: Number(e.target.value), scaled: false}});
              else gset({...g, shape: {...g.shape, focus: PATH[Number(e.target.value)]?.[1] ?? g.shape.focus}});
            }}>
            {g.shape.kind === 'linear' ? <>{LINEAR.map(([label, a]) => <option key={a} value={a}>{label}</option>)}<option value="">Custom</option></> : PATH.map(([label], i) => <option key={label} value={i}>{label}</option>)}
          </select></label>
        {g.shape.kind === 'linear' ? <Num label="Angle" value={g.shape.angle} step={15} suffix="°" onCommit={v => gset({...g, shape: {kind: 'linear', angle: ((v % 360) + 360) % 360, scaled: false}})}/> : null}
        <div className="bgp-label">Gradient stops</div>
        <div className="bgp-stops" style={{background: bar(g)}} role="group" aria-label="Gradient bar"
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
            const rgb = {r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a: 255};
            gset({...g, stops: g.stops.map((s: Any, i: number) => (i === sel ? {...s, color: withAlpha({base: {kind: 'rgb', rgb}}, alphaOf(s.color))} : s))});
          }}/>
            <button type="button" className="sf-button bgp-small" disabled={g.stops.length <= 2} onClick={() => { setStop(Math.max(sel - 1, 0)); gset({...g, stops: g.stops.filter((_: Any, i: number) => i !== sel)}); }}>Remove stop</button></div>
          <Num label="Position" value={Math.round(g.stops[sel].pos * 100)} step={5} min={0} max={100} suffix="%" onCommit={v => gset({...g, stops: g.stops.map((s: Any, i: number) => (i === sel ? {...s, pos: Math.min(Math.max(v / 100, 0), 1)} : s)).sort((a: Any, b: Any) => a.pos - b.pos)})}/>
          <Slider label="Transparency" value={Math.round((1 - alphaOf(g.stops[sel].color)) * 100)} onCommit={v => gset({...g, stops: g.stops.map((s: Any, i: number) => (i === sel ? {...s, color: withAlpha(s.color, 1 - v / 100)} : s))})}/>
        </> : null}
        <label className="bgp-check"><input type="checkbox" checked={g.rotateWithShape !== false} onChange={e => gset({...g, rotateWithShape: e.target.checked})}/><span>Rotate with shape</span></label>
      </> : null}
      {pt ? <>
        <div className="bgp-label">Pattern</div>
        <div className="bgp-patterns" role="listbox" aria-label="Pattern">
          {GALLERY.map((name: string) => <button key={name} type="button" role="option" aria-selected={pt.preset === name} aria-label={patternLabel(name)} title={patternLabel(name)} className={`bgp-pat${pt.preset === name ? ' is-on' : ''}`}
            onClick={() => fill({pattern: {preset: name, fg: colorToParam(pt.fg), bg: colorToParam(pt.bg)}})}>
            <svg viewBox="0 0 8 8" width="22" height="22" shapeRendering="crispEdges" aria-hidden="true"><rect width="8" height="8" fill={hexOf(pt.bg)}/>
              {patternRuns(name).map(([px, py, n]: number[], i: number) => <rect key={i} x={px} y={py} width={n} height={1} fill={hexOf(pt.fg)}/>)}</svg></button>)}
        </div>
        <div className="bgp-row"><span>Foreground color</span><ColorButton label="Foreground color" color={hexOf(pt.fg)} onPick={hex => fill({pattern: {preset: pt.preset, fg: hex, bg: colorToParam(pt.bg)}})}/></div>
        <div className="bgp-row"><span>Background color</span><ColorButton label="Background color" color={hexOf(pt.bg)} onPick={hex => fill({pattern: {preset: pt.preset, fg: colorToParam(pt.fg), bg: hex}})}/></div>
      </> : null}
      {pic ? <>
        <div className="bgp-row"><span>Picture source</span><button type="button" className="sf-button bgp-small" onClick={() => fill({pick: true})}>Insert…</button></div>
        <Slider label="Transparency" value={Math.round((1 - (pic.alpha ?? 1)) * 100)} onCommit={v => fill({transparency: v / 100})}/>
        <label className="bgp-check"><input type="checkbox" checked={!!tile} onChange={e => pp({tile: e.target.checked})}/><span>Tile picture as texture</span></label>
        {tile ? <>
          <Num label="Offset X" value={tile.tx} suffix="pt" onCommit={v => pp({offsetX: v})}/>
          <Num label="Offset Y" value={tile.ty} suffix="pt" onCommit={v => pp({offsetY: v})}/>
          <Num label="Scale X" value={tile.sx * 100} step={5} suffix="%" onCommit={v => pp({scaleX: v / 100})}/>
          <Num label="Scale Y" value={tile.sy * 100} step={5} suffix="%" onCommit={v => pp({scaleY: v / 100})}/>
          <Choice label="Alignment" value={tile.align} items={ALIGN} onPick={v => pp({align: v})}/>
          <Choice label="Mirror type" value={tile.flip} items={MIRROR} onPick={v => pp({mirror: v})}/>
        </> : (pic.mode?.fillRect ?? [0, 0, 0, 0]).map((v: number, i: number) => <Num key={i} label={['Offset left', 'Offset top', 'Offset right', 'Offset bottom'][i]} value={v * 100} suffix="%"
          onCommit={nv => { const rect = [...pic.mode.fillRect]; rect[i] = nv / 100; pp({stretch: rect}); }}/>)}
        <label className="bgp-check"><input type="checkbox" checked={pic.upright !== true} onChange={e => pp({rotateWithShape: e.target.checked})}/><span>Rotate with shape</span></label>
      </> : null}
      <Heading>Line</Heading>
      <div className="bgp-radios" role="radiogroup" aria-label="Line">
        <label className="bgp-radio"><input type="radio" name="fmt-line" checked={lineNone} onChange={() => line({none: true})}/><span>No line</span></label>
        <label className="bgp-radio"><input type="radio" name="fmt-line" checked={lineSolid} onChange={() => line({color: 'tx1', width: 1})}/><span>Solid line</span></label>
        <label className="bgp-radio"><input type="radio" name="fmt-line" checked={!l} onChange={() => line({reset: true})}/><span>Automatic</span></label>
      </div>
      <div className="bgp-row"><span>Color</span><ColorButton label="Line color" color={l?.fill?.kind === 'solid' ? hexOf(l.fill.color) : '#000000'} onPick={hex => line({color: hex})}/></div>
      <Num label="Width" value={l?.width ?? 0.75} step={0.25} min={0} suffix="pt" onCommit={v => line({width: Math.max(v, 0)})}/>
      <Choice label="Dash type" value={dashName} items={DASHES} onPick={v => line({dash: v})}/>
      <Choice label="Compound type" value={l?.compound ?? 'single'} items={COMPOUND} onPick={v => line({compound: v})}/>
      <Choice label="Cap type" value={l?.cap ?? 'flat'} items={CAPS} onPick={v => line({cap: v})}/>
      <Choice label="Join type" value={l?.join ?? 'round'} items={JOINS} onPick={v => line({join: v})}/>
      {([['Begin arrow', 'head', 'Begin size', 'headSize'], ['End arrow', 'tail', 'End size', 'tailSize']] as const).map(([lab, key, slab, skey]) => <div key={key}>
        <Choice label={lab} value={l?.[key]?.kind ?? 'none'} items={ARROWS} onPick={v => line({[key]: v})}/>
        {l?.[key] ? <Choice label={slab} value={l[key].w ?? 'med'} items={ARROW_SIZES} onPick={v => line({[skey]: v})}/> : null}
      </div>)}
    </>;
  };

  const effectsTab = () => {
    const e = sh.effects ?? {};
    const shadow = e.innerShadow ?? e.outerShadow;
    const presetOf = () => (e.innerShadow ? 'inner' : !e.outerShadow ? 'none' : e.outerShadow.align === 'bl' ? 'perspective' : e.outerShadow.dist === 0 ? 'center' : e.outerShadow.dir === 90 ? 'bottom' : 'outer');
    const cur = presetOf();
    const alphaPct = (c: Any) => Math.round((1 - alphaOf(c)) * 100);
    const refl = e.reflection;
    const glow = e.glow;
    const soft = e.softEdge ?? 0;
    const t3: Any = parse3d(e.raw3d);
    const bevel = t3.top?.preset ?? e.bevel ?? 'none';
    const b3 = t3.top;
    return <>
      <Heading>Shadow</Heading>
      <div className="fmt-tiles">{SHADOWS.map(([id, label]) => <EffectTile key={id} kind="shadow" label={label} on={cur === id} onPick={() => fx({shadow: id})}/>)}</div>
      {shadow ? <>
        <div className="bgp-row"><span>Color</span><ColorButton label="Shadow color" color={hexOf(shadow.color)} onPick={hex => fx({shadowProps: {color: hex}})}/></div>
        <Slider label="Transparency" value={alphaPct(shadow.color)} onCommit={v => fx({shadowProps: {transparency: v / 100}})}/>
        <Num label="Blur" value={shadow.blur} min={0} max={100} suffix="pt" onCommit={v => fx({shadowProps: {blur: v}})}/>
        <Num label="Angle" value={shadow.dir} min={0} max={359} suffix="°" onCommit={v => fx({shadowProps: {dir: v}})}/>
        <Num label="Distance" value={shadow.dist} min={0} max={200} suffix="pt" onCommit={v => fx({shadowProps: {dist: v}})}/>
      </> : null}
      <Heading>Reflection</Heading>
      <div className="fmt-seg" role="group" aria-label="Reflection">{[['none', 'None'], ['tight', 'Tight'], ['half', 'Half'], ['full', 'Full']].map(([v, l]) => <button key={v} type="button" className="sf-button bgp-small" onClick={() => fx({reflection: v})}>{l}</button>)}</div>
      {refl ? <>
        <Slider label="Transparency" value={Math.round((1 - refl.startAlpha) * 100)} onCommit={v => fx({reflectionProps: {transparency: v / 100}})}/>
        <Num label="Size" value={refl.endPos * 100} min={0} max={100} suffix="%" onCommit={v => fx({reflectionProps: {size: v / 100}})}/>
        <Num label="Distance" value={refl.dist} min={0} max={100} suffix="pt" onCommit={v => fx({reflectionProps: {dist: v}})}/>
        <Num label="Blur" value={refl.blur} min={0} max={100} suffix="pt" onCommit={v => fx({reflectionProps: {blur: v}})}/>
      </> : null}
      <Heading>Glow</Heading>
      <div className="fmt-tiles">{GLOWS.map(r => <EffectTile key={r} kind="glow" amount={r} label={r === 0 ? 'No glow' : `${r} pt glow`} on={(glow?.radius ?? 0) === r} onPick={() => fx({glowProps: {radius: r}})}/>)}</div>
      <Num label="Size" value={glow?.radius ?? 0} min={0} max={150} suffix="pt" onCommit={v => fx({glowProps: {radius: v}})}/>
      {glow ? <>
        <div className="bgp-row"><span>Color</span><ColorButton label="Glow color" color={hexOf(glow.color)} onPick={hex => fx({glowProps: {color: hex}})}/></div>
        <Slider label="Transparency" value={alphaPct(glow.color)} onCommit={v => fx({glowProps: {transparency: v / 100}})}/>
      </> : null}
      <Heading>Soft Edges</Heading>
      <div className="fmt-tiles">{SOFTS.map(r => <EffectTile key={r} kind="soft" amount={r} label={r === 0 ? 'No soft edges' : `${r} pt soft edges`} on={soft === r} onPick={() => fx({softEdges: r})}/>)}</div>
      <Num label="Size" value={soft} min={0} max={50} suffix="pt" onCommit={v => fx({softEdges: v})}/>
      <Heading>3-D Format</Heading>
      <Choice label="Top bevel" value={bevel} items={[['none', 'None'], ...BEVELS.map((b: string) => [b, (BEVEL_LABELS as Any)[b]] as [string, string])]} onPick={v => fx({threeD: {bevelTop: v}})}/>
      {b3 ? <>
        <Num label="Width" value={b3.w} min={0} max={1584} suffix="pt" onCommit={v => fx({threeD: {bevelTopW: v}})}/>
        <Num label="Height" value={b3.h} min={0} max={1584} suffix="pt" onCommit={v => fx({threeD: {bevelTopH: v}})}/>
      </> : null}
      <div className="bgp-actions"><button type="button" className="sf-button" onClick={() => fx({reset: true})}>Reset Effects</button></div>
    </>;
  };

  const sizeTab = () => {
    const off = center && single ? [x.w / 2, x.h / 2] : [0, 0];
    const inch = (pt: number) => Math.round((pt / IN) * 1000) / 1000;
    const Field = ({label, value, onCommit, suffix = '"', step = 0.1, disabled = false}: {label: string; value: number; onCommit: (v: number) => void; suffix?: string; step?: number; disabled?: boolean}) =>
      <label className="bgp-row"><span>{label}</span><input type="number" value={value} step={step} aria-label={label} disabled={disabled}
        onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) onCommit(v); }}/><small>{suffix}</small></label>;
    return <>
      <Heading>Size</Heading>
      <Field label="Height" value={inch(x.h)} onCommit={v => run('shape.resize', {h: v * IN, ...(lock ? {lockAspect: true} : {})})}/>
      <Field label="Width" value={inch(x.w)} onCommit={v => run('shape.resize', {w: v * IN, ...(lock ? {lockAspect: true} : {})})}/>
      <Field label="Rotation" value={Math.round((x.rot ?? 0) * 10) / 10} suffix="°" step={1} onCommit={v => run('shape.rotate', {deg: v})}/>
      <Field label="Scale Height" value={100} suffix="%" step={5} disabled={!single} onCommit={v => v > 0 && run('shape.sizePosition', {scaleH: v, ...(lock ? {lockAspect: true} : {})})}/>
      <Field label="Scale Width" value={100} suffix="%" step={5} disabled={!single} onCommit={v => v > 0 && run('shape.sizePosition', {scaleW: v, ...(lock ? {lockAspect: true} : {})})}/>
      <label className="bgp-check"><input type="checkbox" checked={lock} onChange={e => setLock(e.target.checked)}/><span>Lock aspect ratio</span></label>
      <Heading>Position</Heading>
      <label className="bgp-row"><span>From</span><select value={center ? 'c' : 'tl'} disabled={!single} aria-label="Position from" onChange={e => setCenter(e.target.value === 'c')}>
        <option value="tl">Top Left Corner</option><option value="c">Center</option></select></label>
      <Field label="Horizontal" value={inch(x.x + off[0])} onCommit={v => run('shape.move', {x: v * IN - off[0]})}/>
      <Field label="Vertical" value={inch(x.y + off[1])} onCommit={v => run('shape.move', {y: v * IN - off[1]})}/>
      <Heading>Alt Text</Heading>
      <textarea className="fmt-alt" rows={3} placeholder="Alt text" aria-label="Alt text" value={alt && alt.id === sh.id ? alt.text : sh.descr ?? ''}
        onChange={e => setAlt({id: sh.id, text: e.target.value})} onBlur={() => { if (alt && alt.id === sh.id && alt.text !== (sh.descr ?? '')) void run('shape.altText', {text: alt.text}); setAlt(null); }}/>
    </>;
  };

  const textTab = () => {
    const b = sh.text?.body ?? {};
    const anchor = b.anchor ?? 'top';
    const fit = b.autofit?.kind === 'shape' ? 'resize' : b.autofit?.kind === 'shrink' ? 'shrink' : 'none';
    return <>
      <Heading>Text Fill</Heading>
      <div className="bgp-row"><span>Color</span><ColorButton label="Text color" color="#000000" onPick={hex => run('format.color', {color: hex})}/></div>
      <Heading>Text Box</Heading>
      <Choice label="Vertical alignment" value={anchor} items={[['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']]} onPick={v => run('format.anchor', {anchor: v})}/>
      <Choice label="Autofit" value={fit} items={[['none', 'Do not Autofit'], ['shrink', 'Shrink text on overflow'], ['resize', 'Resize shape to fit text']]} onPick={v => run('format.autofit', {mode: v})}/>
      <label className="bgp-check"><input type="checkbox" checked={b.wrap !== false} onChange={e => run('format.wrap', {on: e.target.checked})}/><span>Wrap text in shape</span></label>
      {([['Left', 'left', b.insetL ?? 7.2], ['Right', 'right', b.insetR ?? 7.2], ['Top', 'top', b.insetT ?? 3.6], ['Bottom', 'bottom', b.insetB ?? 3.6]] as const)
        .map(([label, key, v]) => <Num key={key} label={`${label} margin`} value={v} step={1} min={0} suffix="pt" onCommit={nv => run('format.margins', {[key]: Math.max(nv, 0)})}/>)}
      <div className="bgp-row"><span>Columns</span>{[1, 2, 3].map(n => <button key={n} type="button" className="sf-button bgp-small" onClick={() => run('format.columns', {count: n, spacing: 18})}>{n}</button>)}
        <button type="button" className="sf-button bgp-small" onClick={() => run('format.columns', {})}>More…</button></div>
    </>;
  };

  const pictureTab = () => {
    const pf = sh.kind?.fill ?? {};
    const adj = pf.adjust ?? {};
    const range = (label: string, value: number, min: number, max: number, set: (v: number) => void, unit = 100) => <Num label={label} value={Math.round(value * unit)} min={min * unit} max={max * unit} suffix="%" onCommit={v => set(v / unit)}/>;
    return <>
      <Heading>Picture Corrections</Heading>
      {range('Brightness', adj.brightness ?? 0, -1, 1, v => run('picture.adjust', {brightness: v}))}
      {range('Contrast', adj.contrast ?? 0, -1, 1, v => run('picture.adjust', {contrast: v}))}
      <Heading>Picture Color</Heading>
      {range('Saturation', adj.saturation ?? 1, 0, 4, v => run('picture.adjust', {saturation: v}))}
      {range('Transparency', 1 - (pf.alpha ?? 1), 0, 1, v => run('picture.adjust', {transparency: v}))}
      <div className="bgp-actions"><button type="button" className="sf-button" onClick={() => run('picture.reset')}>Reset Picture</button></div>
    </>;
  };

  return <div className="bgp fmt" data-format-tab={cur}>
    <div className="fmt-tabs" role="tablist" aria-label="Format Shape">
      {tabs.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={cur === k} aria-label={label} title={label} className={`fmt-tab${cur === k ? ' is-on' : ''}`} data-tab={k} onClick={() => setTab(k)}><TabIcon id={k}/></button>)}
    </div>
    <div className="fmt-title">{isGroup(sh) ? 'Group Options' : sh.kind?.type === 'picture' ? 'Picture Options' : 'Shape Options'}</div>
    {cur === 'effects' ? effectsTab() : cur === 'size' ? sizeTab() : cur === 'text' ? textTab() : cur === 'picture' && isPic ? pictureTab() : fillTab()}
  </div>;
}
