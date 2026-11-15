// Pieces the conditional-format dialogs share: fields of the shell's library over a dialog's values, the
// format preview with its Format... button (the conditional Format Cells), and the rule pictures.

import {type CSSProperties, type ReactNode} from 'react';
import type {SpecField} from '../../../generated/spec-types';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {SelectField, NumberField, Checkbox, ColorField, TextField} from '../../../shell/fields';
import {valuesFromDxf, dxfFromValues} from '../../../../core/grid/dialogs/cfFormatCells.mjs';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import './cond-format.css';

export type SetValue = (field: string, value: unknown) => void;
export type Opt = {value: unknown; label: string};
export const opts = (list: readonly (readonly string[])[]): Opt[] => list.map(([value, label]) => ({value, label: label ?? value}));
export const sp = (id: string, label: string, kind: string, options: readonly Opt[] = [], extra: Partial<SpecField> = {}): SpecField =>
  ({id, label, kind, options: [...options], ...extra}) as SpecField;

type Kind = 'text' | 'select' | 'checkbox' | 'number' | 'color';
const COMPONENTS: Record<Kind, (p: any) => ReactNode> = {text: TextField, select: SelectField, checkbox: Checkbox, number: NumberField, color: ColorField};

/** One library field bound to a value of the dialog. */
export function F({d, set, id, label = '', kind, options = [], disabled, extra}: {d: DialogState; set: SetValue; id: string; label?: string;
  kind: Kind; options?: readonly Opt[]; disabled?: boolean; extra?: Partial<SpecField>}) {
  const Comp = COMPONENTS[kind];
  const error = d.errors.find(e => e.field === id)?.message ?? null;
  const field = sp(id, label, kind, kind === 'color' ? [{value: 'Automatic', label: 'Automatic'}] : options, extra);
  return <Comp field={field} value={d.values[id]} onChange={(v: unknown) => set(id, v)} error={error} disabled={disabled || d.busy}/>;
}

/** A field over a value that is not a top-level one of the dialog (a row of a list): the caller owns the update. */
export function Cell({id, label = '', kind, options = [], value, onChange, error, disabled, extra}: {id: string; label?: string; kind: Kind;
  options?: readonly Opt[]; value: unknown; onChange: (v: unknown) => void; error?: string | null; disabled?: boolean; extra?: Partial<SpecField>}) {
  const Comp = COMPONENTS[kind];
  const field = sp(id, label, kind, kind === 'color' ? [{value: 'Automatic', label: 'Automatic'}] : options, extra);
  return <Comp field={field} value={value} onChange={onChange} error={error ?? null} disabled={disabled}/>;
}

/** What a differential format looks like on a sample, as Excel's preview shows it (null when it sets nothing). */
export function dxfCss(dxf: any): CSSProperties | null {
  if (!dxf || !Object.keys(dxf).length) return null;
  const f = dxf.font ?? {}, css: CSSProperties = {};
  if (typeof f.color === 'string' && f.color.startsWith('#')) css.color = f.color;
  if (f.bold) css.fontWeight = 700;
  if (f.italic) css.fontStyle = 'italic';
  const lines = [f.underline && f.underline !== 'none' ? 'underline' : '', f.strike ? 'line-through' : ''].filter(Boolean).join(' ');
  if (lines) css.textDecorationLine = lines;
  const fill = dxf.fill;
  if (fill) css.background = typeof fill.fg === 'string' ? fill.fg : typeof fill.bg === 'string' ? fill.bg : undefined;
  const b = dxf.borders ?? {};
  for (const [k, side] of [['left', 'Left'], ['right', 'Right'], ['top', 'Top'], ['bottom', 'Bottom']] as const) {
    if (b[k]?.style) {
      const kind = b[k].style === 'double' ? 'double' : /dash|dot|hair/i.test(b[k].style) ? 'dashed' : 'solid';
      (css as any)[`border${side}`] = `${/thick|medium|double/.test(b[k].style) ? 2 : 1}px ${kind} ${typeof b[k].color === 'string' ? b[k].color : 'currentColor'}`;
    }
  }
  return css;
}

/** The format's preview and its Format... button: opens the conditional Format Cells and keeps what it sets. */
export function FormatBox({d, set, label = 'Preview:'}: {d: DialogState; set: SetValue; label?: string}) {
  const {controller} = useEngine();
  const css = dxfCss(d.values.dxf);
  const open = () => {
    controller.collectDialog('dialog.cfFormatCells', valuesFromDxf(d.values.dxf)).then(v => {
      if (!v) return;
      const dxf = dxfFromValues(v);
      set('dxf', Object.keys(dxf).length ? dxf : null);
      if ('preset' in d.values) set('preset', 'custom');
    }).catch(e => controller.notify(toCommandError(e).message, 'error'));
  };
  return <div className="cf-format">
    <span className="cf-format-label">{label}</span>
    <div className="cf-format-sample" data-field-id="preview" role="img" aria-label={css ? 'Format preview' : 'No format set'} style={css ?? undefined}>
      {css ? 'AaBbCcYyZz' : <span className="cf-format-none">No Format Set</span>}
    </div>
    <button type="button" className="gd-button" data-field-id="format" onClick={open}>Format…</button>
  </div>;
}

/** The colours of a scale as the bar the dialog previews. */
export function ScaleBar({colors}: {colors: string[]}) {
  const stops = colors.map((c, i) => `${/^#/.test(c) ? c : '#ffffff'} ${Math.round(i * 100 / Math.max(colors.length - 1, 1))}%`).join(', ');
  return <div className="cf-scale-bar" data-field-id="preview" role="img" aria-label="Color scale preview" style={{background: `linear-gradient(to right, ${stops})`}}/>;
}
