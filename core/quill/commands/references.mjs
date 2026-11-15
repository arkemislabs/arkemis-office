// References tab (U:quill/references): Table of Contents (gallery, Custom, Remove, Add Text, Update
// Table), Footnotes (Insert Footnote/Endnote, Next Footnote, Show Notes, Footnote and Endnote
// options, Convert), Citations & Bibliography (Insert Citation, placeholders, Manage Sources,
// Style, Bibliography), Captions (Insert Caption, Table of Figures, Update Table, Cross-reference),
// Index (Mark Entry, Insert Index, Update Index), Table of Authorities (Mark Citation, Insert,
// Update) and Update Field (F9).
//
// Translated from wordcraft crates/engine/src/cmd/references.rs (`specs`), crates/engine/src/cmd/
// citations.rs (`specs`) and crates/engine/src/cmd/index.rs (`specs`) at
// aadb077e072b7de05f724e359d8db82e151f125c; the engine is in core/quill/lib/references-toc.mjs,
// references-lists.mjs and references-cite.mjs. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Not here (their controls stay hidden): Researcher and Search (upstream's Researcher only says
// it needs an online service), Save Selection to the Table of Contents / Bibliography galleries and
// More Tables of Contents from Office.com (no building-block galleries of that kind upstream).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import * as P from '../model/para.mjs';
import {BODY} from '../model/document.mjs';
import * as T from '../lib/table-session.mjs';
import {UPSTREAM_COMMIT} from '../lib/caret-session.mjs';
import {formatDate} from './insert.mjs';
import {STYLES, findStyle, style as citeStyle} from '../lib/references-cite.mjs';
import {readSources} from '../formats/_docx-bibliography.mjs';
import {
  insertToc, manualToc, updateToc, updateTocPages, tocRange, removeToc, caretInToc, insertNote, noteRefs, noteOptions, insertCaption,
  updateFieldsIn, cleanLabel, cachedTocTabs, rangeTocToField,
} from '../lib/references-toc.mjs';
import {
  manageSources, insertCitation, updateCitations, bibStyleOf, generatedList, updateGenerated, figuresInstr, markCitation, crossReference,
  refTargets, captionLabels, markEntry, insertIndex, indexField, SOURCE_KEYS,
} from '../lib/references-lists.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/references.rs', 'crates/engine/src/cmd/references/toc.rs',
  'crates/engine/src/cmd/references/notes.rs', 'crates/engine/src/cmd/references/fields.rs', 'crates/engine/src/cmd/citations.rs',
  'crates/engine/src/cmd/citations/sources.rs', 'crates/engine/src/cmd/citations/generated.rs', 'crates/engine/src/cmd/citations/cross_refs.rs',
  'crates/engine/src/cmd/index.rs']};

const ready = T.ready;
const run = f => (ctx, p) => f(T.open(ctx), p ?? {});
const done = f => (ctx, p) => { const S = T.open(ctx); const r = f(S, p ?? {}); const out = T.finish(S); return r === undefined ? out : r; };
const NONE = s.object({});
const LEADER = s.enum(['none', 'dot', 'hyphen', 'underscore', 'middleDot']);
const SOURCE = s.object(Object.fromEntries(SOURCE_KEYS.map(k => [k, s.optional(s.string({max: 4096}))])));
const STYLE_NAMES = STYLES.map(x => x.name);
const nowMs = ctx => () => ctx.host?.now?.() ?? Date.now();
const hasNotes = ctx => Object.values(ctx.doc?.parts ?? {}).some(p => p.kind === 'footnote' || p.kind === 'endnote');
const notesState = ctx => { const r = ready(ctx); return !r.enabled ? r : hasNotes(ctx) ? r : {enabled: false, reason: 'There are no footnotes or endnotes in this document'}; };
const withDoc = (ctx, f) => { const r = ready(ctx); if (!r.enabled) return r; return f(ctx.model.open(ctx)); };
const tocState = ctx => withDoc(ctx, d => (tocRange(d) || d.fieldRanges(BODY).some(x => /^\s*TOC\b/i.test(x.instr)) ? {enabled: true} : {enabled: false, reason: 'There is no table of contents'}));

// ---- table of contents -----------------------------------------------------------------------------

function toc(S, p) {
  if (p.manual) { manualToc(S, typeof p.title === 'string' ? p.title : 'Contents'); return; }
  const v = {...p};
  delete v.manual;
  insertToc(S, v);
}

function updateTable(S, p) {
  if (p.pagesOnly) return {updated: updateTocPages(S)};
  updateToc(S);
  return undefined;
}

function removeTable(S) {
  const r = tocRange(S.d);
  if (r) {
    removeToc(S.d, r[0], r[1]);
    S.sel = {anchor: S.d.clamp(S.sel.anchor), focus: S.d.clamp(S.sel.focus)};
  }
}

function addText(S, p) {
  const level = Math.max(0, Math.min(9, Math.round(p.level ?? 0)));
  for (const path of T.selectedPaths(S)) {
    const q = S.d.paraMut(S.sel.focus.story, path);
    q.props = {...(q.props ?? {}), outlineLevel: level === 0 ? 9 : level - 1};
  }
}

/** The Add Text item that is checked: the caret paragraph's TOC level (0 = Do Not Show). */
function addTextState(ctx, p) {
  return withDoc(ctx, d => {
    const all = ctx.model.selection(ctx);
    const f = (all[ctx.selection?.primary ?? 0] ?? all[0]).focus;
    const para = d.paraAt(f);
    if (!para) return {enabled: true};
    const ol = para.props?.outlineLevel;
    let level;
    if (typeof ol === 'number') level = ol >= 9 ? 0 : ol + 1;
    else { const m = /^Heading(\d)$/.exec(para.props?.style ?? ''); level = m ? Number(m[1]) : 0; }
    return p?.level === undefined ? {enabled: true, value: level} : {enabled: true, checked: level === p.level};
  });
}

// ---- footnotes ---------------------------------------------------------------------------------------

/** Next/Previous Footnote/Endnote: the caret to the next reference after it (wrapping). */
function nextNote(S, p) {
  const refs = noteRefs(S.d, p.endnote ? 'endnote' : 'footnote');
  const c = S.sel.focus.story === BODY ? S.sel.focus : null;
  let t;
  if (p.previous) t = (c ? [...refs].reverse().find(r => cmp(r, c) < 0) : null) ?? refs.at(-1);
  else t = (c ? refs.find(r => cmp(r, c) > 0) : null) ?? refs[0];
  if (t) T.setCaret(S, {story: BODY, path: t.path, off: t.off});
}
const cmp = (a, b) => { for (let i = 0; i < Math.min(a.path.length, b.path.length); i++) if (a.path[i] !== b.path[i]) return a.path[i] - b.path[i]; return a.path.length - b.path.length || a.off - b.off; };

/** Show Notes (Word): in a note, back to its reference; in the text, to the note of the next reference. */
function showNotes(S) {
  const d = S.d;
  const list = Object.entries(d.c.parts).filter(([, x]) => x.kind === 'footnote' || x.kind === 'endnote')
    .map(([id, x]) => ({id: Number(id), kind: x.kind, text: d.plainText(Number(id)).split(P.OBJ).join('').trim()}));
  const f = S.sel.focus;
  const refs = noteRefs(d);
  if (f.story !== BODY) {
    const r = refs.find(x => x.id === f.story);
    if (r) T.setCaret(S, {story: BODY, path: r.path, off: r.off + 1});
  } else {
    const r = refs.find(x => cmp(x, f) >= 0) ?? refs[0];
    if (r) T.setCaret(S, d.endOf(r.id));
  }
  return list;
}

// ---- update fields ---------------------------------------------------------------------------------

function updateFields(S, p) {
  updateFieldsIn(S, !!p.all, {formatDate, nowMs: nowMs(S.ctx), afterBody: () => updateCitations(S)});
  // Selected fields that showed their code show their result again (fields.rs show_results).
  const [a, b] = T.ordered(S.sel);
  for (const path of S.d.pathsBetween(a, b)) {
    const q = S.d.para(a.story, path);
    if (!q?.objects?.some(o => o.type === 'field' && o.code)) continue;
    const m = S.d.paraMut(a.story, path);
    m.objects = m.objects.map(o => (o.type === 'field' && o.code ? {...o, code: false} : o));
  }
}

// ---- citations ---------------------------------------------------------------------------------------

function sources(S, p) {
  let imported = null;
  if (typeof p.importData === 'string') {
    try { imported = readSources(p.importData); } catch (e) { throw T.failed(`That file isn't a Word bibliography (${e.message ?? e})`); }
  }
  return manageSources(S, p, imported);
}

function citationStyle(S, p) {
  const st = findStyle(p.style ?? 'APA');
  if (!st) throw T.params(`style must be one of ${JSON.stringify(STYLE_NAMES)}`);
  S.d.updateField('settings', x => ({...x, bibStyle: st.name}));
  updateCitations(S);
  return {style: st.name};
}

/** The Insert Citation menu's list: the document's sources (Word: Author, Title, Year). */
function citationList(ctx) {
  return withDoc(ctx, d => ({enabled: true, value: (d.c.sources ?? []).map(x => ({id: x.tag, label: [x.author, x.title, x.year].filter(Boolean).join(' — ') || x.tag, value: x.tag}))}));
}

// ---- captions --------------------------------------------------------------------------------------

function caption(S, p) {
  const [a, b] = T.ordered(S.sel);
  let objectAt = null;
  if (a.story === b.story && a.path.join() === b.path.join() && b.off === a.off + 1) {
    const o = P.objectAt(S.d.paraAt(a), a.off);
    if (o && P.isDrawing(o)) objectAt = a;
  }
  insertCaption(S, p, objectAt);
}

function captionLabelsCmd(ctx, p) {
  const st = ready(ctx);
  if (!st.enabled) throw T.disabled(st.reason);
  const own = Array.isArray(ctx.prefs?.captionLabels) ? ctx.prefs.captionLabels.filter(x => typeof x === 'string') : [];
  let next = own;
  if (typeof p.add === 'string') {
    const l = cleanLabel(p.add);
    if (!l) throw T.params('a label needs a name');
    if (!['Equation', 'Figure', 'Table'].includes(l) && !own.includes(l)) next = [...own, l];
  }
  if (typeof p.remove === 'string') next = next.filter(x => x !== p.remove);
  if (next !== own) ctx.updatePrefs({captionLabels: next});
  const doc = captionLabels(ctx.model.open(ctx));
  const all = ['Equation', 'Figure', 'Table'];
  for (const l of [...next, ...doc]) if (!all.includes(l)) all.push(l);
  return {labels: all, custom: next};
}

// ---- lists -----------------------------------------------------------------------------------------

const hasField = name => ctx => withDoc(ctx, d => {
  for (let i = 0; i < d.story(BODY).len(); i++) {
    const p = d.para(BODY, [i]);
    if (p?.objects?.some(o => o.type === 'field' && name(String(o.instr).trimStart()))) return {enabled: true};
  }
  return {enabled: false, reason: 'There is nothing to update'};
});
const isFigures = t => /^TOC\b/.test(t) && /\\[ca]\b/.test(t);

export default defineCommands({
  family: 'references',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    // --- Table of Contents ---
    {id: 'references.toc', label: 'Table of Contents', risk: 'edit', state: ready, dialog: 'dialog.toc',
      description: 'Table of Contents: a TOC built from the headings (levels, title, pageNumbers, rightAlign, tabLeader, hyperlinks, headingStyles, outlineLevels, tcFields, styleLevels) replacing one that is there; {} updates it; `manual` inserts Word\'s Manual Table.',
      params: s.object({levels: s.optional(s.integer({min: 1, max: 9})), title: s.optional(s.string({max: 255})), pageNumbers: s.optional(s.boolean()),
        rightAlign: s.optional(s.boolean()), tabLeader: s.optional(LEADER), hyperlinks: s.optional(s.boolean()), headingStyles: s.optional(s.boolean()),
        outlineLevels: s.optional(s.boolean()), tcFields: s.optional(s.boolean()), styleLevels: s.optional(s.record(s.integer({min: 1, max: 9}))),
        manual: s.optional(s.boolean())}),
      run: done(toc)},
    {id: 'references.updateToc', label: 'Update Table', risk: 'edit', state: tocState, dialog: 'dialog.updateToc',
      description: 'Update Table: rebuild the table of contents from the headings with their pages; `pagesOnly` keeps the entries\' text and updates only the page numbers.',
      params: s.object({pagesOnly: s.optional(s.boolean())}), run: done(updateTable)},
    {id: 'references.removeToc', label: 'Remove Table of Contents', risk: 'edit', state: tocState,
      description: 'Remove Table of Contents: the TOC, its heading and entries go.', params: NONE, run: done(removeTable)},
    {id: 'references.addText', label: 'Add Text', risk: 'edit', state: addTextState,
      description: 'Add Text: the selected paragraphs show in the table of contents at `level` 1–9, or 0 = Do Not Show in Table of Contents.',
      params: s.object({level: s.integer({min: 0, max: 9})}), run: done(addText)},
    // --- Footnotes ---
    {id: 'references.footnote', label: 'Insert Footnote', risk: 'edit', state: ready, shortcut: 'Mod+Alt+F',
      description: 'Insert Footnote: a numbered reference at the selection and its note at the page bottom; the caret moves into the note (`text` fills it, `mark` is a custom mark).',
      params: s.object({text: s.optional(s.string({max: 100_000})), mark: s.optional(s.string({max: 64}))}),
      run: (ctx, p) => { const S = T.open(ctx); const r = insertNote(S, p ?? {}, 'footnote'); T.finish(S); return r; }},
    {id: 'references.endnote', label: 'Insert Endnote', risk: 'edit', state: ready, shortcut: 'Mod+Alt+D',
      description: 'Insert Endnote: a reference at the selection and its note at the end of the document; the caret moves into the note.',
      params: s.object({text: s.optional(s.string({max: 100_000})), mark: s.optional(s.string({max: 64}))}),
      run: (ctx, p) => { const S = T.open(ctx); const r = insertNote(S, p ?? {}, 'endnote'); T.finish(S); return r; }},
    {id: 'references.convertNotes', label: 'Convert Notes', risk: 'edit', state: notesState,
      description: 'Convert: footnotes to endnotes (`to` endnote), endnotes to footnotes (footnote) or swap them.',
      params: s.object({to: s.enum(['endnote', 'footnote', 'swap', 'endnotes', 'footnotes'])}),
      run: done((S, p) => {
        const [foot, end] = p.to.startsWith('endnote') ? [true, false] : p.to.startsWith('footnote') ? [false, true] : [true, true];
        return {converted: S.d.convertNotes(foot, end)};
      })},
    {id: 'references.nextFootnote', label: 'Next Footnote', risk: 'read', effect: 'view', state: notesState,
      description: 'Next Footnote: the caret to the next footnote reference (wrapping); `previous` goes back, `endnote` moves among endnotes.',
      params: s.object({previous: s.optional(s.boolean()), endnote: s.optional(s.boolean())}), run: done(nextNote)},
    {id: 'references.notes', label: 'Show Notes', risk: 'read', effect: 'view', state: notesState,
      description: 'Show Notes: from the text, the caret goes to the note of the next reference; from a note, back to its reference. Returns the notes [{id, kind, text}].',
      params: NONE, run: (ctx) => { const S = T.open(ctx); const list = showNotes(S); T.finish(S); return list; }},
    {id: 'references.noteOptions', label: 'Footnote and Endnote', risk: 'edit', state: ready, dialog: 'dialog.noteOptions',
      description: 'Footnote and Endnote: placement, number format, start and numbering of footnotes (`kind` footnote) or endnotes for the whole document or this section; no settings returns the options in effect.',
      params: s.object({kind: s.optional(s.enum(['footnote', 'endnote'])), pos: s.optional(s.enum(['pageBottom', 'beneathText', 'sectEnd', 'docEnd'])),
        numFmt: s.optional(s.string({max: 32})), numStart: s.optional(s.integer({min: 1, max: 32_767})), numRestart: s.optional(s.enum(['continuous', 'eachSect', 'eachPage'])),
        scope: s.optional(s.enum(['document', 'section'])), footnoteFormat: s.optional(s.string({max: 32})), endnoteFormat: s.optional(s.string({max: 32}))}),
      run: done(noteOptions)},
    // --- Citations & Bibliography ---
    {id: 'references.citation', label: 'Insert Citation', risk: 'edit', state: citationList, dialog: 'dialog.source',
      description: 'Insert Citation: a CITATION field for source `tag` (or a new `source`, added first; or a new `placeholder` name), with optional `pages`.',
      params: s.object({tag: s.optional(s.string({max: 255})), source: s.optional(SOURCE), placeholder: s.optional(s.string({max: 255})), pages: s.optional(s.string({max: 255}))}),
      run: (ctx, p) => { const S = T.open(ctx); const r = insertCitation(S, p ?? {}); T.finish(S); return r; }},
    {id: 'references.sources', label: 'Manage Sources', risk: 'edit', state: ready, dialog: 'dialog.sourceManager',
      description: 'Manage Sources: `add` a source (or edit one, by its tag), `remove` a tag, `importData` (the XML of a Word bibliography file); returns the sources.',
      params: s.object({add: s.optional(SOURCE), remove: s.optional(s.string({max: 255})), importData: s.optional(s.string({max: 32 << 20}))}),
      run: (ctx, p) => { const S = T.open(ctx); const r = sources(S, p ?? {}); T.finish(S); return r; }},
    {id: 'references.citationStyle', label: 'Style', risk: 'edit',
      state: (ctx, p) => withDoc(ctx, d => { const cur = bibStyleOf(d); return p?.style ? {enabled: true, checked: citeStyle(p.style).name === cur} : {enabled: true, value: cur}; }),
      description: `Style: the citation and bibliography style (${STYLE_NAMES.join(', ')}); citations and bibliographies follow.`,
      params: s.object({style: s.string({max: 64})}),
      run: (ctx, p) => { const S = T.open(ctx); const r = citationStyle(S, p); T.finish(S); return r; }},
    {id: 'references.bibliography', label: 'Bibliography', risk: 'edit', state: ready,
      description: 'Bibliography: the sources cited (all of them while nothing is cited) in the style, under `title` (default the style\'s; "" for none).',
      params: s.object({title: s.optional(s.string({max: 255}))}),
      run: done((S, p) => { generatedList(S, 'BIBLIOGRAPHY', typeof p.title === 'string' ? p.title : citeStyle(bibStyleOf(S.d)).bibTitle); })},
    // --- Captions ---
    {id: 'references.caption', label: 'Insert Caption', risk: 'edit', state: ready, dialog: 'dialog.caption',
      description: 'Insert Caption: "Figure 1: text" below (or above) the selected picture or the caret\'s paragraph or table, numbered by a SEQ field (label, text, position, excludeLabel, format, chapter, separator).',
      params: s.object({label: s.optional(s.string({max: 64})), text: s.optional(s.string({max: 4096})), position: s.optional(s.enum(['below', 'above'])),
        excludeLabel: s.optional(s.boolean()), format: s.optional(s.enum(['ARABIC', 'alphabetic', 'ALPHABETIC', 'roman', 'ROMAN', 'lowerLetter', 'upperLetter', 'lowerRoman', 'upperRoman'])),
        chapter: s.optional(s.integer({min: 1, max: 9})), separator: s.optional(s.string({max: 2}))}),
      run: done(caption)},
    {id: 'references.captionLabels', label: 'Caption Labels', risk: 'read', effect: 'view', state: ready,
      description: 'Caption labels: Equation, Figure, Table, the person\'s own (`add` New Label, `remove` Delete Label) and the ones the document uses.',
      params: s.object({add: s.optional(s.string({max: 64})), remove: s.optional(s.string({max: 64}))}), run: captionLabelsCmd},
    {id: 'references.tableOfFigures', label: 'Insert Table of Figures', risk: 'edit', state: ready, dialog: 'dialog.tableOfFigures',
      description: 'Insert Table of Figures: the captions of one label with their pages (label, includeLabel, pageNumbers, rightAlign, tabLeader).',
      params: s.object({label: s.optional(s.string({max: 64})), includeLabel: s.optional(s.boolean()), pageNumbers: s.optional(s.boolean()), rightAlign: s.optional(s.boolean()),
        tabLeader: s.optional(LEADER), hyperlinks: s.optional(s.boolean())}),
      run: done((S, p) => { generatedList(S, figuresInstr(p), '', typeof p.tabLeader === 'string' ? p.tabLeader : null); })},
    {id: 'references.updateFigures', label: 'Update Table', risk: 'edit', state: hasField(isFigures),
      description: 'Update Table: rebuild the tables of figures (and the other generated lists).', params: NONE, run: done(S => { updateGenerated(S); })},
    {id: 'insert.crossReference', label: 'Cross-reference', risk: 'edit', state: ready, dialog: 'dialog.crossReference',
      description: 'Cross-reference: a REF or PAGEREF field to a heading, bookmark, figure, table, equation or `label:<Name>` caption (`target` its text), showing its text, page, number or above/below; without `target` lists the targets.',
      params: s.object({to: s.optional(s.string({max: 80})), target: s.optional(s.string({max: 4096})), show: s.optional(s.enum(['text', 'page', 'number', 'aboveBelow'])),
        hyperlink: s.optional(s.boolean())}),
      run: (ctx, p) => {
        const S = T.open(ctx);
        const r = crossReference(S, p ?? {});
        if (typeof p?.target !== 'string') return r;
        T.finish(S);
        return r;
      }},
    // --- Index ---
    {id: 'references.markEntry', label: 'Mark Entry', risk: 'edit', state: ready, dialog: 'dialog.markEntry', shortcut: 'Alt+Shift+X',
      description: 'Mark Entry: a hidden XE field for the selection or `entry` (subentry, crossReference "See …", bookmark page range, bold, italic); `all` marks every paragraph\'s first whole-word match.',
      params: s.object({entry: s.optional(s.string({max: 4096})), subentry: s.optional(s.string({max: 4096})), crossReference: s.optional(s.string({max: 4096})),
        bookmark: s.optional(s.string({max: 64})), bold: s.optional(s.boolean()), italic: s.optional(s.boolean()), all: s.optional(s.boolean()), text: s.optional(s.string({max: 4096}))}),
      run: (ctx, p) => { const S = T.open(ctx); const r = markEntry(S, p ?? {}); T.finish(S); return r; }},
    {id: 'references.index', label: 'Insert Index', risk: 'edit', state: ready, dialog: 'dialog.index',
      description: 'Insert Index: the marked entries with their pages, sorted, with letter headings (type indented|runIn, columns 1–4, rightAlign, tabLeader, headings); new settings for an index that is there.',
      params: s.object({type: s.optional(s.enum(['indented', 'runIn'])), columns: s.optional(s.integer({min: 1, max: 4})), rightAlign: s.optional(s.boolean()),
        tabLeader: s.optional(LEADER), headings: s.optional(s.boolean())}),
      run: done(insertIndex)},
    {id: 'references.updateIndex', label: 'Update Index', risk: 'edit', state: ctx => withDoc(ctx, d => (indexField(d) ? {enabled: true} : {enabled: false, reason: 'There is no index'})),
      description: 'Update Index: rebuild the index from the marked entries.', params: NONE, run: done(S => { updateGenerated(S); })},
    // --- Table of Authorities ---
    {id: 'references.markCitation', label: 'Mark Citation', risk: 'edit', state: ready, shortcut: 'Alt+Shift+I',
      description: 'Mark Citation: a hidden TA field for the selected citation (or `entry`).',
      params: s.object({entry: s.optional(s.string({max: 4096}))}),
      run: (ctx, p) => { const S = T.open(ctx); const r = markCitation(S, p ?? {}); T.finish(S); return r; }},
    {id: 'references.tableOfAuthorities', label: 'Insert Table of Authorities', risk: 'edit', state: ready,
      description: 'Insert Table of Authorities: the marked citations with their pages.',
      params: NONE, run: done(S => { generatedList(S, 'TOA', 'Table of Authorities'); })},
    {id: 'references.updateAuthorities', label: 'Update Table', risk: 'edit', state: hasField(t => t.startsWith('TOA')),
      description: 'Update Table: rebuild the table of authorities (and the other generated lists).', params: NONE, run: done(S => { updateGenerated(S); })},
    // --- fields ---
    {id: 'references.updateFields', label: 'Update Field', risk: 'edit', state: ready, shortcut: 'F9',
      description: 'Update Field (F9): dates, REF/PAGEREF, document properties, formulas, SEQ numbers, citations, lists and the table of contents in the caret\'s story; `all` updates every story.',
      params: s.object({all: s.optional(s.boolean())}), run: done(updateFields)},
    {id: 'references.inToc', label: 'In Table of Contents', risk: 'read', state: ready,
      description: 'Whether the caret is in the table of contents (where the context menu updates the whole table).',
      params: NONE, run: ctx => { const S = T.open(ctx); return {inToc: caretInToc(S.d, S.sel.focus)}; }},
  ],
});

export {cachedTocTabs, rangeTocToField, refTargets};
