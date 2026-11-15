// References › Insert Citation › Add New Placeholder… (Word): a citation of a placeholder source
// named by its tag (submit: references.citation {placeholder}). Word's Placeholder Name dialog; no
// upstream counterpart. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import * as T from '../lib/table-session.mjs';

/** Word's next free placeholder name: Placeholder1, Placeholder2… */
export function nextPlaceholder(sources) {
  for (let n = 1; ; n++) if (!(sources ?? []).some(x => x.tag === `Placeholder${n}`)) return `Placeholder${n}`;
}

export default defineDialog({
  id: 'dialog.placeholder',
  title: 'Placeholder Name',
  command: 'references.citation',
  init: ctx => ({name: nextPlaceholder(T.open(ctx).d.c.sources)}),
  validate: v => (/^\S+$/.test(String(v.name ?? '').trim()) ? [] : [{field: 'name', message: 'A placeholder name is one word.'}]),
  toCommand: v => ({command: 'references.citation', params: {placeholder: String(v.name).trim()}}),
});
