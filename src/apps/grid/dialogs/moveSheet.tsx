// Move or Copy as Excel lays it out: "Move selected sheets", To book:, Before sheet: (the
// workbook's sheets and "(move to end)"), Create a copy. Over core/grid/dialogs/moveSheet.mjs.
// Translated from gridcraft crates/ui-egui/src/dialogs.rs:288 at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import type {DialogState} from '../../../shell/dialogs/dialogState';
import type {SpecField} from '../../../generated/spec-types';
import {SelectField, ListField, Checkbox} from '../../../shell/fields';
import {MOVE_TO_END} from '../../../../core/grid/dialogs/moveSheet.mjs';

type Props = {dialog: DialogState; setValue: (field: string, value: unknown) => void};
const spec = (id: string, label: string, kind: string, options: string[] | {value: unknown; label: string}[] = []): SpecField =>
  ({id, label, kind, options: (options as any[]).map(o => (typeof o === 'string' ? {value: o, label: o} : o))}) as SpecField;

function Body({dialog: d, setValue}: Props) {
  const sheets = (Array.isArray(d.values.sheets) ? d.values.sheets : []) as string[];
  const error = (id: string) => d.errors.find(e => e.field === id)?.message ?? null;
  return <div className="gd-fields mc-list">
    <div className="sf-label" style={{marginBottom: 6}}>Move selected sheets</div>
    <SelectField field={spec('toBook', 'To book:', 'select', [{value: 'this', label: '(this workbook)'}])} value={d.values.toBook ?? 'this'} onChange={v => setValue('toBook', v)}/>
    <ListField field={spec('beforeSheet', 'Before sheet:', 'list', [...sheets, MOVE_TO_END])} value={d.values.beforeSheet} onChange={v => setValue('beforeSheet', v)}
      error={error('beforeSheet')}/>
    <Checkbox field={spec('copy', 'Create a copy', 'checkbox')} value={d.values.copy === true} onChange={v => setValue('copy', v)}/>
  </div>;
}

export default {Body};
