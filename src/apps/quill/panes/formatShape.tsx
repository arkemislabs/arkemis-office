// The Format Shape pane (Shape Format › Shape Styles › Shape Fill › Gradient › More Gradients…; Format Picture for a picture):
// the selected drawing's Fill & Line, Effects and Layout & Properties, and for a picture its Picture tab (Corrections, Color,
// Transparency, Crop). Reads the selected object through object.info and writes through the Shape Format and Picture
// Format commands only (shape.fill, shape.outline, shape.effects, picture.*, arrange.rotation, object.altText).
//
// Translated from wordcraft crates/ui-egui/src/format_shape.rs (`format_shape_pane`: No fill, Solid fill and Gradient fill with
// Color, Transparency, preset gradients, Type, Direction, Angle, Gradient stops, Rotate with shape) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt. The other tabs
// are Word's own sections over the commands the ribbon uses: the pane itself keeps no state of its own.

import {useEffect, useState, type ReactNode} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import {rgbHex, parseRgb} from '../../../../core/quill/model/props.mjs';
import {fillParams, variations, presets, defaultGradient, addStop, linearDirectionName, pathDirectionName, LINEAR_DIRECTIONS, PATH_DIRECTIONS, cornerTile} from '../../../../core/quill/lib/shape-fill.mjs';
import {SHADOW_PRESETS, REFLECTION_PRESETS, BEVELS} from '../../../../core/quill/model/effects.mjs';
import {TileArt} from '../../../shell/ribbon/TileArt';

type Info = {
  type: string; kind: string | null; canvas: boolean; textBox: boolean; width: number; height: number; rotation: number; wrap: string;
  fill: any; stroke: number[] | null; strokeWidth: number; effects: any; crop: number[]; border: number[] | null; edited: boolean; original: {width: number; height: number} | null;
  alt: string; title: string; decorative: boolean; vert: string | null; anchor: string | null; theme: number[][] | null;
  chart: null | {element: string; label: string; elements: {id: string; label: string}[]; areaFill: string | null; areaLine: 'none' | {color: string; width: number} | null; title: string | null; legend: string | null; series: {name: string; color: string}[]};
};
type Tab = 'fill' | 'effects' | 'layout' | 'picture';
const PATHS = PATH_DIRECTIONS as unknown as number[][];
const LINEARS = LINEAR_DIRECTIONS as unknown as number[];

const hex = (c: number[] | null | undefined, d = '#000000') => (c ? `#${rgbHex(c)}` : d);
const round = (v: number, n = 2) => Math.round(v * 10 ** n) / 10 ** n;

function Section({title, children, open = true}: {title: string; children: ReactNode; open?: boolean}) {
  const [on, setOn] = useState(open);
  return <section className="fmt-section" style={{borderTop: '1px solid rgba(255,255,255,.08)', paddingTop: 6}}>
    <button type="button" className="fmt-section-head" aria-expanded={on} onClick={() => setOn(!on)}
      style={{display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 0, color: 'inherit', font: 'inherit', fontWeight: 600, padding: '2px 0', cursor: 'default'}}>
      <span aria-hidden="true" style={{display: 'inline-block', width: 10, transform: on ? 'rotate(90deg)' : 'none'}}>›</span>{title}
    </button>
    {on ? <div style={{display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0 6px 14px'}}>{children}</div> : null}
  </section>;
}
const Row = ({label, children}: {label: string; children: ReactNode}) => <label style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 12}}>
  <span style={{width: 96, flex: 'none', color: '#c1c2c9'}}>{label}</span>{children}</label>;

/** A number box that applies when it is left (Enter or blur), not on every keystroke. */
function Num({value, min, max, step = 1, unit, label, onCommit}: {value: number; min?: number; max?: number; step?: number; unit?: string; label: string; onCommit: (v: number) => void}) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => setText(null), [value]);
  const commit = (t: string) => { const n = Number(t); setText(null); if (Number.isFinite(n) && n !== value) onCommit(min !== undefined && max !== undefined ? Math.min(max, Math.max(min, n)) : n); };
  return <span style={{display: 'inline-flex', alignItems: 'center', gap: 4}}>
    <input className="sf-text" type="number" aria-label={label} min={min} max={max} step={step} value={text ?? String(round(value))} style={{width: 74}}
      onChange={e => setText(e.target.value)} onBlur={e => commit(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); }}/>
    {unit ? <small style={{color: '#b9bac1'}}>{unit}</small> : null}
  </span>;
}
/** A slider that applies when the pointer or key is released. */
function Slide({value, min, max, step = 1, unit, label, onCommit}: {value: number; min: number; max: number; step?: number; unit: string; label: string; onCommit: (v: number) => void}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const done = () => { if (v !== value) onCommit(v); };
  return <span className="sf-slider" style={{width: 'auto', flex: 1}}>
    <input type="range" aria-label={label} min={min} max={max} step={step} value={v} onChange={e => setV(Number(e.target.value))} onPointerUp={done} onKeyUp={done} onBlur={done}/>
    <output>{round(v)}{unit}</output>
  </span>;
}
const Color = ({value, label, onPick}: {value: string; label: string; onPick: (hex: string) => void}) =>
  <input type="color" aria-label={label} value={value} onChange={e => onPick(e.target.value.slice(1).toUpperCase())} style={{width: 36, height: 24, padding: 0, border: 0, background: 'none'}}/>;
const Radio = ({name, on, label, onPick}: {name: string; on: boolean; label: string; onPick: () => void}) => <label style={{display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12}}>
  <input type="radio" name={name} checked={on} onChange={onPick} style={{position: 'static', opacity: 1, width: 'auto'}}/>{label}</label>;
const Check = ({on, label, onPick}: {on: boolean; label: string; onPick: (v: boolean) => void}) => <label style={{display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12}}>
  <input type="checkbox" checked={on} onChange={e => onPick(e.target.checked)} style={{position: 'static', opacity: 1, width: 'auto'}}/>{label}</label>;

export default function FormatShapePane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  useSessionTick();
  const st = session.state(docId, 'object.info') as {enabled: boolean; reason?: string; value?: Info};
  const info = st.enabled ? st.value ?? null : null;
  const view = (() => { try { return (session.get(docId) as any).view ?? {}; } catch { return {}; } })();
  const picture = info?.type === 'image';
  const wanted = (view.formatPaneTab as Tab | undefined) ?? 'fill';
  const [tab, setTab] = useState<Tab>(wanted);
  useEffect(() => setTab(wanted), [wanted]);
  const [lock, setLock] = useState(true);
  const [message, setMessage] = useState('');
  const run = async (id: string, params: Record<string, unknown>) => {
    try { await controller.run(id, params, {origin: 'bridge-ui'}); setMessage(''); } catch (e) { setMessage(toCommandError(e).message); }
  };
  const tabs: [Tab, string][] = picture ? [['fill', 'Fill & Line'], ['effects', 'Effects'], ['layout', 'Layout & Properties'], ['picture', 'Picture']] : [['fill', 'Fill & Line'], ['effects', 'Effects'], ['layout', 'Layout & Properties']];
  const shown: Tab = tabs.some(t => t[0] === tab) ? tab : 'fill';
  if (!info) return <div className="quill-format-pane" style={{fontSize: 12, color: '#b9bac1'}}>{st.reason ?? 'Select a picture or shape.'}</div>;
  if (info.chart) return <ChartFormat info={info} chart={info.chart} run={run} message={message}/>;
  const title = picture ? 'Format Picture' : info.canvas ? 'Format Drawing Canvas' : info.textBox ? 'Format Text Box' : 'Format Shape';
  return <div className="quill-format-pane" data-object={info.type} data-tab={shown} style={{display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5}}>
    <b>{title}</b>
    <div role="tablist" aria-label={title} style={{display: 'flex', gap: 4, flexWrap: 'wrap'}}>
      {tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={shown === id} data-tab-id={id} className={`sf-button${shown === id ? ' is-selected' : ''}`}
        style={shown === id ? {outline: '1px solid var(--ark-glass-focus, #888)'} : undefined} onClick={() => setTab(id)}>{label}</button>)}
    </div>
    {message ? <small role="alert" style={{color: '#ff9d9d'}}>{message}</small> : null}
    {shown === 'fill' ? <FillAndLine info={info} picture={picture} run={run}/> : null}
    {shown === 'effects' ? <Effects info={info} run={run}/> : null}
    {shown === 'layout' ? <Layout info={info} picture={picture} lock={lock} setLock={setLock} run={run}/> : null}
    {shown === 'picture' ? <PictureTab info={info} run={run}/> : null}
  </div>;
}

type Run = (id: string, params: Record<string, unknown>) => Promise<void>;

/** Format Chart Area / Data Series / Chart Title / Legend (Chart Format › Current Selection › Format Selection): the element Current Selection picked. */
function ChartFormat({chart, run, message}: {info: Info; chart: NonNullable<Info['chart']>; run: Run; message: string}) {
  const el = chart.element, series = el.startsWith('series:') ? Number(el.slice(7)) : -1;
  const title = el === 'chartArea' ? 'Format Chart Area' : series >= 0 ? 'Format Data Series' : el === 'title' ? 'Format Chart Title' : 'Format Legend';
  const fillMode = chart.areaFill === 'none' ? 'none' : chart.areaFill ? 'solid' : 'auto';
  const line = chart.areaLine && chart.areaLine !== 'none' ? chart.areaLine : null;
  const lineMode = chart.areaLine === 'none' ? 'none' : line ? 'solid' : 'auto';
  return <div className="quill-format-pane" data-object="chart" data-element={el} style={{display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5}}>
    <b>{title}</b>
    <Row label="Chart element"><span className="sf-select"><select aria-label="Chart element" value={el} onChange={e => run('chart.element', {element: e.target.value})}>
      {chart.elements.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}</select></span></Row>
    {message ? <small role="alert" style={{color: '#ff9d9d'}}>{message}</small> : null}
    {el === 'chartArea' ? <>
      <Section title="Fill">
        <div role="radiogroup" aria-label="Fill" style={{display: 'flex', gap: 10, flexWrap: 'wrap'}}>
          <Radio name="area-fill" on={fillMode === 'none'} label="No fill" onPick={() => run('chart.areaFill', {color: null})}/>
          <Radio name="area-fill" on={fillMode === 'solid'} label="Solid fill" onPick={() => run('chart.areaFill', {color: 'FFFFFF'})}/>
          <Radio name="area-fill" on={fillMode === 'auto'} label="Automatic" onPick={() => run('chart.areaFill', {auto: true})}/>
        </div>
        {fillMode === 'solid' ? <Row label="Color"><Color label="Chart area fill color" value={chart.areaFill ?? '#ffffff'} onPick={c => run('chart.areaFill', {color: c})}/></Row> : null}
      </Section>
      <Section title="Border">
        <div role="radiogroup" aria-label="Border" style={{display: 'flex', gap: 10, flexWrap: 'wrap'}}>
          <Radio name="area-line" on={lineMode === 'none'} label="No line" onPick={() => run('chart.areaOutline', {color: null})}/>
          <Radio name="area-line" on={lineMode === 'solid'} label="Solid line" onPick={() => run('chart.areaOutline', {color: '595959', width: 1})}/>
          <Radio name="area-line" on={lineMode === 'auto'} label="Automatic" onPick={() => run('chart.areaOutline', {auto: true})}/>
        </div>
        {line ? <>
          <Row label="Color"><Color label="Chart area border color" value={line.color} onPick={c => run('chart.areaOutline', {color: c})}/></Row>
          <Row label="Width"><Num label="Chart area border width" value={line.width} min={0} max={72} step={0.25} unit="pt" onCommit={v => run('chart.areaOutline', {width: v})}/></Row>
        </> : null}
      </Section>
    </> : null}
    {series >= 0 && chart.series[series] ? <Section title="Fill">
      <Row label="Color"><Color label="Series fill color" value={chart.series[series].color} onPick={c => run('chart.seriesColor', {series, color: c})}/></Row>
      <button type="button" className="sf-button" onClick={() => run('chart.seriesColor', {series, color: null})}>Automatic</button>
    </Section> : null}
    {el === 'title' ? <Section title="Title"><Row label="Text"><input className="sf-text" aria-label="Chart title" defaultValue={chart.title ?? ''} key={chart.title ?? ''} onBlur={e => { if (e.target.value !== (chart.title ?? '')) void run('chart.title', {text: e.target.value || null}); }}/></Row></Section> : null}
    {el === 'legend' ? <Section title="Legend Options"><Row label="Position"><span className="sf-select"><select aria-label="Legend position" value={chart.legend ?? 'bottom'} onChange={e => run('chart.legend', {pos: e.target.value})}>
      {['top', 'bottom', 'left', 'right'].map(p => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}</select></span></Row></Section> : null}
  </div>;
}

function FillAndLine({info, picture, run}: {info: Info; picture: boolean; run: Run}) {
  const f = info.fill;
  const mode = !f ? 'none' : f.type === 'gradient' ? 'gradient' : 'solid';
  const accent = (info.theme?.[4] as number[] | undefined) ?? [68, 114, 196];
  const g = mode === 'gradient' ? f : null;
  const setGradient = (next: any) => run('shape.fill', fillParams(next));
  const withStops = (stops: any[]) => setGradient({...g, stops});
  const stopsCopy = () => g.stops.map((s: any) => ({...s}));
  const lines = info.stroke !== null && (picture ? !!info.border : true);
  return <>
    {!picture ? <Section title="Fill">
      <div role="radiogroup" aria-label="Fill" style={{display: 'flex', gap: 10, flexWrap: 'wrap'}}>
        <Radio name="fill" on={mode === 'none'} label="No fill" onPick={() => run('shape.fill', {color: null})}/>
        <Radio name="fill" on={mode === 'solid'} label="Solid fill" onPick={() => run('shape.fill', {color: rgbHex(accent)})}/>
        <Radio name="fill" on={mode === 'gradient'} label="Gradient fill" onPick={() => setGradient(defaultGradient(accent))}/>
      </div>
      {mode === 'solid' ? <>
        <Row label="Color"><Color label="Fill color" value={hex(f.color ?? f)} onPick={c => run('shape.fill', {color: c})}/></Row>
        <Row label="Transparency"><Slide label="Fill transparency" value={f.transparency ?? 0} min={0} max={100} unit="%" onCommit={v => run('shape.fill', {color: rgbHex(f.color ?? f), transparency: v})}/></Row>
      </> : null}
      {mode === 'gradient' ? <>
        <div>
          <small style={{color: '#c1c2c9'}}>Presets</small>
          <span style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 38px)', gap: 3, marginTop: 3}}>
            {(presets(info.theme ?? []) as any[]).slice(0, 12).map((p, i) => <button key={i} type="button" className="fmt-preset" aria-label={`Preset gradient ${i + 1}`} style={{background: 'none', border: 0, padding: 0}} onClick={() => setGradient(p)}><TileArt art={{kind: 'gradient', fill: p}}/></button>)}
          </span>
        </div>
        <Row label="Type">
          <span className="sf-select"><select aria-label="Gradient type" value={g.kind.type === 'path' ? g.kind.shape : 'linear'}
            onChange={e => {
              const v = e.target.value;
              setGradient({...g, kind: v === 'linear' ? {type: 'linear', angle: 90, scaled: true} : {type: 'path', shape: v, focus: [50, 50, 50, 50]}, tile: undefined});
            }}>
            <option value="linear">Linear</option><option value="circle">Radial</option><option value="rect">Rectangular</option><option value="shape">Path</option>
          </select></span>
        </Row>
        <Row label="Direction">
          <span className="sf-select"><select aria-label="Gradient direction"
            value={g.kind.type === 'path' ? PATHS.findIndex((d: number[]) => d.every((v: number, i: number) => v === g.kind.focus[i])) : LINEARS.indexOf(Math.round(g.kind.angle))}
            onChange={e => {
              const k = Number(e.target.value);
              setGradient(g.kind.type === 'path'
                ? {...g, kind: {...g.kind, focus: [...PATHS[k]]}, tile: cornerTile(PATHS[k]) ?? undefined}
                : {...g, kind: {...g.kind, angle: LINEARS[k]}});
            }}>
            <option value={-1} disabled>Custom</option>
            {(g.kind.type === 'path' ? PATHS.map((d: number[]) => pathDirectionName(d)) : LINEARS.map((a: number) => linearDirectionName(a))).map((n: string, i: number) => <option key={i} value={i}>{n}</option>)}
          </select></span>
        </Row>
        {g.kind.type === 'linear' ? <Row label="Angle"><Num label="Gradient angle" value={g.kind.angle} min={0} max={359.99} unit="°" onCommit={v => setGradient({...g, kind: {...g.kind, angle: v}})}/></Row> : null}
        <div role="group" aria-label="Gradient stops" style={{display: 'flex', flexDirection: 'column', gap: 4}}>
          <b style={{fontSize: 12}}>Gradient stops</b>
          {g.stops.map((s: any, i: number) => <div key={i} data-stop={i} style={{display: 'flex', alignItems: 'center', gap: 6}}>
            <Num label={`Stop ${i + 1} position`} value={s.pos} min={0} max={100} unit="%" onCommit={v => { const x = stopsCopy(); x[i].pos = v; withStops(x); }}/>
            <Color label={`Stop ${i + 1} color`} value={hex(s.color)} onPick={c => { const x = stopsCopy(); x[i].color = parseRgb(c); withStops(x); }}/>
            <Num label={`Stop ${i + 1} transparency`} value={s.transparency ?? 0} min={0} max={100} unit="%" onCommit={v => { const x = stopsCopy(); x[i].transparency = v; withStops(x); }}/>
            <button type="button" className="sf-button" aria-label={`Remove stop ${i + 1}`} disabled={g.stops.length <= 2} onClick={() => withStops(stopsCopy().filter((_: any, k: number) => k !== i))}>−</button>
          </div>)}
          <button type="button" className="sf-button" style={{alignSelf: 'flex-start'}} onClick={() => { const x = stopsCopy(); if (addStop(x, 50) !== null) withStops(x); }}>Add stop</button>
        </div>
        <Check on={!!g.rotWithShape} label="Rotate with shape" onPick={v => setGradient({...g, rotWithShape: v})}/>
        <div>
          <small style={{color: '#c1c2c9'}}>Variations</small>
          <span style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 38px)', gap: 3, marginTop: 3}}>
            {([0, 1] as const).flatMap(k => (variations(g.stops[Math.floor(g.stops.length / 2)]?.color ?? accent)[k] as any[]).slice(0, 7).map((v, i) => <button key={`${k}${i}`} type="button" aria-label={v.name} title={v.name} style={{background: 'none', border: 0, padding: 0}} onClick={() => setGradient(v.fill)}><TileArt art={{kind: 'gradient', fill: v.fill}}/></button>))}
          </span>
        </div>
      </> : null}
    </Section> : null}
    <Section title={picture ? 'Picture border' : 'Line'}>
      <div role="radiogroup" aria-label="Line" style={{display: 'flex', gap: 10}}>
        <Radio name="line" on={!lines} label={picture ? 'No border' : 'No line'} onPick={() => run(picture ? 'picture.border' : 'shape.outline', picture ? {none: true} : {color: null})}/>
        <Radio name="line" on={lines} label={picture ? 'Border' : 'Solid line'} onPick={() => run(picture ? 'picture.border' : 'shape.outline', picture ? {width: 4} : {width: info.strokeWidth || 0.75, color: rgbHex(info.stroke ?? [0x0e, 0x40, 0x5a])})}/>
      </div>
      {lines ? <>
        <Row label="Color"><Color label="Line color" value={hex(picture ? info.border : info.stroke)} onPick={c => run(picture ? 'picture.border' : 'shape.outline', picture ? {color: c, width: info.border?.[3] ?? 4} : {color: c})}/></Row>
        <Row label={picture ? 'Width (px)' : 'Width'}><Num label="Line width" value={picture ? info.border?.[3] ?? 4 : info.strokeWidth} min={picture ? 1 : 0} max={picture ? 200 : 72} step={picture ? 1 : 0.25} unit={picture ? 'px' : 'pt'}
          onCommit={v => run(picture ? 'picture.border' : 'shape.outline', picture ? {width: v, color: rgbHex(info.border?.slice(0, 3) ?? [0, 0, 0])} : {width: v})}/></Row>
      </> : null}
    </Section>
  </>;
}

function Effects({info, run}: {info: Info; run: Run}) {
  const e = info.effects ?? {};
  const sh = e.shadow, gl = e.glow;
  return <>
    <Section title="Shadow">
      <Row label="Presets"><span className="sf-select"><select aria-label="Shadow preset" value={sh ? 'custom' : 'none'} onChange={ev => run('shape.effects', {shadow: ev.target.value === 'none' ? null : ev.target.value})}>
        <option value="none">No shadow</option>{sh ? <option value="custom" disabled>Custom</option> : null}
        {(SHADOW_PRESETS as readonly (readonly string[])[]).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select></span></Row>
      {sh ? <>
        <Row label="Color"><Color label="Shadow color" value={hex(sh.color)} onPick={c => run('shape.effects', {shadow: {color: c, transparency: sh.transparency, blur: sh.blur, distance: sh.distance, angle: sh.angle}})}/></Row>
        {([['Transparency', 'transparency', 0, 100, '%'], ['Blur', 'blur', 0, 100, 'pt'], ['Distance', 'distance', 0, 200, 'pt'], ['Angle', 'angle', 0, 359, '°']] as [string, string, number, number, string][]).map(([label, key, min, max, unit]) =>
          <Row key={key} label={label}><Num label={`Shadow ${label.toLowerCase()}`} value={sh[key]} min={min} max={max} unit={unit}
            onCommit={v => run('shape.effects', {shadow: {color: rgbHex(sh.color), transparency: sh.transparency, blur: sh.blur, distance: sh.distance, angle: sh.angle, [key]: v}})}/></Row>)}
      </> : null}
    </Section>
    <Section title="Glow">
      <Row label="Size"><Num label="Glow size" value={gl?.size ?? 0} min={0} max={150} unit="pt" onCommit={v => run('shape.effects', {glow: v <= 0 ? null : {size: v, color: rgbHex(gl?.color ?? [0x15, 0x60, 0x82]), transparency: gl?.transparency ?? 60}})}/></Row>
      {gl ? <>
        <Row label="Color"><Color label="Glow color" value={hex(gl.color)} onPick={c => run('shape.effects', {glow: {size: gl.size, color: c, transparency: gl.transparency}})}/></Row>
        <Row label="Transparency"><Slide label="Glow transparency" value={gl.transparency} min={0} max={100} unit="%" onCommit={v => run('shape.effects', {glow: {size: gl.size, color: rgbHex(gl.color), transparency: v}})}/></Row>
      </> : null}
    </Section>
    <Section title="Reflection">
      <Row label="Presets"><span className="sf-select"><select aria-label="Reflection preset" value={e.reflection ? ((REFLECTION_PRESETS as readonly (readonly any[])[]).find(([, , v]) => v.endPos === e.reflection.endPos && v.dist === e.reflection.dist)?.[0] ?? 'custom') : 'none'}
        onChange={ev => run('shape.effects', {reflection: ev.target.value === 'none' ? null : ev.target.value})}>
        <option value="none">No reflection</option>{e.reflection ? <option value="custom" disabled>Custom</option> : null}
        {(REFLECTION_PRESETS as readonly (readonly any[])[]).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select></span></Row>
      {e.reflection ? <>
        <Row label="Transparency"><Slide label="Reflection transparency" value={Math.round((1 - e.reflection.startAlpha) * 100)} min={0} max={100} unit="%" onCommit={v => run('shape.effects', {reflection: {...e.reflection, startAlpha: 1 - v / 100}})}/></Row>
        <Row label="Size"><Slide label="Reflection size" value={Math.round(e.reflection.endPos * 100)} min={0} max={100} unit="%" onCommit={v => run('shape.effects', {reflection: {...e.reflection, endPos: v / 100}})}/></Row>
        <Row label="Distance"><Num label="Reflection distance" value={e.reflection.dist} min={0} max={200} unit="pt" onCommit={v => run('shape.effects', {reflection: {...e.reflection, dist: v}})}/></Row>
      </> : null}
    </Section>
    <Section title="Soft edges">
      <Row label="Size"><Num label="Soft edge size" value={e.softEdge ?? 0} min={0} max={100} unit="pt" onCommit={v => run('shape.effects', {softEdge: v <= 0 ? null : v})}/></Row>
    </Section>
    <Section title="Bevel">
      <Row label="Shape"><span className="sf-select"><select aria-label="Bevel" value={e.bevel?.preset ?? 'none'} onChange={ev => run('shape.effects', {bevel: ev.target.value === 'none' ? null : ev.target.value})}>
        <option value="none">No bevel</option>{(BEVELS as readonly (readonly string[])[]).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select></span></Row>
      {e.bevel ? <Row label="Width"><Num label="Bevel width" value={e.bevel.w} min={0} max={100} unit="pt" onCommit={v => run('shape.effects', {bevel: {preset: e.bevel.preset, w: v, h: v}})}/></Row> : null}
    </Section>
  </>;
}

function Layout({info, picture, lock, setLock, run}: {info: Info; picture: boolean; lock: boolean; setLock: (v: boolean) => void; run: Run}) {
  return <>
    <Section title="Size">
      <Row label="Height"><Num label="Height" value={info.height} min={1} max={4000} unit="pt" onCommit={v => run('picture.size', {height: v, lockAspect: lock})}/></Row>
      <Row label="Width"><Num label="Width" value={info.width} min={1} max={4000} unit="pt" onCommit={v => run('picture.size', {width: v, lockAspect: lock})}/></Row>
      <Row label="Rotation"><Num label="Rotation" value={info.rotation} min={0} max={360} unit="°" onCommit={v => run('arrange.rotation', {degrees: v})}/></Row>
      <Check on={lock} label="Lock aspect ratio" onPick={setLock}/>
      {picture && info.original ? <small style={{color: '#b9bac1'}}>Original size: {round(info.original.height, 1)} × {round(info.original.width, 1)} pt</small> : null}
    </Section>
    {info.textBox ? <Section title="Text box">
      <Row label="Vertical alignment"><span className="sf-select"><select aria-label="Vertical alignment" value={info.anchor ?? 'top'} onChange={e => run('shape.alignText', {anchor: ({top: 't', center: 'ctr', bottom: 'b'} as any)[e.target.value]})}>
        <option value="top">Top</option><option value="center">Middle</option><option value="bottom">Bottom</option></select></span></Row>
      <Row label="Text direction"><span className="sf-select"><select aria-label="Text direction" value={info.vert ?? 'horz'} onChange={e => run('shape.textDirection', {dir: e.target.value})}>
        <option value="horz">Horizontal</option><option value="vert">Rotate all text 90°</option><option value="vert270">Rotate all text 270°</option><option value="stacked">Stacked</option></select></span></Row>
    </Section> : null}
    <AltFields info={info} run={run}/>
  </>;
}

function AltFields({info, run}: {info: Info; run: Run}) {
  const [text, setText] = useState(info.alt);
  const [title, setTitle] = useState(info.title);
  useEffect(() => { setText(info.alt); setTitle(info.title); }, [info.alt, info.title]);
  return <Section title="Alt Text">
    <Row label="Title"><input className="sf-text" aria-label="Title" value={title} disabled={info.decorative} onChange={e => setTitle(e.target.value)} onBlur={() => { if (title !== info.title) void run('object.altText', {title}); }}/></Row>
    <Row label="Description"><textarea className="sf-textarea" aria-label="Description" value={text} disabled={info.decorative} rows={3} onChange={e => setText(e.target.value)} onBlur={() => { if (text !== info.alt) void run('object.altText', {text}); }}/></Row>
    <Check on={info.decorative} label="Mark as decorative" onPick={v => run('object.altText', {decorative: v})}/>
  </Section>;
}

function PictureTab({info, run}: {info: Info; run: Run}) {
  const [b, setB] = useState(0), [c, setC] = useState(0), [sh, setSh] = useState(0), [sat, setSat] = useState(100), [tr, setTr] = useState(0);
  const corr = (next: {brightness?: number; contrast?: number; sharpen?: number}) => run('picture.corrections', {brightness: b, contrast: c, sharpen: sh, ...next});
  const crop = (i: number, v: number) => {
    const x = [...info.crop];
    x[i] = Math.max(0, Math.min(0.95, v / 100));
    run('picture.crop', {left: x[0], top: x[1], right: x[2], bottom: x[3]});
  };
  return <>
    <Section title="Picture corrections">
      <Row label="Brightness"><Slide label="Brightness" value={b} min={-100} max={100} unit="%" onCommit={v => { setB(v); void corr({brightness: v}); }}/></Row>
      <Row label="Contrast"><Slide label="Contrast" value={c} min={-100} max={100} unit="%" onCommit={v => { setC(v); void corr({contrast: v}); }}/></Row>
      <Row label="Sharpness"><Slide label="Sharpness" value={sh} min={-100} max={100} unit="%" onCommit={v => { setSh(v); void corr({sharpen: v}); }}/></Row>
    </Section>
    <Section title="Picture color">
      <Row label="Saturation"><Slide label="Saturation" value={sat} min={0} max={400} step={5} unit="%" onCommit={v => { setSat(v); void run('picture.color', {mode: 'saturation', saturation: v}); }}/></Row>
      <span style={{display: 'flex', gap: 6, flexWrap: 'wrap'}}>
        {(['grayscale', 'sepia', 'washout', 'blackAndWhite'] as const).map(m => <button key={m} type="button" className="sf-button" onClick={() => run('picture.color', {mode: m})}>{({grayscale: 'Grayscale', sepia: 'Sepia', washout: 'Washout', blackAndWhite: 'Black and White'})[m]}</button>)}
      </span>
      <Row label="Transparency"><Slide label="Picture transparency" value={tr} min={0} max={100} unit="%" onCommit={v => { setTr(v); void run('picture.transparency', {percent: v}); }}/></Row>
    </Section>
    <Section title="Crop">
      {(['Left', 'Top', 'Right', 'Bottom'] as const).map((side, i) => <Row key={side} label={side}><Num label={`Crop ${side.toLowerCase()}`} value={(info.crop[i] ?? 0) * 100} min={0} max={95} unit="%" onCommit={v => crop(i, v)}/></Row>)}
      <button type="button" className="sf-button" style={{alignSelf: 'flex-start'}} onClick={() => run('picture.crop', {})}>Reset crop</button>
    </Section>
    <button type="button" className="sf-button" style={{alignSelf: 'flex-start'}} disabled={!info.edited && info.crop.every(v => !v)}
      onClick={() => { setB(0); setC(0); setSh(0); setSat(100); setTr(0); void run('picture.reset', {}); }}>Reset picture</button>
  </>;
}
