// References › Insert Citation › Add New Source… and Source Manager › New… / Edit… (Create Source /
// Edit Source). OK adds the source and, from Insert Citation, cites it. Translated from wordcraft
// crates/ui-egui/src/dialogs/dialogs_refs/sources.rs (`SOURCE_TYPES`, `ALL_FIELDS`, `SourceForm`
// fields, `source_ui`) at aadb077e072b7de05f724e359d8db82e151f125c, with Word's source type names.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {SOURCE_KEYS} from '../lib/references-lists.mjs';

/** Source types with the fields each shows: [kind, Word's name, [[field, label]]] (SOURCE_TYPES). */
export const SOURCE_TYPES = [
  ['book', 'Book', [['author', 'Author'], ['title', 'Title'], ['year', 'Year'], ['city', 'City'], ['publisher', 'Publisher']]],
  ['bookSection', 'Book Section', [['author', 'Author'], ['title', 'Title'], ['journal', 'Book Title'], ['year', 'Year'], ['pages', 'Pages'], ['city', 'City'], ['publisher', 'Publisher']]],
  ['article', 'Journal Article', [['author', 'Author'], ['title', 'Title'], ['journal', 'Journal Name'], ['year', 'Year'], ['volume', 'Volume'], ['pages', 'Pages']]],
  ['periodical', 'Article in a Periodical', [['author', 'Author'], ['title', 'Title'], ['journal', 'Periodical Title'], ['year', 'Year'], ['month', 'Month'], ['day', 'Day'], ['pages', 'Pages']]],
  ['conference', 'Conference Proceedings', [['author', 'Author'], ['title', 'Title'], ['journal', 'Conference Name'], ['year', 'Year'], ['pages', 'Pages'], ['city', 'City'], ['publisher', 'Publisher']]],
  ['report', 'Report', [['author', 'Author'], ['title', 'Title'], ['year', 'Year'], ['publisher', 'Publisher'], ['city', 'City']]],
  ['website', 'Web site', [['author', 'Author'], ['title', 'Name of Web Page'], ['journal', 'Name of Web Site'], ['year', 'Year'], ['month', 'Month'], ['day', 'Day'], ['url', 'URL']]],
  ['film', 'Film', [['author', 'Performer'], ['title', 'Title'], ['publisher', 'Production Company'], ['year', 'Year']]],
  ['other', 'Miscellaneous', [['author', 'Author'], ['title', 'Title'], ['year', 'Year'], ['city', 'City'], ['publisher', 'Publisher']]],
];
/** Every bibliography field (ALL_FIELDS). */
export const ALL_FIELDS = [['author', 'Author'], ['editor', 'Editor'], ['title', 'Title'], ['journal', 'Container Title'], ['year', 'Year'], ['month', 'Month'],
  ['day', 'Day'], ['city', 'City'], ['publisher', 'Publisher'], ['edition', 'Edition'], ['volume', 'Volume'], ['issue', 'Issue'], ['pages', 'Pages'],
  ['url', 'URL'], ['doi', 'DOI'], ['accessed', 'Accessed on']];

/** The fields the form shows for its type, every field with Show All (SourceForm::fields, before the tag). */
export function sourceFields(kind, showAll) {
  const own = (SOURCE_TYPES.find(([k]) => k === kind) ?? SOURCE_TYPES[0])[2];
  const v = [...own];
  if (showAll) for (const f of ALL_FIELDS) if (!own.some(([k]) => k === f[0])) v.push(f);
  return v;
}

/** The Source the form describes. */
export function sourceParams(v) {
  const src = {};
  for (const k of SOURCE_KEYS) src[k] = typeof v[k] === 'string' ? v[k].trim() : '';
  if (!src.kind) src.kind = 'book';
  return src;
}

export default defineDialog({
  id: 'dialog.source',
  title: 'Create Source',
  command: 'references.sources',
  init: () => ({kind: 'book', showAll: false, edit: false, cite: true, ...Object.fromEntries(SOURCE_KEYS.filter(k => k !== 'kind').map(k => [k, '']))}),
  validate(v) {
    if (!['author', 'title', 'editor', 'tag'].some(k => typeof v[k] === 'string' && v[k].trim())) return [{field: 'author', message: 'Give the source an author or a title.'}];
    return [];
  },
  toCommand(v) {
    const src = sourceParams(v);
    return v.cite && !v.edit ? {command: 'references.citation', params: {source: src}} : {command: 'references.sources', params: {add: src}};
  },
});
