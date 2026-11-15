// PreviewField: hosts the dialog model's preview() data, drawn from the data's own shape. An app
// override (src/apps/<app>/dialogs/<id>.tsx `Preview`) draws custom previews. Without one the data picks
// the control, never a text sample by default:
//
//   {type: 'text', text}                    a status line or paragraph ("Creates 3 files from 9 pages.")
//   {type: 'meter', score: 0..1, label}     a strength bar ("Strong")
//   {type: 'list', items, empty?}           a list box; items are strings or {label, detail?, icon?}
//   {type: 'tree', items: [{value, label, depth, kind, color}], selected?}   a notebook > group > section tree
//   {type: 'swatches', rows, greys, selected?}   a drawn palette (hexagon rows + a grey strip)
//   {type: 'colors', new, current}          the New / Current colour pair
//   {type: 'path', path}                    a read-only path or value field
//   {type: 'thumbs', pages: [{label, selected?}]}   a strip of page thumbnails
//   {type: 'font', text?, font?, size?, color?}     a text sample in a font (Font dialogs)
//
// With no `type` the shape decides (`meter`, `items`, `tree`, `comb`, `path`, `pages`, `text`), a dialog whose
// values hold a font gets the font sample, one with page-layout values the framed sample page, and a preview
// field whose own id holds a value (Notebook Properties' Path) shows that value in a read-only field.

import type {CSSProperties} from 'react';
import type {FieldProps} from './common';
import {fieldLabel} from './common';
import {fillTemplate, stripTokens} from '../dialogs/templates';
import {previewKind, type PreviewKind} from './previewKind';
import {ItemList, TreeBox, SwatchPalette, StrengthMeter, ThumbStrip, ValueBox, ColorPair, toItems, toTree, type ListItem} from './controls';

export interface PreviewProps { field: FieldProps['field']; values: Record<string, unknown>; preview: unknown }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pick = (values: Record<string, unknown>, ...keys: string[]) => { for (const k of keys) if (values[k] !== undefined && values[k] !== null && values[k] !== '') return values[k]; return null; };

export function PreviewField({field, values, preview}: PreviewProps) {
  const data = (preview && typeof preview === 'object' ? preview : {}) as Record<string, unknown>;
  const kind = previewKind(field, data, values);
  const raw = typeof field.label === 'string' ? field.label : '';
  const filled = fillTemplate(raw, values);
  // A label that is the upstream's sentence with its numbers in it ("Creates {f} files from {n} pages.") is the data's job: it shows
  // only when it fills, else the word before the first colon or full stop ("Strength: {s}" -> "Strength").
  const short = (t: string) => stripTokens(t).split(/[:.]/)[0].replace(/\s+(?:from|of|for|to|on|in)$/i, '').trim();
  const label = filled.complete ? fieldLabel({...field, label: filled.text}).replace(/\s*\(.*\)$/, '') : short(raw);
  if (kind === 'empty') return null;
  return <div className="sf sf-preview" data-field-id={field.id} data-kind="preview" data-preview-kind={kind}>
    {label && kind !== 'colors' && (kind !== 'text' || (filled.complete && label.length <= 24)) ? <div className="sf-label">{label}</div> : null}
    <PreviewBody kind={kind} field={field} data={data} values={values}/>
  </div>;
}

function PreviewBody({kind, field, data, values}: {kind: PreviewKind; field: FieldProps['field']; data: Record<string, unknown>; values: Record<string, unknown>}) {
  switch (kind) {
    case 'text': return <p className="sf-status" role="status">{textOf(field, data)}</p>;
    case 'meter': {
      const m = (typeof data.meter === 'object' && data.meter ? data.meter : data) as Record<string, unknown>;
      return <StrengthMeter score={num(m.score) ?? 0} label={typeof m.label === 'string' ? m.label : ''} detail={typeof data.text === 'string' ? data.text : undefined}/>;
    }
    case 'list': return <ItemList items={toItems(Array.isArray(data.items) ? data.items : data.lines)} empty={typeof data.empty === 'string' ? data.empty : undefined} label={fieldLabel(field)}/>;
    case 'tree': return <TreeBox items={toTree(data.tree)} selected={typeof data.selected === 'string' ? data.selected : null} label={fieldLabel(field)}/>;
    case 'swatches': return <SwatchPalette rows={((data.comb as {rows?: string[][]} | undefined)?.rows ?? data.rows ?? []) as string[][]}
      greys={((data.comb as {greys?: string[]} | undefined)?.greys ?? data.greys ?? []) as string[]} selected={typeof data.selected === 'string' ? data.selected : null} label={fieldLabel(field)}/>;
    case 'colors': return <ColorPair next={String(data.new)} current={String(data.current)}/>;
    case 'path': return <ValueBox value={typeof data.path === 'string' ? data.path : String(values[field.id] ?? '')} label={fieldLabel(field)} empty={typeof data.empty === 'string' ? data.empty : 'Nothing chosen'}/>;
    case 'thumbs': return <>
      <ThumbStrip pages={((Array.isArray(data.pages) ? data.pages : data.thumbs) as {label: string; selected?: boolean}[]).map(p => (typeof p === 'object' ? p : {label: String(p)}))}/>
      {typeof data.text === 'string' ? <p className="sf-status" role="status">{data.text}</p> : null}
    </>;
    case 'font': return <FontSample field={field} data={data} values={values}/>;
    case 'page': return <div className="sf-preview-box is-page" role="img" aria-label="Preview"><PagePreview values={values}/></div>;
    default: return null;
  }
}

const textOf = (field: FieldProps['field'], data: Record<string, unknown>) =>
  String(typeof data[field.id] === 'string' ? data[field.id] : typeof data.text === 'string' ? data.text : data.message ?? '');

function FontSample({field, data, values}: {field: FieldProps['field']; data: Record<string, unknown>; values: Record<string, unknown>}) {
  const text = typeof data.text === 'string' ? data.text : sampleText(field.label);
  const font = String(pick(data, 'font') ?? pick(values, 'font', 'fontName', 'name', 'typeface') ?? '');
  const size = num(pick(data, 'size')) ?? num(pick(values, 'size', 'fontSize')) ?? 14;
  const color = String(pick(data, 'color') ?? pick(values, 'color', 'fontColor') ?? '');
  const style = String(pick(values, 'fontStyle') ?? '');
  const css: CSSProperties = {
    fontFamily: font ? `"${font}", var(--ark-font)` : undefined,
    fontSize: Math.max(8, Math.min(48, size * 1.15)),
    fontWeight: values.bold === true || /bold/i.test(style) ? 700 : 400,
    fontStyle: values.italic === true || /italic/i.test(style) ? 'italic' : undefined,
    textDecoration: [values.underline === true || (values.underlineStyle && values.underlineStyle !== '(none)') ? 'underline' : '', values.strike === true || values.doubleStrike === true ? 'line-through' : ''].filter(Boolean).join(' ') || undefined,
    textTransform: values.allCaps === true ? 'uppercase' : undefined,
    fontVariant: values.smallCaps === true ? 'small-caps' : undefined,
    color: /^#[0-9a-f]{6}$/i.test(color) ? color : undefined,
    letterSpacing: num(values.spacing) ? `${num(values.spacing)}pt` : undefined,
  };
  return <div className="sf-preview-box" role="img" aria-label={`Preview: ${text}`}><span className="sf-preview-text" style={css}>{text}</span></div>;
}

function sampleText(label: string): string {
  const m = /\(([^)]+)\)/.exec(label);
  if (m && m[1].length < 40 && !/selection/i.test(m[1])) return m[1].split(/\s+or\s+/)[0];
  return 'AaBbYyZz';
}

/** A miniature page with grey text lines, indented and spaced from the values (Paragraph, Page Setup). */
function PagePreview({values}: {values: Record<string, unknown>}) {
  const indent = Math.max(0, Math.min(40, (num(values.left) ?? num(values.indentLeft) ?? 0) / 2));
  const right = Math.max(0, Math.min(40, (num(values.right) ?? num(values.indentRight) ?? 0) / 2));
  const before = Math.max(0, Math.min(16, (num(values.before) ?? num(values.spaceBefore) ?? 0) / 2));
  const align = String(values.alignment ?? values.align ?? 'left').toLowerCase();
  const lines = [100, 96, 98, 72];
  return <div className="sf-page">
    {[0, 1, 2].map(p => <div key={p} className={`sf-page-para${p === 1 ? ' is-current' : ''}`} style={p === 1 ? {marginLeft: indent, marginRight: right, marginTop: before} : undefined}>
      {lines.map((w, i) => <i key={i} style={{width: `${w - (p === 1 && i === lines.length - 1 ? 30 : 0)}%`, marginLeft: p === 1 && /center/.test(align) ? 'auto' : p === 1 && /right/.test(align) ? 'auto' : undefined, marginRight: p === 1 && /center/.test(align) ? 'auto' : undefined}}/>)}
    </div>)}
  </div>;
}

export type {ListItem};
