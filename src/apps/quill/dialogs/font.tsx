// Font dialog view (Home › Font launcher, Ctrl+D): Word's Font and Advanced pages, laid out as
// Word lays them out (Font / Font style / Size across the top, All text, Effects, Preview), over the
// model in core/quill/dialogs/font.mjs. Also exports the pieces the other U:quill/format dialog
// views share (page tabs, a spec field by id, style pickers, the Word preview boxes).
// Layout from wordcraft crates/ui-egui/src/dialogs/dispatch.rs `font_dialog` and Word's dialog at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode} from 'react';
import {useFonts} from '../../../shell/common/Flyout';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {fieldComponent, PreviewField, LabelField} from '../../../shell/fields';
import {fieldVisible, type DialogState} from '../../../shell/dialogs/dialogState';
import type {SpecField} from '../../../generated/spec-types';
import {styleOptions} from '../../../../core/quill/lib/format-dialogs.mjs';

export type BodyProps = {dialog: DialogState; setValue: (field: string, value: unknown) => void};

// ---------------------------------------------------------------------------------------------
// Shared pieces

/** The dialog's page tabs (a Body override draws them itself). */
export function PageTabs({dialog: d}: {dialog: DialogState}) {
  const {controller} = useEngine();
  if (d.spec.tabs.length < 2) return null;
  return <div className="gd-tabs" role="tablist" aria-label={`${d.spec.title} pages`}>
    {d.spec.tabs.map((t, i) => <button key={i} type="button" role="tab" aria-selected={i === d.tab} className={i === d.tab ? 'is-active' : undefined}
      onClick={() => controller.setDialogTab(d.key, i)}
      onKeyDown={e => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        controller.setDialogTab(d.key, (i + (e.key === 'ArrowRight' ? 1 : -1) + d.spec.tabs.length) % d.spec.tabs.length);
      }}>{t.name}</button>)}
  </div>;
}

const findField = (d: DialogState, id: string): SpecField | null => {
  for (const t of d.spec.tabs) for (const f of t.fields) if (f.id === id) return f;
  return null;
};

/** One spec field by id, drawn with the shell's field library (hidden when its visibleWhen fails). */
export function Field({d, id, set, override, style, options, noLabel, patch}: {d: DialogState; id: string; set: BodyProps['setValue']; override?: SpecField['kind'];
  style?: CSSProperties; options?: {value: unknown; label: string}[]; noLabel?: boolean; patch?: Record<string, unknown>}) {
  const {controller} = useEngine();
  const base = findField(d, id);
  const field = useMemo(() => (base ? {...base, ...(override ? {kind: override} : {}), ...(options ? {options} : {}), ...(noLabel ? {label: ''} : {}), ...(patch ?? {})} as SpecField : null), [base, override, options, noLabel, patch]);
  if (!field || !fieldVisible(field, d.values)) return null;
  if (field.kind === 'label') return <div style={style}><LabelField field={field} values={d.values}/></div>;
  const C = fieldComponent(field);
  if (!C) return null;
  const error = d.errors.find(e => e.field === id)?.message ?? null;
  return <div style={style}>
    <C field={field} value={d.values[id]} onChange={v => set(id, v)} error={error} disabled={d.busy}
      onPress={fid => { void controller.pressField(d.key, fid).catch(e => controller.notify(toCommandError(e).message, 'error')); }}
      onNested={(dialogId, fieldId, init) => { try { controller.openDialog(dialogId, {parent: d.key, target: {dialog: d.key, field: fieldId}, init}); } catch (e) { controller.notify(toCommandError(e).message, 'error'); } }}/>
  </div>;
}

/** A labelled group as Word frames one (All text, Effects, Indentation, Spacing…). */
export function Group({title, children, style}: {title: string; children: ReactNode; style?: CSSProperties}) {
  return <fieldset className="gd-section" style={{margin: '0 0 12px', paddingBottom: 10, ...style}}><legend>{title}</legend>{children}</fieldset>;
}

export const grid = (cols: string, extra?: CSSProperties): CSSProperties => ({display: 'grid', gridTemplateColumns: cols, gap: '10px 14px', alignItems: 'end', ...extra});

/** The document's styles for a Style based on / following / link box. */
export function useStyleOptions(kinds: string[], none: string | null = null) {
  const {session, docId} = useEngine();
  const ctx = session.readContext(docId) as {doc?: {styles?: unknown}} | null;
  const sheet = ctx?.doc?.styles;
  return useMemo(() => styleOptions(sheet, {kinds, none}) as {value: string; label: string}[], [sheet, kinds.join(','), none]);
}

/** Word's preview box: white paper, the sample in the chosen font and effects, with a baseline rule. */
export function TextPreview({p, label = 'Preview'}: {p: Record<string, unknown> | null; label?: string}) {
  const data = p ?? {};
  const size = typeof data.size === 'number' ? data.size : 12;
  const underline = typeof data.underline === 'string' ? data.underline : null;
  const deco: string[] = [];
  if (underline || data.hidden) deco.push('underline');
  if (data.strike || data.doubleStrike) deco.push('line-through');
  const decoStyle = data.hidden ? 'dotted' : underline === 'double' || data.doubleStrike ? 'double' : underline === 'dotted' ? 'dotted'
    : underline === 'dash' || underline === 'dotDash' || underline === 'dotDotDash' ? 'dashed' : underline === 'wave' || underline === 'doubleWave' ? 'wavy' : 'solid';
  const css: CSSProperties = {
    fontFamily: typeof data.font === 'string' && data.font ? `"${data.font}", Aptos, "Segoe UI", sans-serif` : undefined,
    fontSize: Math.max(8, Math.min(46, size * 1.33)),
    fontWeight: data.bold ? 700 : 400, fontStyle: data.italic ? 'italic' : 'normal',
    textDecorationLine: deco.join(' ') || undefined, textDecorationStyle: decoStyle as CSSProperties['textDecorationStyle'],
    textDecorationThickness: underline === 'thick' ? 2 : undefined,
    textDecorationColor: typeof data.underlineColor === 'string' ? data.underlineColor : undefined,
    textTransform: data.allCaps ? 'uppercase' : undefined, fontVariant: data.smallCaps ? 'small-caps' : undefined,
    color: typeof data.color === 'string' && data.color ? data.color : '#1b1b1d',
    letterSpacing: typeof data.spacing === 'number' && data.spacing ? `${data.spacing * 1.33}px` : undefined,
    verticalAlign: data.superscript ? 'super' : data.subscript ? 'sub' : undefined,
    position: typeof data.position === 'number' && data.position ? 'relative' : undefined,
    top: typeof data.position === 'number' && data.position ? -data.position * 1.33 : undefined,
    display: 'inline-block', transform: typeof data.scale === 'number' && data.scale !== 100 ? `scaleX(${data.scale / 100})` : undefined,
    whiteSpace: 'nowrap', maxWidth: '96%', overflow: 'hidden', textOverflow: 'ellipsis',
  };
  const text = String(data.text ?? 'AaBbYyZz');
  const shown = data.superscript || data.subscript ? <span style={{fontSize: Math.max(8, Math.min(46, size * 1.33)) * 0.65, ...css}}>{text}</span> : <span style={css}>{text}</span>;
  return <div className="sf" data-field-id="preview" data-kind="preview">
    <span className="sf-label">{label}</span>
    <div role="img" aria-label={`Preview: ${text}`} style={{position: 'relative', display: 'grid', placeItems: 'center', height: 74, overflow: 'hidden',
      borderRadius: 10, background: '#fff', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.25)'}}>
      <span style={{position: 'absolute', left: 14, right: 14, top: '62%', height: 1, background: 'rgba(0,0,0,.18)'}}/>
      {shown}
    </div>
  </div>;
}

/** Word's Paragraph preview page: grey previous/following paragraphs and the sample in darker grey. */
export function ParagraphPreview({p, label = 'Preview'}: {p: Record<string, unknown> | null; label?: string}) {
  const data = p ?? {};
  const k = 0.42; // px per point on the miniature page
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  const align = String(data.align ?? 'left');
  const rtl = !!data.rtl;
  const line = Math.max(0.5, Math.min(3, n(data.line) || 1));
  const widths = [100, 100, 100, 100, 62];
  const lines = (count: number, dark: boolean, sample: boolean) => Array.from({length: count}, (_, i) => {
    const last = i === count - 1;
    const w = sample ? widths[i] ?? 100 : last ? 54 : 100;
    const first = sample && i === 0 ? n(data.first) * k : 0;
    const just = sample && (align === 'justify' || align === 'distribute') && !last;
    const side = (align === 'center') ? 'auto' : undefined;
    const pushRight = (align === 'right') !== rtl && !just;
    return <i key={i} style={{display: 'block', height: 3.5, marginBottom: sample ? 3.5 * line : 3.5, borderRadius: 1, background: dark ? '#6b6e76' : '#cfd1d6',
      width: just ? `calc(100% - ${first}px)` : `calc(${w}% - ${first}px)`, marginLeft: sample ? (pushRight ? 'auto' : side ?? (rtl ? 0 : first)) : 0,
      marginRight: sample ? (align === 'center' ? 'auto' : rtl && !pushRight ? first : 0) : 0}}/>;
  });
  return <div className="sf" data-field-id="preview" data-kind="preview">
    <span className="sf-label">{label}</span>
    <div role="img" aria-label="Paragraph preview" style={{height: 132, padding: '10px 0', borderRadius: 10, background: '#e6e7ea', overflow: 'hidden'}}>
      <div style={{width: '82%', height: '100%', margin: '0 auto', padding: '10px 14px', boxSizing: 'border-box', background: '#fff', boxShadow: '0 1px 6px rgba(0,0,0,.2)', overflow: 'hidden'}}>
        <div>{lines(2, false, false)}</div>
        <div style={{marginTop: Math.min(24, n(data.before) * k) + 4, marginBottom: Math.min(24, n(data.after) * k) + 4,
          marginLeft: Math.max(-14, Math.min(120, n(rtl ? data.right : data.left) * k)), marginRight: Math.max(-14, Math.min(120, n(rtl ? data.left : data.right) * k))}}>
          {lines(5, true, true)}
        </div>
        <div>{lines(3, false, false)}</div>
      </div>
    </div>
  </div>;
}

/** A model preview, drawn as the generic preview field when no Word box fits. */
export function GenericPreview({d, id, p}: {d: DialogState; id: string; p: unknown}) {
  const f = findField(d, id);
  return f ? <PreviewField field={f} values={d.values} preview={p}/> : null;
}

/** The model's preview data for the dialog's current values. */
export function usePreview(d: DialogState): Record<string, unknown> | null {
  const {controller, session, docId} = useEngine();
  return useMemo(() => {
    const model = controller.dialogModel(d.id) as {preview?: (ctx: unknown, v: unknown) => unknown} | null;
    if (!model?.preview) return null;
    try { return model.preview(session.readContext(docId), d.values) as Record<string, unknown>; } catch { return null; }
  }, [controller, session, docId, d.id, d.values]);
}

// ---------------------------------------------------------------------------------------------
// The Font dialog

const SIZE_LIST = ['8', '9', '10', '10.5', '11', '12', '14', '16', '18', '20', '22', '24', '26', '28', '36', '48', '72'].map(n => ({value: n, label: n}));

// Whole rows (24 px each plus the 3 px padding) so the last row is never cut in half.
const LIST_H = {height: 3 + 6 * 24 + 3};
const STYLE_LIST = [{value: 'regular', label: 'Regular'}, {value: 'italic', label: 'Italic'}, {value: 'bold', label: 'Bold'}, {value: 'boldItalic', label: 'Bold Italic'}];

/** Word's list with an edit box above it (Font, Font style, Size): typing sets the value and the list follows. */
function EditList({d, id, set, options, matchLabel}: {d: DialogState; id: string; set: BodyProps['setValue']; options: {value: unknown; label: string}[]; matchLabel?: boolean}) {
  const base = findField(d, id);
  const raw = d.values[id];
  const shownFor = (v: unknown) => (matchLabel ? options.find(o => o.value === v)?.label ?? '' : v === null || v === undefined ? '' : String(v));
  const [text, setText] = useState(() => shownFor(raw));
  useEffect(() => { setText(t => (matchLabel && options.find(o => o.label.toLowerCase() === t.trim().toLowerCase())?.value === raw ? t : shownFor(raw))); }, [raw]); // eslint-disable-line react-hooks/exhaustive-deps
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = box.current?.querySelector<HTMLElement>('.sf-list');
    if (!list) return;
    const q = text.trim().toLowerCase();
    const items = Array.from(list.querySelectorAll<HTMLElement>('.sf-list-item'));
    const hit = list.querySelector<HTMLElement>('.is-selected') ?? (q ? items.find(i => (i.textContent ?? '').toLowerCase().startsWith(q)) : undefined);
    if (hit) list.scrollTop = Math.max(0, hit.offsetTop - list.offsetTop - 2);
  }, [text, raw]);
  if (!base) return null;
  const type = (t: string) => {
    setText(t);
    if (matchLabel) {
      const o = options.find(x => x.label.toLowerCase() === t.trim().toLowerCase());
      if (o) set(id, o.value);
    } else set(id, t);
  };
  const label = String(base.label ?? '');
  return <div ref={box} className="sf" data-field-id={`${id}-edit`} style={{display: 'grid', gap: 6, minWidth: 0}}>
    <label className="sf-label" htmlFor={`fd-${id}`}>{label}</label>
    <input id={`fd-${id}`} className="sf-text" type="text" value={text} disabled={d.busy} autoComplete="off" spellCheck={false} onChange={e => type(e.target.value)}
      aria-label={label.replace(/:$/, '')}/>
    <Field d={d} id={id} set={set} override="list" options={options} noLabel patch={LIST_H}/>
  </div>;
}

function Body({dialog: d, setValue: set}: BodyProps) {
  const p = usePreview(d);
  const fonts = useFonts(true);
  const fontOptions = useMemo(() => fonts.map(f => ({value: f, label: f})), [fonts]);
  const page = d.spec.tabs[d.tab]?.name ?? 'Font';
  return <div className="gd-fields" data-dialog-page={page}>
    <PageTabs dialog={d}/>
    {page === 'Font' ? <>
      {d.values.asian ? <div style={grid('1fr', {marginBottom: 10})}><Field d={d} id="fontEastAsia" set={set} override="combo"/></div> : null}
      <div style={grid('minmax(0, 2fr) minmax(0, 1.2fr) minmax(0, .8fr)', {marginBottom: 14, alignItems: 'start'})}>
        <EditList d={d} id="font" set={set} options={fontOptions}/>
        <EditList d={d} id="fontStyle" set={set} options={STYLE_LIST} matchLabel/>
        <EditList d={d} id="size" set={set} options={SIZE_LIST}/>
      </div>
      <Group title="All text">
        <div style={grid('repeat(3, minmax(0, 1fr))')}>
          <Field d={d} id="color" set={set}/>
          <Field d={d} id="underlineStyle" set={set}/>
          <Field d={d} id="underlineColor" set={set}/>
        </div>
      </Group>
      <Group title="Effects">
        <div style={grid('repeat(3, minmax(0, 1fr))', {alignItems: 'start', gap: '7px 14px'})}>
          <div style={{display: 'grid', gap: 7}}>
            <Field d={d} id="strike" set={set}/><Field d={d} id="doubleStrike" set={set}/>
            <Field d={d} id="superscript" set={set}/><Field d={d} id="subscript" set={set}/>
          </div>
          <div style={{display: 'grid', gap: 7}}>
            <Field d={d} id="smallCaps" set={set}/><Field d={d} id="allCaps" set={set}/><Field d={d} id="hidden" set={set}/>
          </div>
          <div style={{display: 'grid', gap: 7}}>
            <Field d={d} id="shadow" set={set}/><Field d={d} id="outline" set={set}/><Field d={d} id="emboss" set={set}/><Field d={d} id="engrave" set={set}/>
          </div>
        </div>
      </Group>
    </> : <>
      <Group title="Character Spacing">
        <div style={grid('minmax(0, 1.4fr) minmax(0, 1fr)', {alignItems: 'end'})}>
          <Field d={d} id="scale" set={set}/><div/>
          <Field d={d} id="spacingType" set={set}/><Field d={d} id="spacingBy" set={set}/>
          <Field d={d} id="position" set={set}/><Field d={d} id="positionBy" set={set}/>
          <Field d={d} id="kerning" set={set}/><Field d={d} id="kerningAt" set={set}/>
        </div>
      </Group>
    </>}
    <TextPreview p={p}/>
  </div>;
}

export default {Body};
