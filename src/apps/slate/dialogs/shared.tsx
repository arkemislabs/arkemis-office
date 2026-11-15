// Pieces the Slate dialog views share: one spec field by id drawn with the shell's field library,
// and the two-column grid helper.

import {useMemo, type CSSProperties} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {fieldComponent} from '../../../shell/fields';
import {fieldVisible, type DialogState} from '../../../shell/dialogs/dialogState';
import type {SpecField} from '../../../generated/spec-types';

export type BodyProps = {dialog: DialogState; setValue: (field: string, value: unknown) => void};

const findField = (d: DialogState, id: string): SpecField | null => {
  for (const t of d.spec.tabs) for (const f of t.fields) if (f.id === id) return f;
  return null;
};

export function Field({d, id, set, style, options}: {d: DialogState; id: string; set: BodyProps['setValue']; style?: CSSProperties; options?: {value: unknown; label: string}[]}) {
  const {controller} = useEngine();
  const base = findField(d, id);
  const field = useMemo(() => (base ? ({...base, ...(options ? {options} : {})} as SpecField) : null), [base, options]);
  if (!field || !fieldVisible(field, d.values)) return null;
  const C = fieldComponent(field);
  if (!C) return null;
  const error = d.errors.find(e => e.field === id)?.message ?? null;
  return <div style={style}>
    <C field={field} value={d.values[id]} onChange={v => set(id, v)} error={error} disabled={d.busy}
      onPress={fid => { void controller.pressField(d.key, fid).catch(e => controller.notify(toCommandError(e).message, 'error')); }}/>
  </div>;
}

export const grid = (cols: string, extra?: CSSProperties): CSSProperties => ({display: 'grid', gridTemplateColumns: cols, gap: '10px 14px', alignItems: 'end', ...extra});
