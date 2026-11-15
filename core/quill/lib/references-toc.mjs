// References engine, part 1 (U:quill/references): field instructions, the table of contents,
// footnote and endnote references, captions and SEQ numbering, and Update Field (F9).
//
// Translated from wordcraft (ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c):
//   crates/engine/src/cmd/references.rs              FieldCode (parse, has, arg, is_table_of_figures)
//   crates/engine/src/cmd/references/toc.rs          level_range, leader, toc_instr, headings,
//                                                    toc_entries, toc_range, remove_toc,
//                                                    caret_in_toc, range_toc_to_field, toc_field,
//                                                    cached_toc_tabs, insert_toc, bookmark_heading,
//                                                    update_toc, regenerate_toc, entry_tabs
//   crates/engine/src/cmd/references/notes.rs        note, note_options, note_refs
//   crates/engine/src/cmd/references/fields.rs       seq_format, CHAPTER_SEPARATORS, caption,
//                                                    update_seq, has_switch, update_fields_in
//   crates/engine/src/cmd/references/properties.rs   summary_property, new_property_value,
//                                                    count_text, text_result, doc_property(_arg),
//                                                    date_picture, bookmark_text
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// What differs from upstream (docs/behaviour-fidelity.md):
// * STYLEREF: upstream evaluates it with crates/layout/src/styleref.rs (not translated). Update
//   Field here fills the STYLEREF fields captions use (`STYLEREF n \s`: the chapter number, the
//   last level-n heading's list number or, unnumbered, its count) and `STYLEREF "Style"` (the
//   nearest paragraph of that style above, its text); other switches keep the stored result.
// * Update Table's "Update page numbers only" (Word's Update Table of Contents dialog) has no
//   upstream counterpart: it keeps the entries' text and writes each entry's current page after
//   its last tab (or `\p` separator), finding the heading by the entry's `_Toc` link.
// * At the start of a paragraph the table goes above it (Word); upstream splits there and leaves
//   an empty paragraph above the table.
// * Manual Table (Word's gallery) has no upstream counterpart: a TOCHeading and TOC1–3 entries
//   with Word's placeholder text and no field, which Update Table leaves alone as Word does.

import * as P from '../model/para.mjs';
import {BODY, samePath, cmpPos, fragmentPlainText} from '../model/document.mjs';
import {resolvePara} from '../model/styles.mjs';
import {Counters} from '../model/numbering.mjs';
import {sectionOf, columnBoxes, textWidth} from '../model/section.mjs';
import {formatSwitch, fieldNumber, applyCaseSwitch, fieldName} from '../layout/fields.mjs';
import {evaluateFieldWith, numberFormatCovers} from './table-formula.mjs';
import {layout as runLayout, LayoutCache, getDefaultShaper} from '../layout/index.mjs';
import * as T from './table-session.mjs';

export const UPSTREAM_FILES = ['crates/engine/src/cmd/references.rs', 'crates/engine/src/cmd/references/toc.rs',
  'crates/engine/src/cmd/references/notes.rs', 'crates/engine/src/cmd/references/fields.rs', 'crates/engine/src/cmd/references/properties.rs'];

const OBJ = P.OBJ;
const failed = T.failed;
const bad = T.params;
const field = (instr, result = '') => ({type: 'field', instr, result});
const bodyBlocks = d => d.story(BODY);
const topPara = (d, i) => d.para(BODY, [i]);

// ---- FieldCode (references.rs) --------------------------------------------------------------------

/**
 * A field instruction split into its name, positional arguments and switches (ECMA-376 §17.16.1):
 * `TOC \o "1-3" \h` → name `TOC`, switches `o` = `1-3` and `h` (FieldCode::parse). Quoted text stays
 * whole; a switch takes the word after it unless that word is another switch.
 */
export function parseField(instr) {
  const words = [];
  const cs = [...String(instr ?? '')];
  let i = 0;
  while (i < cs.length) {
    const c = cs[i];
    if (/\s/u.test(c)) { i++; continue; }
    if (c === '"') {
      i++;
      let w = '';
      while (i < cs.length) {
        const d = cs[i++];
        if (d === '"') break;
        if (d === '\\' && (cs[i] === '"' || cs[i] === '\\')) { w += cs[i++]; continue; }
        w += d;
      }
      words.push([w, true]);
    } else {
      let w = '';
      while (i < cs.length) {
        const d = cs[i];
        if (/\s/u.test(d) || (d === '"' && w)) break;
        w += d;
        i++;
      }
      words.push([w, false]);
    }
  }
  const f = {name: (words[0]?.[0] ?? '').replace(/^=+/, '').toUpperCase(), args: [], switches: []};
  for (let k = 1; k < words.length; k++) {
    const [w, quoted] = words[k];
    const sw = !quoted && w.startsWith('\\') ? [...w.slice(1)][0] : undefined;
    if (sw !== undefined) {
      const next = words[k + 1];
      let arg = null;
      if (next && (next[1] || !next[0].startsWith('\\'))) { arg = next[0]; k++; }
      f.switches.push([sw.toLowerCase(), arg]);
    } else f.args.push(w);
  }
  return f;
}
export const fieldHas = (f, c) => f.switches.some(([k]) => k === c);
export const fieldArg = (f, c) => f.switches.find(([k]) => k === c)?.[1] ?? null;
/** A table of figures (`TOC \c` / `TOC \a`), not a table of contents (is_table_of_figures). */
export const isTableOfFigures = f => f.name === 'TOC' && (fieldHas(f, 'c') || fieldHas(f, 'a'));

// ---- properties.rs ----------------------------------------------------------------------------------

const SUMMARY = {TITLE: 'title', SUBJECT: 'subject', AUTHOR: 'creator', KEYWORDS: 'keywords', COMMENTS: 'description'};
/** (summary_property) */
export const summaryProperty = (core, name) => String(core?.[SUMMARY[name]] ?? '');
/** (new_property_value) */
export function newPropertyValue(instr) {
  const a = parseField(instr).args[0];
  return a === undefined ? null : [...a].slice(0, 255).join('');
}
/** (count_text) */
export function countText(instr, n) {
  let fmt = formatSwitch(instr);
  if (fmt && !numberFormatCovers(fmt, n)) fmt = null;
  return fieldNumber(instr, fmt ?? 'decimal', Math.min(n, 0xffffffff));
}
/** (text_result) */
export const textResult = (instr, text) => applyCaseSwitch(instr, text);
/** (doc_property_arg) */
export function docPropertyArg(instr) {
  const m = /^\s*\S+\s+([\s\S]*)$/.exec(String(instr));
  if (!m) return null;
  const rest = m[1].trimStart();
  const name = rest.startsWith('"') ? rest.slice(1).split('"')[0] : rest.split(/[ \\]/)[0];
  return name ? name : null;
}
/** (doc_property) */
export function docProperty(d, core, name) {
  const custom = d.customProp(name);
  if (custom !== null && custom !== undefined) return String(custom);
  const c = core ?? {};
  switch (String(name).trim().toLowerCase()) {
    case 'title': return c.title ?? '';
    case 'subject': return c.subject ?? '';
    case 'author': case 'creator': return c.creator ?? '';
    case 'keywords': return c.keywords ?? '';
    case 'comments': case 'description': return c.description ?? '';
    case 'category': return c.category ?? '';
    case 'lastmodifiedby': case 'last modified by': case 'lastsavedby': case 'last saved by': return c.lastModifiedBy ?? '';
    case 'revisionnumber': case 'revision number': case 'revision': return String(c.revision ?? 0);
    default: return null;
  }
}
/** A field's `\@` date picture (date_picture). */
export function datePicture(instr) {
  const i = String(instr).indexOf('\\@');
  if (i < 0) return null;
  const rest = String(instr).slice(i + 2).trimStart();
  const pic = rest.startsWith('"') ? rest.slice(1).split('"')[0] : rest.split(/\s+/)[0] ?? '';
  return pic ? pic : null;
}
/** The text bookmark `name` marks, to its end in the same paragraph (bookmark_text). */
export function bookmarkText(d, name) {
  const hit = d.bookmarks().find(([n]) => n === name);
  if (!hit) return null;
  const start = hit[1];
  const para = d.para(start.story, start.path);
  if (!para) return null;
  const end = P.objectOffsets(para).find(o => o > start.off && P.objectAt(para, o)?.type === 'bookmarkEnd' && P.objectAt(para, o).name === name) ?? para.text.length;
  return fragmentPlainText(d.copyRange(start, {...start, off: end})).split(OBJ).join('').trim();
}

// ---- toc.rs ---------------------------------------------------------------------------------------

/** A level range such as `1-3` (or `2`), clamped to 1–9 (level_range). */
export function levelRange(s) {
  const parts = String(s ?? '').split('-').map(x => (/^\s*\d+\s*$/.test(x) ? Number(x) : null));
  if (parts[0] === null || parts[0] === undefined) return null;
  const a = Math.max(1, Math.min(9, parts[0]));
  let b = a;
  if (parts.length > 1) { if (parts[1] === null) return null; b = Math.max(1, Math.min(9, parts[1])); }
  return [Math.min(a, b), Math.max(a, b)];
}
/** The tab leader named in a command parameter (leader). */
export const leaderOf = name => (['none', 'hyphen', 'underscore', 'middleDot'].includes(name) ? name : 'dot');

/** The TOC instruction for references.toc's parameters (toc_instr). */
export function tocInstr(v) {
  const levels = Math.max(1, Math.min(9, Math.round(v.levels ?? 3)));
  const on = (k, d) => (typeof v[k] === 'boolean' ? v[k] : d);
  let s = 'TOC';
  if (on('headingStyles', true)) s += ` \\o "1-${levels}"`;
  if (on('hyperlinks', true)) s += ' \\h';
  s += ' \\z';
  if (on('outlineLevels', true)) s += ' \\u';
  if (on('tcFields', false)) s += ` \\f \\l "1-${levels}"`;
  if (!on('pageNumbers', true)) s += ` \\n "1-${levels}"`;
  else if (!on('rightAlign', true)) s += ' \\p " "';
  const clean = n => [...String(n)].filter(c => c !== '"' && c !== ',' && c !== '\\').slice(0, 64).join('').trim();
  const pairs = [];
  if (v.styleLevels && typeof v.styleLevels === 'object') {
    for (const [name, l] of Object.entries(v.styleLevels).slice(0, 64)) {
      if (typeof l !== 'number' || !Number.isFinite(l)) continue;
      const n = clean(name);
      if (n) pairs.push(`${n},${Math.max(1, Math.min(9, Math.round(l)))}`);
    }
  }
  if (pairs.length) s += ` \\t "${pairs.join(',')}"`;
  return s;
}

/** The heading level (1–9) of a built-in heading style (heading_style_level). */
export function headingStyleLevel(p) {
  const m = /^Heading\s*(\d+)$/.exec(p.props?.style ?? '');
  const l = m ? Number(m[1]) : 0;
  return l >= 1 && l <= 9 ? l : null;
}
const leadOf = p => { let n = 0; while (p.text[n] === '\u000C') n++; return n; };

/** The entries a TOC field collects from the body, in document order (toc_entries): {path, level 0-based, text, lead}. */
export function tocEntries(d, f) {
  const o = fieldHas(f, 'o') ? levelRange(fieldArg(f, 'o')) ?? [1, 9] : null;
  const max = o ? o[1] : 9;
  const tArg = fieldArg(f, 't');
  const styles = [];
  if (tArg !== null) {
    const parts = tArg.split(/[,;]/).map(x => x.trim());
    for (let i = 0; i + 1 < parts.length; i += 2) if (/^\d+$/.test(parts[i + 1])) styles.push([parts[i], Math.max(1, Math.min(9, Number(parts[i + 1])))]);
  }
  const tc = fieldHas(f, 'f') ? (fieldArg(f, 'f') ?? '').toUpperCase() : null;
  const tcLevels = levelRange(fieldArg(f, 'l')) ?? [1, 9];
  const out = [];
  const counters = new Counters();
  for (const path of d.paraPaths(BODY)) {
    const p = d.para(BODY, path);
    if (!p) continue;
    const n = p.props?.numbering ?? resolvePara(d.c.styles, p.props ?? {}).numbering;
    let number = null;
    if (n && n.num !== 0) {
      const got = counters.nextLabel(d.c.numbering, n.num, n.level ?? 0);
      if (got && got[0] && got[1].format !== 'bullet' && got[1].format !== 'none') {
        const sfx = got[1].suffix ?? 'tab';
        number = sfx === 'tab' ? `${got[0]}\t` : sfx === 'space' ? `${got[0]} ` : got[0];
      }
    }
    const style = p.props?.style ?? 'Normal';
    if (style.startsWith('TOC')) continue;
    const lead = leadOf(p);
    const st = d.c.styles.styles.find(x => x.id === style);
    const byStyle = styles.find(([nm]) => (st && st.name.toLowerCase() === nm.toLowerCase()) || nm === style)?.[1] ?? null;
    const ol = p.props?.outlineLevel;
    const byOutline = fieldHas(f, 'u') && typeof ol === 'number' && ol < 9 && ol + 1 <= max ? ol + 1 : null;
    const hidden = fieldHas(f, 'u') && ol === 9;
    let byHeading = null;
    if (o) {
      let l = headingStyleLevel(p);
      if (l === null) { const r = resolvePara(d.c.styles, {style: p.props?.style}).outlineLevel; l = typeof r === 'number' ? r + 1 : null; }
      if (l !== null && l >= o[0] && l <= o[1]) byHeading = l;
    }
    const l = byStyle ?? byOutline ?? (hidden ? null : byHeading);
    if (l !== null) {
      const t = P.plainText(p).split(OBJ).join('').replace(/[\u000C\n\t]/g, ' ').trim();
      if (t) out.push({path, level: l - 1, text: number ? `${number}${t}` : t, lead});
    }
    if (tc !== null) {
      for (const off of P.objectOffsets(p)) {
        const ob = P.objectAt(p, off);
        if (ob?.type !== 'field') continue;
        const c = parseField(ob.instr);
        if (c.name !== 'TC') continue;
        const kind = (fieldArg(c, 'f') ?? 'C').toUpperCase();
        const lv = Math.max(1, Math.min(9, Number.parseInt(fieldArg(c, 'l') ?? '1', 10) || 1));
        const text = (c.args[0] ?? '').trim();
        if ((tc === '' || tc === kind) && lv >= tcLevels[0] && lv <= tcLevels[1] && text) out.push({path, level: lv - 1, text, lead: off});
      }
    }
  }
  return out;
}

/** The body's headings: [block, level 1–9, text, lead] (headings). */
export function headings(d) {
  return tocEntries(d, parseField('TOC \\o "1-9" \\u')).filter(e => e.path.length === 1).map(e => [e.path[0], e.level + 1, e.text, e.lead]);
}

/** The TOC instruction in paragraph `p` (not a table of figures) (toc_field). */
export function tocField(p) {
  for (const o of p?.objects ?? []) {
    if (o.type !== 'field') continue;
    const f = parseField(o.instr);
    if (f.name === 'TOC' && !isTableOfFigures(f)) return o.instr;
  }
  return null;
}
const isEntryStyle = st => typeof st === 'string' && st.startsWith('TOC') && st !== 'TOCHeading';

/** The engine TOC's block range [start, end] (toc_range). */
export function tocRange(d) {
  const bl = bodyBlocks(d);
  let start = -1;
  for (let i = 0; i < bl.len(); i++) { const b = bl.get(i); if (b.kind === 'para' && tocField(b) !== null) { start = i; break; } }
  if (start < 0) return null;
  let end = start;
  while (end + 1 < bl.len()) {
    const b = bl.get(end + 1);
    if (b.kind === 'para' && isEntryStyle(b.props?.style)) end++; else break;
  }
  return [start, end];
}

/** Remove the TOC blocks start..=end; returns where the TOC was (remove_toc). */
export function removeToc(d, start, end) {
  for (let i = end; i > start; i--) d.removeBlock(BODY, [i]);
  let at;
  const p = topPara(d, start);
  if (p && p.section) {
    const q = d.paraMut(BODY, [start]);
    const sect = q.section;
    d.setBlock(BODY, [start], {...P.newParagraph(q.id), section: sect});
    at = start + 1;
  } else {
    d.removeBlock(BODY, [start]);
    at = start;
  }
  const prev = start > 0 ? topPara(d, start - 1) : null;
  if (prev && prev.props?.style === 'TOCHeading' && !prev.section && tocField(prev) === null) {
    d.removeBlock(BODY, [start - 1]);
    return at - 1;
  }
  return at;
}

function convertibleTocRange(d, r) {
  const f = parseField(r.instr);
  return tocRange(d) === null && f.name === 'TOC' && !isTableOfFigures(f) && r.depth === 0 && !r.locked && r.start.path.length === 1 && r.end.path.length === 1;
}

/** The caret is in the table of contents (caret_in_toc). */
export function caretInToc(d, at) {
  if (at.story !== BODY || at.path.length !== 1) return false;
  const r = tocRange(d);
  if (r && at.path[0] >= r[0] && at.path[0] <= r[1]) return true;
  const range = d.fieldRanges(BODY).find(x => convertibleTocRange(d, x));
  return !!range && at.path[0] >= range.start.path[0] && at.path[0] <= range.end.path[0];
}

/** A TOC imported as a range field becomes the engine's TOC before an update (range_toc_to_field). */
export function rangeTocToField(S) {
  const d = S.d;
  if (tocRange(d)) return;
  const r = d.fieldRanges(BODY).find(x => convertibleTocRange(d, x));
  if (!r) return;
  const end = {...r.end, off: r.end.off + 1};
  const props = P.propsOfChar(d.paraAt(r.start), r.start.off) ?? {};
  let at = d.deleteRange(r.start, end);
  const i = at.path[0];
  const leftover = p => p.text.length === 0 || ((p.objects ?? []).every(o => o.type === 'controlEnd') && [...p.text].every(c => c === OBJ) && isEntryStyle(p.props?.style));
  const here = d.paraAt(at);
  const before = i > 0 ? topPara(d, i - 1) : null;
  if (at.path.length === 1 && i > 0 && here && leftover(here) && before && (before.props?.style === 'TOCHeading' || (before.text.length === 0 && !(before.objects ?? []).length))) {
    d.removeBlock(BODY, at.path);
    at = {story: BODY, path: [i - 1], off: topPara(d, i - 1).text.length};
  }
  const after = d.insertObject(at, field(String(r.instr).trim()), props);
  const p = d.paraAt(after);
  if (p && after.off < p.text.length) d.splitParagraph(after);
  S.sel = {anchor: d.clamp(S.sel.anchor), focus: d.clamp(S.sel.focus)};
}

/** The first cached number-separator tab formatting at each TOC level (cached_toc_tabs). */
export function cachedTocTabs(d) {
  let span = null;
  const r = tocRange(d);
  if (r) span = [r[0] + 1, r[1]];
  else {
    const fr = d.fieldRanges(BODY).find(x => {
      const f = parseField(x.instr);
      return x.depth === 0 && !x.locked && x.start.path.length === 1 && x.end.path.length === 1 && f.name === 'TOC' && !isTableOfFigures(f);
    });
    if (fr) span = [fr.start.path[0], fr.end.path[0]];
  }
  if (!span) return [];
  const out = [];
  for (let i = span[0]; i <= span[1]; i++) {
    const p = topPara(d, i);
    if (!p) continue;
    const style = p.props?.style;
    const direct = p.props?.tabs;
    if (!style || !direct) continue;
    if (!direct.some(t => t.align === 'left' || t.align === 'center' || t.align === 'decimal')) continue;
    if (!isEntryStyle(style) || out.some(([id]) => id === style)) continue;
    out.push([style, direct.map(t => ({...t}))]);
  }
  return out;
}

/** A hidden `_Toc` bookmark around the heading at `path` (after `lead`), reusing one there (bookmark_heading). */
export function bookmarkHeading(S, path, lead) {
  const d = S.d;
  const para = d.para(BODY, path);
  if (!para) throw failed('heading is gone');
  const o = P.objectAt(para, lead);
  if (o?.type === 'bookmarkStart' && o.name.startsWith('_Toc')) return o.name;
  let next = 0;
  for (const [n] of d.bookmarks()) { const m = /^_Toc(\d+)$/.exec(n); if (m) next = Math.max(next, Number(m[1])); }
  const name = `_Toc${String(next + 1).padStart(9, '0')}`;
  const end = para.text.length;
  d.insertObject({story: BODY, path, off: end}, {type: 'bookmarkEnd', name}, {});
  d.insertObject({story: BODY, path, off: lead}, {type: 'bookmarkStart', name}, {});
  for (const k of ['anchor', 'focus']) {
    const q = S.sel[k];
    if (q.story === BODY && samePath(q.path, path)) S.sel = {...S.sel, [k]: {...q, off: q.off > end ? q.off + 2 : q.off >= lead && q.off > 0 ? q.off + 1 : q.off}};
  }
  return name;
}

/**
 * The document as it stands mid-command, laid out (Session::layout). A command edits its Document in
 * place once it owns it, so a layout cached by content identity would be stale: this one is fresh.
 */
export function freshLayout(S) {
  const v = S.ctx?.view ?? {};
  return runLayout(S.d.content, {view: 'print', showHidden: !!v.showHidden, cache: new LayoutCache(), shaper: getDefaultShaper()});
}
/** The page number the text at `pos` is on (generated.rs page_of); `l` a layout of the document now. */
export function pageOf(S, pos, l = freshLayout(S)) {
  const c = l?.caret(pos);
  return (c && l.pages[c.page]?.number) || 1;
}

/** The width of the TOC's column: its own section's first column (regenerate_toc). */
function tocWidth(d, start) {
  const afterBreak = !!topPara(d, start)?.section;
  const secs = d.sections();
  const s = secs[d.sectionIndexOf(start + (afterBreak ? 1 : 0))];
  const sect = sectionOf(s ? s[1] : d.c.lastSection);
  const boxes = columnBoxes(sect);
  return boxes.length ? boxes[0][1] : textWidth(sect);
}

/** The tab stops of a TOC entry (entry_tabs). */
function entryTabs(d, props, text, right) {
  const tabs = (props.tabs ?? []).filter(t => t.pos < right.pos - 0.5 && t.align !== 'right' && t.align !== 'bar').map(t => ({...t}));
  if (!text.includes('\t')) {
    const st = resolvePara(d.c.styles, {style: props.style});
    for (const t of st.tabs ?? []) if (t.pos < right.pos - 0.5 && t.align !== 'right' && t.align !== 'bar') tabs.push({pos: t.pos, align: 'clear', leader: 'none'});
  }
  tabs.push(right);
  return tabs;
}

/** Rebuild the TOC entries the field's switches ask for, with page numbers (regenerate_toc). */
export function regenerateToc(S, leader0, tabs) {
  rangeTocToField(S);
  const d = S.d;
  const r = tocRange(d);
  if (!r) return;
  const [start, end] = r;
  const instr = tocField(topPara(d, start));
  if (instr === null) return;
  // An imported TOC field's cached result goes, so the writer spans the field across the entries.
  const hp = d.paraMut(BODY, [start]);
  if (hp.objects?.some(o => o.type === 'field' && o.result && parseField(o.instr).name === 'TOC' && !isTableOfFigures(parseField(o.instr)))) {
    hp.objects = hp.objects.map(o => (o.type === 'field' && parseField(o.instr).name === 'TOC' && !isTableOfFigures(parseField(o.instr)) ? {...o, result: ''} : o));
  }
  const f = parseField(instr);
  const leader = leader0 ?? (end > start ? (topPara(d, start + 1)?.props?.tabs?.at(-1)?.leader ?? 'dot') : 'dot');
  for (let i = end; i > start; i--) d.removeBlock(BODY, [i]);
  const width = tocWidth(d, start);
  const entries = tocEntries(d, f);
  const links = [];
  if (fieldHas(f, 'h')) {
    for (const e of entries) {
      const p = d.para(BODY, e.path);
      links.push(`#${bookmarkHeading(S, e.path, p ? leadOf(p) : 0)}`);
    }
  }
  const noPages = fieldHas(f, 'n') ? levelRange(fieldArg(f, 'n')) ?? [1, 9] : null;
  const sep = fieldArg(f, 'p') ?? '\t';
  for (let pass = 0; pass < 2; pass++) {
    const pages = [];
    // Pass 1 lays out with the entries in place, so the headings below sit where they will be.
    const shift = pass === 0 ? 0 : entries.length;
    const l = freshLayout(S);
    for (const e of entries) {
      const target = [...e.path];
      if (target[0] > start) target[0] += shift;
      pages.push(pageOf(S, {story: BODY, path: target, off: e.lead}, l));
    }
    if (pass === 1) for (let k = 0; k < entries.length; k++) d.removeBlock(BODY, [start + 1]);
    entries.forEach((e, k) => {
      const showPage = !noPages || !(e.level + 1 >= noPages[0] && e.level + 1 <= noPages[1]);
      const text = showPage ? `${e.text}${sep}${pages[k]}` : e.text;
      const props = links[k] ? {link: links[k]} : {};
      const para = P.styled(P.paragraphWithText(text, props, d.newId()), `TOC${e.level + 1}`);
      delete para.mark;
      if (e.text.includes('\t')) {
        const t = tabs.find(([st]) => st === para.props?.style);
        if (t) para.props = {...para.props, tabs: t[1].map(x => ({...x}))};
      }
      if (showPage && sep.includes('\t')) {
        const right = {pos: width - 0.5, align: 'right', leader};
        para.props = {...para.props, tabs: entryTabs(d, para.props ?? {}, e.text, right)};
      }
      d.insertBlock(BODY, [start + 1 + k], para);
    });
  }
}

/** References › Update Table (update_toc). */
export function updateToc(S) { regenerateToc(S, null, cachedTocTabs(S.d)); }

/** Update page numbers only (Word): each entry keeps its text; the page after its last separator follows its heading. */
export function updateTocPages(S) {
  rangeTocToField(S);
  const d = S.d;
  const r = tocRange(d);
  if (!r) return 0;
  const sep = fieldArg(parseField(tocField(topPara(d, r[0]))), 'p') ?? '\t';
  const marks = new Map(d.bookmarks().map(([n, at]) => [n, at]));
  let n = 0;
  const l = freshLayout(S);
  for (let i = r[0] + 1; i <= r[1]; i++) {
    const p = topPara(d, i);
    const link = p?.runs?.map(x => x.props?.link).find(x => typeof x === 'string' && x.startsWith('#_Toc'));
    const at = link ? marks.get(link.slice(1)) : null;
    if (!p || !at) continue;
    const k = p.text.lastIndexOf(sep);
    if (k < 0) continue;
    const page = String(pageOf(S, at, l));
    const from = k + sep.length;
    if (p.text.slice(from) === page) continue;
    const props = P.propsOfChar(p, Math.max(0, from - 1)) ?? {};
    d.deleteRange({story: BODY, path: [i], off: from}, {story: BODY, path: [i], off: p.text.length});
    d.insertText({story: BODY, path: [i], off: from}, page, props);
    n++;
  }
  return n;
}

/** Word's Manual Table: entries with placeholder text and page numbers, no field (office). */
export function manualToc(S, title = 'Contents') {
  const d = S.d;
  const at = T.deleteSelection(S);
  if (at.story !== BODY || at.path.length !== 1) throw failed('a table of contents goes in the main text');
  const width = tocWidth(d, at.path[0]);
  const blocks = [P.styled(P.paragraphWithText(title, {}, d.newId()), 'TOCHeading')];
  [1, 2, 3, 1, 2, 3].forEach((lvl, k) => {
    const p = P.styled(P.paragraphWithText(`Type chapter title (level ${lvl})\t${k + 1}`, {}, d.newId()), `TOC${lvl}`);
    p.props = {...p.props, tabs: [{pos: width - 0.5, align: 'right', leader: 'dot'}]};
    blocks.push(p);
  });
  const i = d.paraAt(at)?.text.length === 0 || at.off === 0 ? at.path[0] : d.splitParagraph(at).path[0];
  blocks.forEach((b, k) => d.insertBlock(BODY, [i + k], b));
  T.setCaret(S, {story: BODY, path: [i], off: 0});
}

/** References › Table of Contents: insert, or replace with new settings; `{}` updates (insert_toc). */
export function insertToc(S, v) {
  const d = S.d;
  const tabs = cachedTocTabs(d);
  rangeTocToField(S);
  const replace = Object.keys(v).length > 0;
  let placeholder = false;
  let at;
  const r = tocRange(d);
  if (r && !replace) { regenerateToc(S, null, tabs); return; }
  if (r) {
    const start = removeToc(d, r[0], r[1]);
    d.insertBlock(BODY, [start], P.newParagraph(d.newId()));
    placeholder = true;
    at = {story: BODY, path: [start], off: 0};
    T.setCaret(S, at);
  } else at = T.deleteSelection(S);
  const title = typeof v.title === 'string' ? v.title : 'Contents';
  if (at.story !== BODY || at.path.length !== 1) throw failed('a table of contents goes in the main text');
  const head = P.styled(P.paragraphWithText(title, {}, d.newId()), 'TOCHeading');
  P.insertObject(head, head.text.length, field(tocInstr(v)), {});
  let i;
  if (d.paraAt(at)?.text.length === 0) {
    if (placeholder) d.removeBlock(BODY, at.path);
    i = at.path[0];
  } else i = at.off === 0 ? at.path[0] : d.splitParagraph(at).path[0];
  d.insertBlock(BODY, [i], head);
  regenerateToc(S, leaderOf(v.tabLeader ?? 'dot'), tabs);
  T.setCaret(S, d.clamp(S.sel.focus));
}

// ---- notes.rs ---------------------------------------------------------------------------------------

/** Insert a footnote or endnote at the selection; the caret moves into the note (note). */
export function insertNote(S, v, kind) {
  const d = S.d;
  const text = typeof v.text === 'string' ? v.text : '';
  const custom = [...String(v.mark ?? '').trim()].filter(c => !/\p{Cc}/u.test(c)).slice(0, 10).join('');
  const [style, refStyle] = kind === 'footnote' ? ['FootnoteText', 'FootnoteReference'] : ['EndnoteText', 'EndnoteReference'];
  const para = P.styled(P.newParagraph(d.newId()), style);
  const id = d.tryAddPart(kind, []);
  if (!id) throw failed('no room for another note');
  P.insertObject(para, 0, {type: 'noteRef', kind, id, custom}, {style: refStyle});
  P.insertText(para, para.text.length, ` ${text}`, {});
  d.setStory(id, [para]);
  const at = T.deleteSelection(S);
  d.insertObject(at, {type: 'noteRef', kind, id, custom}, {style: refStyle});
  T.setCaret(S, d.endOf(id));
  return {id};
}

/** Note references in the body, in order (note_refs): positions, optionally of one kind. */
export function noteRefs(d, kind = null) {
  const out = [];
  for (const path of d.paraPaths(BODY)) {
    const p = d.para(BODY, path);
    if (!p) continue;
    for (const [off, o] of P.objectsWithOffsets(p)) if (o.type === 'noteRef' && (!kind || o.kind === kind)) out.push({story: BODY, path, off, id: o.id, kind: o.kind});
  }
  return out;
}

const NOTE_FORMATS = ['decimal', 'lowerLetter', 'upperLetter', 'lowerRoman', 'upperRoman', 'chicago', 'decimalEnclosedCircle', 'decimalFullWidth', 'ideographDigital'];
/** references.noteOptions (note_options): options for the document or the selection's sections; the options in effect. */
export function noteOptions(S, v) {
  const d = S.d;
  const fmt = k => {
    if (v[k] === undefined || v[k] === null) return null;
    if (!NOTE_FORMATS.includes(v[k])) throw bad(`unknown number format ${JSON.stringify(v[k])}`);
    return v[k];
  };
  const oldFoot = fmt('footnoteFormat'), oldEnd = fmt('endnoteFormat');
  const kind = v.kind ?? 'footnote';
  if (kind !== 'footnote' && kind !== 'endnote') throw bad(`unknown \`kind\` ${JSON.stringify(kind)}; use footnote or endnote`);
  const endnote = kind === 'endnote';
  let pos = null;
  if (v.pos !== undefined && v.pos !== null) {
    const ok = endnote ? ['sectEnd', 'docEnd'] : ['pageBottom', 'beneathText'];
    if (!ok.includes(v.pos)) throw bad(`\`pos\` ${JSON.stringify(v.pos)} doesn't apply here; use ${ok.join(' or ')}`);
    pos = v.pos;
  }
  let numRestart = null;
  if (v.numRestart !== undefined && v.numRestart !== null) {
    if (!['continuous', 'eachSect', 'eachPage'].includes(v.numRestart)) throw bad(`unknown \`numRestart\` ${JSON.stringify(v.numRestart)}; use continuous, eachSect or eachPage`);
    if (v.numRestart === 'eachPage' && endnote) throw bad('endnotes can\'t start again on each page');
    numRestart = v.numRestart;
  }
  const change = {pos, numFmt: fmt('numFmt'), numStart: typeof v.numStart === 'number' ? Math.max(1, Math.min(32_767, Math.round(v.numStart))) : null, numRestart};
  const scope = v.scope ?? 'document';
  if (scope !== 'document' && scope !== 'section') throw bad(`unknown \`scope\` ${JSON.stringify(scope)}; use document or section`);
  const keys = ['pos', 'numFmt', 'numStart', 'numRestart'];
  const merge = (to, clear) => { const out = {...(to ?? {})}; for (const k of keys) if (change[k] !== null) { if (clear) delete out[k]; else out[k] = change[k]; } return out; };
  const prKey = endnote ? 'endnotePr' : 'footnotePr';
  const empty = keys.every(k => change[k] === null);
  if (!empty) {
    if (scope === 'document') {
      d.updateField('settings', st0 => {
        const st = {...st0};
        if (change.numFmt !== null) st[endnote ? 'endnoteFormat' : 'footnoteFormat'] = change.numFmt;
        const prev = change.numFmt;
        change.numFmt = null;
        st[prKey] = merge(st[prKey], false);
        change.numFmt = prev;
        return st;
      });
      for (const [e] of d.sections()) d.updateSection(e, sect => ({...sect, [prKey]: merge(sect[prKey], true)}));
    } else {
      const [a, b] = T.ordered(S.sel);
      const from = a.story === BODY ? a.path[0] : bodyBlocks(d).len() - 1;
      const to = b.story === BODY ? b.path[0] : from;
      const ends = new Set();
      for (let i = from; i <= to; i++) ends.add(d.sectionIndexOf(i));
      const list = d.sections();
      for (const k of ends) d.updateSection(list[k][0], sect => ({...sect, [prKey]: merge(sect[prKey], false)}));
    }
  }
  if (oldFoot) d.updateField('settings', st => ({...st, footnoteFormat: oldFoot}));
  if (oldEnd) d.updateField('settings', st => ({...st, endnoteFormat: oldEnd}));
  const sect = sectionOf(T.caretSection(S));
  return {footnote: d.noteOptions(sect, false), endnote: d.noteOptions(sect, true), footnoteFormat: d.c.settings.footnoteFormat, endnoteFormat: d.c.settings.endnoteFormat};
}

// ---- fields.rs: captions and SEQ ------------------------------------------------------------------

/** The `\*` switch value for a caption number format (seq_format). */
export function seqFormat(name) {
  switch (name) {
    case 'alphabetic': case 'lowerLetter': return 'alphabetic';
    case 'ALPHABETIC': case 'upperLetter': return 'ALPHABETIC';
    case 'roman': case 'lowerRoman': return 'roman';
    case 'ROMAN': case 'upperRoman': return 'ROMAN';
    default: return 'ARABIC';
  }
}
export const CHAPTER_SEPARATORS = Object.freeze(['-', '.', ':', '\u2014', '\u2013']);
/** A caption label as Word keeps it: no quotes, backslashes or control characters, at most 40 characters. */
export const cleanLabel = l => [...String(l ?? '')].filter(c => c !== '"' && c !== '\\' && !/\p{Cc}/u.test(c)).slice(0, 40).join('').trim();
/** The SEQ identifier of a caption label: Word joins a multi-word label with underscores (seq_ident). */
export const seqIdent = label => String(label).split(/\s+/).filter(Boolean).join('_');

/** Insert a caption below (or above) the selected object or the caret's top-level block (caption). */
export function insertCaption(S, v, objectAt = null) {
  const d = S.d;
  const label = cleanLabel(v.label ?? 'Figure') || 'Figure';
  const ident = seqIdent(label);
  const text = typeof v.text === 'string' ? v.text : '';
  const above = v.position === 'above';
  const format = seqFormat(v.format ?? 'ARABIC');
  const chapter = Number.isInteger(v.chapter) && v.chapter >= 1 && v.chapter <= 9 ? v.chapter : null;
  const sep = CHAPTER_SEPARATORS.includes(v.separator) ? v.separator : '-';
  const para = P.styled(P.newParagraph(d.newId()), 'Caption');
  if (!v.excludeLabel) P.insertText(para, 0, `${label} `, {});
  let seq = `SEQ ${ident} \\* ${format}`;
  if (chapter) {
    P.insertObject(para, para.text.length, field(`STYLEREF ${chapter} \\s`), {});
    P.insertText(para, para.text.length, sep, {});
    seq += ` \\s ${chapter}`;
  }
  P.insertObject(para, para.text.length, field(seq), {});
  if (text) P.insertText(para, para.text.length, `: ${text}`, {});
  const f = S.sel.focus;
  let path;
  if (objectAt) {
    const k = objectAt.path[objectAt.path.length - 1];
    path = [...objectAt.path.slice(0, -1), above ? k : k + 1];
  } else path = [above ? (f.path[0] ?? 0) : (f.path[0] ?? 0) + 1];
  const story = objectAt ? objectAt.story : f.story;
  d.insertBlock(story, path, para);
  updateSeq(d);
  T.setCaret(S, {story, path, off: d.para(story, path)?.text.length ?? 0});
}

/** The chapter number or text a STYLEREF in body paragraph `path` shows (styleref.rs, the cases captions use). */
function styleRef(d, instr, path, chapterLabels) {
  const f = parseField(instr);
  const want = f.args[0] ?? '';
  const level = /^\d$/.test(want) ? Number(want) : null;
  const paths = d.paraPaths(BODY);
  const k = paths.findIndex(x => samePath(x, path));
  for (let i = k; i >= 0; i--) {
    const p = d.para(BODY, paths[i]);
    if (!p) continue;
    const st = p.props?.style ?? 'Normal';
    const sheet = d.c.styles.styles.find(x => x.id === st);
    const hit = level !== null ? headingStyleLevel(p) === level : st === want || sheet?.name.toLowerCase() === want.toLowerCase();
    if (!hit) continue;
    if (fieldHas(f, 's') || fieldHas(f, 'n')) return chapterLabels.get(paths[i].join('/')) ?? '';
    return P.plainText(p).split(OBJ).join('').trim();
  }
  return null;
}

/** Renumber the body's SEQ fields and fill STYLEREF chapter numbers (update_seq). */
export function updateSeq(d) {
  const headings = new Array(9).fill(0);
  const seq = new Map();
  // Chapter numbers: each heading's list number (without its suffix) or, unnumbered, its count.
  const chapter = new Map();
  const counters = new Counters();
  const count = new Array(9).fill(0);
  for (const path of d.paraPaths(BODY)) {
    const p = d.para(BODY, path);
    if (!p) continue;
    const n = p.props?.numbering ?? resolvePara(d.c.styles, p.props ?? {}).numbering;
    const got = n && n.num !== 0 ? counters.nextLabel(d.c.numbering, n.num, n.level ?? 0) : null;
    const l = headingStyleLevel(p);
    if (l) { count[l - 1]++; for (let j = l; j < 9; j++) count[j] = 0; chapter.set(path.join('/'), got?.[0] ? got[0].replace(/[.)]+$/, '') : String(count[l - 1])); }
  }
  for (const path of d.paraPaths(BODY)) {
    const p = d.para(BODY, path);
    if (!p) continue;
    const l = headingStyleLevel(p);
    if (l) headings[l - 1] = Math.min(headings[l - 1] + 1, 0xffffffff);
    const updates = [];
    (p.objects ?? []).forEach((o, k) => {
      if (o.type !== 'field' || o.locked) return;
      const f = parseField(o.instr);
      if (f.name === 'SEQ') {
        const id = f.args[0];
        if (!id) return;
        const lv = Number.parseInt(fieldArg(f, 's') ?? '', 10);
        const restart = lv >= 1 && lv <= 9 ? headings[lv - 1] : null;
        let cur = seq.get(id) ?? [0, 0];
        if (restart !== null && cur[1] !== restart) cur = [0, restart];
        const r = fieldArg(f, 'r');
        if (r !== null && /^\d+$/.test(r)) cur = [Number(r), cur[1]];
        else if (!fieldHas(f, 'c')) cur = [Math.min(cur[0] + 1, 0xffffffff), cur[1]];
        seq.set(id, cur);
        const fmt = formatSwitch(o.instr) ?? 'decimal';
        updates.push([k, fieldHas(f, 'h') ? '' : fieldNumber(o.instr, fmt, cur[0])]);
      } else if (f.name === 'STYLEREF') {
        const r = styleRef(d, o.instr, path, chapter);
        if (r !== null) updates.push([k, textResult(o.instr, r)]);
      }
    });
    if (!updates.length) continue;
    const q = d.paraMut(BODY, path);
    q.objects = q.objects.map((o, k) => { const u = updates.find(([j]) => j === k); return u ? {...o, result: u[1], dirty: false} : o; });
  }
}

/** Whether `instr` has switch `\sw`, also run together with another (has_switch). */
export function hasSwitch(instr, sw) {
  return String(instr).split('\\').slice(1).some(s => { const cs = [...s]; return cs[0]?.toLowerCase() === sw.toLowerCase() && (cs.length < 2 || !/[\p{L}\p{N}]/u.test(cs[1])); });
}

/**
 * Update fields as Word's F9 does (update_fields_in): in the caret's story, or with `all` every story.
 * SEQ, citations and the TOC are body-only (`afterBody` runs the citations and lists).
 */
export function updateFieldsIn(S, all, {formatDate, nowMs, afterBody}) {
  const d = S.d;
  const caretStory = S.sel.focus.story;
  const inBody = all || caretStory === BODY;
  if (inBody) updateSeq(d);
  const pages = new Map();
  const formats = d.sections().map(([, s]) => sectionOf(s).pageNumFormat ?? 'decimal');
  const l = freshLayout(S);
  for (const [name, pos] of d.bookmarks()) {
    if (pages.has(name)) continue;
    const c = l?.caret(pos);
    const pg = c ? l.pages[c.page] : null;
    pages.set(name, pg ? [pg.number, formats[pg.section] ?? 'decimal'] : [1, 'decimal']);
  }
  const stories = all ? [BODY, ...Object.keys(d.c.parts).map(Number)] : [caretStory];
  const core = {...d.c.core};
  const fileName = S.ctx.file?.name ?? '';
  const filePath = S.ctx.file?.path ?? fileName;
  for (const story of stories) {
    for (const path of d.paraPaths(story)) {
      const p = d.para(story, path);
      if (!p || !(p.objects ?? []).some(o => o.type === 'field')) continue;
      const updates = [];
      (p.objects ?? []).forEach((o, k) => {
        if (o.type !== 'field' || o.locked) return;
        const instr = o.instr ?? '';
        if (instr.trimStart().startsWith('=')) {
          const cell = T.cellOfPos({story, path, off: 0});
          if (cell) {
            const [tp, r, c] = cell;
            const t = d.table(story, tp);
            if (t) {
              let text;
              try { text = evaluateFieldWith(t, {paraLang: q => T.paraLang(d, q)}, T.defaultLang(S), r, c, instr); } catch (e) { text = `!${e.message ?? e}`; }
              updates.push([k, text]);
            }
          }
          return;
        }
        const name = fieldName(instr);
        switch (name) {
          case 'DATE': case 'TIME': case 'CREATEDATE': case 'SAVEDATE': case 'PRINTDATE': {
            const pic = datePicture(instr) ?? (name === 'TIME' ? 'h:mm am/pm' : 'M/d/yyyy');
            updates.push([k, textResult(instr, formatDate(pic, nowMs()))]);
            break;
          }
          case 'REF': case 'PAGEREF': {
            const f = parseField(instr);
            const target = (f.args[0] ?? '').split('\\')[0].replace(/^"|"$/g, '');
            let r = null;
            if (name === 'REF') { if (!hasSwitch(instr, 'p')) r = bookmarkText(d, target); }
            else if (!hasSwitch(instr, 'p') && pages.has(target)) {
              const [num, pf] = pages.get(target);
              r = fieldNumber(instr, formatSwitch(instr) ?? pf, num);
            }
            if (r !== null) updates.push([k, name === 'REF' ? textResult(instr, r) : r]);
            break;
          }
          case 'TITLE': case 'SUBJECT': case 'AUTHOR': case 'KEYWORDS': case 'COMMENTS': {
            const v = newPropertyValue(instr);
            if (v !== null) core[SUMMARY[name]] = v;
            updates.push([k, textResult(instr, summaryProperty(core, name))]);
            break;
          }
          case 'LASTSAVEDBY': updates.push([k, textResult(instr, core.lastModifiedBy ?? '')]); break;
          case 'NUMWORDS': updates.push([k, countText(instr, d.wordCount())]); break;
          case 'NUMCHARS': updates.push([k, countText(instr, [...d.plainText(BODY)].filter(c => !/\s/u.test(c)).length)]); break;
          case 'REVNUM': updates.push([k, countText(instr, core.revision ?? 0)]); break;
          case 'DOCPROPERTY': {
            const nm = docPropertyArg(instr);
            const v = nm ? docProperty(d, core, nm) : null;
            if (v !== null) updates.push([k, textResult(instr, v)]);
            break;
          }
          case 'FILENAME': updates.push([k, textResult(instr, hasSwitch(instr, 'p') ? filePath : fileName)]); break;
          default:
        }
      });
      if (!updates.length) continue;
      const q = d.paraMut(story, path);
      q.objects = q.objects.map((o, k) => { const u = updates.find(([j]) => j === k); return u ? {...o, result: u[1], dirty: false} : o; });
    }
  }
  if (Object.keys(core).some(k => core[k] !== d.c.core[k])) d.setField('core', core);
  if (!inBody) return;
  afterBody?.();
  updateToc(S);
}

export {cmpPos};
