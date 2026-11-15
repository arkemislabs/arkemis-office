// Word bibliography sources: a `b:Sources` document — the custom XML part of a .docx, or Word's own
// `Sources.xml` master list that References > Manage Sources > Browse imports — read into the
// model's `content.sources` / `content.settings.bibStyle`, and written back as the custom XML part
// (customXml/itemN.xml + itemPropsN.xml) Word's citations and bibliography fields read.
//
// Translated from wordcraft crates/docx (ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c):
//   src/bibliography.rs         read_sources, parse, Seen, MAX_SOURCES, MAX_STYLE_NAME, the 2004/10 namespace
//   src/write/bibliography.rs   to_source_type, from_source_type, bib_style, write_name_list,
//                               split_accessed_date, bibliography_xml, bibliography_props_xml
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The model's Source is upstream's (crates/doc/src/settings.rs `Source`, camelCased): every field
// a string, '' when absent (content.mjs `source`). No DOM, no Node built-ins.

import {parseXml, W, DocxError} from './docx-read.mjs';
import {source as newSource} from '../model/content.mjs';

export const UPSTREAM = Object.freeze({repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c',
  files: ['crates/docx/src/bibliography.rs', 'crates/docx/src/write/bibliography.rs']});

/** Bibliography sources kept from one file (Word's own source manager holds far fewer). */
export const MAX_SOURCES = 10_000;
/** Characters kept of a bibliography's citation style name. */
export const MAX_STYLE_NAME = 64;

/** OOXML's bibliography namespace (ECMA-376 Part 1, 22.6). */
export const BIBLIOGRAPHY_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/bibliography';
/**
 * The bibliography namespace Word's own `Sources.xml` files may carry instead of OOXML's (the VBA
 * `Source.XML` format, `schemas.microsoft.com/office/word/2004/10/bibliography`).
 */
export const WORD_2004_BIBLIOGRAPHY = 'http://schemas.microsoft.com/office/word/2004/10/bibliography';

// =============================================================================================
// bibliography.rs
// =============================================================================================

/**
 * Read a Word bibliography sources file — Word's `Sources.xml`, or any `b:Sources` document in one
 * of the bibliography namespaces (ECMA-376's, or Word's own 2004/10) — into `{sources, style}`
 * (bibliography.rs `read_sources`). `style` is the citation style it names (`StyleName`), or null.
 * Throws DocxError: kind 'Xml' for text that isn't XML, 'NotWord' for another root element.
 * @param {Uint8Array|ArrayBuffer|string} bytesOrString
 * @returns {{sources: object[], style: string|null}}
 */
export function readSources(bytesOrString) {
  const input = bytesOrString instanceof ArrayBuffer ? new Uint8Array(bytesOrString) : bytesOrString;
  // `extra` maps Word's 2004/10 namespace onto the canonical `b` prefix as well, so both formats
  // read; the root check then refuses an un-namespaced or unrelated `<Sources>`.
  const root = parseXml(input, {extra: [['b', WORD_2004_BIBLIOGRAPHY]]});
  if (root.name !== 'b:Sources') throw new DocxError('NotWord', `root element is ${root.name}`);
  return parse(root, new Seen(), MAX_SOURCES);
}

/** Bibliography sources already read: tags, and (title, author) of untagged ones (bibliography.rs `Seen`). */
export class Seen {
  constructor() { this.tags = new Set(); this.untagged = new Set(); }
}

const childText = (el, local) => { for (const e of el.els()) if (e.local() === local) return e.text(); return ''; };
const childEl = (el, local) => { for (const e of el.els()) if (e.local() === local) return e; return null; };
const childEls = (el, local) => el.elList().filter(e => e.local() === local);

/** "Last, First Middle; Last, First" from the `b:Person` elements of a name list (bibliography.rs `parse_persons`). */
function parsePersons(parent) {
  const names = [];
  const inLists = childEls(parent, 'NameList').flatMap(n => childEls(n, 'Person'));
  const personEls = inLists.length ? inLists : childEls(parent, 'Person');
  for (const nameEl of personEls) {
    const last = childText(nameEl, 'Last');
    const first = childText(nameEl, 'First');
    const middle = childText(nameEl, 'Middle');
    let name;
    if (first && middle) name = `${last}, ${first} ${middle}`;
    else if (first) name = `${last}, ${first}`;
    else name = last;
    if (name) names.push(name);
  }
  return names.join('; ');
}

/**
 * The fresh sources and style of a parsed `b:Sources` root element (bibliography.rs `parse`):
 * `seen` carries the tags and untagged (title, author) keys already taken, so repeated parts
 * collapse into one source, and at most `room` fresh sources are built (later ones are left
 * unread, bounding hostile files).
 */
export function parse(root, seen, room) {
  let style = null;
  for (const [k, v] of root.attrs) {
    if (k.split(':').pop() !== 'StyleName') continue;
    const name = v.trim();
    if (name) style = [...name].slice(0, MAX_STYLE_NAME).join('');
    break;
  }
  const out = {sources: [], style};
  for (const srcEl of childEls(root, 'Source')) {
    if (out.sources.length >= room) break; // more than MAX_SOURCES: the rest are dropped
    const tag = childText(srcEl, 'Tag');
    const kind = fromSourceType(childText(srcEl, 'SourceType'));
    let author = '', editor = '';
    const a = childEl(srcEl, 'Author');
    if (a) {
      const inner = childEl(a, 'Author');
      const auth = inner ? parsePersons(inner) : '';
      author = auth || parsePersons(a);
      const ed = childEl(a, 'Editor');
      editor = ed ? parsePersons(ed) : '';
    }
    if (!editor) { const ed = childEl(srcEl, 'Editor'); editor = ed ? parsePersons(ed) : ''; }
    const title = childText(srcEl, 'Title');
    const year = childText(srcEl, 'Year');
    const month = childText(srcEl, 'Month');
    const day = childText(srcEl, 'Day');
    const city = childText(srcEl, 'City');
    const publisher = childText(srcEl, 'Publisher');
    const journal = childText(srcEl, 'JournalName');
    const edition = childText(srcEl, 'Edition');
    const volume = childText(srcEl, 'Volume');
    const issue = childText(srcEl, 'Issue');
    const pages = childText(srcEl, 'Pages');
    const url = childText(srcEl, 'URL');
    let accessed = childText(srcEl, 'Accessed');
    if (!accessed) {
      const y = childText(srcEl, 'YearAccessed');
      const m = childText(srcEl, 'MonthAccessed');
      const d = childText(srcEl, 'DayAccessed');
      if (y && m && d) accessed = `${y}-${m}-${d}`;
      else if (y && m) accessed = `${y}-${m}`;
      else accessed = y;
    }
    const doi = childText(srcEl, 'DOI') || childText(srcEl, 'StandardNumber');

    // Keep sources with some content, once each (by tag, or title and author untagged).
    if (!tag && !title && !author && !editor) continue;
    let fresh;
    if (!tag) {
      const key = `${title}\u0000${author || editor}`;
      fresh = !seen.untagged.has(key);
      seen.untagged.add(key);
    } else {
      fresh = !seen.tags.has(tag);
      seen.tags.add(tag);
    }
    if (!fresh) continue;
    out.sources.push(newSource({tag, kind, author, title, year, city, publisher, journal, volume, pages, url, editor, edition, issue, month, day,
      accessed, doi}));
  }
  return out;
}

// =============================================================================================
// write/bibliography.rs
// =============================================================================================

const asciiLower = s => s.replace(/[A-Z]/g, c => c.toLowerCase());

/** The model's source kind as Word's `b:SourceType` (write/bibliography.rs `to_source_type`). */
export function toSourceType(kind) {
  switch (asciiLower(String(kind ?? ''))) {
    case 'book': return 'Book';
    case 'booksection': case 'chapter': return 'BookSection';
    case 'article': case 'journal': case 'journalarticle': return 'JournalArticle';
    case 'periodical': case 'articleinaperiodical': return 'ArticleInAPeriodical';
    case 'website': case 'site': case 'internetsite': return 'InternetSite';
    case 'documentfrominternetsite': return 'DocumentFromInternetSite';
    case 'electronicsource': return 'ElectronicSource';
    case 'report': return 'Report';
    case 'conference': case 'proceedings': case 'conferenceproceedings': return 'ConferenceProceedings';
    case 'case': return 'Case';
    case 'art': return 'Art';
    case 'film': return 'Film';
    case 'interview': return 'Interview';
    case 'patent': return 'Patent';
    case 'performance': return 'Performance';
    case 'soundrecording': return 'SoundRecording';
    case 'standard': return 'Standard';
    case 'thesis': return 'Thesis';
    case 'other': case 'misc': return 'Misc';
    default: return 'Book';
  }
}

/** Word's `b:SourceType` as the model's source kind (write/bibliography.rs `from_source_type`). */
export function fromSourceType(st) {
  const t = String(st ?? '').trim();
  switch (t) {
    case 'Book': case 'book': return 'book';
    case 'BookSection': case 'booksection': return 'bookSection';
    case 'JournalArticle': case 'journalarticle': case 'article': return 'article';
    case 'ArticleInAPeriodical': case 'articleinaperiodical': return 'periodical';
    case 'InternetSite': case 'internetsite': case 'website': return 'website';
    case 'DocumentFromInternetSite': case 'documentfrominternetsite': return 'website';
    case 'ElectronicSource': case 'electronicsource': return 'electronicsource';
    case 'Report': case 'report': return 'report';
    case 'ConferenceProceedings': case 'conferenceproceedings': return 'conference';
    case 'Case': case 'case': return 'case';
    case 'SoundRecording': case 'soundrecording': return 'soundrecording';
    case 'Film': case 'film': return 'film';
    case 'Interview': case 'interview': return 'interview';
    case 'Patent': case 'patent': return 'patent';
    case 'Performance': case 'performance': return 'performance';
    case 'Standard': case 'standard': return 'standard';
    case 'Thesis': case 'thesis': return 'thesis';
    case 'Misc': case 'misc': return 'other';
    case '': return 'book';
    default: return asciiLower(t);
  }
}

/**
 * The document's citation style, APA when it has none, and a style sheet file name made from it
 * (`\APA.XSL`, `\MLA.XSL`) (write/bibliography.rs `bib_style`). `c` is schema-2 content.
 * @returns {[string, string]}
 */
export function bibStyle(c) {
  const raw = c?.settings?.bibStyle;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  const name = trimmed || 'APA';
  const file = [...name].filter(ch => /^[A-Za-z0-9]$/.test(ch)).join('');
  return [name, `\\${file || 'APA'}.XSL`];
}

/** `b:NameList` from "Last, First Middle; Last, First" (write/bibliography.rs `write_name_list`). */
function writeNameList(w, names) {
  w.open('b:NameList');
  const persons = names.split(';').map(s => s.trim()).filter(Boolean);
  for (const a of persons) {
    w.open('b:Person');
    // Parse "Last, First" or "Last, First Middle"
    const comma = a.indexOf(',');
    const [last, firstMiddle] = comma >= 0 ? [a.slice(0, comma).trim(), a.slice(comma + 1).trim()] : [a, ''];
    w.leaf('b:Last', [], last);
    if (firstMiddle) {
      const parts = firstMiddle.split(/\s+/).filter(Boolean);
      if (parts.length) w.leaf('b:First', [], parts[0]);
      if (parts.length > 1) w.leaf('b:Middle', [], parts.slice(1).join(' '));
    }
    w.close('b:Person');
  }
  w.close('b:NameList');
}

/**
 * An accessed date's year, month and day: "2024-05-15", "2024/05", or the whole text as the year
 * (write/bibliography.rs `split_accessed_date`).
 * @returns {[string|null, string|null, string|null]}
 */
export function splitAccessedDate(s0) {
  const s = String(s0 ?? '').trim();
  if (!s) return [null, null, null];
  const parts = s.includes('-') ? s.split('-') : s.includes('/') ? s.split('/') : [];
  if (parts.length === 3) return [parts[0].trim(), parts[1].trim(), parts[2].trim()];
  if (parts.length === 2) return [parts[0].trim(), parts[1].trim(), null];
  return [s, null, null];
}

/** The `b:Sources` custom XML part for the document's sources (write/bibliography.rs `bibliography_xml`). */
export function bibliographyXml(c) {
  const [styleName, selected] = bibStyle(c);
  const w = new W();
  w.open('b:Sources', [['SelectedStyle', selected], ['StyleName', styleName], ['xmlns:b', BIBLIOGRAPHY_NS], ['xmlns', BIBLIOGRAPHY_NS]]);
  for (const s0 of c?.sources ?? []) {
    const src = newSource(s0);
    for (const k of Object.keys(src)) if (typeof src[k] !== 'string') src[k] = src[k] === null || src[k] === undefined ? '' : String(src[k]);
    w.open('b:Source');
    w.leaf('b:Tag', [], src.tag);
    w.leaf('b:SourceType', [], toSourceType(src.kind));
    // Author & Editor
    if (src.author || src.editor) {
      w.open('b:Author');
      if (src.author) { w.open('b:Author'); writeNameList(w, src.author); w.close('b:Author'); }
      if (src.editor) { w.open('b:Editor'); writeNameList(w, src.editor); w.close('b:Editor'); }
      w.close('b:Author');
    }
    for (const [tag, v] of [['b:Title', src.title], ['b:Year', src.year], ['b:Month', src.month], ['b:Day', src.day], ['b:City', src.city],
      ['b:Publisher', src.publisher], ['b:JournalName', src.journal], ['b:Edition', src.edition], ['b:Volume', src.volume], ['b:Issue', src.issue],
      ['b:Pages', src.pages], ['b:URL', src.url]]) {
      if (v) w.leaf(tag, [], v);
    }
    if (src.accessed) {
      const [y, m, d] = splitAccessedDate(src.accessed);
      if (y) w.leaf('b:YearAccessed', [], y);
      if (m) w.leaf('b:MonthAccessed', [], m);
      if (d) w.leaf('b:DayAccessed', [], d);
      w.leaf('b:Accessed', [], src.accessed);
    }
    if (src.doi) {
      w.leaf('b:DOI', [], src.doi);
      w.leaf('b:StandardNumber', [], src.doi);
    }
    w.close('b:Source');
  }
  w.close('b:Sources');
  return w.toString();
}

/** The bibliography part's data store properties (write/bibliography.rs `bibliography_props_xml`). */
export function bibliographyPropsXml() {
  const w = new W();
  w.open('ds:datastoreItem', [['xmlns:ds', 'http://schemas.openxmlformats.org/officeDocument/2006/customXml'],
    ['ds:itemID', '{3315B9A8-2323-4554-B8B2-1234567890AB}']]);
  w.open('ds:schemaRefs');
  w.empty('ds:schemaRef', [['ds:uri', BIBLIOGRAPHY_NS]]);
  w.close('ds:schemaRefs');
  w.close('ds:datastoreItem');
  return w.toString();
}
