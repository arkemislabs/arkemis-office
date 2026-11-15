// References › Table of Contents › Custom Table of Contents… (submit: references.toc).
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_refs/toc.rs (`TocForm` read/params,
// `toc_ui`, `toc_options_ui`) at aadb077e072b7de05f724e359d8db82e151f125c: the form reads the TOC
// field that is there (else `TOC \o "1-3" \h \z \u`) and the leader its entries have; Options… (Build
// table of contents from: Styles with their levels, Outline levels, Table entry fields) is the second
// section of src/apps/quill/dialogs/toc.tsx. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import * as T from '../lib/table-session.mjs';
import {BODY} from '../model/document.mjs';
import {parseField, fieldHas, fieldArg, levelRange, tocRange} from '../lib/references-toc.mjs';

const isToc = instr => /^\s*TOC\b/i.test(instr) && !/\\[ca]\b/.test(instr);

/** The TOC field instruction in the body, or null (index.rs body_field "TOC"). */
function bodyToc(d) {
  for (let i = 0; i < d.story(BODY).len(); i++) {
    const o = (d.para(BODY, [i])?.objects ?? []).find(x => x.type === 'field' && isToc(x.instr));
    if (o) return parseField(o.instr);
  }
  const r = d.fieldRanges(BODY).find(x => isToc(x.instr));
  return r ? parseField(r.instr) : null;
}

/** TocForm::read. */
export function tocValues(ctx) {
  const d = T.open(ctx).d;
  const f = bodyToc(d) ?? parseField('TOC \\o "1-3" \\h \\z \\u');
  const levels = levelRange(fieldArg(f, 'o'))?.[1] ?? 3;
  const listed = [];
  const t = fieldArg(f, 't');
  if (t) {
    const parts = t.split(',').map(x => x.trim());
    for (let i = 0; i + 1 < parts.length; i += 2) if (/^\d+$/.test(parts[i + 1])) listed.push([parts[i], Math.min(9, Math.max(1, Number(parts[i + 1])))]);
  }
  const styleLevels = d.c.styles.styles.filter(st => st.kind === 'paragraph' && !st.hidden && !st.id.startsWith('Heading') && !st.id.startsWith('TOC'))
    .map(st => [st.name, listed.find(([n]) => n.toLowerCase() === st.name.toLowerCase())?.[1] ?? 0]);
  const r = tocRange(d);
  const entry = r && r[1] > r[0] ? d.para(BODY, [r[0] + 1]) : null;
  const leader = entry?.props?.tabs?.at(-1)?.leader;
  const p = fieldArg(f, 'p');
  return {pageNumbers: !fieldHas(f, 'n'), rightAlign: p === null || p.includes('\t'), tabLeader: ['none', 'hyphen', 'underscore'].includes(leader) ? leader : 'dot',
    hyperlinks: fieldHas(f, 'h'), levels: Math.min(9, Math.max(1, levels)), headingStyles: fieldHas(f, 'o'), outlineLevels: fieldHas(f, 'u'), tcFields: fieldHas(f, 'f'), styleLevels};
}

/** TocForm::params. */
export function tocParams(v) {
  const styleLevels = {};
  for (const [n, l] of Array.isArray(v.styleLevels) ? v.styleLevels : []) if (Number(l) > 0) styleLevels[n] = Math.min(9, Math.max(1, Math.round(Number(l))));
  return {levels: Math.min(9, Math.max(1, Math.round(Number(v.levels) || 3))), pageNumbers: !!v.pageNumbers, rightAlign: !!v.rightAlign, tabLeader: v.tabLeader ?? 'dot',
    hyperlinks: !!v.hyperlinks, headingStyles: !!v.headingStyles, outlineLevels: !!v.outlineLevels, tcFields: !!v.tcFields, styleLevels};
}

export default defineDialog({
  id: 'dialog.toc',
  title: 'Table of Contents',
  command: 'references.toc',
  init: tocValues,
  validate(v) {
    const n = Number(v.levels);
    return Number.isInteger(n) && n >= 1 && n <= 9 ? [] : [{field: 'levels', message: 'Enter a number from 1 to 9.'}];
  },
  toCommand: v => ({command: 'references.toc', params: tocParams(v)}),
});
