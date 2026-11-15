// The document as a whole: its top-level fields and their defaults, parts (secondary stories),
// settings, document properties, comments, revisions, building blocks, and the text box budget.
// Translated from wordcraft crates/doc/src/lib.rs (`Document`), document.rs (`Document::new`,
// `from_text`), parts.rs, block.rs (`BoxBudget`), settings.rs and review.rs at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Schema-2 content is upstream's serialized `Document` with the body chunked (body.mjs) and stable
// ids added (ids.mjs):
//   {body: {chunks}, lastSection, parts: {[id]: Part}, styles, numbering, comments: {[id]: Comment},
//    revisions: Revision[], settings, core, sources, customProps, footnoteSeparators,
//    endnoteSeparators, media: {[key]: base64}, passthrough: {[name]: base64}, glossary}
// Every top-level field is always present. No DOM, no Node built-ins.

import {newParagraph, paragraphWithText} from './para.mjs';
import {defaultSection} from './section.mjs';
import {builtinStyleSheet, BODY_FONT, HEADING_FONT} from './styles.mjs';
import {emptyNumbering} from './numbering.mjs';
import {bodyFromBlocks} from './body.mjs';
import {newId} from './ids.mjs';

/** The top-level fields of schema-2 content, in upstream's order. */
export const CONTENT_KEYS = Object.freeze(['body', 'lastSection', 'parts', 'styles', 'numbering', 'comments', 'revisions', 'settings', 'core',
  'sources', 'customProps', 'footnoteSeparators', 'endnoteSeparators', 'media', 'passthrough', 'glossary']);

/** Whether `content` is Quill schema-2 content (schema 1 holds ProseMirror JSON in `doc`). */
export const isQuill2 = content => !!content && typeof content === 'object' && !content.doc && !!content.body && Array.isArray(content.body.chunks);

// --- parts.rs -------------------------------------------------------------------------------

export const PART_KINDS = Object.freeze(['header', 'footer', 'footnote', 'endnote', 'comment', 'textBox']);
/** Word's default text box margins (left, top, right, bottom), EMU: 0.1" and 0.05". */
export const TEXT_BOX_INSET = Object.freeze([91_440, 45_720, 91_440, 45_720]);
/** Widest text box margin kept, EMU (22"). */
export const MAX_TEXT_BOX_INSET = 20_116_800;
/** Most boxes one chain of linked text boxes runs through. */
export const MAX_LINKED_BOXES = 256;
/** A text box's text body with its defaults. */
export const defaultTextBody = () => ({vert: 'horz', anchor: 'top', next: null, inset: null, autoFit: false});
export const textBodyOf = b => ({...defaultTextBody(), ...(b || {})});
/** The internal margins (left, top, right, bottom) in points. */
export const textBodyInsetsPt = b => (b?.inset ?? TEXT_BOX_INSET).map(v => Math.min(v, MAX_TEXT_BOX_INSET) / 12_700);
/** A part (secondary story). */
export const part = (kind, blocks) => ({kind, blocks});
/** Whether a document's note separators are all the defaults. */
export const noteSeparatorsIsEmpty = s => !s || (!s.separator && !s.continuationSeparator && !s.continuationNotice);
/** Can everyone edit a permission range (rather than one person or group)? */
export const permEveryone = r => String(r.group ?? '').toLowerCase() === 'everyone';

// --- block.rs -------------------------------------------------------------------------------

/** Text boxes inside text boxes count (and show) this many levels deep. */
export const MAX_TEXT_BOX_DEPTH = 4;

/** Bounds the work of expanding text boxes inside text boxes (block.rs `BoxBudget`). */
export class BoxBudget {
  static MAX_NESTED = 64;
  constructor() { this.open = []; this.nested = 0; this.totalCount = 0; }
  /** Start expanding text box story `id`; false if it mustn't be (pair a true with leave()). */
  enter(id) {
    if (this.open.includes(id) || this.open.length >= MAX_TEXT_BOX_DEPTH) return false;
    if (!this.open.length) this.nested = 0;
    else if (this.nested >= BoxBudget.MAX_NESTED) return false;
    else this.nested += 1;
    this.totalCount += 1;
    this.open.push(id);
    return true;
  }
  leave() { this.open.pop(); }
  inside() { return this.open.length > 0; }
  total() { return this.totalCount; }
}

// --- settings.rs ----------------------------------------------------------------------------

export const LEGACY_COMPAT_MODE = 12;
export const COMPAT_MODE_CURRENT = 15;
export const DEFAULT_HYPHENATION_ZONE = 18;
export const DEFAULT_GRID = 9;
/** Our default theme colours: dk1 lt1 dk2 lt2 accent1..6 hlink folHlink. */
export const THEME_COLORS = Object.freeze([[0x00, 0x00, 0x00], [0xff, 0xff, 0xff], [0x0e, 0x28, 0x41], [0xe8, 0xe8, 0xe8], [0x15, 0x60, 0x82],
  [0xe9, 0x71, 0x32], [0x19, 0x6b, 0x24], [0x0f, 0x9e, 0xd5], [0xa0, 0x2b, 0x93], [0x4e, 0xa7, 0x2e], [0x46, 0x78, 0x86], [0x96, 0x60, 0x7d]]);

export function defaultSettings() {
  return {
    trackChanges: false, trackMoves: true, defaultTab: 36, evenOddHeaders: false, mirrorMargins: false, autoHyphenation: false,
    hyphenationZone: DEFAULT_HYPHENATION_ZONE, hyphenateCaps: true, consecutiveHyphenLimit: 0, pageColor: null, pagePicture: null,
    watermark: null, majorFont: HEADING_FONT, minorFont: BODY_FONT, themeColors: THEME_COLORS.map(c => [...c]), themeName: 'Craft',
    footnoteFormat: 'decimal', endnoteFormat: 'lowerRoman', footnotePr: {}, endnotePr: {}, protection: null, protectFormatting: false,
    protectHash: [], compatMode: COMPAT_MODE_CURRENT, romanFonts: [], sumParagraphSpacing: false, doNotExpandShiftReturn: false,
    allowSpaceOfSameStyleInTable: false, gridH: DEFAULT_GRID, gridV: DEFAULT_GRID, math: null, bibStyle: null, attachedTemplate: null,
    linkStyles: false, mailMerge: null, zoom: null, view: null, removePersonalInfo: false, removeDateTime: false,
  };
}
/** Settings with defaults for every missing field. */
export const settingsOf = s => ({...defaultSettings(), ...(s || {})});

export const defaultWatermark = () => ({text: 'DRAFT', font: BODY_FONT, color: [0xc0, 0xc0, 0xc0], diagonal: true, semitransparent: true});

/** Whether a watermark has anything to draw: text, or a picture. */
export const watermarkDrawn = w => !!w && (!!w.picture?.media || String(w.text ?? '').trim().length > 0);

/** The box a watermark's text fills on a page `pageW` × `pageH` (Watermark::frame). */
export function watermarkFrame(w, pageW, pageH) {
  const size = w.size;
  if (Array.isArray(size) && size.every(v => Number.isFinite(v) && v > 0)) return [Math.min(size[0], 4000), Math.min(size[1], 4000)];
  const fin = v => (Number.isFinite(v) ? v : 0);
  const pic = w.picture;
  if (pic && pic.w > 0 && pic.h > 0) {
    // A picture watermark: its own size times Scale, or Auto: as large as fits within the page's width and height (Word's Auto).
    const k = w.scale > 0 ? Math.min(w.scale, 500) / 100 : Math.min(1, (Math.max(72, fin(pageW)) * 0.8) / pic.w, (Math.max(72, fin(pageH)) * 0.8) / pic.h) || 1;
    return [Math.max(4, Math.min(4000, pic.w * k)), Math.max(4, Math.min(4000, pic.h * k))];
  }
  const pw = Math.max(72, Math.min(4000, fin(pageW))), ph = Math.max(72, Math.min(4000, fin(pageH)));
  const across = w.diagonal ? Math.sqrt(pw * pw + ph * ph) : pw;
  const width = Math.max(36, Math.min(2000, across * 0.5));
  const chars = Math.max(1, [...String(w.text ?? '')].slice(0, 200).length);
  return [width, Math.max(12, Math.min(400, width / (0.55 * chars)))];
}

export const defaultCore = () => ({title: '', subject: '', creator: '', keywords: '', description: '', category: '', lastModifiedBy: '', created: '',
  modified: '', revision: 0});

export const SOURCE_FIELDS = Object.freeze(['tag', 'kind', 'author', 'title', 'year', 'publisher', 'city', 'journal', 'volume', 'pages', 'url', 'editor',
  'edition', 'issue', 'month', 'day', 'accessed', 'doi']);
export const source = (fields = {}) => ({...Object.fromEntries(SOURCE_FIELDS.map(k => [k, ''])), ...fields});

// --- review.rs ------------------------------------------------------------------------------

export const REVISION_KINDS = Object.freeze(['insert', 'delete', 'format']);
export const revision = (kind, author, date) => ({kind, author, date});
export const comment = (fields = {}) => ({author: '', initials: '', date: '', parent: null, resolved: false, part: 0, ...fields});
/** The gallery Quick Parts saves to. */
export const QUICK_PARTS_GALLERY = 'docParts';
/** The AutoText gallery. */
export const AUTO_TEXT_GALLERY = 'autoTxt';
export const buildingBlock = (fields = {}) => ({name: '', gallery: '', category: '', blocks: [], ...fields});

// --- Document::new / from_text ----------------------------------------------------------------

/** A blank document: one empty Normal paragraph, Letter, built-in styles (Document::new). */
export function createContent(blocks = null) {
  return {
    body: bodyFromBlocks(blocks && blocks.length ? blocks : [newParagraph()]),
    lastSection: defaultSection(),
    parts: {},
    styles: builtinStyleSheet(),
    numbering: emptyNumbering(),
    comments: {},
    revisions: [],
    settings: defaultSettings(),
    core: defaultCore(),
    sources: [],
    customProps: [],
    footnoteSeparators: {},
    endnoteSeparators: {},
    media: {},
    passthrough: {},
    glossary: [],
  };
}

/** A document from plain text, one paragraph per line (Document::from_text). */
export function contentFromText(text) {
  const blocks = String(text).split('\n').map(l => paragraphWithText(l.replace(/\r+$/, ''), {}));
  return createContent(blocks.length ? blocks : [newParagraph()]);
}

export {newId};
