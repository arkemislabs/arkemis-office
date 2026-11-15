// Insert › Quick Parts › Field… (Ctrl+F9; submit: insert.field).
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_insert/field.rs (FieldKind, FIELDS,
// STYLEREF_SWITCHES, FIELD_CATEGORIES, DATE_FORMATS, NUMBER_FORMATS, field_kind, FieldForm {new,
// select, instruction, final_code, params}, merge_field_name) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import * as T from '../lib/table-session.mjs';

/** The fields upstream computes, by category: [name, category, description] (FIELDS). */
export const FIELDS = [
  ['CREATEDATE', 'Date and Time', 'When this document was first created'], ['DATE', 'Date and Time', 'The date it is today'],
  ['PRINTDATE', 'Date and Time', 'When this document was most recently printed'], ['SAVEDATE', 'Date and Time', 'When this document was most recently saved'],
  ['TIME', 'Date and Time', 'The time right now'], ['AUTHOR', 'Document Information', 'Who the document properties name as author'],
  ['COMMENTS', 'Document Information', 'Comments from the document properties'], ['FILENAME', 'Document Information', 'Name of the file this document is saved as'],
  ['KEYWORDS', 'Document Information', 'Keywords from the document properties'], ['LASTSAVEDBY', 'Document Information', 'Who last saved the document'],
  ['NUMCHARS', 'Document Information', 'How many characters the document holds'], ['NUMPAGES', 'Document Information', 'How many pages the whole document has'],
  ['NUMWORDS', 'Document Information', 'How many words the document holds'], ['REVNUM', 'Document Information', 'How many times the document has been saved'],
  ['SUBJECT', 'Document Information', 'Subject from the document properties'], ['TITLE', 'Document Information', 'Title from the document properties'],
  ['PAGE', 'Numbering', 'Number of the page the field sits on'], ['SECTION', 'Numbering', 'Number of the section the field sits in'],
  ['SECTIONPAGES', 'Numbering', 'How many pages this section has'], ['SEQ', 'Numbering', 'A numbered sequence (figures, tables…)'],
  ['PAGEREF', 'Links and References', 'Page on which a bookmarked passage falls'], ['REF', 'Links and References', 'Copy of the text a bookmark marks'],
  ['STYLEREF', 'Links and References', 'Text of the nearest paragraph with a given style (running headers)'], ['TOC', 'Index and Tables', 'A table of contents'],
  ['MERGEFIELD', 'Mail Merge', 'A mail merge field'],
];
/** STYLEREF's options: [switch letter, label] (STYLEREF_SWITCHES). */
export const STYLEREF_SWITCHES = [['l', 'Take the last match on the page'], ['n', 'Show its list number'], ['r', 'Show its number relative to this field'],
  ['w', 'Show its number with all higher levels'], ['t', 'Number only, without the label\'s words'], ['p', 'Add whether it is above or below']];
export const FIELD_CATEGORIES = ['(All)', 'Date and Time', 'Document Information', 'Links and References', 'Index and Tables', 'Mail Merge', 'Numbering'];
/** Date and time pictures for the \@ switch (DATE_FORMATS). */
export const DATE_FORMATS = ['M/d/yyyy', 'dddd, MMMM d, yyyy', 'MMMM d, yyyy', 'M/d/yy', 'yyyy-MM-dd', 'd-MMM-yy', 'M.d.yyyy', 'd MMMM yyyy', 'MMMM yy', 'MMM-yy',
  'M/d/yyyy h:mm am/pm', 'M/d/yyyy h:mm:ss am/pm', 'h:mm am/pm', 'h:mm:ss am/pm', 'HH:mm', 'HH:mm:ss'];
/** Number formats for the \* switch: [value, example] (NUMBER_FORMATS). */
export const NUMBER_FORMATS = [['', '(none)'], ['Arabic', '1, 2, 3, …'], ['alphabetic', 'a, b, c, …'], ['ALPHABETIC', 'A, B, C, …'], ['roman', 'i, ii, iii, …'],
  ['ROMAN', 'I, II, III, …'], ['Ordinal', '1st, 2nd, 3rd, …'], ['CardText', 'One, Two, Three, …'], ['OrdText', 'First, Second, Third, …']];

/** What a field's options are about (field_kind). */
export function fieldKind(name) {
  switch (name) {
    case 'DATE': case 'TIME': case 'CREATEDATE': case 'SAVEDATE': case 'PRINTDATE': return 'date';
    case 'PAGE': case 'NUMPAGES': case 'SECTION': case 'SECTIONPAGES': case 'NUMWORDS': case 'NUMCHARS': case 'REVNUM': return 'number';
    case 'REF': case 'PAGEREF': return 'bookmark';
    case 'SEQ': return 'sequence';
    case 'MERGEFIELD': return 'merge';
    case 'TOC': return 'toc';
    case 'STYLEREF': return 'style';
    default: return 'plain';
  }
}

const words = s => s.split(/\s+/).filter(Boolean).join('_');

/** The field code the options make (instruction). */
export function instruction(v) {
  let s = v.names;
  const target = String(v.target ?? '').trim();
  const kind = fieldKind(v.names);
  if (kind === 'date' && String(v.dateFormat ?? '').trim()) s += ` \\@ "${String(v.dateFormat).trim().replace(/"/g, '')}"`;
  else if (kind === 'bookmark' && target) s += ` ${words(target)} \\h`;
  else if (kind === 'sequence') s += ` ${target ? words(target) : 'Figure'}`;
  else if (kind === 'merge' && target) s += /\s/.test(target) ? ` "${target.replace(/"/g, '')}"` : ` ${target}`;
  else if (kind === 'toc') s += ' \\o "1-3" \\h \\z \\u';
  else if (kind === 'style' && target) {
    s += ` "${target.replace(/["\\]/g, '')}"`;
    for (const [c] of STYLEREF_SWITCHES) if (String(v.styleSwitches ?? '').includes(c)) s += ` \\${c}`;
  }
  if ((kind === 'number' || kind === 'sequence') && v.numberFormat) s += ` \\* ${v.numberFormat}`;
  if (v.preserve && kind !== 'toc') s += ' \\* MERGEFORMAT';
  return s;
}

/** The merge field a MERGEFIELD code names (merge_field_name). */
export function mergeFieldName(code) {
  const m = /^\s*\S+\s+(.*)$/.exec(code);
  const rest = m ? m[1].trimStart() : '';
  if (rest.startsWith('"')) return rest.slice(1).split('"')[0];
  return rest.split(/\s+/)[0] ?? '';
}

/** Choose a field: its options start from defaults (select). */
function select(v, name) {
  const kind = fieldKind(name);
  const target = kind === 'bookmark' ? v.bookmarkNames[0] ?? '' : kind === 'sequence' ? 'Figure' : kind === 'merge' ? v.mergeFields[0] ?? ''
    : kind === 'style' ? v.styleNames.find(n => n.toLowerCase() === 'heading 1') ?? v.styleNames[0] ?? 'Heading 1' : '';
  const out = {names: name, numberFormat: '', target, styleSwitches: ''};
  if (kind === 'date') out.dateFormat = name === 'TIME' ? 'h:mm am/pm' : 'M/d/yyyy';
  const next = {...v, ...out};
  return {...out, description: FIELDS.find(f => f[0] === name)?.[2] ?? '', codes: instruction(next), finalCode: instruction(next)};
}

export default defineDialog({
  id: 'dialog.field',
  title: 'Field',
  command: 'insert.field',
  init(ctx) {
    const S = T.open(ctx);
    const bookmarkNames = [...new Set(S.d.bookmarks().map(([n]) => n).filter(n => !n.startsWith('_')))].sort();
    const styleNames = [...new Set((S.d.c.styles?.styles ?? []).filter(s => (s.kind === 'paragraph' || s.kind === 'character') && !s.hidden).map(s => s.name))]
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const mergeFields = Array.isArray(ctx.view?.merge?.headers) ? ctx.view.merge.headers : [];
    const base = {categories: '(All)', dateFormat: 'M/d/yyyy', preserve: true, editCodes: false, bookmarkNames, styleNames, mergeFields};
    return {...base, ...select(base, 'DATE')};
  },
  derive(v, changed) {
    if (changed.includes('categories')) {
      const shown = FIELDS.filter(f => v.categories === '(All)' || f[1] === v.categories).map(f => f[0]);
      return shown.includes(v.names) ? {} : select(v, shown[0] ?? 'DATE');
    }
    if (changed.includes('names') && v.names) return select(v, v.names);
    if (changed.includes('codes')) return {editCodes: true, finalCode: String(v.codes ?? '')};
    const code = instruction(v);
    return v.editCodes ? {finalCode: String(v.codes ?? '')} : {codes: code, finalCode: code};
  },
  validate(v) {
    const code = v.editCodes ? String(v.codes ?? '').trim() : instruction(v);
    if (!code) return [{field: 'codes', message: 'Type a field code.'}];
    if (code.length > 4096) return [{field: 'codes', message: 'The field code is too long.'}];
    return [];
  },
  toCommand(v) {
    const instr = v.editCodes ? String(v.codes ?? '').trim() : instruction(v);
    const name = instr.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
    return {command: 'insert.field', params: name === 'MERGEFIELD' ? {instr, result: `«${mergeFieldName(instr)}»`} : {instr}};
  },
});
