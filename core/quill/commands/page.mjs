// Layout › Page Setup (U:quill/page): margins, orientation, size, columns, breaks, line numbers,
// vertical alignment, section direction, document grid, the header/footer page options, and Page
// Setup's whole-section command, over the schema-2 model.
//
// Translated from wordcraft crates/engine/src/cmd/page.rs (`specs`, `line_numbers`,
// `section_of_part`, `section_index_of_focus`, `sect`, `selected_section_ends`, `with_sect`,
// `grid_font_size`, `grid_result`, `document_grid`, `MARGIN_PRESETS`, `margins_preset_at`,
// `columns_preset_at`, `validate_section`, `margins`, `MARGINS_DONT_FIT`, `MIN_TEXT_ROOM`,
// `margins_fit`, `MIN_PAGE_SIDE`, `MAX_PAGE_SIDE`, `size`, `columns`, `selection_sectionable`,
// `selection_to_sections`, `column_widths`, `breaks`, `shifted_by_split`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Every command edits the section(s) of the selection (`with_sect`), or the document settings, as
// one undoable op. A section break splits the paragraph at the selection's start: the first half
// ends a section with the current setup (a new section id), the rest keeps the section (and its
// id) and starts as asked. The page view reflows from the model (core/quill/layout honours
// sections, page sizes, columns with separators and balancing, page/column breaks, odd/even page
// starts, vertical alignment, mirror margins, line numbers and the document grid).
//
// Not registered here (hidden, docs/behaviour-fidelity.md): layout.hyphenation and
// layout.manualHyphenation (the layout has no automatic hyphenation: wordcraft_proof's patterns are
// not translated, see core/quill/layout/README.md), layout.textDirection (vertical sections are not
// laid out: layout vertical.rs), layout.pageNumberFormat (its Page Number Format dialog belongs with
// Insert › Page Number).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {open, finish, ready, ordered, isCollapsed, caret, cmpPos, UPSTREAM_COMMIT} from '../lib/caret-session.mjs';
import {sectionOf, setLandscape, textWidth, textHeight, gridLinePitchOf, gridCharPitchOf, charSpaceFor, gridLinesPerPage, gridCharsPerLine,
  defaultDocGrid, parsePageVAlign, MIN_GRID_PITCH, MAX_GRID_PITCH, MAX_CHAR_SPACE, MAX_NOTE_START} from '../model/section.mjs';
import {resolveChar} from '../model/styles.mjs';
import {borderVisible} from '../model/props.mjs';
import {PAPER_SIZES, paperByName} from '../lib/geom.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/page.rs']};

const params = (msg, data) => new CommandError('invalid_params', msg, data);
const failed = msg => new CommandError('failed', msg);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** The largest f32: a JSON number beyond it is infinite to upstream (`p::f32` drops it). */
const F32_MAX = 3.4028234663852886e38;
/** upstream `p::f32`: a finite number within f32 range, else absent. */
const f32 = v => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= F32_MAX ? v : null);
/** upstream `p::u64`: a non-negative finite number, truncated, else absent. */
const u64 = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null);
const isNum = v => f32(v) !== null;

// ---------------------------------------------------------------------------------------------
// Constants (page.rs)

/** Layout › Margins presets: id and [top, bottom, left, right] in points. */
export const MARGIN_PRESETS = Object.freeze([
  ['normal', [72, 72, 72, 72]],
  ['narrow', [36, 36, 36, 36]],
  ['moderate', [72, 72, 54, 54]],
  ['wide', [72, 72, 144, 144]],
  ['mirrored', [72, 72, 90, 72]],
  ['office2003', [72, 72, 90, 90]],
].map(Object.freeze));
export const MARGIN_PRESET_IDS = Object.freeze(MARGIN_PRESETS.map(([id]) => id));

/** Why `layout.size` refuses a page its margins don't fit. */
export const MARGINS_DONT_FIT = "The margins don't fit on a page this size; make the margins smaller first.";
/** Text room the margins must leave on a page, each way, points. */
export const MIN_TEXT_ROOM = 36;
/** The smallest and largest page side, points (0.1" and 22", as Word allows). */
export const MIN_PAGE_SIDE = 7.2;
export const MAX_PAGE_SIDE = 1584;
export const BREAK_KINDS = Object.freeze(['page', 'column', 'textWrapping', 'nextPage', 'continuous', 'evenPage', 'oddPage']);
export const LINE_NUMBER_VALUES = Object.freeze(['none', 'continuous', 'restartPage', 'restartSection']);
export const COLUMN_APPLY = Object.freeze(['section', 'document', 'forward', 'selection']);
export const GRID_TYPES = Object.freeze(['none', 'default', 'lines', 'linesAndChars', 'snapToChars']);
export {PAPER_SIZES};

/**
 * Whether margins (top, bottom, left, right) and a gutter leave text room on a page (width,
 * height), all in points: the rule `layout.margins` and `layout.size` both apply, and Page Setup
 * checks before it runs either (margins_fit).
 */
export function marginsFit([pw, ph], [t, b, l, r], gutter) {
  return l + r + gutter <= pw - MIN_TEXT_ROOM && t + b <= ph - MIN_TEXT_ROOM;
}

// ---------------------------------------------------------------------------------------------
// The caret's section

/** The section a header, footer or note story belongs to (section_of_part). */
function sectionOfPart(d, id) {
  const sections = d.sections();
  for (let i = 0; i < sections.length; i++) {
    const sp = sections[i][1];
    const hf = [sp.headers?.default, sp.headers?.first, sp.headers?.even, sp.footers?.default, sp.footers?.first, sp.footers?.even];
    if (hf.includes(id)) return i;
  }
  const bl = d.story('body');
  for (const [bi, b] of bl.entries()) {
    if (b.kind !== 'para') continue;
    for (const o of b.objects ?? []) if (o?.type === 'noteRef' && o.id === id) return d.sectionIndexOf(bi);
  }
  return 0;
}

/** The index (into sections()) of the section the position is in (section_index_of_focus). */
export function sectionIndexAt(d, pos) {
  if (pos.story === 'body') return d.sectionIndexOf(pos.path[0] ?? 0);
  return sectionOfPart(d, pos.story);
}

/** The section properties at the selection's focus, every field filled (sect). */
export function sectAt(d, sel) {
  const i = sectionIndexAt(d, sel.focus);
  return sectionOf(d.sections()[i]?.[1]);
}

/** The last block of each section of the selection (selected_section_ends). */
function selectedSectionEnds(d, sel) {
  const [a, b] = ordered(sel);
  const ends = d.sections().map(([e]) => e);
  if (a.story !== 'body' || b.story !== 'body') return [ends[sectionIndexAt(d, sel.focus)] ?? 0];
  const i0 = a.path[0] ?? 0, i1 = b.path[0] ?? 0;
  let first = ends.findIndex(e => i0 <= e);
  if (first < 0) first = 0;
  let last = ends.findIndex(e => i1 <= e);
  if (last < 0) last = first;
  const out = [];
  for (let k = first; k <= last; k++) out.push(ends[k] ?? 0);
  return out;
}

/** Apply `f(section)` (mutating a filled-out copy) to the section(s) of the selection (with_sect). */
export function withSect(S, f) {
  for (const end of selectedSectionEnds(S.d, S.sel)) {
    S.d.updateSection(end, cur => { const x = sectionOf(cur); f(x); return x; });
  }
  return sectAt(S.d, S.sel);
}

/** Run an edit of the selection's sections as one command: the result is the caret's section. */
export function sectEdit(ctx, f) {
  const S = open(ctx);
  const section = f(S);
  return finish(ctx, S, {edit: true, result: {section: section ?? sectAt(S.d, S.sel)}});
}

/** A read-only view of the document and selection for state() and queries. */
function look(ctx) {
  const d = ctx.model.open(ctx);
  const all = ctx.model.selection(ctx);
  const r = all[ctx.selection?.primary ?? 0] ?? all[0];
  return {d, sel: {anchor: d.clamp(r.anchor), focus: d.clamp(r.focus)}};
}

function lookSect(ctx) {
  const {d, sel} = look(ctx);
  return {d, sel, x: sectAt(d, sel)};
}

/** state() with a check mark from the caret's section. */
const checkState = test => ctx => {
  const st = ready(ctx);
  if (!st.enabled) return st;
  try { return {enabled: true, checked: !!test(lookSect(ctx))}; } catch { return {enabled: true, checked: false}; }
};

// ---------------------------------------------------------------------------------------------
// Margins

/** The Margins preset the caret's section is set to, if any (Mirrored only with mirror margins on). */
export function marginsPresetOf(x, mirror) {
  const m = [x.marginTop, x.marginBottom, x.marginLeft, x.marginRight];
  const hit = MARGIN_PRESETS.find(([id, p]) => (id === 'mirrored') === !!mirror && p.every((a, i) => Math.abs(a - m[i]) < 0.5));
  return hit ? hit[0] : null;
}

function margins(ctx, p) {
  return sectEdit(ctx, S => {
    const cur = sectAt(S.d, S.sel);
    let t, b, l, r;
    if (p.preset !== undefined) {
      const hit = MARGIN_PRESETS.find(([id]) => id === p.preset);
      if (!hit) throw params(`unknown preset \`${p.preset}\``, {path: '/preset'});
      [t, b, l, r] = hit[1];
    } else {
      t = f32(p.top) ?? cur.marginTop; b = f32(p.bottom) ?? cur.marginBottom; l = f32(p.left) ?? cur.marginLeft; r = f32(p.right) ?? cur.marginRight;
    }
    // Negative margins count as zero before the fit check, so one can't offset another.
    [t, b, l, r] = [t, b, l, r].map(v => Math.max(0, v));
    const gutter = f32(p.gutter) !== null ? Math.max(0, p.gutter) : null;
    if (!marginsFit([cur.pageW, cur.pageH], [t, b, l, r], gutter ?? cur.gutter)) throw params('margins leave no room for text');
    // A preset picks mirrored or not, as does `mirror`; plain numbers alone keep the setting.
    const mirror = p.mirror ?? (p.preset !== undefined ? p.preset === 'mirrored' : undefined);
    if (mirror !== undefined && !!S.d.settings.mirrorMargins !== mirror) S.d.updateField('settings', st => { st.mirrorMargins = mirror; });
    return withSect(S, x => {
      Object.assign(x, {marginTop: t, marginBottom: b, marginLeft: l, marginRight: r});
      if (gutter !== null) x.gutter = gutter;
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Size

function size(ctx, p) {
  let w, h;
  if (p.name !== undefined) {
    const hit = paperByName(p.name);
    if (!hit) throw params(`unknown paper \`${p.name}\``, {path: '/name'});
    [, w, h] = hit;
  } else {
    if (!isNum(p.width)) throw params('`width` is required', {path: '/width'});
    if (!isNum(p.height)) throw params('`height` is required', {path: '/height'});
    w = p.width; h = p.height;
  }
  // Word's range per side is 0.1"–22".
  w = clamp(w, MIN_PAGE_SIDE, MAX_PAGE_SIDE); h = clamp(h, MIN_PAGE_SIDE, MAX_PAGE_SIDE);
  // Each section keeps its orientation: the long side across in landscape, down in portrait.
  const oriented = x => (x.landscape ? [Math.max(w, h), Math.min(w, h)] : [Math.min(w, h), Math.max(w, h)]);
  return sectEdit(ctx, S => {
    const sections = S.d.sections();
    const fits = block => {
      const hit = sections.find(([e]) => e === block);
      if (!hit) return true;
      const x = sectionOf(hit[1]);
      return marginsFit(oriented(x), [x.marginTop, x.marginBottom, x.marginLeft, x.marginRight], x.gutter);
    };
    if (!selectedSectionEnds(S.d, S.sel).every(fits)) throw params(MARGINS_DONT_FIT);
    return withSect(S, x => { [x.pageW, x.pageH] = oriented(x); });
  });
}

/** The named paper size of a section's page (either orientation), or null for a custom size. */
export function paperOf(x) {
  const hit = PAPER_SIZES.find(([, pw, ph]) => (Math.abs(pw - x.pageW) < 0.5 && Math.abs(ph - x.pageH) < 0.5) || (Math.abs(pw - x.pageH) < 0.5 && Math.abs(ph - x.pageW) < 0.5));
  return hit ? hit[0] : null;
}

// ---------------------------------------------------------------------------------------------
// Columns

/** The Columns preset the caret's section matches: one, two, three, left or right (columns_preset_at). */
export function columnsPresetOf(x) {
  const c = x.columns ?? {count: 1, widths: []};
  const ws = c.widths ?? [];
  const first = ws[0]?.[0];
  const equal = ws.every(w => first !== undefined && Math.abs(w[0] - first) < 0.5);
  const n = c.count ?? 1;
  if (n === 1) return 'one';
  if (n === 2 && ws.length === 2 && ws[0][0] < ws[1][0] - 0.5) return 'left';
  if (n === 2 && ws.length === 2 && ws[0][0] > ws[1][0] + 0.5) return 'right';
  if (n === 2 && equal) return 'two';
  if (n === 3 && equal) return 'three';
  return null;
}

/** `[[width, space after], …]` in points: 1–12 columns, each at least 0.25", that fit the text width (column_widths). */
export function columnWidths(v, tw) {
  const bad = () => params('widths: [[width, space after], …] in points, 1–12 columns', {path: '/widths'});
  if (!Array.isArray(v) || v.length < 1 || v.length > 12) throw bad();
  const out = [];
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    const num = k => (Array.isArray(c) && isNum(c[k]) ? c[k] : null);
    const w = num(0);
    if (w === null) throw bad();
    // The last column has no space after it.
    const sp = i + 1 === v.length ? 0 : num(1) ?? 0;
    if (w < 18 || sp < 0 || sp > 300) throw params('each column must be at least 0.25" wide, with 0–300 pt after it', {path: '/widths'});
    out.push([w, sp]);
  }
  const total = out.reduce((a, [w, sp]) => a + w + sp, 0);
  if (total > tw + 1) throw params(`the columns (${Math.round(total)} pt) are wider than the text (${Math.round(tw)} pt)`, {path: '/widths'});
  return out;
}

/** Whether the selection can become sections of its own: text selected in the main text, outside tables. */
export function selectionSectionable(sel) {
  const [a, b] = ordered(sel);
  return !isCollapsed(sel) && [a, b].every(p => p.story === 'body' && p.path.length === 1);
}

/**
 * Where `p` lands after the top-level body paragraph at `at` was split there, the second half
 * starting at `nw` (shifted_by_split).
 */
function shiftedBySplit(p, at, nw) {
  if (p.story !== at.story) return p;
  if (p.path.length === at.path.length && p.path.every((v, i) => v === at.path[i])) {
    return p.off >= at.off ? {...nw, path: [...nw.path], off: Math.max(0, p.off - at.off)} : p;
  }
  const q = {...p, path: [...p.path]};
  if (q.path.length && at.path.length && q.path[0] > at.path[0]) q.path[0] += 1;
  return q;
}

/**
 * A section break of `start` just before the selection (breaks: nextPage/continuous/evenPage/
 * oddPage). The paragraph before ends a section with the current setup; the new section after it
 * takes the setup too and starts as asked. The selection keeps its text, which now starts the new
 * section (#852).
 */
function sectionBreak(S, start) {
  const old = S.sel;
  const [at, end] = ordered(old);
  if (at.story !== 'body' || at.path.length > 1) throw failed('section breaks go in the main text');
  S.sel = caret(at);
  const cur = sectAt(S.d, S.sel);
  const nw = S.d.splitParagraph(at);
  // The first half ends a section with the current props (a section of its own: a new id); the
  // section after the break keeps the old one's id and end mark, and starts as requested.
  const para = S.d.paraMut('body', at.path);
  para.section = {...structuredClone(cur), id: S.d.newId()};
  S.d.updateSection(nw.path[0], () => ({...structuredClone(cur), start}));
  const first = {...nw, off: 0};
  const last = shiftedBySplit(end, at, first);
  S.sel = cmpPos(old.anchor, old.focus) <= 0 ? {anchor: first, focus: last} : {anchor: last, focus: first};
}

/**
 * Columns for the selected text (#2024), as Word does it: a continuous section break where the
 * selection starts and one where it ends, unless that end already meets a section boundary
 * (selection_to_sections).
 */
function selectionToSections(S) {
  if (!selectionSectionable(S.sel)) throw params('selected text in the main text, outside tables, is needed');
  const old = S.sel;
  let [a, b] = ordered(old);
  const block = p => p.path[0] ?? 0;
  const len = p => S.d.paraAt(p)?.text.length ?? 0;
  const ends = S.d.sections().map(([e]) => e);
  const afterBreak = i => i > 0 && ends.includes(i - 1);
  // A selection that took a section break with it ends before that break.
  if (b.off === 0 && block(b) > block(a) && afterBreak(block(b))) {
    const prev = {story: 'body', path: [block(b) - 1], off: 0};
    b = {...prev, off: len(prev)};
  }
  const lastBlock = Math.max(0, S.d.story('body').len() - 1);
  const endBreak = !(b.off === len(b) && (ends.includes(block(b)) || block(b) === lastBlock));
  const startBreak = !(a.off === 0 && (block(a) === 0 || afterBreak(block(a))));
  // The end first: the start's position doesn't move.
  if (endBreak) { S.sel = caret(b); sectionBreak(S, 'continuous'); }
  let first = a, last = b;
  if (startBreak) {
    S.sel = caret(a);
    sectionBreak(S, 'continuous');
    first = S.sel.focus;
    last = shiftedBySplit(b, a, first);
  }
  S.sel = cmpPos(old.anchor, old.focus) <= 0 ? {anchor: first, focus: last} : {anchor: last, focus: first};
}

function columns(ctx, p) {
  return sectEdit(ctx, S => {
    const preset = p.preset;
    const space0 = clamp(f32(p.space) ?? 36, 0, 300);
    const sep = p.separator ?? false;
    const tw = textWidth(sectAt(S.d, S.sel));
    // Unequal columns: (width, space after) each, as the Columns dialog sends them.
    const custom = p.widths !== undefined && p.widths !== null ? columnWidths(p.widths, tw) : null;
    const count = custom ? custom.length : u64(p.count) ?? (preset === 'left' || preset === 'right' ? 2 : 1);
    if (count < 1 || count > 12) throw params('columns must be 1–12', {path: '/count'});
    let widths = [];
    if (custom && custom.length > 1) widths = custom;
    else if (!custom && preset === 'left') widths = [[(tw - space0) / 3, space0], [(tw - space0) * 2 / 3, 0]];
    else if (!custom && preset === 'right') widths = [[(tw - space0) * 2 / 3, space0], [(tw - space0) / 3, 0]];
    // Equal columns keep one spacing; unequal ones remember the first gap for a later switch back.
    const space = widths[0]?.[1] ?? space0;
    const cols = {count, space, separator: sep, widths};
    const setCols = x => { x.columns = structuredClone(cols); };
    // With text selected the gallery works on that text, as in Word (#2024).
    const apply = p.apply ?? (selectionSectionable(S.sel) ? 'selection' : 'section');
    switch (apply) {
      case 'section': return withSect(S, setCols);
      case 'document': {
        for (const [e] of S.d.sections()) S.d.updateSection(e, cur => { const x = sectionOf(cur); setCols(x); return x; });
        return sectAt(S.d, S.sel);
      }
      // From the caret on: a continuous section break first, then the new section's columns.
      case 'forward': {
        S.sel = caret(ordered(S.sel)[0]);
        sectionBreak(S, 'continuous');
        return withSect(S, setCols);
      }
      case 'selection': {
        selectionToSections(S);
        return withSect(S, setCols);
      }
      default: throw params(`unknown apply \`${apply}\` (section, document, forward or selection)`, {path: '/apply'});
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Breaks

function breaks(ctx, p) {
  const kind = p.kind ?? 'page';
  // Page, Column and Text Wrapping breaks are the characters Ctrl+Enter, Ctrl+Shift+Enter and
  // Shift+Enter type.
  if (kind === 'page') return ctx.run('text.pageBreak', {});
  if (kind === 'column') return ctx.run('text.columnBreak', {});
  if (kind === 'textWrapping') return ctx.run('text.lineBreak', {});
  const S = open(ctx);
  sectionBreak(S, kind);
  return finish(ctx, S, {edit: true});
}

// ---------------------------------------------------------------------------------------------
// Line numbers

/**
 * Line Numbers: on with a restart mode (`value`), or off (`none`). `start`, `countBy` and
 * `distance` change the numbering's options and turn it on (keeping its restart mode).
 */
function lineNumbers(ctx, p) {
  return sectEdit(ctx, S => {
    const mode = p.value;
    if (mode === 'none') return withSect(S, x => { x.lineNumbers = null; });
    const restart = mode === 'restartPage' ? 'page' : mode === 'restartSection' ? 'section' : mode === 'continuous' ? 'continuous' : null;
    const start = u64(p.start) !== null ? clamp(u64(p.start), 1, 32_767) : null;
    const countBy = u64(p.countBy) !== null ? clamp(u64(p.countBy), 1, 100) : null;
    const distance = f32(p.distance) !== null ? clamp(p.distance, 0, 1584) : null;
    const options = start !== null || countBy !== null || distance !== null;
    return withSect(S, x => {
      // Options alone keep the current numbering's other settings; a new mode alone starts over.
      const fresh = {countBy: 1, start: 1, distance: 0, restart: 'page'};
      const l = x.lineNumbers && options ? {...fresh, ...x.lineNumbers} : options ? {...fresh, restart: 'continuous'} : fresh;
      const r = restart ?? (options ? null : 'continuous');
      if (r) l.restart = r;
      if (start !== null) l.start = start;
      if (countBy !== null) l.countBy = countBy;
      if (distance !== null) l.distance = distance;
      x.lineNumbers = l;
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Page Setup: a whole section

const finite = v => f32(v) !== null;
const BORDER_KEYS = ['top', 'left', 'bottom', 'right', 'between', 'inside_v'];

/**
 * Checks a whole section handed to `layout.pageSetup` by the rules of Size, Margins, Columns, Line
 * Numbers, Footnotes and Page Borders: a non-finite number or margins that leave no room for text
 * is an error; the rest is clamped to the ranges those commands use (validate_section).
 */
export function validateSection(input) {
  const x = sectionOf(structuredClone(input));
  const bad = what => params(`section: ${what} must be a finite number`, {path: '/section'});
  for (const k of ['pageW', 'pageH', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'header', 'footer', 'gutter']) {
    if (!finite(x[k])) throw bad('sizes, margins, distances and column gaps');
  }
  if (!finite(x.columns.space ?? 36)) throw bad('sizes, margins, distances and column gaps');
  if (!Array.isArray(x.columns.widths)) x.columns.widths = [];
  if (x.columns.widths.some(w => !Array.isArray(w) || !finite(w[0]) || !finite(w[1] ?? 0))) throw bad('column widths');
  if (x.lineNumbers && !finite(x.lineNumbers.distance ?? 0)) throw bad('the line number distance');
  if (x.docGrid && !finite(x.docGrid.linePitch ?? 18)) throw bad('the grid pitch');
  if (x.pageBorders && BORDER_KEYS.some(k => x.pageBorders[k] && (!finite(x.pageBorders[k].width ?? 0) || !finite(x.pageBorders[k].space ?? 0)))) {
    throw bad('page border widths and distances');
  }
  x.pageW = clamp(x.pageW, MIN_PAGE_SIDE, MAX_PAGE_SIDE);
  x.pageH = clamp(x.pageH, MIN_PAGE_SIDE, MAX_PAGE_SIDE);
  // Like Size, the orientation follows the sides.
  if (x.pageW !== x.pageH) x.landscape = x.pageW > x.pageH;
  for (const k of ['marginTop', 'marginBottom', 'marginLeft', 'marginRight']) x[k] = Math.max(0, x[k]);
  x.header = clamp(x.header, 0, x.pageH);
  x.footer = clamp(x.footer, 0, x.pageH);
  x.gutter = clamp(x.gutter, 0, MAX_PAGE_SIDE);
  // A page narrower than the usual text room needs only margins that leave the whole of it.
  const room = side => Math.min(MIN_TEXT_ROOM, side);
  if (x.marginLeft + x.marginRight + x.gutter > x.pageW - room(x.pageW) || x.marginTop + x.marginBottom > x.pageH - room(x.pageH)) {
    throw params('margins leave no room for text', {path: '/section'});
  }
  x.columns = {...x.columns, space: clamp(x.columns.space ?? 36, 0, 300), widths: x.columns.widths.slice(0, 12).map(([w, sp]) => [clamp(w, 18, MAX_PAGE_SIDE), clamp(sp ?? 0, 0, 300)])};
  // As in Columns: custom widths set the count; a single width is no custom layout.
  if (x.columns.widths.length > 1) x.columns.count = x.columns.widths.length;
  else { x.columns.widths = []; x.columns.count = clamp(Number.isInteger(x.columns.count) ? x.columns.count : 1, 1, 12); }
  if (x.lineNumbers) {
    const l = {countBy: 1, start: 1, distance: 0, restart: 'page', ...x.lineNumbers};
    x.lineNumbers = {...l, start: clamp(Math.trunc(l.start), 1, 32_767), countBy: clamp(Math.trunc(l.countBy), 1, 100), distance: clamp(l.distance, 0, 1584)};
  }
  if (x.docGrid) {
    const g = {...defaultDocGrid(), ...x.docGrid};
    x.docGrid = {...g, linePitch: clamp(g.linePitch, MIN_GRID_PITCH, MAX_GRID_PITCH), charSpace: clamp(Math.trunc(g.charSpace ?? 0), -MAX_CHAR_SPACE, MAX_CHAR_SPACE)};
  }
  if (x.pageNumStart !== null && x.pageNumStart !== undefined) x.pageNumStart = Math.min(100_000, Math.max(0, Math.trunc(Number(x.pageNumStart) || 0)));
  for (const k of ['footnotePr', 'endnotePr']) {
    if (x[k] && x[k].numStart !== undefined && x[k].numStart !== null) x[k] = {...x[k], numStart: clamp(Math.trunc(x[k].numStart), 1, MAX_NOTE_START)};
  }
  // Page Borders: width 0.25–6 pt, distance from the text 0–31 pt.
  if (x.pageBorders) {
    const b = {...x.pageBorders};
    for (const k of BORDER_KEYS) if (b[k]) b[k] = {...b[k], width: clamp(b[k].width ?? 0.5, 0.25, 6), space: clamp(b[k].space ?? 0, 0, 31)};
    x.pageBorders = b;
  }
  x.valign = parsePageVAlign(x.valign);
  return x;
}

function pageSetup(ctx, p) {
  if (p.section === undefined || p.section === null) {
    const {x} = lookSect(ctx);
    return {section: x};
  }
  if (typeof p.section !== 'object' || Array.isArray(p.section)) throw params('`section` must be an object', {path: '/section'});
  const nw = validateSection(p.section);
  return sectEdit(ctx, S => withSect(S, x => {
    const id = x.id;
    for (const k of Object.keys(x)) delete x[k];
    Object.assign(x, structuredClone(nw), {id});
  }));
}

// ---------------------------------------------------------------------------------------------
// Document grid

/** The default font size (Normal style), which the character pitch is based on (grid_font_size). */
function gridFontSize(d) {
  const size = resolveChar(d.styles, 'Normal', {}).size;
  return Number.isFinite(size) ? clamp(size, 1, 1584) : 10.5;
}

function gridResult(x, fontSize) {
  const g = x.docGrid ?? defaultDocGrid();
  return {
    type: g.type === 'default' ? 'none' : g.type,
    linePitch: gridLinePitchOf(g),
    charSpace: g.charSpace ?? 0,
    charPitch: gridCharPitchOf(g, fontSize),
    linesPerPage: gridLinesPerPage(x),
    charsPerLine: gridCharsPerLine(x, fontSize),
  };
}

function documentGrid(ctx, p) {
  const kind = p.type === undefined ? null : p.type === 'none' || p.type === 'default' ? 'default' : p.type;
  const lines = u64(p.linesPerPage) !== null ? clamp(u64(p.linesPerPage), 1, 1000) : null;
  const chars = u64(p.charsPerLine) !== null ? clamp(u64(p.charsPerLine), 1, 1000) : null;
  const linePitch = f32(p.linePitch) !== null ? clamp(p.linePitch, MIN_GRID_PITCH, MAX_GRID_PITCH) : null;
  const charSpace = typeof p.charSpace === 'number' && Number.isFinite(p.charSpace) ? clamp(Math.trunc(p.charSpace), -MAX_CHAR_SPACE, MAX_CHAR_SPACE) : null;
  if (kind === null && lines === null && chars === null && linePitch === null && charSpace === null) {
    const {d, x} = lookSect(ctx);
    return gridResult(x, gridFontSize(d));
  }
  const S = open(ctx);
  const fontSize = gridFontSize(S.d);
  withSect(S, x => {
    const g = {...defaultDocGrid(), ...(x.docGrid ?? {})};
    if (kind !== null) g.type = kind;
    if (lines !== null) g.linePitch = clamp(textHeight(x) / lines, MIN_GRID_PITCH, MAX_GRID_PITCH);
    if (linePitch !== null) g.linePitch = linePitch;
    if (chars !== null) g.charSpace = charSpaceFor(textWidth(x) / chars, fontSize);
    if (charSpace !== null) g.charSpace = charSpace;
    x.docGrid = g;
  });
  return finish(ctx, S, {edit: true, result: gridResult(sectAt(S.d, S.sel), fontSize)});
}

// ---------------------------------------------------------------------------------------------
// The commands

const PT = (description, o = {}) => s.number({description, ...o});
const SECTION_RESULT = 'Returns the caret section\'s properties (`section`).';

export default defineCommands({
  family: 'page',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'layout.margins', label: 'Margins', risk: 'edit', dialog: 'dialog.pageSetup',
      description: `Margins (Layout › Page Setup): a preset (normal, narrow, moderate, wide, mirrored, office2003) or top/bottom/left/right/gutter in points for the section(s) of the selection; margins that leave no room for text are refused. ${SECTION_RESULT}`,
      params: s.object({
        preset: s.optional(s.enum(MARGIN_PRESET_IDS)),
        top: s.optional(PT('pt')), bottom: s.optional(PT('pt')), left: s.optional(PT('pt')), right: s.optional(PT('pt')),
        gutter: s.optional(PT('pt')), mirror: s.optional(s.boolean({description: 'Mirror margins (Page Setup › Multiple pages)'})),
      }),
      state(ctx, p) {
        const st = ready(ctx);
        if (!st.enabled || !p?.preset) return st;
        try {
          const {d, x} = lookSect(ctx);
          const mirror = !!d.settings.mirrorMargins;
          // Mirrored margins come from the document as well as from the preset (#1181).
          return {enabled: true, checked: marginsPresetOf(x, mirror) === p.preset || (p.preset === 'mirrored' && mirror)};
        } catch { return st; }
      },
      run: margins,
    },
    {
      id: 'layout.orientation', label: 'Orientation', risk: 'edit',
      description: `Orientation (Layout › Page Setup): portrait or landscape for the section(s) of the selection (the page turns and its margins with it); without a value it toggles. ${SECTION_RESULT}`,
      params: s.object({value: s.optional(s.enum(['portrait', 'landscape']))}),
      state: (ctx, p) => (p?.value ? checkState(({x}) => x.landscape === (p.value === 'landscape'))(ctx) : ready(ctx)),
      run(ctx, p) {
        return sectEdit(ctx, S => {
          const land = p.value === 'landscape' ? true : p.value === 'portrait' ? false : !sectAt(S.d, S.sel).landscape;
          return withSect(S, x => { const y = setLandscape(x, land); for (const k of Object.keys(y)) x[k] = y[k]; });
        });
      },
    },
    {
      id: 'layout.size', label: 'Size', risk: 'edit', dialog: 'dialog.pageSetup',
      description: `Size (Layout › Page Setup): a named paper (${PAPER_SIZES.map(p => p[0]).join(', ')}) or width and height in points (each side 7.2–1584 pt); the section keeps its orientation, and a size its margins don't fit is refused. ${SECTION_RESULT}`,
      params: s.object({
        name: s.optional(s.string({min: 1, max: 64})),
        width: s.optional(PT('pt')), height: s.optional(PT('pt')),
      }),
      state: (ctx, p) => (p?.name ? checkState(({x}) => paperOf(x)?.toLowerCase() === String(p.name).toLowerCase())(ctx) : ready(ctx)),
      run: size,
    },
    {
      id: 'layout.columns', label: 'Columns', risk: 'edit', dialog: 'dialog.columns',
      description: `Columns (Layout › Page Setup): 1–12 equal columns (count, space, separator), a left/right preset, or unequal widths [[width, space after], …]; apply to the section, the document, from the caret forward, or the selected text (its own section; the default with text selected). ${SECTION_RESULT}`,
      params: s.object({
        count: s.optional(s.number({description: '1-12'})),
        space: s.optional(PT('pt between columns (0-300)')),
        separator: s.optional(s.boolean({description: 'Line between'})),
        preset: s.optional(s.enum(['left', 'right'])),
        widths: s.optional(s.nullable(s.array(s.array(s.number())))),
        apply: s.optional(s.enum(COLUMN_APPLY)),
      }),
      state(ctx, p) {
        const want = p?.preset ?? (p?.count === 1 ? 'one' : p?.count === 2 ? 'two' : p?.count === 3 ? 'three' : null);
        if (!want || p?.widths) return ready(ctx);
        return checkState(({x}) => columnsPresetOf(x) === want)(ctx);
      },
      run: columns,
    },
    {
      id: 'layout.break', label: 'Breaks', risk: 'edit',
      description: 'Breaks (Layout › Page Setup): a page, column or text-wrapping break at the caret, or a section break (next page, continuous, even page, odd page) just before the selection, which keeps its text.',
      params: s.object({kind: s.enum(BREAK_KINDS)}),
      state: ready,
      run: breaks,
    },
    {
      id: 'layout.lineNumbers', label: 'Line Numbers', risk: 'edit', dialog: 'dialog.lineNumbers',
      description: `Line Numbers (Layout › Page Setup): none, continuous, restart each page or each section; start (1-32767), countBy (1-100) and distance (pt, 0 = auto) set the options and turn numbering on. ${SECTION_RESULT}`,
      params: s.object({
        value: s.optional(s.enum(LINE_NUMBER_VALUES)),
        start: s.optional(s.number({description: '1-32767'})), countBy: s.optional(s.number({description: '1-100'})), distance: s.optional(PT('pt from the text, 0 = auto')),
      }),
      state(ctx, p) {
        if (!p?.value) return ready(ctx);
        return checkState(({x}) => {
          const r = x.lineNumbers?.restart ?? null;
          return p.value === 'none' ? !x.lineNumbers : r === ({continuous: 'continuous', restartPage: 'page', restartSection: 'section'})[p.value];
        })(ctx);
      },
      run: lineNumbers,
    },
    {
      id: 'layout.pageSetup', label: 'Page Setup', risk: 'edit', dialog: 'dialog.pageSetup',
      description: 'Page Setup: with `section` (the whole SectionProps, as layout.section returns it) replaces the section(s) of the selection, checked like Size, Margins, Columns, Line Numbers and Page Borders; without it returns the caret section.',
      params: s.object({section: s.optional(s.nullable(s.record(s.any())))}),
      state: ready,
      run: pageSetup,
    },
    {
      id: 'layout.verticalAlign', label: 'Vertical Alignment', risk: 'edit',
      description: `Vertical Alignment (Page Setup › Layout): top, center, justify (shares each page's spare room between its paragraphs and tables) or bottom. ${SECTION_RESULT}`,
      params: s.object({value: s.enum(['top', 'center', 'justify', 'bottom', 'both', 'justified', 'middle'])}),
      state: (ctx, p) => (p?.value ? checkState(({x}) => x.valign === parsePageVAlign(p.value))(ctx) : ready(ctx)),
      run: (ctx, p) => sectEdit(ctx, S => withSect(S, x => { x.valign = parsePageVAlign(p.value); })),
    },
    {
      id: 'layout.sectionRtl', label: 'Right-to-Left Section', risk: 'edit',
      description: `Right-to-Left Section (Page Setup › Document Grid › Section direction): the section's columns run right to left; without a value it toggles. ${SECTION_RESULT}`,
      params: s.object({value: s.optional(s.boolean())}),
      state: checkState(({x}) => x.rtl),
      run: (ctx, p) => sectEdit(ctx, S => {
        const on = p.value ?? !sectAt(S.d, S.sel).rtl;
        return withSect(S, x => { x.rtl = on; });
      }),
    },
    {
      id: 'layout.differentFirstPage', label: 'Different First Page', risk: 'edit',
      description: `Different First Page (Header & Footer › Options, Page Setup › Layout): the section's first page has its own header and footer; without a value it toggles. ${SECTION_RESULT}`,
      params: s.object({value: s.optional(s.boolean())}),
      state: checkState(({x}) => x.titlePage),
      run: (ctx, p) => sectEdit(ctx, S => {
        const on = p.value ?? !sectAt(S.d, S.sel).titlePage;
        return withSect(S, x => { x.titlePage = on; });
      }),
    },
    {
      id: 'layout.differentOddEven', label: 'Different Odd & Even Pages', risk: 'edit',
      description: 'Different Odd & Even Pages (Header & Footer › Options, Page Setup › Layout): even pages have their own headers and footers, for the whole document; without a value it toggles.',
      params: s.object({value: s.optional(s.boolean())}),
      state: ctx => { const st = ready(ctx); return st.enabled ? {enabled: true, checked: !!ctx.doc.settings?.evenOddHeaders} : st; },
      run(ctx, p) {
        const S = open(ctx);
        const on = p.value ?? !S.d.settings.evenOddHeaders;
        S.d.updateField('settings', st => { st.evenOddHeaders = on; });
        return finish(ctx, S, {edit: true, result: {value: on}});
      },
    },
    {
      id: 'layout.documentGrid', label: 'Document Grid', risk: 'edit',
      description: 'Document Grid (Page Setup › Document Grid): type none|lines|linesAndChars|snapToChars, linesPerPage (sets the line pitch from the text height), charsPerLine (sets the character pitch from the text width), linePitch (pt), charSpace (4096ths of a point); left out stays as it is. Returns the grid with its lines per page and characters per line.',
      params: s.object({
        type: s.optional(s.enum(GRID_TYPES)), linesPerPage: s.optional(s.number()), charsPerLine: s.optional(s.number()),
        linePitch: s.optional(PT('pt')), charSpace: s.optional(s.number()),
      }),
      state: ready,
      run: documentGrid,
    },
    {
      id: 'layout.section', label: 'Section Properties', risk: 'read',
      description: 'The section properties at the caret: page size, orientation, margins, columns, line numbers, vertical alignment, page borders, headers and footers.',
      params: s.object({}),
      state: ready,
      run: ctx => lookSect(ctx).x,
    },
  ],
});

/** For dialogs and tests: the caret section and document over a command context. */
export function caretSection(ctx) {
  const {d, x} = lookSect(ctx);
  return {d, x, mirror: !!d.settings.mirrorMargins, evenOdd: !!d.settings.evenOddHeaders};
}

/** Page borders of a section in the shape dialogs use (visible sides only). */
export function visibleSides(b) {
  if (!b) return {};
  const out = {};
  for (const k of ['top', 'bottom', 'left', 'right']) if (borderVisible(b[k])) out[k] = b[k];
  return out;
}

