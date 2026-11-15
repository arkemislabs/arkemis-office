// The form layer of one page: filling the form in place (type into text fields, toggle check boxes
// and radio buttons, pick drop-down and list items, press buttons) and Prepare a form (every field
// with its light-blue fill and name tag, select, move, resize, draw new fields with a field tool, a
// marquee, the right-click menu).
//
// Translated from printcraft crates/ui-egui/src/tools/prepare.rs (FIELD_FILL, SELECT_BLUE, page_input:
// click or drag with a field tool places a field, Grab::Move / Corner / Select, handles at the four
// corners, name tags: white text on black, blue when selected, paint_page), tools/forms_ui.rs (filling:
// text fields edit in place and commit on Enter or leaving, check boxes and radio buttons toggle, a
// list box picks the row under the pointer, buttons run their action) and canvas.rs:1930 (the field
// menu) at 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see assets/third-party-licenses/artcraft-reference.txt).
// Everything is written through commands (form.fill, form.field.set_rect, form.add.*, form.select).

import {useEffect, useRef, useState, type PointerEvent as ReactPointerEvent} from 'react';
import {userRectToView, normalize} from '../../../../core/folio/lib/geom.mjs';
import {resized, handlePos} from '../../../../core/folio/lib/pageview.mjs';
import {defaultSize} from '../../../../core/folio/lib/form-edit.mjs';
import type {PageGeom} from './PageView';

type Any = any;

export interface FormState { prepare: boolean; preview: boolean; highlight: boolean; tool: string | null; sel: {name: string; widget: number}[] }

const FIELD_FILL = 'rgba(77, 148, 240, .35)';
const SELECT_BLUE = '#1473e6';
const HIGHLIGHT = 'rgba(77, 148, 240, .2)';
const CORNERS: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
const TOOL_KIND: Record<string, string> = {'form.add.text': 'text', 'form.add.checkbox': 'checkbox', 'form.add.radio': 'radio', 'form.add.combo': 'combo', 'form.add.list': 'list',
  'form.add.button': 'button', 'form.add.image': 'image', 'form.add.date': 'date', 'form.add.signature': 'signature'};

type Gesture =
  | {kind: 'move'; name: string; widget: number; from: [number, number]; to: [number, number]; rect: number[]}
  | {kind: 'resize'; name: string; widget: number; handle: [number, number]; from: [number, number]; to: [number, number]; rect: number[]}
  | {kind: 'draw'; from: [number, number]; to: [number, number]}
  | {kind: 'marquee'; from: [number, number]; to: [number, number]; extend: boolean};

const round = (v: number) => Math.round(v * 1000) / 1000;
const css = (c: number[] | null) => (Array.isArray(c) ? `rgb(${c.map(v => Math.round(v * 255)).join(',')})` : undefined);

export function FormLayer({api, page, geom, form, fields}: {api: Any; page: Any; geom: PageGeom; form: FormState; fields: Any[]}) {
  const host = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const gref = useRef<Gesture | null>(null);
  gref.current = gesture;
  const prepare = form.prepare && !form.preview;
  const scale = geom.scale;
  const widgets = fields.flatMap(f => f.widgets.map((w: Any, wi: number) => ({f, w, wi}))).filter(({w}) => w.pageId === page.id && !w.hidden);
  const viewRect = (w: Any) => normalize(userRectToView(page, w.rect));
  const toView = (e: {clientX: number; clientY: number}): [number, number] => {
    const b = host.current!.getBoundingClientRect();
    return [(e.clientX - b.left) / scale, (e.clientY - b.top) / scale];
  };
  const px = (r: number[]) => ({left: r[0] * scale, top: r[1] * scale, width: (r[2] - r[0]) * scale, height: (r[3] - r[1]) * scale});
  const selected = (name: string, wi: number) => form.sel.some(s => s.name === name && s.widget === wi);
  const select = (name: string, widget: number, extend: boolean) => {
    const next = extend ? (selected(name, widget) ? form.sel.filter(s => !(s.name === name && s.widget === widget)) : [...form.sel, {name, widget}]) : [{name, widget}];
    return api.exec('form.select', {fields: next});
  };
  const commit = async (name: string, value: unknown) => { await api.exec('form.fill', {name, value}); };

  // ── Prepare: gestures ──────────────────────────────────────────────────────────────────────
  const tool = form.tool && TOOL_KIND[form.tool] ? form.tool : null;
  function down(e: ReactPointerEvent<HTMLDivElement>, hit: {name: string; widget: number; rect: number[]; handle?: [number, number]} | null) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const v = toView(e);
    try { host.current?.setPointerCapture(e.pointerId); } catch { /* a pointer the system does not track */ }
    (host.current?.closest('.folio-surface') as HTMLElement | null)?.focus({preventScroll: true});
    if (tool) { setGesture({kind: 'draw', from: v, to: v}); return; }
    if (hit?.handle) { setGesture({kind: 'resize', name: hit.name, widget: hit.widget, handle: hit.handle, from: v, to: v, rect: hit.rect}); return; }
    if (hit) {
      const extend = e.shiftKey || e.ctrlKey || e.metaKey;
      if (!selected(hit.name, hit.widget) || extend) void select(hit.name, hit.widget, extend);
      if (!extend || !selected(hit.name, hit.widget)) setGesture({kind: 'move', name: hit.name, widget: hit.widget, from: v, to: v, rect: hit.rect});
      return;
    }
    setGesture({kind: 'marquee', from: v, to: v, extend: e.shiftKey || e.ctrlKey || e.metaKey});
  }
  function move(e: ReactPointerEvent<HTMLDivElement>) {
    const g = gref.current;
    if (!g) return;
    setGesture({...g, to: toView(e)} as Gesture);
  }
  async function up(e: ReactPointerEvent<HTMLDivElement>) {
    const g = gref.current;
    setGesture(null);
    try { host.current?.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (!g) return;
    const to = toView(e);
    const dist = Math.hypot((to[0] - g.from[0]) * scale, (to[1] - g.from[1]) * scale);
    switch (g.kind) {
      case 'draw': {
        const r = normalize([g.from[0], g.from[1], to[0], to[1]]);
        const w = (r[2] - r[0]) * scale, h = (r[3] - r[1]) * scale;
        const args: Any = {page: page.id};
        // A click: the default size, top-left at the pointer; a drag: the rectangle drawn (prepare.rs page_input).
        if (w < 4 || h < 4) args.at = [round(g.from[0]), round(g.from[1])]; else args.rect = [round(r[0]), round(r[1]), round(r[2] - r[0]), round(r[3] - r[1])];
        await api.exec(form.tool!, args);
        break;
      }
      case 'move':
        if (dist >= 1) await api.exec('form.field.set_rect', {name: g.name, widget: g.widget, dx: round(to[0] - g.from[0]), dy: round(to[1] - g.from[1])});
        break;
      case 'resize': {
        if (dist < 1) break;
        const r = resized(g.rect, g.handle, to[0] - g.from[0], to[1] - g.from[1], null);
        if ((r[2] - r[0]) * scale >= 4 && (r[3] - r[1]) * scale >= 4) await api.exec('form.field.set_rect', {name: g.name, widget: g.widget, rect: [round(r[0]), round(r[1]), round(r[2] - r[0]), round(r[3] - r[1])]});
        break;
      }
      case 'marquee': {
        if (dist < 4) { if (!g.extend) await api.exec('form.select', {fields: []}); break; }
        const box = normalize([g.from[0], g.from[1], to[0], to[1]]);
        const hit = widgets.filter(({w}) => { const r = viewRect(w); return r[0] < box[2] && r[2] > box[0] && r[1] < box[3] && r[3] > box[1]; }).map(({f, wi}) => ({name: f.name, widget: wi}));
        await api.exec('form.select', {fields: hit, extend: g.extend});
        break;
      }
      default: break;
    }
  }

  // The previews of a gesture in progress.
  const live = (name: string, wi: number, base: number[]): number[] => {
    const g = gesture;
    if (!g || !('name' in g) || g.name !== name || g.widget !== wi) return base;
    if (g.kind === 'move') return [base[0] + g.to[0] - g.from[0], base[1] + g.to[1] - g.from[1], base[2] + g.to[0] - g.from[0], base[3] + g.to[1] - g.from[1]];
    if (g.kind === 'resize') return resized(g.rect, g.handle, g.to[0] - g.from[0], g.to[1] - g.from[1], null);
    return base;
  };

  // ── Prepare: painting ──────────────────────────────────────────────────────────────────────
  if (prepare) {
    const drawing = gesture?.kind === 'draw' || gesture?.kind === 'marquee' ? normalize([gesture.from[0], gesture.from[1], gesture.to[0], gesture.to[1]]) : null;
    return <div ref={host} className={`ff-layer is-prepare${tool ? ' has-tool' : ''}`} data-form-layer="prepare" onPointerDown={e => down(e, null)} onPointerMove={move} onPointerUp={e => void up(e)} onPointerCancel={() => setGesture(null)}
      style={{cursor: tool ? 'crosshair' : 'default'}}>
      {widgets.map(({f, w, wi}) => {
        const base = viewRect(w);
        const r = live(f.name, wi, base);
        const on = selected(f.name, wi);
        return <div key={`${f.id}:${wi}`} className={`ff-box${on ? ' is-selected' : ''}`} data-form-widget={`${f.name}\u0000${wi}`} data-field={f.name} data-widget={wi} style={{...px(r), background: FIELD_FILL, borderColor: on ? SELECT_BLUE : 'rgba(90,90,90,.9)', cursor: tool ? 'crosshair' : 'move'}}
          onPointerDown={e => down(e, {name: f.name, widget: wi, rect: base})}>
          <span className="ff-tag" style={{background: on ? SELECT_BLUE : '#000'}}>{f.name}</span>
          {on ? CORNERS.map(h => { const p = handlePos([0, 0, r[2] - r[0], r[3] - r[1]], h as [number, number]); return <u key={h.join()} className="ff-handle" style={{left: p[0] * scale, top: p[1] * scale}}
            onPointerDown={e => down(e as Any, {name: f.name, widget: wi, rect: base, handle: h})}/>; }) : null}
        </div>;
      })}
      {drawing ? <div className="ff-drawing" style={px(drawing)}/> : null}
      {tool && gesture?.kind !== 'draw' ? <span className="ff-hint">{`Click to add a ${tool ? defaultSize(TOOL_KIND[tool]).join(' × ') : ''} pt field, or drag to set its size`}</span> : null}
    </div>;
  }

  // ── Fill: the widgets ─────────────────────────────────────────────────────────────────────
  return <div ref={host} className="ff-layer is-fill" data-form-layer="fill">
    {widgets.map(({f, w, wi}) => {
      const r = viewRect(w);
      const key = `${f.id}:${wi}`;
      const ro = !!(f.flags & 1) || w.readOnly || !!api.formLocked;
      const box = px(r);
      const common = {className: `ff-w ff-${f.kind}${form.highlight ? ' is-highlighted' : ''}${ro ? ' is-readonly' : ''}`, 'data-form-widget': `${f.name}\u0000${wi}`, 'data-field': f.name, 'data-kind': f.kind, onPointerDown: (e: Any) => e.stopPropagation()};
      const style = {...box, ...(form.highlight ? {background: HIGHLIGHT} : {})};
      switch (f.kind) {
        case 'text': {
          const multiline = !!(f.flags & (1 << 12));
          const stored = f.value[0] ?? '';
          const size = Math.max(7, ((w.look?.size || Math.min(12, Math.max(4, (r[3] - r[1]) / 1.15))) * scale));
          // Uncontrolled: what is typed is read when the field loses focus (forms_ui.rs commits on Enter or leaving), so the
          // value stored in the form never lags a keystroke; the key makes a value changed elsewhere show at once.
          const props: Any = {className: 'ff-input', defaultValue: stored, readOnly: ro, 'aria-label': f.name, maxLength: f.maxLen || undefined, spellCheck: !(f.flags & (1 << 22)),
            type: f.flags & (1 << 13) ? 'password' : 'text', style: {fontSize: size, textAlign: ['left', 'center', 'right'][f.quadding] as Any, color: css(w.look?.text) ?? '#000'},
            onBlur: (e: Any) => { const v = e.currentTarget.value; if (v !== stored) void commit(f.name, v); },
            onKeyDown: (e: Any) => { e.stopPropagation(); if (e.key === 'Enter' && !multiline) e.currentTarget.blur(); else if (e.key === 'Escape') { e.currentTarget.value = stored; e.currentTarget.blur(); } }};
          return <div key={key} {...common} style={style}>{multiline ? <textarea key={`${key}:${stored}`} {...props}/> : <input key={`${key}:${stored}`} {...props}/>}</div>;
        }
        case 'checkbox': case 'radio': {
          const on = f.kind === 'checkbox' ? f.value.length > 0 : f.value[0] === w.onState;
          return <button key={key} type="button" {...common} style={style} role={f.kind} aria-checked={on} aria-label={f.name} disabled={ro}
            onClick={() => { if (ro) return; void api.exec('form.fill', {name: f.name, value: f.kind === 'checkbox' ? !on : (on && !(f.flags & (1 << 14)) ? null : w.onState)}); }}/>;
        }
        case 'combo': {
          const cur = f.value[0] ?? '';
          const editable = !!(f.flags & (1 << 18));
          const opts = f.options as [string, string][];
          return <div key={key} {...common} style={style}>
            <select className="ff-select" value={cur} disabled={ro} aria-label={f.name} onChange={e => void api.exec('form.fill', {name: f.name, value: e.target.value})}>
              {cur === '' || !opts.some(([x]) => x === cur) ? <option value={cur}>{editable ? cur : ''}</option> : null}
              {opts.map(([x, label]) => <option key={x} value={x}>{label}</option>)}
            </select></div>;
        }
        case 'list': {
          const rows = w.list ?? {top: 0, inset: 2, row: 13.8, size: 12};
          return <div key={key} {...common} style={style} role="listbox" aria-multiselectable={!!(f.flags & (1 << 21))} aria-label={f.name}
            onClick={e => {
              if (ro) return;
              const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const y = (e.clientY - b.top) / scale;
              if (y < rows.inset) return;
              const i = rows.top + Math.floor((y - rows.inset) / rows.row);
              const opt = (f.options as [string, string][])[i];
              if (!opt) return;
              const multi = !!(f.flags & (1 << 21));
              const has = f.value.includes(opt[0]);
              void api.exec('form.fill', {name: f.name, value: multi && (e.ctrlKey || e.metaKey) ? (has ? f.value.filter((x: string) => x !== opt[0]) : [...f.value, opt[0]]) : [opt[0]]});
            }}/>;
        }
        case 'pushbutton': {
          const act = f.button;
          return <button key={key} type="button" {...common} style={style} aria-label={f.widgets[0]?.caption || f.name} disabled={ro && false}
            onClick={() => { void runButton(api, act, f); }}/>;
        }
        case 'signature':
          return <button key={key} type="button" {...common} style={style} aria-label={`Sign ${f.name}`} onClick={() => api.sign?.(f.name)}/>;
        default: return null;
      }
    })}
  </div>;
}

/** forms_ui.rs: what a push button's mouse-up action does here (the ones that act on the document). */
async function runButton(api: Any, act: Any, f: Any) {
  if (!act) return;
  switch (act.kind) {
    case 'reset': await api.exec('form.clear', act.fields?.length ? {names: act.fields} : {}); break;
    case 'goto': await api.exec('surface.scroll', {page: act.page + 1}); break;
    case 'named': {
      const forward = act.name === 'NextPage', back = act.name === 'PrevPage';
      if (forward || back) await api.exec('view.step_page', {forward});
      else if (act.name === 'FirstPage') await api.exec('surface.scroll', {page: 1});
      else if (act.name === 'LastPage') await api.exec('surface.scroll', {page: api.content.pages.length});
      else if (act.name === 'Print') await api.exec('file.print', {});
      break;
    }
    case 'alert': api.notify?.(act.message); break;
    default: void f;
  }
}

export {TOOL_KIND};
