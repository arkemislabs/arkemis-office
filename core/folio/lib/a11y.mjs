// The Accessibility Checker (32 rules in Acrobat's seven categories), its report, alternate text, tag editing, Automatically tag PDF and Tag form fields,
// on the PDF's objects.
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt): crates/a11y
//   lib.rs          the 32 rules, their categories, names, descriptions and explanations, which are manual, which are on by default; `check`
//   content.rs      the Document, Page Content and Forms rules: the content scan (tagged or artifact content, text, images, fonts), annotations
//   structure.rs    the structure walk and the Alternate Text, Tables, Lists and Headings rules (spans carried through table rows)
//   report.rs       the accessibility report page
//   alt.rs          figures, set_alt, mark_decorative, mark_tag_artifact (marked content becomes an /Artifact, the tag leaves its parent and the parent tree)
//   tags.rs         tags(), set_tag_property (type, title, actual text, alternate text, language, table summary and scope), move_tag
//   autotag.rs      autotag_text (text-only pages: each text object becomes a P)
//   autotag_fields.rs tag_form_fields (a Form element with an object reference for each untagged widget)
// Not translated: the findings' boxes (content_bboxes: the page is not flashed at a figure), the wordings tables for other languages (`said`), headings(),
// tag_content. A rule that only a person can judge stays "Needs manual check": nothing here says a document is accessible, only which rules passed.
// No DOM, no Node built-ins.

import '../../common/lib/pdf-guard.mjs';
import {PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFString, PDFHexString, PDFNumber, PDFBool, decodePDFRawStream} from 'pdf-lib';
import {parseContent, serializeContent} from './redact-content.mjs';
import {pageStreams, pageResources} from './text-interp.mjs';

const N = s => PDFName.of(s);
const key = r => `${r.objectNumber} ${r.generationNumber}`;
export const refOfKey = k => { const [o, g] = String(k).split(' ').map(Number); return PDFRef.of(o, g ?? 0); };
const look = (doc, v) => doc.context.lookup(v);
const asDict = (doc, v) => { const o = look(doc, v); return o instanceof PDFDict ? o : o instanceof PDFStream ? o.dict : null; };
const nameText = v => (v instanceof PDFName ? v.decodeText() : undefined);
const strText = v => { if (v instanceof PDFString || v instanceof PDFHexString) { try { return v.decodeText(); } catch { return ''; } } return null; };
const intOf = v => (v instanceof PDFNumber && Number.isInteger(v.asNumber()) ? v.asNumber() : undefined);
const text = (doc, d, k) => { const s = strText(look(doc, d?.get(N(k)))); const t = s == null ? '' : s.trim(); return t || null; };
const text16 = s => PDFHexString.fromText(String(s));
const arrayOf = (doc, v) => { const o = look(doc, v); return o instanceof PDFArray ? o.asArray() : null; };

/** A reference chain followed to its value (bounded; a loop is no value). */
function resolved(doc, v) {
  const seen = new Set();
  let o = v;
  while (o instanceof PDFRef) { if (seen.size >= 32 || seen.has(key(o))) return undefined; seen.add(key(o)); o = doc.context.lookup(o); }
  return o;
}

// ── the rules ───────────────────────────────────────────────────────────────────────────────

export const CATEGORIES = ['Document', 'Page Content', 'Forms', 'Alternate Text', 'Tables', 'Lists', 'Headings'];
const R = (id, category, name, description, explanation, manual = false) => ({id, category, name, description, explanation, manual, onByDefault: id !== 'color-contrast'});
export const RULES = [
  R('permission-flag', 'Document', 'Accessibility permission flag', 'Accessibility permission flag is set', 'Security settings must allow assistive technology to read the content ("Enable text access for screen reader devices"). Change the document\'s security to allow it.'),
  R('image-only', 'Document', 'Image-only PDF', 'Document is not image-only PDF', "Pages that are only pictures of text can't be read aloud or searched. Recognize text (OCR) to add a text layer."),
  R('tagged-pdf', 'Document', 'Tagged PDF', 'Document is tagged PDF', 'Tags give the document a logical structure that assistive technology follows. Tag the document (Automatically tag PDF).'),
  R('logical-reading-order', 'Document', 'Logical Reading Order', 'Document structure provides a logical reading order', 'Check that the tags read in the order a sighted reader would. Use the Reading Order tool or the Tags panel to correct it.', true),
  R('primary-language', 'Document', 'Primary language', 'Text language is specified', "Screen readers choose their voice from the document's language. Set it in Document Properties > Advanced > Language."),
  R('title', 'Document', 'Title', 'Document title is showing in title bar', 'The window should show a meaningful title rather than the file name. Set a title and Initial View > Show: Document Title.'),
  R('bookmarks', 'Document', 'Bookmarks', 'Bookmarks are present in large documents', 'Documents of more than 20 pages need bookmarks for navigation. Add bookmarks for the main sections.'),
  R('color-contrast', 'Document', 'Color contrast', 'Document has appropriate color contrast', 'Text must contrast enough with its background for people with low vision. Check the colours by eye or with a contrast tool.', true),
  R('tagged-content', 'Page Content', 'Tagged content', 'All page content is tagged', 'Everything on a page must be tagged or marked as an artifact (decoration, headers, footers). Tag the untagged content.'),
  R('tagged-annotations', 'Page Content', 'Tagged annotations', 'All annotations are tagged', 'Comments, links and fields must be in the tag tree to be announced. Tag the annotations.'),
  R('tab-order', 'Page Content', 'Tab order', 'Tab order is consistent with structure order', "Pages with links, comments or fields should tab in structure order. The fix sets each page's tab order to Use Document Structure."),
  R('character-encoding', 'Page Content', 'Character encoding', 'Reliable character encoding is provided', 'Fonts must map their characters to Unicode so text can be read and copied. Fix the fonts or recreate the PDF.'),
  R('tagged-multimedia', 'Page Content', 'Tagged multimedia', 'All multimedia objects are tagged', 'Video, sound and rich media must be tagged to be announced. Tag the multimedia annotations.'),
  R('screen-flicker', 'Page Content', 'Screen flicker', 'Page will not cause screen flicker', 'Animation that flashes can cause seizures. Check scripts and media for flicker.', true),
  R('scripts', 'Page Content', 'Scripts', 'No inaccessible scripts', "Scripted content must be usable with a keyboard and assistive technology. Check the document's scripts.", true),
  R('timed-responses', 'Page Content', 'Timed responses', 'Page does not require timed responses', 'People may need more time to respond. Check that nothing has a time limit.', true),
  R('navigation-links', 'Page Content', 'Navigation links', 'Navigation links are not repetitive', 'Repeated navigation links should be skippable. Check links that appear on every page.', true),
  R('tagged-form-fields', 'Forms', 'Tagged form fields', 'All form fields are tagged', 'Form fields must be in the tag tree (Form tags) to be announced. Tag the form fields.'),
  R('field-descriptions', 'Forms', 'Field descriptions', 'All form fields have description', 'Each field needs a tooltip that says what to enter. Add one in Field Properties > General > Tooltip.'),
  R('figures-alt-text', 'Alternate Text', 'Figures alternate text', 'Figures require alternate text', 'Pictures need alternate text that describes them, or must be marked decorative. Add alternate text to each figure.'),
  R('nested-alt-text', 'Alternate Text', 'Nested alternate text', 'Alternate text that will never be read', 'Alternate text inside an element that already has alternate text is never read. Remove the inner alternate text.'),
  R('alt-text-associated', 'Alternate Text', 'Associated with content', 'Alternate text must be associated with some content', 'Alternate text on an element without page content is never reached. Remove it or attach the element to content.'),
  R('alt-text-hides-annotation', 'Alternate Text', 'Hides annotation', 'Alternate text should not hide annotation', 'Alternate text on an element that contains a link or field hides that annotation from assistive technology. Move the alternate text.'),
  R('other-elements-alt-text', 'Alternate Text', 'Other elements alternate text', 'Other elements that require alternate text', 'Formulas and similar non-text elements need alternate text. Add alternate text to them.'),
  R('table-rows', 'Tables', 'Rows', 'TR must be a child of Table, THead, TBody, or TFoot', "Table rows belong directly in a table or its head, body or foot. Fix the table's tags."),
  R('table-cells', 'Tables', 'TH and TD', 'TH and TD must be children of TR', "Table cells belong in a row. Fix the table's tags."),
  R('table-headers', 'Tables', 'Headers', 'Tables should have headers', 'Header cells (TH) tell listeners what each column or row holds. Mark the header cells.'),
  R('table-regularity', 'Tables', 'Regularity', 'Tables must contain the same number of columns in each row and rows in each column', 'Irregular tables confuse cell navigation. Give every row the same number of cells (counting spans).'),
  R('table-summary', 'Tables', 'Summary', 'Tables must have a summary', "A summary describes the table's purpose and layout. Add a Summary attribute to each table."),
  R('list-items', 'Lists', 'List items', 'LI must be a child of L', "List items belong in a list. Fix the list's tags."),
  R('lbl-lbody', 'Lists', 'Lbl and LBody', 'Lbl and LBody must be children of LI', "List labels and bodies belong in a list item. Fix the list's tags."),
  R('heading-nesting', 'Headings', 'Appropriate nesting', 'Appropriate nesting', "Heading levels shouldn't skip (an H1 followed by an H3). Retag the headings."),
];
export const RULE_BY_ID = Object.fromEntries(RULES.map(r => [r.id, r]));
export const STATUS_LABEL = {passed: 'Passed', failed: 'Failed', manual: 'Needs manual check', skipped: 'Skipped'};
export const defaultRules = () => RULES.filter(r => r.onByDefault).map(r => r.id);
/** Rules with an automatic (or guided) fix (a11y_ui.rs `fixable`). */
export const FIXABLE = ['primary-language', 'title', 'tab-order'];
const MAX_FINDINGS = 200;

const finding = (page, message, extra = {}) => ({page: page ?? null, object: null, bbox: null, message, ...extra});

// ── the structure tree ──────────────────────────────────────────────────────────────────────

const STANDARD = new Set(['Document', 'DocumentFragment', 'Part', 'Art', 'Sect', 'Div', 'BlockQuote', 'Caption', 'TOC', 'TOCI', 'Index', 'NonStruct', 'Private', 'Aside', 'Title',
  'FENote', 'P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'L', 'LI', 'Lbl', 'LBody', 'Table', 'TR', 'TH', 'TD', 'THead', 'TBody', 'TFoot', 'Span', 'Quote', 'Note', 'Reference',
  'BibEntry', 'Code', 'Link', 'Annot', 'Ruby', 'RB', 'RT', 'RP', 'Warichu', 'WT', 'WP', 'Figure', 'Formula', 'Form', 'Sub', 'Em', 'Strong', 'Artifact']);
const MAX_DEPTH = 256;
const MAX_SPAN = 10_000;

function structRoot(doc) {
  const r = asDict(doc, doc.catalog.get(N('StructTreeRoot')));
  return r instanceof PDFDict ? r : null;
}
export const hasStructTree = doc => !!structRoot(doc);

function roleMapOf(doc, root) { const m = asDict(doc, root?.get(N('RoleMap'))); return m instanceof PDFDict ? m : null; }

/** The standard type of `ty`, following the role map (a bounded number of steps). */
function standardType(doc, roleMap, ty) {
  let t = ty;
  for (let i = 0; i < 12; i++) {
    if (STANDARD.has(t)) return t;
    const n = nameText(look(doc, roleMap?.get?.(N(t))));
    if (n && n !== t) t = n; else break;
  }
  return t;
}

const kindOf = ty => {
  switch (ty) {
    case 'Figure': return 'figure';
    case 'Formula': return 'formula';
    case 'Table': return 'table';
    case 'THead': case 'TBody': case 'TFoot': return 'section';
    case 'TR': return 'tr';
    case 'TH': return 'th';
    case 'TD': return 'td';
    case 'L': return 'l';
    case 'LI': return 'li';
    case 'Lbl': return 'lbl';
    case 'LBody': return 'lbody';
    case 'TOCI': case 'BibEntry': case 'Note': case 'FENote': return 'note';
    default: return /^H[1-6]$/.test(ty) ? `h${ty[1]}` : 'other';
  }
};

/** structure.rs `walk`: every element in document order, told to the visitor as it opens and as it closes. */
function walkStructure(doc, pages, visitor) {
  const root = structRoot(doc);
  if (!root) return;
  const roleMap = roleMapOf(doc, root);
  const pageIndex = new Map(pages.map((p, i) => [key(p.ref), i]));
  const seen = new Set();
  const frames = [];
  let opened = 0;
  const markContent = () => { if (frames.length) frames[frames.length - 1].content = true; };
  const attrDicts = d => {
    const a = look(doc, d.get(N('A')));
    if (!a) return [];
    const held = a instanceof PDFArray ? a.asArray().map(x => look(doc, x)) : [a];
    return held.filter(x => x instanceof PDFDict);
  };
  const attrKey = (attrs, k) => attrs.find(a => a.has(N(k)))?.get(N(k));
  const span = (attrs, k) => { const v = look(doc, attrKey(attrs, k)); const n = intOf(v); return n !== undefined && n >= 1 ? Math.min(n, MAX_SPAN) : 1; };
  const node = (value, depth, page) => {
    if (depth > MAX_DEPTH || value === undefined || value === null) return;
    if (value instanceof PDFArray) {
      const items = value.asArray();
      if (items.length) for (const it of items) node(it, depth + 1, page);
    } else if (value instanceof PDFNumber) markContent();
    else if (value instanceof PDFRef) {
      const k = key(value);
      if (seen.has(k)) return;
      seen.add(k);
      const target = look(doc, value);
      if (target instanceof PDFDict) dictNode(target, depth, page, value);
      else if (target instanceof PDFArray || target instanceof PDFNumber) { /* the walk reads only dictionaries behind a reference */ }
    } else if (value instanceof PDFDict) dictNode(value, depth, page, null);
  };
  const dictNode = (d, depth, page, object) => {
    const type = nameText(look(doc, d.get(N('Type'))));
    if (type === 'MCR') return markContent();
    if (type === 'OBJR') {
      markContent();
      const o = d.get(N('Obj'));
      const a = o instanceof PDFRef ? look(doc, o) : null;
      if (a instanceof PDFDict && a.has(N('Subtype')) && a.has(N('Rect')) && frames.length) frames[frames.length - 1].annot = true;
      return;
    }
    const s = nameText(look(doc, d.get(N('S'))));
    if (!s) return;
    const pg = d.get(N('Pg'));
    const pageHere = pg instanceof PDFRef && pageIndex.has(key(pg)) ? pageIndex.get(key(pg)) : page;
    const alt = !!text(doc, d, 'Alt') || !!text(doc, d, 'ActualText');
    const ty = standardType(doc, roleMap, s);
    const kind = kindOf(ty);
    const attrs = kind === 'table' || kind === 'td' || kind === 'th' ? attrDicts(d) : [];
    const parent = frames[frames.length - 1];
    const frame = {object, ty, kind, index: opened, page: pageHere ?? null, alt, altAbove: !!parent && (parent.alt || parent.altAbove),
      summary: attrs.some(a => a.has(N('Summary'))), colSpan: span(attrs, 'ColSpan'), rowSpan: span(attrs, 'RowSpan'), content: false, annot: false, subContent: false, subAnnot: false};
    opened++;
    frames.push(frame);
    visitor.enter(frames.slice(0, -1), frame);
    if (d.has(N('K'))) node(d.get(N('K')), depth + 1, pageHere ?? page);
    frames.pop();
    const p = frames[frames.length - 1];
    if (p) { p.subContent ||= frame.content || frame.subContent; p.subAnnot ||= frame.annot || frame.subAnnot; }
    visitor.exit(frames, frame);
  };
  if (root.has(N('K'))) node(root.get(N('K')), 0, null);
}

const rowOwner = path => {
  if (!path.length) return null;
  const parent = path[path.length - 1], rest = path.slice(0, -1);
  if (parent.kind === 'table') return rest.length;
  if (parent.kind === 'section') { const g = rest[rest.length - 1]; return g && g.kind === 'table' ? rest.length - 1 : null; }
  return null;
};

/** A table that is open: the widths of its rows, and the spans that reach into later rows (structure.rs Table). */
class TableState {
  constructor(depth) { Object.assign(this, {depth, hasTh: false, range: null, carry: [], col: 0, cursor: 0, starts: []}); }
  static coveredEnd(carry, cursorRef, col) {
    while (carry[cursorRef.at] && carry[cursorRef.at].end <= col) cursorRef.at++;
    const r = carry[cursorRef.at];
    return r && r.start <= col ? r.end : null;
  }
  startRow() { this.col = 0; this.cursor = 0; this.starts = []; }
  place(colSpan, rowSpan) {
    const c = {at: this.cursor};
    let start = this.col, end;
    while ((end = TableState.coveredEnd(this.carry, c, start)) !== null) start = end;
    this.cursor = c.at;
    end = start + colSpan;
    if (rowSpan > 1) this.starts.push({start, end, rows: rowSpan - 1});
    this.col = end;
  }
  endRow() {
    const c = {at: this.cursor};
    let width = this.col, end;
    while ((end = TableState.coveredEnd(this.carry, c, width)) !== null) width = end;
    this.range = this.range ? [Math.min(this.range[0], width), Math.max(this.range[1], width)] : [width, width];
    this.carry = carryIntoNextRow(this.carry, this.starts);
    this.starts = [];
  }
}
function carryIntoNextRow(carry, row) {
  const points = [...new Set([...carry, ...row].flatMap(r => [r.start, r.end]))].sort((a, b) => a - b);
  const out = [];
  let a = 0, b = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const from = points[i], to = points[i + 1];
    while (carry[a] && carry[a].end <= from) a++;
    while (row[b] && row[b].end <= from) b++;
    const before = carry[a] && carry[a].start <= from ? Math.max(0, carry[a].rows - 1) : 0;
    const here = row[b] && row[b].start <= from ? row[b].rows : 0;
    const rows = Math.max(before, here);
    if (!rows) continue;
    const last = out[out.length - 1];
    if (last && last.end === from && last.rows === rows) last.end = to; else out.push({start: from, end: to, rows});
  }
  return out;
}

const STRUCTURE_RULES = ['figures-alt-text', 'nested-alt-text', 'alt-text-associated', 'alt-text-hides-annotation', 'other-elements-alt-text', 'table-rows', 'table-cells',
  'table-headers', 'table-regularity', 'table-summary', 'list-items', 'lbl-lbody', 'heading-nesting'];

function structureRules(doc, pages, selected) {
  const found = new Map(STRUCTURE_RULES.filter(r => selected.has(r)).map(r => [r, []]));
  if (!found.size) return new Map();
  const tables = [];
  let heading = 0;
  const add = (rule, index, make) => { const list = found.get(rule); if (list) list.push({index, f: make()}); };
  const about = (e, what, extra = {}) => finding(e.page, e.page !== null ? `${e.ty} element on page ${e.page + 1}: ${what}` : `${e.ty} element: ${what}`, {object: e.object ? key(e.object) : null, ...extra});
  const tableAt = depth => { const t = tables[tables.length - 1]; return t && t.depth === depth ? t : null; };
  walkStructure(doc, pages, {
    enter(ancestors, e) {
      const parent = ancestors[ancestors.length - 1]?.kind;
      if (e.alt && e.altAbove) add('nested-alt-text', e.index, () => about(e, "its alternate text is inside another element's and will never be read"));
      switch (e.kind) {
        case 'figure': if (!e.alt && !e.altAbove) add('figures-alt-text', e.index, () => about(e, 'no alternate text')); break;
        case 'formula': if (!e.alt && !e.altAbove) add('other-elements-alt-text', e.index, () => about(e, 'no alternate text')); break;
        case 'table':
          tables.push(new TableState(ancestors.length));
          if (!e.summary) add('table-summary', e.index, () => about(e, 'no summary'));
          break;
        case 'tr': {
          if (parent !== 'table' && parent !== 'section') add('table-rows', e.index, () => about(e, 'not in a Table, THead, TBody or TFoot'));
          const owner = rowOwner(ancestors);
          const t = owner === null ? null : tableAt(owner);
          if (t) t.startRow();
          break;
        }
        case 'th': case 'td': {
          const inRow = parent === 'tr';
          if (!inRow) add('table-cells', e.index, () => about(e, 'not in a TR'));
          if (inRow) {
            const owner = rowOwner(ancestors.slice(0, -1));
            const t = owner === null ? null : tableAt(owner);
            if (t) { t.place(e.colSpan, e.rowSpan); t.hasTh ||= e.kind === 'th'; }
          }
          break;
        }
        case 'li': if (parent !== 'l') add('list-items', e.index, () => about(e, 'not in an L (list)')); break;
        case 'lbl': case 'lbody': if (parent !== 'li' && parent !== 'note') add('lbl-lbody', e.index, () => about(e, 'not in an LI (list item)')); break;
        default:
          if (/^h[1-6]$/.test(e.kind)) {
            const level = Number(e.kind[1]), prev = heading;
            if (level > prev + 1) add('heading-nesting', e.index, () => about(e, prev === 0 ? `the first heading is an H${level}; headings should not skip levels` : `H${level} follows an H${prev}; headings should not skip levels`));
            heading = level;
          }
      }
    },
    exit(ancestors, e) {
      if (e.kind === 'table') {
        const t = tables[tables.length - 1];
        if (t && t.depth === ancestors.length) {
          tables.pop();
          if (!t.hasTh) add('table-headers', e.index, () => about(e, 'no header cells (TH)'));
          if (t.range && t.range[0] !== t.range[1]) add('table-regularity', e.index, () => about(e, `rows have between ${t.range[0]} and ${t.range[1]} columns`));
        }
      } else if (e.kind === 'tr') {
        const owner = rowOwner(ancestors);
        const t = owner === null ? null : tableAt(owner);
        if (t) t.endRow();
      }
      if (e.alt) {
        if (!(e.content || e.subContent)) add('alt-text-associated', e.index, () => about(e, 'alternate text on an element with no page content'));
        if (e.annot || e.subAnnot) add('alt-text-hides-annotation', e.index, () => about(e, 'alternate text hides an annotation inside it'));
      }
    },
  });
  const out = new Map();
  for (const [rule, list] of found) {
    list.sort((a, b) => a.index - b.index);
    out.set(rule, {findings: list.slice(0, MAX_FINDINGS).map(x => x.f), total: list.length});
  }
  return out;
}

// ── the content scan ────────────────────────────────────────────────────────────────────────

const MAX_FORM_DEPTH = 12;
const MAX_FORMS_PER_PAGE = 2000;
const MAX_PAGE_BYTES = 64 * 1024 * 1024;

const streamData = s => { try { return s instanceof PDFStream && 'contents' in s ? decodePDFRawStream(s).decode() : null; } catch { return null; } };

function scanContent(doc, pages, list) {
  const scan = {hasText: false, hasImages: false, untagged: new Map(), fonts: new Map(), incomplete: new Set()};
  for (const p of list) {
    const page = pages[p];
    if (!page) continue;
    let budget = MAX_PAGE_BYTES, forms = MAX_FORMS_PER_PAGE;
    const resOf = r => (r instanceof PDFDict ? r : null);
    let bytes;
    try {
      const parts = pageStreams(doc, page).map(s => s.bytes);
      budget -= parts.reduce((n, b) => n + b.length, 0);
      bytes = new Uint8Array(parts.reduce((n, b) => n + b.length + 1, 0));
      let at = 0;
      for (const b of parts) { bytes.set(b, at); at += b.length; bytes[at++] = 32; }
    } catch { scan.incomplete.add(p); continue; }
    const active = new Set();
    const content = (data, res, covered, depth) => {
      const sub = k => asDict(doc, res?.get(N(k)));
      const fonts = sub('Font'), xobjects = sub('XObject'), props = sub('Properties');
      const stack = [];
      let untagged = 0;
      for (const op of parseContent(data)) {
        const inside = covered || (stack.length ? stack[stack.length - 1] : false);
        switch (op.op) {
          case 'BMC': stack.push(inside || (op.args[0]?.k === 'name' && op.args[0].v === 'Artifact')); break;
          case 'BDC': stack.push(inside || bdcMarks(doc, op, props)); break;
          case 'EMC': stack.pop(); break;
          case 'Tj': case 'TJ': case "'": case '"': scan.hasText = true; untagged += inside ? 0 : 1; break;
          case 'Tf': {
            const r = op.args[0]?.k === 'name' ? fonts?.get(N(op.args[0].v)) : null;
            if (r instanceof PDFRef) { if (!scan.fonts.has(p)) scan.fonts.set(p, new Set()); scan.fonts.get(p).add(key(r)); }
            break;
          }
          case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': case 'S': case 's': case 'sh': untagged += inside ? 0 : 1; break;
          case 'BI': scan.hasImages = true; untagged += inside ? 0 : 1; break;
          case 'Do': {
            const r = op.args[0]?.k === 'name' ? xobjects?.get(N(op.args[0].v)) : null;
            if (!(r instanceof PDFRef)) break;
            const x = look(doc, r);
            if (!(x instanceof PDFStream)) break;
            const sub = nameText(look(doc, x.dict.get(N('Subtype'))));
            if (sub === 'Image') { scan.hasImages = true; untagged += inside ? 0 : 1; }
            else if (sub === 'Form' && depth < MAX_FORM_DEPTH && !active.has(key(r))) {
              if (forms-- <= 0) { scan.incomplete.add(p); break; }
              const d = streamData(x);
              if (!d) break;
              budget -= d.length;
              if (budget < 0) { scan.incomplete.add(p); break; }
              active.add(key(r));
              content(d, resOf(asDict(doc, x.dict.get(N('Resources')))) ?? res, inside, depth + 1);
              active.delete(key(r));
            }
            break;
          }
          default:
        }
      }
      if (untagged > 0) scan.untagged.set(p, (scan.untagged.get(p) ?? 0) + untagged);
    };
    content(bytes, pageResources(page), false, 0);
  }
  return scan;
}

function bdcMarks(doc, op, props) {
  if (op.args[0]?.k === 'name' && op.args[0].v === 'Artifact') return true;
  const a = op.args[1];
  if (a?.k === 'dict') return a.entries.some(([k]) => k === 'MCID');
  if (a?.k === 'name') { const d = asDict(doc, props?.get(N(a.v))); return !!d && d.has(N('MCID')); }
  return false;
}

// ── Document, Page Content and Forms rules ──────────────────────────────────────────────────

const MULTIMEDIA = new Set(['Screen', 'Movie', 'Sound', 'RichMedia', '3D']);
const infoDict = doc => asDict(doc, doc.context.trailerInfo.Info) ?? null;

function documentRule(doc, id, pages, scan, input) {
  const cat = doc.catalog;
  switch (id) {
    case 'permission-flag': return input.accessibilityAllowed === false ? [finding(null, "The security settings don't allow screen readers to read the text")] : [];
    case 'image-only': return !scan.hasText && scan.hasImages ? [finding(null, 'No page has text: the document appears to be images of pages')] : [];
    case 'tagged-pdf': {
      const out = [];
      if (!cat.has(N('StructTreeRoot'))) out.push(finding(null, 'The document has no tags (structure tree)'));
      const mi = asDict(doc, resolved(doc, cat.get(N('MarkInfo'))));
      const marked = mi ? resolved(doc, mi.get(N('Marked'))) : undefined;
      if (!(marked instanceof PDFBool && marked.asBoolean())) out.push(finding(null, "The document isn't marked as tagged (MarkInfo Marked)"));
      return out;
    }
    case 'primary-language': return text(doc, cat, 'Lang') === null ? [finding(null, 'No document language is set')] : [];
    case 'title': {
      const out = [];
      if (text(doc, infoDict(doc), 'Title') === null) out.push(finding(null, 'The document has no title'));
      const vp = asDict(doc, cat.get(N('ViewerPreferences')));
      const shows = vp ? look(doc, vp.get(N('DisplayDocTitle'))) : null;
      if (!(shows instanceof PDFBool && shows.asBoolean())) out.push(finding(null, 'The window shows the file name, not the title (Initial View > Show)'));
      return out;
    }
    case 'bookmarks': {
      const o = asDict(doc, cat.get(N('Outlines')));
      return pages.length > 20 && !(o && o.has(N('First'))) ? [finding(null, `${pages.length} pages and no bookmarks`)] : [];
    }
    default: return [];
  }
}

const annotsOf = (doc, page) => {
  const a = arrayOf(doc, page.node.get(N('Annots'))) ?? [];
  const out = [];
  for (const x of a) { if (!(x instanceof PDFRef)) continue; const d = look(doc, x); if (d instanceof PDFDict && nameText(look(doc, d.get(N('Subtype')))) !== 'Popup') out.push([x, d]); }
  return out;
};

const PREDEFINED_CJK_BASES = new Set(['GB-EUC', 'GBpc-EUC', 'GBK-EUC', 'GBKp-EUC', 'GBK2K', 'UniGB-UCS2', 'UniGB-UTF16', 'B5pc', 'HKscs-B5', 'ETen-B5', 'ETenms-B5', 'CNS-EUC', 'UniCNS-UCS2',
  'UniCNS-UTF16', '90ms-RKSJ', '90msp-RKSJ', 'Add-RKSJ', 'EUC', 'Ext-RKSJ', 'UniJIS-UCS2', 'UniJIS-UCS2-HW', 'UniJIS-UTF16', 'KSC-EUC', 'KSCms-UHC', 'KSCms-UHC-HW', 'UniKS-UCS2', 'UniKS-UTF16']);
function predefinedCjkCMap(n) {
  if (['H', 'V', '83pv-RKSJ-H', '90pv-RKSJ-H', 'KSCpc-EUC-H', 'UniAKR-UTF8-H', 'UniAKR-UTF16-H', 'UniAKR-UTF32-H'].includes(n)) return true;
  const base = n.endsWith('-H') || n.endsWith('-V') ? n.slice(0, -2) : null;
  return !!base && PREDEFINED_CJK_BASES.has(base);
}
/** Whether text in this font declares a Unicode mapping route (ToUnicode, a standard encoding, a predefined CJK CMap, or an Adobe CJK collection). */
function mapsToUnicode(doc, f) {
  if (f.has(N('ToUnicode'))) return true;
  const enc = look(doc, f.get(N('Encoding')));
  const sub = nameText(look(doc, f.get(N('Subtype'))));
  if (sub === 'Type0') {
    if (enc instanceof PDFName && predefinedCjkCMap(enc.decodeText())) return true;
    const desc = arrayOf(doc, f.get(N('DescendantFonts')));
    const d0 = desc?.[0] ? asDict(doc, desc[0]) : null;
    const si = d0 ? asDict(doc, d0.get(N('CIDSystemInfo'))) : null;
    if (!si) return false;
    const reg = strText(look(doc, si.get(N('Registry')))), ord = strText(look(doc, si.get(N('Ordering'))));
    return reg === 'Adobe' && ['Japan1', 'GB1', 'CNS1', 'Korea1', 'KR'].includes(ord);
  }
  if (sub === 'Type3') return !!enc;
  if (enc instanceof PDFName || enc instanceof PDFDict) return true;
  const fd = asDict(doc, f.get(N('FontDescriptor')));
  const flags = fd ? (intOf(look(doc, fd.get(N('Flags')))) ?? 32) : 32;
  const base = nameText(look(doc, f.get(N('BaseFont')))) ?? '';
  return (flags & 4) === 0 || base === 'Symbol' || base === 'ZapfDingbats';
}

function fullName(doc, ref) {
  const parts = [];
  let node = ref;
  for (let i = 0; i < 64 && node; i++) {
    const d = look(doc, node);
    if (!(d instanceof PDFDict)) break;
    const t = text(doc, d, 'T');
    if (t) parts.push(t);
    const p = d.get(N('Parent'));
    node = p instanceof PDFRef ? p : null;
  }
  return parts.reverse().join('.');
}

function pageRule(doc, id, pages, list, scan, tagged) {
  const out = [];
  switch (id) {
    case 'tagged-content': {
      if (!tagged && scan.untagged.size) return [finding(null, "The document isn't tagged, so none of its content is")];
      for (const p of [...scan.untagged.keys()].sort((a, b) => a - b)) {
        const n = scan.untagged.get(p);
        out.push(finding(p, `Page ${p + 1}: ${n} untagged content ${n === 1 ? 'item' : 'items'}`));
      }
      return out;
    }
    case 'tagged-annotations': case 'tagged-multimedia': case 'tagged-form-fields':
      for (const p of list) {
        const page = pages[p];
        if (!page) continue;
        for (const [, a] of annotsOf(doc, page)) {
          const st = nameText(look(doc, a.get(N('Subtype')))) ?? '';
          const applies = id === 'tagged-form-fields' ? st === 'Widget' : id === 'tagged-multimedia' ? MULTIMEDIA.has(st) : st !== 'Widget' && !MULTIMEDIA.has(st) && st !== 'PrinterMark';
          if (applies && !(tagged && a.has(N('StructParent')))) out.push(finding(p, st === 'Widget' ? `Form field on page ${p + 1} isn't tagged` : `${st} annotation on page ${p + 1} isn't tagged`));
        }
      }
      return out;
    case 'tab-order':
      for (const p of list) {
        const page = pages[p];
        if (page && annotsOf(doc, page).length && nameText(look(doc, page.node.get(N('Tabs')))) !== 'S') out.push(finding(p, `Page ${p + 1} doesn't tab in structure order`));
      }
      return out;
    case 'character-encoding': {
      const seen = new Set();
      for (const [p, fonts] of [...scan.fonts.entries()].sort((a, b) => a[0] - b[0])) {
        for (const k of fonts) {
          if (seen.has(k)) continue;
          seen.add(k);
          const f = look(doc, refOfKey(k));
          if (f instanceof PDFDict && !mapsToUnicode(doc, f)) {
            const n = nameText(look(doc, f.get(N('BaseFont'))));
            out.push(finding(p, n ? `Font ${n} on page ${p + 1} doesn't map its characters to Unicode` : `Font (unnamed) on page ${p + 1} doesn't map its characters to Unicode`));
          }
        }
      }
      return out;
    }
    case 'field-descriptions': {
      const seen = new Set();
      for (const p of list) {
        const page = pages[p];
        if (!page) continue;
        for (const [r, a] of annotsOf(doc, page)) {
          if (nameText(look(doc, a.get(N('Subtype')))) !== 'Widget') continue;
          const par = a.get(N('Parent'));
          const field = a.has(N('T')) ? r : par instanceof PDFRef ? par : null;
          if (!field || seen.has(key(field))) continue;
          seen.add(key(field));
          const fd = look(doc, field);
          if (text(doc, fd instanceof PDFDict ? fd : null, 'TU') === null) out.push(finding(p, `Field "${fullName(doc, field)}" on page ${p + 1} has no description (tooltip)`));
        }
      }
      return out;
    }
    default: return out;
  }
}

// ── check ───────────────────────────────────────────────────────────────────────────────────

/**
 * The full check. `options.rules`: rule ids to run (the others are Skipped); `options.pages`: 0-based pages for the page rules (null: all);
 * `options.accessibilityAllowed`: the document's own text-access-for-screen-readers permission (null when it has no security).
 * @returns {{results: {rule: string, status: 'passed'|'failed'|'manual'|'skipped', findings: object[]}[]}}
 */
export function check(doc, options = {}) {
  const rules = new Set(options.rules ?? defaultRules());
  const pages = doc.getPages();
  const list = (options.pages ?? pages.map((_, i) => i)).filter(p => p >= 0 && p < pages.length);
  const tagged = hasStructTree(doc);
  const needScan = ['image-only', 'tagged-content', 'character-encoding'].some(r => rules.has(r));
  const scan = needScan ? scanContent(doc, pages, list) : {hasText: false, hasImages: false, untagged: new Map(), fonts: new Map(), incomplete: new Set()};
  const tree = structureRules(doc, pages, rules);
  const results = [];
  for (const rule of RULES) {
    if (!rules.has(rule.id)) { results.push({rule: rule.id, status: 'skipped', findings: []}); continue; }
    if (rule.manual) { results.push({rule: rule.id, status: 'manual', findings: []}); continue; }
    let findings, total;
    if (rule.category === 'Document') { findings = documentRule(doc, rule.id, pages, scan, options); total = findings.length; }
    else if (rule.category === 'Page Content' || rule.category === 'Forms') { findings = pageRule(doc, rule.id, pages, list, scan, tagged); total = findings.length; }
    else { const t = tree.get(rule.id); findings = t?.findings ?? []; total = t?.total ?? 0; }
    const unsure = scan.incomplete.size > 0 && ((rule.id === 'image-only' && !scan.hasText) || ((rule.id === 'tagged-content' || rule.id === 'character-encoding') && !findings.length));
    if (unsure) { results.push({rule: rule.id, status: 'manual', findings: []}); continue; }
    if (total > MAX_FINDINGS) { findings = findings.slice(0, MAX_FINDINGS); findings.push(finding(null, `… and ${total - MAX_FINDINGS} more`)); }
    results.push({rule: rule.id, status: findings.length ? 'failed' : 'passed', findings});
  }
  return {results, incomplete: [...scan.incomplete].sort((a, b) => a - b)};
}

export const countStatus = (report, status) => report.results.filter(r => r.status === status).length;

/** What the checker says in one line (a11y_ui.rs `run_accessibility_check`). */
export function summarize(report) {
  const failed = countStatus(report, 'failed'), manual = countStatus(report, 'manual'), skipped = countStatus(report, 'skipped'), passed = countStatus(report, 'passed');
  const message = failed === 0 && manual === 0 && skipped === 0 ? 'The checker found no problems in this document.'
    : failed === 1 ? 'The checker found 1 problem which may prevent the document from being fully accessible.'
      : failed > 1 ? `The checker found ${failed} problems which may prevent the document from being fully accessible.`
        : manual > 0 ? `Needs manual check: ${manual}` : `Skipped: ${skipped}`;
  return {failed, manual, skipped, passed, message};
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** report.rs `report_html`: a self-contained page with the summary and, per category, each rule's status, description and problems. */
export function reportHtml(report, fileName, date, lang = 'en') {
  const sum = summarize(report);
  let h = `<!doctype html>\n<html lang="${esc(lang)}"><head><meta charset="utf-8"><title>Accessibility Report</title>\n<style>\n`;
  h += 'body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#1d1d1f}h1{font-size:22px}h2{font-size:17px;margin-top:28px}table{border-collapse:collapse;width:100%}'
    + 'th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f2f2f2}.failed{color:#b3261e;font-weight:600}.passed{color:#1e7b34}ul{margin:4px 0 0;padding-left:18px}\n';
  h += `</style></head><body>\n<h1>Accessibility Report</h1>\n<p>Filename: <b>${esc(fileName)}</b><br>Report created: ${esc(date)}</p>\n<h2>Summary</h2>\n<p>`;
  h += esc(sum.failed > 0 ? 'The checker found problems which may prevent the document from being fully accessible.' : sum.manual > 0 ? `${STATUS_LABEL.manual}: ${sum.manual}` : sum.skipped > 0 ? `${STATUS_LABEL.skipped}: ${sum.skipped}` : 'The checker found no problems in this document.');
  h += '</p>\n<ul>\n';
  for (const s of ['manual', 'skipped', 'passed', 'failed']) h += `<li>${esc(STATUS_LABEL[s])}: ${countStatus(report, s)}</li>\n`;
  h += '</ul>\n<h2>Detailed Report</h2>\n';
  for (const c of CATEGORIES) {
    h += `<h3>${esc(c)}</h3>\n<table><tr><th>Rule Name</th><th>Status</th><th>Description</th></tr>\n`;
    for (const r of report.results.filter(x => RULE_BY_ID[x.rule].category === c)) {
      const rule = RULE_BY_ID[r.rule];
      h += `<tr><td>${esc(rule.name)}</td><td class="${r.status}">${esc(STATUS_LABEL[r.status])}</td><td>${esc(rule.description)}`;
      if (r.findings.length) h += `<ul>${r.findings.map(f => `<li>${esc(f.message)}</li>`).join('')}</ul>`;
      h += '</td></tr>\n';
    }
    h += '</table>\n';
  }
  return `${h}</body></html>\n`;
}

// ── elements, figures, alternate text ───────────────────────────────────────────────────────

/** alt.rs `elements`: the reachable indirect structure elements in document order, each with its page, parent and depth. */
export function elements(doc) {
  const root = structRoot(doc);
  if (!root) return [];
  const out = [];
  const seen = new Set();
  const stack = root.has(N('K')) ? [{k: root.get(N('K')), pg: null, parent: null, depth: 0}] : [];
  while (stack.length) {
    const {k, pg, parent, depth} = stack.pop();
    if (out.length > 1_000_000) break;
    if (k instanceof PDFArray) { const items = k.asArray(); for (let i = items.length - 1; i >= 0; i--) stack.push({k: items[i], pg, parent, depth}); }
    else if (k instanceof PDFRef) {
      if (seen.has(key(k))) continue;
      seen.add(key(k));
      const d = look(doc, k);
      if (!(d instanceof PDFDict) || !d.has(N('S'))) continue;
      const own = d.get(N('Pg'));
      const page = own instanceof PDFRef ? own : pg;
      if (d.has(N('K'))) stack.push({k: d.get(N('K')), pg: page, parent: k, depth: depth + 1});
      out.push({ref: k, dict: d, page, parent, depth});
    } else if (k instanceof PDFDict && k.has(N('S'))) {
      const own = k.get(N('Pg'));
      if (k.has(N('K'))) stack.push({k: k.get(N('K')), pg: own instanceof PDFRef ? own : pg, parent, depth});
    }
  }
  return out;
}

const mcidsOf = (doc, d) => {
  const out = [];
  const push = o => {
    const v = o instanceof PDFRef ? look(doc, o) : o;
    if (v instanceof PDFNumber) out.push(v.asNumber());
    else if (v instanceof PDFDict && nameText(look(doc, v.get(N('Type')))) === 'MCR') { const n = intOf(look(doc, v.get(N('MCID')))); if (n !== undefined) out.push(n); }
  };
  const k = d.get(N('K'));
  if (k instanceof PDFArray) k.asArray().forEach(push); else if (k) push(k);
  return out;
};

const isFigure = (doc, roleMap, d) => { const s = nameText(look(doc, d.get(N('S')))); return !!s && standardType(doc, roleMap, s) === 'Figure'; };

/** alt.rs `figures`: every Figure element with its page and alternate text. */
export function figures(doc) {
  const root = structRoot(doc);
  if (!root) return [];
  const roleMap = roleMapOf(doc, root);
  const index = new Map(doc.getPages().map((p, i) => [key(p.ref), i]));
  return elements(doc).filter(e => isFigure(doc, roleMap, e.dict)).map(e => ({object: key(e.ref), page: e.page && index.has(key(e.page)) ? index.get(key(e.page)) : null, alt: text(doc, e.dict, 'Alt')}));
}

export class A11yError extends Error { constructor(message, code = 'failed') { super(message); this.name = 'A11yError'; this.code = code; } }

function checkFigure(doc, k) {
  const root = structRoot(doc);
  if (!root) throw new A11yError('the document has no tags');
  const d = look(doc, refOfKey(k));
  if (!(d instanceof PDFDict) || !isFigure(doc, roleMapOf(doc, root), d)) throw new A11yError(`object ${k.split(' ')[0]} is not a figure`);
  return d;
}

/** alt.rs `set_alt`: /Alt on a figure; blank text removes it. */
export function setAlt(doc, k, alt) {
  const d = checkFigure(doc, k);
  const t = String(alt ?? '').trim();
  if (t) d.set(N('Alt'), text16(t)); else d.delete(N('Alt'));
}

function clearParentTree(doc, keyNum, obj) {
  const root = structRoot(doc);
  const pt = root?.get(N('ParentTree'));
  const tree = pt ? asDict(doc, pt) : null;
  const nums = tree ? arrayOf(doc, tree.get(N('Nums'))) : null;
  if (!tree || !nums) return;
  const wipe = a => a.asArray().map(x => (x instanceof PDFRef && key(x) === key(obj) ? doc.context.obj(null) : x));
  for (let i = 0; i + 1 < nums.length; i += 2) {
    if (intOf(look(doc, nums[i])) !== keyNum) continue;
    const v = nums[i + 1];
    if (v instanceof PDFArray) nums[i + 1] = doc.context.obj(wipe(v));
    else if (v instanceof PDFRef) { const a = look(doc, v); if (a instanceof PDFArray) doc.context.assign(v, doc.context.obj(wipe(a))); }
  }
  tree.set(N('Nums'), doc.context.obj(nums));
}

const removeFromParent = (doc, parent, obj) => {
  const p = look(doc, parent);
  if (!(p instanceof PDFDict)) return;
  const kids = p.get(N('K'));
  if (kids instanceof PDFArray) p.set(N('K'), doc.context.obj(kids.asArray().filter(x => !(x instanceof PDFRef && key(x) === key(obj)))));
  else if (kids instanceof PDFRef && key(kids) === key(obj)) p.set(N('K'), doc.context.obj([]));
};

/** Marked content with the given MCIDs on `page` becomes `/Artifact BMC`; returns whether anything changed (alt.rs artifact_marked_content). */
function artifactMarkedContent(doc, page, ids, {requireAll = false} = {}) {
  const props = asDict(doc, pageResources(page)?.get(N('Properties')));
  const streams = pageStreams(doc, page);
  const found = new Set();
  const rewritten = streams.map(s => {
    const ops = parseContent(s.bytes);
    let changed = false;
    for (const op of ops) {
      if (op.op !== 'BDC') continue;
      const a = op.args[1];
      let id;
      if (a?.k === 'dict') { const e = a.entries.find(([k]) => k === 'MCID'); id = e?.[1]?.k === 'num' ? e[1].v : undefined; }
      else if (a?.k === 'name') { const d = asDict(doc, props?.get(N(a.v))); id = d ? intOf(look(doc, d.get(N('MCID')))) : undefined; }
      if (id !== undefined && ids.has(id)) { op.op = 'BMC'; op.args = [{k: 'name', v: 'Artifact'}]; changed = true; found.add(id); }
    }
    return changed ? ops : null;
  });
  if (requireAll && found.size !== ids.size) throw new A11yError("the tag's marked content was not found on its page");
  if (!rewritten.some(Boolean)) return false;
  rewritten.forEach((ops, i) => {
    if (!ops) return;
    const ref = streams[i].ref;
    const packed = doc.context.flateStream(serializeContent(ops));
    if (ref instanceof PDFRef) doc.context.assign(ref, packed);
    else { const nr = doc.context.register(packed); const c = page.node.get(N('Contents')); if (c instanceof PDFArray) c.set(i, nr); else page.node.set(N('Contents'), nr); }
  });
  return true;
}

const pageOfRef = (doc, ref) => doc.getPages().find(p => ref && key(p.ref) === key(ref)) ?? null;

/** alt.rs `mark_decorative`: the figure's marked content becomes an artifact and the figure leaves the tree. */
export function markDecorative(doc, k) {
  const d = checkFigure(doc, k);
  const ids = new Set(mcidsOf(doc, d));
  const obj = refOfKey(k);
  const own = d.get(N('Pg'));
  const pg = own instanceof PDFRef ? own : elements(doc).find(e => key(e.ref) === k)?.page;
  const page = pageOfRef(doc, pg);
  if (page && ids.size && artifactMarkedContent(doc, page, ids)) {
    const sp = intOf(look(doc, page.node.get(N('StructParents'))));
    if (sp !== undefined) clearParentTree(doc, sp, obj);
  }
  const par = d.get(N('P'));
  if (par instanceof PDFRef) removeFromParent(doc, par, obj);
}

const hasChildStructure = (doc, tag) => {
  const child = it => (it instanceof PDFArray ? it.asArray().some(child) : it instanceof PDFRef ? (look(doc, it) instanceof PDFDict && look(doc, it).has(N('S'))) : it instanceof PDFDict && it.has(N('S')));
  const k = tag.get(N('K'));
  return !!k && child(k);
};

/** alt.rs `mark_tag_artifact`: a leaf tag's marked content becomes an artifact and the tag leaves its parent and the parent tree. */
export function markTagArtifact(doc, k) {
  if (!structRoot(doc)) throw new A11yError('the document has no tags');
  const element = elements(doc).find(e => key(e.ref) === k);
  if (!element) throw new A11yError(`object ${k.split(' ')[0]} is not a reachable indirect structure tag`);
  if (hasChildStructure(doc, element.dict)) throw new A11yError('the tag has child structure elements; mark a leaf tag instead');
  const ids = new Set(mcidsOf(doc, element.dict));
  if (!ids.size) throw new A11yError('the tag has no direct marked content');
  const page = pageOfRef(doc, element.page);
  if (!page) throw new A11yError('the tag has no page');
  artifactMarkedContent(doc, page, ids, {requireAll: true});
  const sp = intOf(look(doc, page.node.get(N('StructParents'))));
  if (sp !== undefined) clearParentTree(doc, sp, element.ref);
  const par = element.dict.get(N('P'));
  if (!(par instanceof PDFRef)) throw new A11yError('the tag has no removable structure-tree parent');
  const p = look(doc, par);
  const kids = p instanceof PDFDict ? p.get(N('K')) : null;
  const n = kids instanceof PDFArray ? kids.asArray().filter(x => x instanceof PDFRef && key(x) === k).length : kids instanceof PDFRef && key(kids) === k ? 1 : 0;
  if (n !== 1) throw new A11yError('the parent must list the tag exactly once');
  removeFromParent(doc, par, element.ref);
  element.dict.delete(N('P'));
}

// ── tags ────────────────────────────────────────────────────────────────────────────────────

const attributeEntries = (doc, d) => {
  const a = d.get(N('A'));
  if (!a) return {entries: [], array: false};
  const r = look(doc, a);
  if (!(r instanceof PDFArray)) return {entries: [{o: a, rev: null}], array: false};
  const entries = [];
  for (const item of r.asArray()) {
    const last = entries[entries.length - 1];
    if (item instanceof PDFNumber && last && last.rev === null) last.rev = item; else entries.push({o: item, rev: null});
  }
  return {entries, array: true};
};
const tableAttribute = (doc, d, k) => {
  for (const {o} of attributeEntries(doc, d).entries) {
    const v = look(doc, o);
    if (v instanceof PDFDict && nameText(look(doc, v.get(N('O')))) === 'Table' && v.has(N(k))) return look(doc, v.get(N(k)));
  }
  return undefined;
};

/** tags.rs `tags`: every reachable tag with its properties. */
export function tags(doc) {
  const index = new Map(doc.getPages().map((p, i) => [key(p.ref), i]));
  return elements(doc).map(e => {
    const kind = nameText(look(doc, e.dict.get(N('S'))));
    if (!kind) return null;
    const summary = tableAttribute(doc, e.dict, 'Summary'), scope = tableAttribute(doc, e.dict, 'Scope');
    return {object: key(e.ref), parent: e.parent ? key(e.parent) : null, depth: e.depth, kind, title: text(doc, e.dict, 'T') ?? null, actualText: text(doc, e.dict, 'ActualText') ?? null,
      alt: text(doc, e.dict, 'Alt') ?? null, language: text(doc, e.dict, 'Lang') ?? null, summary: strText(summary) ?? null, scope: nameText(scope) ?? null,
      page: e.page && index.has(key(e.page)) ? index.get(key(e.page)) : null};
  }).filter(Boolean);
}

export const TAG_PROPERTIES = ['type', 'title', 'actual_text', 'alternate_text', 'language', 'summary', 'scope'];
const PROP_KEY = {type: 'S', title: 'T', actual_text: 'ActualText', alternate_text: 'Alt', language: 'Lang', summary: 'Summary', scope: 'Scope'};
const TABLE_ATTR_OF = {summary: 'Table', scope: 'TH'};

function setTableAttribute(doc, element, k, value) {
  const {entries, array} = attributeEntries(doc, element.dict);
  const list = entries.map(e => { const v = look(doc, e.o); return {...e, table: v instanceof PDFDict && nameText(look(doc, v.get(N('O')))) === 'Table' ? v : null}; });
  const holding = e => e.table && e.table.has(N(k));
  if (value !== null) {
    let i = list.findIndex(holding);
    if (i < 0) i = list.findIndex(e => e.table);
    if (i >= 0) { list[i].table.set(N(k), value); list[i].o = list[i].table; }
    else list.push({o: doc.context.obj({O: 'Table', [k]: value}), rev: null, table: null});
  } else {
    if (!list.some(holding)) return;
    for (const e of list) if (e.table && e.table.has(N(k))) { e.table.delete(N(k)); e.o = e.table; }
    for (let i = list.length - 1; i >= 0; i--) if (list[i].table && [...list[i].table.keys()].every(x => x.decodeText() === 'O')) list.splice(i, 1);
  }
  if (!list.length) element.dict.delete(N('A'));
  else if (list.length === 1 && list[0].rev === null && !array) element.dict.set(N('A'), list[0].o);
  else element.dict.set(N('A'), doc.context.obj(list.flatMap(e => (e.rev ? [e.o, e.rev] : [e.o]))));
}

/** tags.rs `set_tag_property`: an empty value removes the property. */
export function setTagProperty(doc, k, property, value) {
  const element = elements(doc).find(e => key(e.ref) === k);
  if (!element) throw new A11yError(`object ${k} is not a reachable indirect structure tag`);
  if (!TAG_PROPERTIES.includes(property)) throw new A11yError(`unknown tag property ${property}`);
  const v = value === null || value === undefined || value === '' ? null : String(value);
  if (v !== null && new TextEncoder().encode(v).length > 65_536) throw new A11yError('tag property text is too long (maximum 65536 bytes)');
  if (property === 'type' && !(v !== null && v.length <= 127 && /^[A-Za-z0-9:._-]+$/.test(v))) throw new A11yError('a tag type must be a nonempty PDF name using letters, digits, colon, period, underscore or hyphen');
  const owner = TABLE_ATTR_OF[property];
  if (owner) {
    const ty = standardType(doc, roleMapOf(doc, structRoot(doc)), nameText(look(doc, element.dict.get(N('S')))) ?? '');
    if (ty !== owner) throw new A11yError(`${property} applies only to ${owner} tags`);
    let obj = null;
    if (v !== null) {
      if (property === 'scope') { if (!['Row', 'Column', 'Both'].includes(v)) throw new A11yError('a scope must be Row, Column or Both'); obj = N(v); }
      else obj = text16(v);
    }
    return setTableAttribute(doc, element, PROP_KEY[property], obj);
  }
  const pk = N(PROP_KEY[property]);
  if (v === null) element.dict.delete(pk); else element.dict.set(pk, property === 'type' ? N(v) : text16(v));
}

/** tags.rs `move_tag`: `object` goes before or after its sibling `anchor`. */
export function moveTag(doc, object, anchor, placement = 'before') {
  if (object === anchor) throw new A11yError('both tags must be distinct, reachable, direct children of the same structure parent');
  const all = elements(doc);
  if (!all.some(e => key(e.ref) === object) || !all.some(e => key(e.ref) === anchor)) throw new A11yError('both tags must be distinct, reachable, direct children of the same structure parent');
  const parentOf = k => { const d = look(doc, refOfKey(k)); const p = d instanceof PDFDict ? d.get(N('P')) : null; return p instanceof PDFRef ? key(p) : null; };
  const parent = parentOf(object);
  if (!parent || parentOf(anchor) !== parent) throw new A11yError('both tags must be distinct, reachable, direct children of the same structure parent');
  const owner = look(doc, refOfKey(parent));
  const kids = owner instanceof PDFDict ? look(doc, owner.get(N('K'))) : null;
  if (!(kids instanceof PDFArray)) throw new A11yError('the parent must list each tag exactly once in its /K array');
  const items = kids.asArray();
  const at = k => { const m = items.map((x, i) => (x instanceof PDFRef && key(x) === k ? i : -1)).filter(i => i >= 0); return m.length === 1 ? m[0] : -1; };
  const from = at(object), to = at(anchor);
  if (from < 0 || to < 0) throw new A11yError('the parent must list each tag exactly once in its /K array');
  const next = [...items];
  const [moved] = next.splice(from, 1);
  const target = from < to ? to - 1 : to;
  const dest = target + (placement === 'after' ? 1 : 0);
  if (dest === from) throw new A11yError('the tag is already at the requested position');
  next.splice(dest, 0, moved);
  owner.set(N('K'), doc.context.obj(next));
}

// ── Automatically tag PDF, Tag form fields ──────────────────────────────────────────────────

const MAX_PAGES = 1000, MAX_OPERATORS = 100_000, MAX_TEXT_OBJECTS = 4096;
const HARMLESS_OUTSIDE = new Set(['q', 'Q', 'cm', 'w', 'J', 'j', 'M', 'd', 'ri', 'i', 'gs', 'G', 'g', 'RG', 'rg', 'K', 'k', 'CS', 'cs', 'SC', 'sc', 'SCN', 'scn']);
const HARMLESS_INSIDE = new Set(['Tf', 'Tc', 'Tw', 'Tz', 'TL', 'Tr', 'Ts', 'Td', 'TD', 'Tm', 'T*', 'G', 'g', 'RG', 'rg', 'K', 'k', 'CS', 'cs', 'SC', 'sc', 'SCN', 'scn']);

/** autotag.rs `autotag_text`: a page of text becomes a Document of P elements, one per text object. Anything else on the page stops it, saying what. */
export function autotagText(doc) {
  if (doc.catalog.has(N('StructTreeRoot'))) throw new A11yError('the document already has a structure tree; review its existing tags instead');
  const unsupported = (i, why) => new A11yError(`page ${i + 1}: ${why}`);
  if (doc.catalog.has(N('AcroForm'))) throw unsupported(0, 'form fields need their own tags; this text-only action cannot tag them (use Tag form fields)');
  const pages = doc.getPages();
  if (pages.length > MAX_PAGES) throw new A11yError(`the document has too many pages to auto-tag in one edit (maximum ${MAX_PAGES})`);
  const plans = [];
  let total = 0;
  pages.forEach((page, index) => {
    if (page.node.has(N('StructParents'))) throw unsupported(index, 'page already has a structure parent key');
    const annots = look(doc, page.node.get(N('Annots')));
    if (annots && (!(annots instanceof PDFArray) || annots.size() > 0)) throw unsupported(index, 'annotations need separate structure tags');
    let streams;
    try { streams = pageStreams(doc, page); } catch (e) { throw unsupported(index, `content cannot be decoded: ${e.message}`); }
    const all = new Uint8Array(streams.reduce((n, s) => n + s.bytes.length + 1, 0));
    let at = 0;
    for (const s of streams) { all.set(s.bytes, at); at += s.bytes.length; all[at++] = 32; }
    const ops = parseContent(all);
    if (ops.length > MAX_OPERATORS) throw unsupported(index, 'content has too many operators');
    let start = null, hasText = false;
    const spans = [];
    ops.forEach((op, i) => {
      const name = op.op;
      if (name === 'BT' && start === null) { start = i; hasText = false; }
      else if (name === 'ET') {
        if (start === null) throw unsupported(index, 'unmatched ET operator');
        if (hasText) { spans.push([start, i]); if (spans.length > MAX_TEXT_OBJECTS) throw unsupported(index, 'too many text objects (maximum 4096)'); }
        start = null;
      } else if (start !== null && ['Tj', 'TJ', "'", '"'].includes(name)) hasText = true;
      else if (start !== null && HARMLESS_INSIDE.has(name)) { /* state only */ }
      else if (start === null && HARMLESS_OUTSIDE.has(name)) { /* state only */ }
      else throw unsupported(index, `unsupported or painted operator ${name}`);
    });
    if (start !== null) throw unsupported(index, 'unterminated BT text object');
    total += spans.length;
    plans.push({page, ops, spans});
  });
  if (!total) throw new A11yError('the document has no text objects to tag');
  const ctx = doc.context;
  const rootRef = ctx.nextRef(), docRef = ctx.nextRef();
  const children = [], numbers = [];
  let taggedPages = 0, paragraphs = 0;
  for (const plan of plans) {
    if (!plan.spans.length) continue;
    const keyNum = taggedPages;
    const parents = [];
    const starts = new Map(), ends = new Set();
    plan.spans.forEach(([first, last], mcid) => {
      const ref = ctx.register(ctx.obj({Type: 'StructElem', S: 'P', P: docRef, Pg: plan.page.ref, K: mcid}));
      parents.push(ref); children.push(ref);
      starts.set(first, mcid); ends.add(last);
      paragraphs++;
    });
    const marked = [];
    plan.ops.forEach((op, i) => {
      if (starts.has(i)) marked.push({op: 'BDC', args: [{k: 'name', v: 'P'}, {k: 'dict', entries: [['MCID', {k: 'num', v: starts.get(i)}]]}]});
      marked.push(op);
      if (ends.has(i)) marked.push({op: 'EMC', args: []});
    });
    const stream = ctx.register(ctx.flateStream(serializeContent(marked)));
    plan.page.node.set(N('Contents'), stream);
    plan.page.node.set(N('StructParents'), PDFNumber.of(keyNum));
    numbers.push(PDFNumber.of(keyNum), ctx.obj(parents));
    taggedPages++;
  }
  const parentTree = ctx.register(ctx.obj({Nums: numbers}));
  ctx.assign(docRef, ctx.obj({Type: 'StructElem', S: 'Document', P: rootRef, K: children}));
  ctx.assign(rootRef, ctx.obj({Type: 'StructTreeRoot', K: docRef, ParentTree: parentTree, ParentTreeNextKey: taggedPages}));
  const mi = asDict(doc, doc.catalog.get(N('MarkInfo')));
  const markInfo = mi ? mi : ctx.obj({});
  markInfo.set(N('Marked'), PDFBool.True);
  doc.catalog.set(N('StructTreeRoot'), rootRef);
  doc.catalog.set(N('MarkInfo'), markInfo);
  return {pages: taggedPages, paragraphs};
}

/** autotag_fields.rs `tag_form_fields`: a Form element holding an object reference for each untagged widget. */
export function tagFormFields(doc) {
  const ctx = doc.context;
  const cat = doc.catalog;
  if (!cat.has(N('AcroForm'))) throw new A11yError('the PDF has no AcroForm fields');
  const widgets = [];
  const seen = new Set();
  for (const page of doc.getPages()) {
    for (const a of arrayOf(doc, page.node.get(N('Annots'))) ?? []) {
      if (!(a instanceof PDFRef)) continue;
      const d = look(doc, a);
      if (d instanceof PDFDict && nameText(look(doc, d.get(N('Subtype')))) === 'Widget' && !d.has(N('StructParent')) && !seen.has(key(a))) { seen.add(key(a)); widgets.push([page.ref, a]); }
    }
  }
  if (!widgets.length) throw new A11yError('the AcroForm has no untagged page widgets');
  const existing = cat.get(N('StructTreeRoot'));
  let structRef, docRef, parentTree, nums, firstKey, fresh = false;
  if (existing) {
    if (!(existing instanceof PDFRef)) throw new A11yError('the structure tree root must be an indirect reference');
    structRef = existing;
    const sr = look(doc, structRef);
    if (!(sr instanceof PDFDict)) throw new A11yError('the structure tree root is invalid');
    docRef = sr.get(N('K'));
    if (!(docRef instanceof PDFRef)) throw new A11yError('the structure tree root K must be an indirect reference');
    const dd = look(doc, docRef);
    if (!(dd instanceof PDFDict) || nameText(look(doc, dd.get(N('S')))) !== 'Document') throw new A11yError('the structure tree root must point directly to a Document element');
    parentTree = sr.get(N('ParentTree'));
    if (!(parentTree instanceof PDFRef)) throw new A11yError('the structure parent tree must be an indirect reference');
    const pt = look(doc, parentTree);
    const arr = pt instanceof PDFDict ? look(doc, pt.get(N('Nums'))) : null;
    if (!(arr instanceof PDFArray)) throw new A11yError('the structure parent tree must use a direct Nums array');
    nums = arr.asArray();
    if (nums.length % 2) throw new A11yError('the structure parent tree has an odd number of entries');
    let greatest = -1;
    for (let i = 0; i < nums.length; i += 2) { const n = intOf(nums[i]); if (n === undefined) throw new A11yError('the structure parent tree has a non-integer key'); if (n < 0) throw new A11yError('the structure parent tree has a negative key'); greatest = Math.max(greatest, n); }
    firstKey = greatest + 1;
  } else {
    fresh = true;
    structRef = ctx.register(ctx.obj({Type: 'StructTreeRoot'}));
    docRef = ctx.register(ctx.obj({S: 'Document', P: structRef}));
    parentTree = ctx.register(ctx.obj({}));
    nums = []; firstKey = 0;
  }
  const kids = [];
  widgets.forEach(([pageRef, widget], i) => {
    const keyNum = firstKey + i;
    const objr = ctx.obj({Type: 'OBJR', Obj: widget, Pg: pageRef});
    const formRef = ctx.register(ctx.obj({S: 'Form', P: docRef, Pg: pageRef, K: objr}));
    look(doc, widget).set(N('StructParent'), PDFNumber.of(keyNum));
    nums.push(PDFNumber.of(keyNum), formRef);
    kids.push(formRef);
  });
  const dd = look(doc, docRef);
  const old = dd.get(N('K'));
  const all = old === undefined ? [] : old instanceof PDFArray ? old.asArray() : [old];
  dd.set(N('K'), ctx.obj([...all, ...kids]));
  look(doc, parentTree).set(N('Nums'), ctx.obj(nums));
  if (fresh) { const sr = look(doc, structRef); sr.set(N('K'), docRef); sr.set(N('ParentTree'), parentTree); }
  const mi = asDict(doc, cat.get(N('MarkInfo'))) ?? ctx.obj({});
  mi.set(N('Marked'), PDFBool.True);
  cat.set(N('MarkInfo'), mi);
  if (fresh) cat.set(N('StructTreeRoot'), structRef);
  return widgets.length;
}

// ── fixes ───────────────────────────────────────────────────────────────────────────────────

/** The document language (/Lang) and the title the window shows (a11y_ui.rs `Fix`: language and title are chosen in Document Properties). */
export function setReadingOptions(doc, {language, title, displayTitle, tabOrder} = {}) {
  const done = [];
  if (language !== undefined) {
    const l = String(language).trim();
    if (l && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(l)) throw new A11yError('a language is a tag such as en, en-US or ar');
    if (l) doc.catalog.set(N('Lang'), PDFString.of(l)); else doc.catalog.delete(N('Lang'));
    done.push('language');
  }
  if (title !== undefined) {
    const t = String(title).trim();
    let info = infoDict(doc);
    if (!info) { const ref = doc.context.register(doc.context.obj({})); doc.context.trailerInfo.Info = ref; info = look(doc, ref); }
    if (t) info.set(N('Title'), text16(t)); else info.delete(N('Title'));
    done.push('title');
  }
  if (displayTitle !== undefined) {
    let vp = asDict(doc, doc.catalog.get(N('ViewerPreferences')));
    if (!vp) { vp = doc.context.obj({}); doc.catalog.set(N('ViewerPreferences'), vp); }
    vp.set(N('DisplayDocTitle'), displayTitle ? PDFBool.True : PDFBool.False);
    done.push('displayTitle');
  }
  if (tabOrder) {
    let n = 0;
    for (const page of doc.getPages()) if (annotsOf(doc, {node: page.node}).length) { page.node.set(N('Tabs'), N('S')); n++; }
    done.push(`tabOrder (${n} pages)`);
  }
  return done;
}

export const infoTitle = doc => text(doc, infoDict(doc), 'Title');
export const documentLanguage = doc => text(doc, doc.catalog, 'Lang');
export const displayDocTitle = doc => { const vp = asDict(doc, doc.catalog.get(N('ViewerPreferences'))); const v = vp ? look(doc, vp.get(N('DisplayDocTitle'))) : null; return v instanceof PDFBool && v.asBoolean(); };
export {key as objectKey};
