// Section properties: page setup, columns, headers/footers, page numbering, notes, grid.
// Translated from wordcraft crates/doc/src/section.rs (everything but `NumFormat`, which is in
// numfmt.mjs) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A section is a full object (every field present; `None` is null), plus `id`, the stable id of
// the section for addresses (`/sec:<id>`, `/hdr:<id>.default`). No DOM, no Node built-ins.

import {newId} from './ids.mjs';

export const PAGE_VALIGNS = Object.freeze(['top', 'center', 'justify', 'bottom']);
/** From a command or file value: top|center|justify|bottom (also both, justified, middle). */
export function parsePageVAlign(v) {
  if (v === 'center' || v === 'middle') return 'center';
  if (v === 'justify' || v === 'justified' || v === 'both') return 'justify';
  if (v === 'bottom') return 'bottom';
  return 'top';
}

export const SECTION_STARTS = Object.freeze(['nextPage', 'continuous', 'evenPage', 'oddPage', 'nextColumn']);
export const NOTE_POSITIONS = Object.freeze(['pageBottom', 'beneathText', 'sectEnd', 'docEnd']);
export const NOTE_RESTARTS = Object.freeze(['continuous', 'eachSect', 'eachPage']);
export const LINE_NUMBER_RESTARTS = Object.freeze(['page', 'section', 'continuous']);
export const DOC_GRID_TYPES = Object.freeze(['default', 'lines', 'linesAndChars', 'snapToChars']);

/** The highest note number "start at" takes. */
export const MAX_NOTE_START = 32_767;
export const MIN_GRID_PITCH = 1;
export const MAX_GRID_PITCH = 1584;
export const MAX_CHAR_SPACE = 1584 * 4096;

export const defaultColumns = () => ({count: 1, space: 36, separator: false, widths: []});
export const defaultLineNumbering = () => ({countBy: 1, start: 1, distance: 0, restart: 'page'});
export const defaultDocGrid = () => ({type: 'default', linePitch: 18, charSpace: 0});
export const emptyHeaderSet = () => ({default: null, first: null, even: null});
export const noteProps = () => ({});
export const notePropsIsEmpty = p => !p || ['pos', 'numFmt', 'numStart', 'numRestart'].every(k => p[k] === undefined || p[k] === null);

/** Word's default section: US Letter, 1" margins, 0.5" header/footer distance. */
export function defaultSection(id = newId()) {
  return {
    id,
    start: 'nextPage', pageW: 612, pageH: 792, landscape: false,
    marginTop: 72, marginBottom: 72, marginLeft: 72, marginRight: 72,
    header: 36, footer: 36, gutter: 0,
    columns: defaultColumns(), headers: emptyHeaderSet(), footers: emptyHeaderSet(),
    titlePage: false, pageNumStart: null, pageNumFormat: 'decimal', pageNumSet: false,
    lineNumbers: null, valign: 'top', formProt: null, pageBorders: null, rtl: false,
    textDirection: 'horizontal', textDirectionSet: false, fmtChange: null, docGrid: null,
    footnotePr: {}, endnotePr: {},
  };
}

/** A section filled out with the defaults for every missing field (serde `#[serde(default)]`). */
export function sectionOf(s) {
  const d = defaultSection(s?.id);
  if (!s) return d;
  const out = {...d, ...s};
  out.columns = {...defaultColumns(), ...(s.columns || {})};
  out.headers = {...emptyHeaderSet(), ...(s.headers || {})};
  out.footers = {...emptyHeaderSet(), ...(s.footers || {})};
  return out;
}

/**
 * Join the section before this one into it (SectionProps::absorb): this section's setup stays,
 * and the headers and footers it leaves out (linked to the previous) are taken from `before`.
 * Returns the new section.
 */
export function absorb(sect, before) {
  const out = {...sect, headers: {...sect.headers}, footers: {...sect.footers}};
  for (const [own, prev] of [[out.headers, before?.headers], [out.footers, before?.footers]]) {
    own.default = own.default ?? prev?.default ?? null;
    own.first = own.first ?? prev?.first ?? null;
    own.even = own.even ?? prev?.even ?? null;
  }
  return out;
}

export const textWidth = s => Math.max(s.pageW - s.marginLeft - s.marginRight - s.gutter, 18);
export const textHeight = s => Math.max(s.pageH - s.marginTop - s.marginBottom, 18);

/** Swap to landscape/portrait, rotating the margins as Word does. Returns the new section. */
export function setLandscape(s, on) {
  if (!!on === !!s.landscape) return s;
  const out = {...s, landscape: !!on, pageW: s.pageH, pageH: s.pageW};
  const {marginTop: t, marginBottom: b, marginLeft: l, marginRight: r} = s;
  if (on) Object.assign(out, {marginTop: l, marginBottom: r, marginLeft: b, marginRight: t});
  else Object.assign(out, {marginLeft: t, marginRight: b, marginBottom: l, marginTop: r});
  return out;
}

/** The grid's line pitch, clamped to something layout can use. */
export const gridLinePitchOf = g => (Number.isFinite(g?.linePitch) ? Math.max(MIN_GRID_PITCH, Math.min(MAX_GRID_PITCH, g.linePitch)) : 18);
/** The character pitch for a document whose default font is `fontSize` points. */
export function gridCharPitchOf(g, fontSize) {
  const size = Number.isFinite(fontSize) ? Math.max(MIN_GRID_PITCH, Math.min(MAX_GRID_PITCH, fontSize)) : 10.5;
  const cs = Math.max(-MAX_CHAR_SPACE, Math.min(MAX_CHAR_SPACE, g?.charSpace ?? 0));
  return Math.max(MIN_GRID_PITCH, Math.min(MAX_GRID_PITCH, size + cs / 4096));
}
/** The `w:charSpace` that gives `pitch` with the default font at `fontSize` points. */
export function charSpaceFor(pitch, fontSize) {
  const p = Number.isFinite(pitch) ? Math.max(MIN_GRID_PITCH, Math.min(MAX_GRID_PITCH, pitch)) : fontSize;
  const size = Number.isFinite(fontSize) ? Math.max(MIN_GRID_PITCH, Math.min(MAX_GRID_PITCH, fontSize)) : 10.5;
  return Math.max(-MAX_CHAR_SPACE, Math.min(MAX_CHAR_SPACE, Math.round((p - size) * 4096)));
}
export const gridLinePitch = s => (s.docGrid && s.docGrid.type !== 'default' ? gridLinePitchOf(s.docGrid) : null);
export const gridCharPitch = (s, fontSize) =>
  (s.docGrid && (s.docGrid.type === 'linesAndChars' || s.docGrid.type === 'snapToChars') ? gridCharPitchOf(s.docGrid, fontSize) : null);
export const gridLinesPerPage = s => Math.max(1, Math.floor(textHeight(s) / gridLinePitchOf(s.docGrid ?? defaultDocGrid()) + 0.001));
export const gridCharsPerLine = (s, fontSize) => Math.max(1, Math.floor(textWidth(s) / gridCharPitchOf(s.docGrid ?? defaultDocGrid(), fontSize) + 0.001));

/** Column (x offset from the text area's left, width) for each column, in reading order. */
export function columnBoxes(s) {
  const tw = textWidth(s);
  const n = Math.max(1, Math.min(45, s.columns?.count ?? 1));
  const widths = s.columns?.widths ?? [];
  let boxes;
  if (widths.length && widths.length === n) {
    let x = 0;
    boxes = widths.map(([w, sp]) => { const b = [x, Math.max(w, 18)]; x += w + sp; return b; });
  } else {
    const space = Math.max(0, s.columns?.space ?? 36);
    const w = Math.max((tw - space * (n - 1)) / n, 18);
    boxes = Array.from({length: n}, (_, i) => [i * (w + space), w]);
  }
  return s.rtl ? boxes.map(([x, w]) => [tw - x - w, w]) : boxes;
}
