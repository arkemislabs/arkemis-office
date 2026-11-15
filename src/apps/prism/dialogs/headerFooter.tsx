// Header and Footer: the Format list shows today's date or time in each of the thirteen formats
// (deckcraft crates/ui-egui/src/dialogs/body.rs `dlg_header_footer`, `date_rows`), as Office does.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {SelectField, type FieldProps} from '../../../shell/fields';
import {DATE_KINDS, fieldText, fromMillis} from '../../../../core/prism/lib/insert-datetime.mjs';

function Formats(props: FieldProps) {
  const now = fromMillis(Date.now());
  const options = DATE_KINDS.map((k: string) => ({value: k, label: fieldText(k, 'en-US', now) ?? k}));
  const field = {...props.field, kind: 'select', options} as FieldProps['field'];
  return <SelectField {...props} field={field}/>;
}

type Sample = {date: boolean; dateText: string; num: boolean; footer: boolean; footerText: string};

/** A slide in miniature with the date at the left, the footer in the middle and the slide number at the right of its bottom edge. */
function Slide({preview}: {values: Record<string, unknown>; preview: unknown; field: unknown}) {
  const s = (preview ?? {}) as Sample;
  const txt = (x: number, anchor: 'start' | 'middle' | 'end', t: string) => <text x={x} y={87} fontSize={5.5} textAnchor={anchor} fill="#666">{t}</text>;
  return <svg viewBox="0 0 160 90" width={200} height={112} role="img" aria-label="Preview of the slide" style={{background: '#fff', borderRadius: 4, border: '1px solid rgba(128,128,128,.5)'}}>
    <rect x={14} y={12} width={132} height={14} fill="#e6e6e6"/><rect x={14} y={32} width={132} height={36} fill="#f1f1f1"/>
    {s.date ? txt(10, 'start', s.dateText || 'Date') : <rect x={10} y={82} width={26} height={6} fill="none" stroke="#bbb" strokeDasharray="2 2"/>}
    {s.footer ? txt(80, 'middle', s.footerText || 'Footer') : <rect x={58} y={82} width={44} height={6} fill="none" stroke="#bbb" strokeDasharray="2 2"/>}
    {s.num ? txt(150, 'end', '‹#›') : <rect x={134} y={82} width={16} height={6} fill="none" stroke="#bbb" strokeDasharray="2 2"/>}
  </svg>;
}

export default {fields: {dateFormat: Formats, nDateFormat: Formats}, Preview: Slide};
