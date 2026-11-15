// References engine, part 2 (U:quill/references): sources and citations, the generated lists
// (bibliography, table of figures, table of authorities, index), Mark Entry and cross-references.
//
// Translated from wordcraft (ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c):
//   crates/engine/src/cmd/citations/sources.rs     auto_tag(_base), by_author, sources, import_sources,
//                                                  citation, citation_field, cited_tags, author_key,
//                                                  bib_order, number_of, update_citations,
//                                                  refresh_citations
//   crates/engine/src/cmd/citations/generated.rs   figures_instr, seq_ident, generated_list(_with),
//                                                  list_kind, figures_label, captioned_as,
//                                                  caption_body, ENTRY_STYLE, update_generated,
//                                                  add_entry_style, entries_for
//   crates/engine/src/cmd/citations/cross_refs.rs  cross_ref, caption_label, captions,
//                                                  caption_labels, ref_targets, ref_bookmark
//   crates/engine/src/cmd/citations.rs             references.markCitation (the TA field)
//   crates/engine/src/cmd/index.rs                 xe_instr, mark_entry, index_instr, index_field,
//                                                  insert_index, collect, refs, rebuild, columns
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Word additions (docs/behaviour-fidelity.md): a citation placeholder (Insert Citation › Add New
// Placeholder…) is a source with only its tag; its citation shows the tag in parentheses, as Word
// shows `(Placeholder1)`. Cross-reference's "Insert as hyperlink" sets or leaves out `\h` (upstream
// always writes it).

import * as P from '../model/para.mjs';
import {BODY, cmpPos} from '../model/document.mjs';
import {sortKey, cmpSortKeys, headingLetter} from '../model/collate.mjs';
import {style as styleRecord, upsertStyle, getStyle, resolvePara} from '../model/styles.mjs';
import {sectionOf, textWidth} from '../model/section.mjs';
import {cite, entry, style as citeStyle, numbered, authors, ORDER} from './references-cite.mjs';
import {parseField, fieldHas, fieldArg, isTableOfFigures, leaderOf, pageOf, freshLayout, bookmarkText, seqIdent} from './references-toc.mjs';
import * as T from './table-session.mjs';

export const UPSTREAM_FILES = ['crates/engine/src/cmd/citations.rs', 'crates/engine/src/cmd/citations/sources.rs',
  'crates/engine/src/cmd/citations/generated.rs', 'crates/engine/src/cmd/citations/cross_refs.rs', 'crates/engine/src/cmd/index.rs'];

const OBJ = P.OBJ;
const bad = T.params;
const failed = T.failed;
const field = (instr, result = '') => ({type: 'field', instr, result});
const topPara = (d, i) => d.para(BODY, [i]);
const bodyLen = d => d.story(BODY).len();
const plain = p => P.plainText(p).split(OBJ).join('');

/** The paragraph style generated lists use for their entries (ENTRY_STYLE). */
export const ENTRY_STYLE = 'ListEntry';
export const MAX_SOURCES = 10_000;
export const SOURCE_KEYS = Object.freeze(['tag', 'kind', 'author', 'title', 'year', 'publisher', 'city', 'journal', 'volume', 'pages', 'url',
  'editor', 'edition', 'issue', 'month', 'day', 'accessed', 'doi']);
/** A Source as the model keeps it (every field a string). */
export function sourceOf(v) {
  const out = {};
  for (const k of SOURCE_KEYS) out[k] = typeof v?.[k] === 'string' ? v[k] : v?.[k] === undefined || v?.[k] === null ? '' : String(v[k]);
  if (!out.kind) out.kind = 'book';
  return out;
}
/** The document's citation style name (Session::bib_style, saved as settings.bibStyle). */
export const bibStyleOf = d => citeStyle(d.c.settings?.bibStyle ?? 'APA').name;

// ---- sources.rs -----------------------------------------------------------------------------------

/** The stem of a new source's tag (auto_tag_base): three alphanumerics of the first author, two year digits. */
export function autoTagBase(src) {
  const first = authors(src.author ?? '')[0]?.[0] ?? '';
  let name = [...first].filter(c => /[\p{L}\p{N}]/u.test(c)).slice(0, 3).join('');
  if (!name) name = 'Src';
  const digits = [...String(src.year ?? '')].filter(c => c >= '0' && c <= '9');
  return `${name}${digits.slice(Math.max(0, digits.length - 2)).join('')}`;
}
/** The tag a new source gets, with 1, 2… added while it is taken (auto_tag). */
export function autoTag(sources, src) {
  const base = autoTagBase(src);
  const taken = t => sources.some(x => x.tag === t);
  if (!taken(base)) return base;
  for (let n = 1; ; n++) if (!taken(`${base}${n}`)) return `${base}${n}`;
}
const byAuthor = x => (x.author ? x.author : x.editor);

/** Manage Sources: add (or edit, by tag), remove, import; returns the sources (sources). */
export function manageSources(S, v, imported = null) {
  const d = S.d;
  if (v.add) {
    const src = sourceOf(v.add);
    if (!src.tag) src.tag = autoTag(d.c.sources ?? [], src);
    const list = [...(d.c.sources ?? [])];
    const i = list.findIndex(x => x.tag === src.tag);
    if (i >= 0) { list[i] = src; d.setField('sources', list); updateCitations(S); } else if (list.length < MAX_SOURCES) { list.push(src); d.setField('sources', list); }
  }
  if (typeof v.remove === 'string') d.setField('sources', (d.c.sources ?? []).filter(x => x.tag !== v.remove));
  if (imported) importSources(d, imported);
  return (d.c.sources ?? []).map(x => ({...x}));
}

/** Add the sources of a Word bibliography file to this document (import_sources). */
export function importSources(d, file) {
  const list = [...(d.c.sources ?? [])];
  const tags = new Set(list.map(x => x.tag));
  const keys = new Set(list.map(x => `${x.title}\u0000${byAuthor(x)}`));
  const next = new Map();
  let added = false;
  for (const s0 of file.sources ?? []) {
    if (list.length >= MAX_SOURCES) break;
    const src = sourceOf(s0);
    if (!s0.tag) {
      if (keys.has(`${src.title}\u0000${byAuthor(src)}`)) continue;
      const base = autoTagBase(src);
      let n = next.get(base) ?? 0;
      let tag = n === 0 ? base : `${base}${n}`;
      while (tags.has(tag)) { n++; tag = `${base}${n}`; }
      next.set(base, n + 1);
      src.tag = tag;
    }
    if (tags.has(src.tag)) continue;
    tags.add(src.tag);
    keys.add(`${src.title}\u0000${byAuthor(src)}`);
    list.push(src);
    added = true;
  }
  if (added) d.setField('sources', list);
  return added;
}

/** The tag and `\p` pages of a CITATION instruction (citation_field). */
export function citationField(instr) {
  const words = String(instr).trim().split(/\s+/);
  if (words[0] !== 'CITATION' || !words[1]) return null;
  const parts = String(instr).split('\\p');
  return [words[1], parts.length > 1 ? parts[1].trim() : ''];
}

/** Tags cited in the body, in order of first citation (cited_tags). */
export function citedTags(d) {
  const seen = new Set();
  for (const path of d.paraPaths(BODY)) {
    const p = d.para(BODY, path);
    for (const o of p?.objects ?? []) { const c = o.type === 'field' ? citationField(o.instr) : null; if (c) seen.add(c[0]); }
  }
  return [...seen];
}
const authorKey = src => (authors(src.author ?? '')[0]?.[0] ?? src.title ?? '').toLowerCase() || String(src.title ?? '').toLowerCase();

/** Indices into the sources in bibliography order (bib_order). */
export function bibOrder(d, st, lang) {
  const sources = d.c.sources ?? [];
  const cited = citedTags(d);
  let idx;
  if (!cited.length) idx = sources.map((_, i) => i);
  else if (st.order === ORDER.CITED) idx = cited.map(t => sources.findIndex(x => x.tag === t)).filter(i => i >= 0);
  else { const set = new Set(cited); idx = sources.map((x, i) => (set.has(x.tag) ? i : -1)).filter(i => i >= 0); }
  if (st.order !== ORDER.CITED) {
    const byTitle = st.order === ORDER.TITLE;
    const keys = new Map(idx.map(i => [i, sortKey(byTitle ? sources[i].title ?? '' : authorKey(sources[i]), lang)]));
    idx.sort((a, b) => cmpSortKeys(keys.get(a), keys.get(b)));
  }
  return idx;
}
const numberOf = (d, order, tag) => { const k = order.findIndex(i => d.c.sources[i]?.tag === tag); return (k < 0 ? order.length : k) + 1; };
const isPlaceholder = src => !src.author && !src.title && !src.editor && !src.year;
/** The text a citation shows: the style's, or `(Tag)` for a placeholder (Word). */
const citeText = (src, st, n, pages) => (isPlaceholder(src) ? `(${src.tag})` : cite(src, st.name, n, pages));

/** Insert Citation (citation): `tag`, or a new `source` (added), `pages`; `placeholder` names a placeholder (Word). */
export function insertCitation(S, v) {
  const d = S.d;
  if (typeof v.placeholder === 'string') {
    const tag = v.placeholder.trim().replace(/\s+/g, '');
    if (!tag) throw bad('a placeholder needs a name');
    if (!(d.c.sources ?? []).some(x => x.tag === tag)) manageSources(S, {add: {tag, kind: 'book'}});
    v = {tag, pages: v.pages};
  } else if (v.source) manageSources(S, {add: v.source});
  let tag = v.tag;
  if (typeof tag !== 'string') {
    if (!v.source) throw bad('give `tag` or `source`');
    tag = d.c.sources.at(-1)?.tag ?? '';
  }
  const src = (d.c.sources ?? []).find(x => x.tag === tag);
  if (!src) throw bad(`no source \`${tag}\``);
  const pages = typeof v.pages === 'string' ? v.pages.trim() : '';
  const st = citeStyle(bibStyleOf(d));
  const n = numberOf(d, bibOrder(d, st, T.defaultLang(S)), tag);
  const props = T.typingProps(S);
  const at = T.deleteSelection(S);
  const instr = pages ? `CITATION ${tag} \\p ${pages}` : `CITATION ${tag}`;
  const end = d.insertObject(at, field(instr, citeText(src, st, n, pages)), props);
  T.setCaret(S, end);
  if (numbered(st)) refreshCitations(S);
  return {tag};
}

/** Refresh the CITATION results in the body (refresh_citations). */
export function refreshCitations(S) {
  const d = S.d;
  const st = citeStyle(bibStyleOf(d));
  const order = bibOrder(d, st, T.defaultLang(S));
  for (const path of d.paraPaths(BODY)) {
    const p = d.para(BODY, path);
    if (!p?.objects?.some(o => o.type === 'field' && citationField(o.instr))) continue;
    const ups = new Map();
    p.objects.forEach((o, k) => {
      const c = o.type === 'field' ? citationField(o.instr) : null;
      const src = c && d.c.sources.find(x => x.tag === c[0]);
      if (src) ups.set(k, citeText(src, st, numberOf(d, order, c[0]), c[1]));
    });
    if (!ups.size) continue;
    const q = d.paraMut(BODY, path);
    q.objects = q.objects.map((o, k) => (ups.has(k) && ups.get(k) !== o.result ? {...o, result: ups.get(k)} : o));
  }
}
/** Refresh citations and generated lists (update_citations). */
export function updateCitations(S) { refreshCitations(S); updateGenerated(S); }

// ---- generated.rs ---------------------------------------------------------------------------------

/** The TOC instruction of a table of figures (figures_instr). */
export function figuresInstr(v) {
  const label = [...String(v.label ?? 'Figure')].filter(c => c !== '"' && c !== '\\' && !/\p{Cc}/u.test(c)).slice(0, 40).join('');
  const ident = seqIdent(label) || 'Figure';
  const on = k => (typeof v[k] === 'boolean' ? v[k] : true);
  let s = `TOC \\${on('includeLabel') ? 'c' : 'a'} "${ident}"`;
  if (on('hyperlinks') === false) { /* Word's \h; upstream writes none */ }
  if (!on('pageNumbers')) s += ' \\n';
  else if (!on('rightAlign')) s += ' \\p " "';
  return s;
}

function listKind(p) {
  for (const o of p?.objects ?? []) {
    if (o.type !== 'field') continue;
    const t = String(o.instr).trimStart();
    if (t.startsWith('BIBLIOGRAPHY') || t.startsWith('INDEX') || t.startsWith('TOA') || figuresLabel(t) !== null) return t;
  }
  return null;
}
/** The caption label (SEQ identifier) a table of figures lists (figures_label). */
export function figuresLabel(instr) {
  const f = parseField(instr);
  if (!isTableOfFigures(f)) return null;
  const a = fieldArg(f, 'c') ?? fieldArg(f, 'a');
  return a === null ? 'Figure' : seqIdent(a);
}

/** Whether `p` is a caption numbered by SEQ identifier `ident` (captioned_as). */
function captionedAs(p, ident) {
  if (p.props?.style !== 'Caption') return false;
  const seq = (p.objects ?? []).map(o => (o.type === 'field' ? parseField(o.instr) : null)).find(f => f?.name === 'SEQ');
  if (seq) return (seq.args[0] ?? '').toLowerCase() === ident.toLowerCase();
  const l = captionLabel(p, plain(p));
  return l !== null && seqIdent(l).toLowerCase() === ident.toLowerCase();
}

/** A caption's text without its label and number (caption_body). */
function captionBody(p, label) {
  let seqEnd = null;
  for (const [off, o] of P.objectsWithOffsets(p)) if (o.type === 'field' && parseField(o.instr).name === 'SEQ') { seqEnd = off + 1; break; }
  let rest;
  if (seqEnd !== null) {
    rest = '';
    let k = 0;
    for (let i = 0; i < p.text.length; i++) {
      const c = p.text[i];
      if (c === OBJ) { if (i >= seqEnd) rest += objectText(p.objects[k]); k++; } else if (i >= seqEnd) rest += c;
    }
  } else {
    const text = plain(p);
    const start = text.trimStart();
    const after = (start.slice(0, label.length).toLowerCase() === label.toLowerCase() ? start.slice(label.length) : text).trimStart();
    const n = after.search(/\s/);
    if (/^[0-9]/.test(after)) rest = n >= 0 ? after.slice(n) : '';
    else rest = after;
  }
  return rest.replace(/^[\s:.\-–—]+/u, '').trimEnd();
}
const objectText = o => (o?.type === 'field' ? o.result ?? '' : '');

/** Add the ListEntry style if the document hasn't it yet (add_entry_style). */
function addEntryStyle(d) {
  if (getStyle(d.c.styles, ENTRY_STYLE)) return;
  d.setField('styles', upsertStyle(d.c.styles, styleRecord({id: ENTRY_STYLE, name: 'List Entry', kind: 'paragraph', basedOn: 'Normal', para: {spaceAfter: 4}, hidden: true})));
}

/** A generated list: a heading paragraph holding the field, then its entries (generated_list_with). */
export function generatedList(S, instr, title, leader = null) {
  const d = S.d;
  const at = T.deleteSelection(S);
  if (at.story !== BODY || at.path.length !== 1) throw failed('lists go in the main text');
  const head = title ? P.styled(P.paragraphWithText(title, {}, d.newId()), 'Heading1') : P.newParagraph(d.newId());
  P.insertObject(head, head.text.length, field(instr), {});
  const i = d.paraAt(at)?.text.length === 0 || at.off === 0 ? at.path[0] : d.splitParagraph(at).path[0];
  d.insertBlock(BODY, [i], head);
  if (leader) {
    const seed = P.styled(P.newParagraph(d.newId()), ENTRY_STYLE);
    seed.props = {...seed.props, tabs: [{pos: 0, align: 'right', leader}]};
    d.insertBlock(BODY, [i + 1], seed);
  }
  updateGenerated(S);
  T.setCaret(S, d.clamp(S.sel.focus));
}

/** Rebuild every generated list (update_generated). */
export function updateGenerated(S) {
  const d = S.d;
  for (let i = 0; i < bodyLen(d); i++) {
    const kind = listKind(topPara(d, i));
    if (!kind) continue;
    addEntryStyle(d);
    if (kind.startsWith('INDEX')) { rebuildIndex(S, i, null); continue; }
    let saved = null;
    if (figuresLabel(kind) !== null) {
      const p = topPara(d, i);
      if (p.objects.some(o => o.type === 'field' && o.result && figuresLabel(o.instr) !== null)) {
        saved = p.props?.tabs?.at(-1)?.leader ?? null;
        const q = d.paraMut(BODY, [i]);
        q.objects = q.objects.map(o => (o.type === 'field' && o.result && figuresLabel(o.instr) !== null ? {...o, result: ''} : o));
      }
    }
    const nx = topPara(d, i + 1);
    const leader = (nx?.props?.style === ENTRY_STYLE ? nx.props?.tabs?.at(-1)?.leader : null) ?? saved ?? 'dot';
    while (topPara(d, i + 1)?.props?.style === ENTRY_STYLE) d.removeBlock(BODY, [i + 1]);
    const lines = entriesFor(S, kind);
    const width = textWidth(sectionOf(T.caretSection(S)));
    lines.forEach(([text, hanging], k) => {
      const para = P.styled(P.paragraphWithText(text, {}, d.newId()), ENTRY_STYLE);
      if (hanging) para.props = {...para.props, indentLeft: 36, indentFirst: -36};
      if (text.includes('\t')) para.props = {...para.props, tabs: [{pos: width - 0.5, align: 'right', leader}]};
      d.insertBlock(BODY, [i + 1 + k], para);
    });
  }
}

/** Entry lines [text, hanging] for a generated list (entries_for). */
function entriesFor(S, kind) {
  const d = S.d;
  if (kind.startsWith('BIBLIOGRAPHY')) {
    const st = citeStyle(bibStyleOf(d));
    return bibOrder(d, st, T.defaultLang(S)).map((i, k) => [entry(d.c.sources[i], st.name, k + 1), !numbered(st)]).filter(([t]) => t !== undefined);
  }
  const marks = [];
  const figures = figuresLabel(kind);
  const bare = fieldHas(parseField(kind), 'a');
  const want = kind.startsWith('INDEX') ? 'XE' : 'TA';
  for (const path of d.paraPaths(BODY)) {
    const p = d.para(BODY, path);
    if (!p) continue;
    if (figures !== null) {
      if (captionedAs(p, figures)) marks.push([bare ? captionBody(p, figures.replace(/_/g, ' ')) : plain(p), {story: BODY, path, off: 0}]);
      continue;
    }
    for (const [off, o] of P.objectsWithOffsets(p)) {
      if (o.type !== 'field') continue;
      const t = String(o.instr).trimStart();
      if (t.startsWith(want)) marks.push([t.split('"')[1] ?? '', {story: BODY, path, off}]);
    }
  }
  const l = marks.length ? freshLayout(S) : null;
  const withPages = marks.map(([e, pos]) => [e, pageOf(S, pos, l)]);
  if (figures !== null) {
    const f = parseField(kind);
    const sep = fieldArg(f, 'p') ?? '\t';
    return withPages.map(([t, p]) => [fieldHas(f, 'n') ? t : `${t}${sep}${p}`, false]);
  }
  const lang = T.defaultLang(S);
  const grouped = new Map();
  for (const [e, p] of withPages) {
    if (!grouped.has(e)) grouped.set(e, {key: sortKey(e, lang), pages: []});
    const g = grouped.get(e);
    if (!g.pages.includes(p)) g.pages.push(p);
  }
  const sorted = [...grouped.entries()].sort((a, b) => cmpSortKeys(a[1].key, b[1].key) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out = [];
  let letter;
  for (const [e, {pages}] of sorted) {
    const first = headingLetter(e, lang);
    if (kind.startsWith('INDEX') && first !== letter) { letter = first; if (first !== null && first !== undefined) out.push([first, false]); }
    const list = pages.join(', ');
    out.push(kind.startsWith('INDEX') ? [`${e}, ${list}`, true] : [`${e}\t${list}`, false]);
  }
  return out;
}

/** References › Mark Citation: a hidden TA field after the selection (references.markCitation). */
export function markCitation(S, v) {
  const entryText = typeof v.entry === 'string' ? v.entry : selectedText(S).trim();
  if (!entryText) throw bad('select a citation or give `entry`');
  const [, b] = T.ordered(S.sel);
  S.d.insertObject(b, field(`TA \\l "${entryText.replace(/"/g, '')}"`), {hidden: true});
  return {entry: entryText};
}

/** The selection's text (Session::selected_text). */
export function selectedText(S) {
  const [a, b] = T.ordered(S.sel);
  if (cmpPos(a, b) === 0) return '';
  const frag = S.d.copyRange(a, b);
  return frag.blocks.filter(x => x.kind === 'para').map(plain).join('\n');
}

// ---- cross_refs.rs ----------------------------------------------------------------------------------

/** The label of a caption (caption_label). */
export function captionLabel(p, text) {
  const fields = P.objectsWithOffsets(p).filter(([, o]) => o.type === 'field').map(([o, ob]) => [o, ob.instr ?? '']);
  const seq = fields.findIndex(([, instr]) => (instr.trim().split(/\s+/)[0] ?? '').toUpperCase() === 'SEQ');
  let label;
  if (seq >= 0) {
    const said = (from, to) => { const t = p.text.slice(from, to).split(OBJ).join('').trim(); return /[\p{L}\p{N}]/u.test(t) ? t : null; };
    const first = fields[0]?.[0] ?? 0;
    const afterPrevious = seq > 0 ? fields[seq - 1][0] + 1 : 0;
    label = said(0, first) ?? said(afterPrevious, fields[seq][0]) ?? (fields[seq][1].trim().split(/\s+/)[1]?.replace(/_/g, ' ') ?? null);
    if (label === null) return null;
  } else {
    const k = text.search(/[0-9]/);
    if (k < 0) return null;
    label = text.slice(0, k).trim();
  }
  return label && [...label].length <= 40 ? label : null;
}
function captions(d) {
  const out = [];
  for (const path of d.paraPaths(BODY)) {
    const p = d.para(BODY, path);
    if (p?.props?.style !== 'Caption') continue;
    const text = plain(p);
    out.push([text, {story: BODY, path, off: 0}, captionLabel(p, text)]);
  }
  return out;
}
/** The labels the body's captions use, first seen first (caption_labels). */
export function captionLabels(d) {
  const out = [];
  for (const [, , l] of captions(d)) if (l && !out.includes(l)) out.push(l);
  return out;
}

/** Cross-reference targets of a kind: [text or bookmark name, position] (ref_targets). */
export function refTargets(d, to) {
  if (to === 'bookmark') return d.bookmarks().filter(([n]) => !n.startsWith('_'));
  if (to.startsWith('label:')) {
    const want = to.slice(6);
    return captions(d).filter(([, , l]) => want && l === want).map(([t, pos]) => [t, pos]);
  }
  const out = [];
  if (to === 'figure' || to === 'table' || to === 'equation') {
    const label = to === 'table' ? 'Table' : to === 'equation' ? 'Equation' : 'Figure';
    for (const path of d.paraPaths(BODY)) {
      const p = d.para(BODY, path);
      if (p?.props?.style === 'Caption' && plain(p).startsWith(label)) out.push([plain(p), {story: BODY, path, off: 0}]);
    }
    return out;
  }
  for (const path of d.paraPaths(BODY)) {
    const p = d.para(BODY, path);
    if (!p) continue;
    const ol = resolveOutline(d, p);
    if (ol !== null && ol !== undefined && ol < 9 && plain(p).trim()) out.push([plain(p).trim(), {story: BODY, path, off: 0}]);
  }
  return out;
}
const resolveOutline = (d, p) => resolvePara(d.c.styles, p.props ?? {}).outlineLevel;

/** The hidden `_Ref` bookmark on the target paragraph (ref_bookmark); returns [name, at moved]. */
function refBookmark(S, pos, numberOnly, at) {
  const d = S.d;
  const para = d.para(pos.story, pos.path);
  if (!para) throw bad('cross-reference target is gone');
  const colon = para.text.indexOf(':');
  const end = numberOnly ? (colon >= 0 ? colon : para.text.length) : para.text.length;
  const o0 = P.objectAt(para, 0);
  if (o0?.type === 'bookmarkStart' && o0.name.startsWith('_Ref')) {
    const same = P.objectOffsets(para).some(o => {
      const ob = P.objectAt(para, o);
      const rest = para.text.slice(o + 1);
      return ob?.type === 'bookmarkEnd' && ob.name === o0.name && (numberOnly ? rest.startsWith(':') : rest === '');
    });
    if (same) return [o0.name, at];
  }
  let next = 0;
  for (const [n] of d.bookmarks()) { const m = /^_Ref(\d+)$/.exec(n); if (m) next = Math.max(next, Number(m[1])); }
  const name = `_Ref${String(next + 1).padStart(9, '0')}`;
  d.insertObject({...pos, off: end}, {type: 'bookmarkEnd', name}, {});
  d.insertObject({...pos, off: 0}, {type: 'bookmarkStart', name}, {});
  if (at.story === pos.story && at.path.join('/') === pos.path.join('/')) at = {...at, off: at.off >= end ? at.off + 2 : at.off > 0 ? at.off + 1 : at.off};
  return [name, at];
}

/** Insert › Cross-reference (cross_ref): lists the targets without `target`. */
export function crossReference(S, v) {
  const d = S.d;
  const to = v.to ?? 'heading';
  const targets = refTargets(d, to);
  if (typeof v.target !== 'string') return targets.map(([t]) => t);
  const find = ts => ts.find(([t]) => t === v.target) ?? ts.find(([t]) => t.startsWith(v.target));
  const hit = find(targets);
  if (!hit) throw bad(`no ${to} \`${v.target}\``);
  const [text, pos] = hit;
  const show = v.show ?? 'text';
  let result;
  if (show === 'page') result = String(pageOf(S, pos));
  else if (show === 'number') result = text.split(':')[0].trim();
  else if (show === 'aboveBelow') result = cmpPos(pos, S.sel.focus) < 0 ? 'above' : 'below';
  else if (to === 'bookmark') result = bookmarkText(d, text) ?? '';
  else result = text;
  const props = T.typingProps(S);
  let at = T.deleteSelection(S);
  let name;
  if (to === 'bookmark') name = text;
  else {
    const again = find(refTargets(d, to));
    if (!again) throw bad(`no ${to} \`${v.target}\``);
    [name, at] = refBookmark(S, again[1], show === 'number', at);
  }
  const link = v.hyperlink === false ? '' : ' \\h';
  const instr = `${show === 'page' ? 'PAGEREF' : 'REF'} ${name}${show === 'aboveBelow' ? ' \\p' : ''}${link}`;
  const end = d.insertObject(at, field(instr, result), props);
  T.setCaret(S, end);
  return {inserted: result};
}

// ---- index.rs ---------------------------------------------------------------------------------------

const clean = (t, max) => [...String(t)].filter(c => c !== '"' && !/\p{Cc}/u.test(c)).slice(0, max).join('').trim();

/** The XE instruction for references.markEntry's parameters (xe_instr). */
function xeInstr(d, v, main) {
  const sub = typeof v.subentry === 'string' ? clean(v.subentry, 200) : '';
  let instr = sub ? `XE "${main}:${sub}"` : `XE "${main}"`;
  const see = typeof v.crossReference === 'string' ? clean(v.crossReference, 200) : '';
  if (see) instr += ` \\t "${see}"`;
  else if (typeof v.bookmark === 'string' && v.bookmark.trim()) {
    if (!d.bookmarks().some(([n]) => n === v.bookmark)) throw bad(`no bookmark \`${v.bookmark}\``);
    instr += ` \\r ${v.bookmark.trim()}`;
  }
  if (v.bold) instr += ' \\b';
  if (v.italic) instr += ' \\i';
  return instr;
}

/** Mark Entry (mark_entry): one XE field after the selection, or Mark All. */
export function markEntry(S, v) {
  const d = S.d;
  const main = clean(typeof v.entry === 'string' ? v.entry : selectedText(S), 200);
  if (!main) throw bad('select a word or give `entry`');
  const instr = xeInstr(d, v, main);
  const hidden = {hidden: true};
  if (!v.all) {
    const [, b] = T.ordered(S.sel);
    d.insertObject(b, field(instr), hidden);
    return {entry: main, marked: 1};
  }
  let text = typeof v.text === 'string' ? v.text : (() => { const t = selectedText(S); return t.trim() ? t.trim() : main; })();
  if (!text) throw bad('nothing to look for');
  let marked = 0;
  for (const path of d.paraPaths(BODY)) {
    const p = d.para(BODY, path);
    if (!p) continue;
    const st = p.props?.style;
    if (st === ENTRY_STYLE || st?.startsWith('TOC')) continue;
    if ((p.objects ?? []).some(o => o.type === 'field' && o.instr === instr)) continue;
    const word = c => c !== undefined && /[\p{L}\p{N}]/u.test(c);
    let end = null;
    for (let i = p.text.indexOf(text); i >= 0; i = p.text.indexOf(text, i + 1)) {
      const j = i + text.length;
      if (!word([...p.text.slice(0, i)].at(-1)) && !word([...p.text.slice(j)][0])) { end = j; break; }
    }
    if (end === null) continue;
    d.insertObject({story: BODY, path, off: end}, field(instr), hidden);
    marked++;
  }
  S.sel = {anchor: d.clamp(S.sel.anchor), focus: d.clamp(S.sel.focus)};
  return {entry: main, marked};
}

/** The INDEX instruction (index_instr). */
export function indexInstr(v) {
  let s = 'INDEX';
  if (v.headings !== false) s += ' \\h "A"';
  const cols = Math.max(1, Math.min(4, Math.round(v.columns ?? 1)));
  if (cols > 1) s += ` \\c "${cols}"`;
  if (v.rightAlign) s += ' \\e "\t"';
  if (v.type === 'runIn') s += ' \\r';
  return s;
}
/** The body block holding the INDEX field and its instruction (index_field). */
export function indexField(d) {
  for (let i = 0; i < bodyLen(d); i++) {
    const o = (topPara(d, i)?.objects ?? []).find(x => x.type === 'field' && parseField(x.instr).name === 'INDEX');
    if (o) return [i, o.instr];
  }
  return null;
}

/** Insert Index (insert_index): new settings for the index there, or a new one. */
export function insertIndex(S, v) {
  const d = S.d;
  const instr = indexInstr(v);
  const there = indexField(d);
  if (there) {
    const q = d.paraMut(BODY, [there[0]]);
    q.objects = q.objects.map(o => (o.type === 'field' && parseField(o.instr).name === 'INDEX' ? {...o, instr} : o));
  } else generatedList(S, instr, 'Index');
  const now = indexField(d);
  if (now) rebuildIndex(S, now[0], typeof v.tabLeader === 'string' ? leaderOf(v.tabLeader) : null);
  S.sel = {anchor: d.clamp(S.sel.anchor), focus: d.clamp(S.sel.focus)};
}

/** Every XE entry with its pages, grouped and sorted (collect). */
function collect(S, lang) {
  const d = S.d;
  const marks = [];
  for (const path of d.paraPaths(BODY)) {
    const p = d.para(BODY, path);
    for (const [off, o] of p ? P.objectsWithOffsets(p) : []) {
      if (o.type !== 'field') continue;
      const f = parseField(o.instr);
      if (f.name === 'XE') marks.push([f, {story: BODY, path, off}]);
    }
  }
  const l = marks.length ? freshLayout(S) : null;
  const page = pos => pageOf(S, pos, l);
  const bookmarkEnd = name => {
    for (const path of d.paraPaths(BODY)) {
      const p = d.para(BODY, path);
      for (const [off, o] of p ? P.objectsWithOffsets(p) : []) if (o.type === 'bookmarkEnd' && o.name === name) return {story: BODY, path, off};
    }
    return null;
  };
  const starts = d.bookmarks();
  const tree = new Map();
  const keyOf = levels => levels.map(x => sortKey(x, lang));
  const node = levels => {
    const k = levels.join('\u0001');
    if (!tree.has(k)) tree.set(k, {keys: keyOf(levels), levels, pages: [], see: []});
    return tree.get(k);
  };
  for (const [f, pos] of marks) {
    const levels = (f.args[0] ?? '').split(':').map(x => x.trim()).filter(Boolean).slice(0, 9);
    if (!levels.length) continue;
    for (let k = 1; k < levels.length; k++) node(levels.slice(0, k));
    const n = node(levels);
    const see = fieldArg(f, 't');
    if (see !== null) { if (!n.see.includes(see)) n.see.push(see); continue; }
    let range = null;
    const bm = fieldArg(f, 'r');
    if (bm) {
      const s = starts.find(([x]) => x === bm);
      if (s) {
        const a = page(s[1]);
        const e = bookmarkEnd(bm);
        const b = e ? page(e) : a;
        range = b > a ? `${a}–${b}` : String(a);
      }
    }
    const r = {page: range ?? String(page(pos)), bold: fieldHas(f, 'b'), italic: fieldHas(f, 'i')};
    const x = n.pages.find(y => y.page === r.page);
    if (x) { x.bold ||= r.bold; x.italic ||= r.italic; } else n.pages.push(r);
  }
  const cmpKeys = (a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = cmpSortKeys(a[i], b[i]); if (c) return c; }
    return a.length - b.length;
  };
  return [...tree.values()].sort((a, b) => cmpKeys(a.keys, b.keys));
}

function refs(line, node, sep) {
  node.pages.forEach((r, k) => {
    line.push([k === 0 ? sep : ', ', {}]);
    const props = {};
    if (r.bold) props.bold = true;
    if (r.italic) props.italic = true;
    line.push([r.page, props]);
  });
  node.see.forEach((see, k) => {
    line.push([k > 0 || node.pages.length ? '; ' : '. ', {}]);
    line.push([see, {italic: true}]);
  });
}

/** Rebuild the index whose field is in body block `i` (rebuild). */
export function rebuildIndex(S, i, leader0) {
  const d = S.d;
  const instr = (topPara(d, i)?.objects ?? []).find(o => o.type === 'field' && parseField(o.instr).name === 'INDEX')?.instr;
  if (!instr) return;
  const f = parseField(instr);
  let oldLeader = null, oldSect = null;
  while (topPara(d, i + 1)?.props?.style === ENTRY_STYLE) {
    const p = topPara(d, i + 1);
    oldLeader ??= p.props?.tabs?.at(-1)?.leader ?? null;
    if (p.section) oldSect = p.section;
    d.removeBlock(BODY, [i + 1]);
  }
  const leader = leader0 ?? oldLeader ?? 'dot';
  const cols = Math.max(1, Math.min(4, Number.parseInt(fieldArg(f, 'c') ?? '1', 10) || 1));
  const sep = fieldArg(f, 'e') ?? ', ';
  const runIn = fieldHas(f, 'r');
  const headings = f.switches.find(([c]) => c === 'h');
  const head = headings ? headings[1] ?? '' : null;
  const lang = T.paraLang(d, topPara(d, i)) ?? T.defaultLang(S);
  const nodes = collect(S, lang);
  const lines = [];
  let letter;
  for (let k = 0; k < nodes.length; k++) {
    const node = nodes[k];
    const main = node.levels[0];
    if (head !== null) {
      const first = headingLetter(main, lang);
      if (first !== letter) {
        if (letter !== undefined || head) lines.push([0, [[head ? first ?? '' : '', {}]]]);
        letter = first;
      }
    }
    if (runIn) {
      if (node.levels.length > 1) continue;
      const line = [[main, {}]];
      refs(line, node, sep);
      let firstSub = true;
      while (k + 1 < nodes.length && nodes[k + 1].levels.length > 1 && nodes[k + 1].levels[0] === main) {
        const sub = nodes[++k];
        line.push([firstSub ? ': ' : '; ', {}]);
        firstSub = false;
        line.push([sub.levels.slice(1).join(', '), {}]);
        refs(line, sub, ', ');
      }
      lines.push([0, line]);
    } else {
      const line = [[node.levels.at(-1), {}]];
      refs(line, node, sep);
      lines.push([node.levels.length - 1, line]);
    }
  }
  const secs = d.sections();
  const sect = sectionOf(secs[d.sectionIndexOf(i + 1)]?.[1] ?? d.c.lastSection);
  const space = oldSect ? sectionOf(oldSect).columns.space : sect.columns.space;
  const colW = (textWidth(sect) - space * (cols - 1)) / cols;
  lines.forEach(([level, runs], k) => {
    const para = P.styled(P.newParagraph(d.newId()), ENTRY_STYLE);
    for (const [t, props] of runs) P.insertText(para, para.text.length, t, props);
    para.props = {...para.props, indentLeft: 18 * (level + 1), indentFirst: -18};
    if (para.text.includes('\t')) para.props.tabs = [{pos: Math.max(colW - 0.5, 18), align: 'right', leader}];
    d.insertBlock(BODY, [i + 1 + k], para);
  });
  indexColumns(d, i, lines.length, cols, oldSect);
}

/** The index entries in a continuous section of `cols` columns, or joined back for one (columns). */
function indexColumns(d, i, n, cols, old) {
  const last = i + n;
  if (cols > 1 && n > 0) {
    if (last + 1 >= bodyLen(d)) d.insertBlock(BODY, [last + 1], P.newParagraph(d.newId()));
    const after = sectionOf(d.sections()[d.sectionIndexOf(last + 1)]?.[1] ?? d.c.lastSection);
    const head = d.paraMut(BODY, [i]);
    const fresh = !head.section;
    if (fresh) head.section = {...after, id: d.newId()};
    const sect = {...(old ? sectionOf(old) : after), columns: {...(old ? sectionOf(old) : after).columns, count: cols, widths: []}, start: 'continuous', pageNumStart: null, id: d.newId()};
    const end = d.paraMut(BODY, [last]);
    end.section = sect;
    if (fresh) d.updateSection(last + 1, s => ({...s, start: 'continuous', pageNumStart: null}));
  } else if (old) {
    const head = d.paraMut(BODY, [i]);
    if (head.section) {
      const before = head.section;
      delete head.section;
      d.updateSection(i, s => ({...s, start: before.start, pageNumStart: before.pageNumStart}));
    }
  }
}
