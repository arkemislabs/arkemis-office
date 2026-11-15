// Slate schema 2: the notebook document and the ProseMirror schema of a page (F:slate foundation,
// docs/architecture.md sections 14.6 and 16.5).
//
// Slate has no ArtCraft upstream: the shape follows docs/spec/slate.json `dataModel` (notebook →
// section groups → sections → pages; a page holds note containers, ink and page styles) and
// OneNote's behaviour. The ProseMirror schema is built headlessly from @tiptap/pm/model, so the
// same commands run in the renderer (with the editor) and in the main-process headless host.
//
// A Slate document is one notebook. Its home is a folder the person chose (sections are folders
// with one file per page, see core/slate/lib/notebook-folder.mjs); in the vault it is stored as
// this content object:
//
//   content = {
//     format: 'arkemis.slate-notebook', version: 1,
//     notebook: {id, name, color, created, path: string|null},
//     tree:     [itemId...],                               top-level sections and section groups
//     groups:   {[id]: {id, name, created, items: [itemId...]}},
//     sections: {[id]: {id, name, color, created, pages: [{id, level: 0|1|2}]}},
//     pages:    {[id]: {id, title, created, modified, color, rule: {pattern, color}, titleHidden,
//                       paperSize, body: <ProseMirror doc JSON>, ink: [Stroke]}},
//   }
//
// Collections are keyed by id so a change copies one small record (2,000-page notebooks stay
// cheap, see tests/slate/foundation-benchmark.test.mjs). Order lives in `tree`, `groups[].items`
// and `sections[].pages`. Units may add fields to these records (password, versions, recycle
// bin): validation checks the fields named here and leaves the others alone.
//
// App op (kernel change.apply, section 4.2): {type: 'steps', page, steps: StepJSON[], modified}
// applies ProseMirror steps to one page body; its inverse is the inverted steps.
//
// No DOM, no Node built-ins.

import {Schema} from '@tiptap/pm/model';
import {Step, Mapping} from '@tiptap/pm/transform';
import {CommandError} from '../kernel/errors.mjs';

export const NOTEBOOK_FORMAT = 'arkemis.slate-notebook';
export const CONTENT_VERSION = 1;

/** OneNote paragraph styles (Home › Styles): Heading 1–6, Page Title, Citation, Quote, Code, Normal. */
export const PARAGRAPH_STYLES = Object.freeze(['normal', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pageTitle', 'citation', 'quote', 'code']);
/** View › Page Setup › Rule Lines patterns (spec `page.ruleLines` args). */
export const RULE_PATTERNS = Object.freeze(['none', 'narrow-ruled', 'college-ruled', 'standard-ruled', 'wide-ruled',
  'small-grid', 'medium-grid', 'large-grid', 'very-large-grid']);
export const DEFAULT_RULE_COLOR = '#9fbfe0';
export const MAX_LEVEL = 2;
/** What a stroke is drawn with (Draw › Pens): a pen, a pencil or a highlighter; `fx` is the galaxy or rainbow ink. */
export const INK_KINDS = Object.freeze(['pen', 'pencil', 'highlighter']);
export const INK_FX = Object.freeze(['galaxy', 'rainbow']);
export const LIMITS = Object.freeze({pages: 20000, sections: 2000, groups: 500, nameLength: 100, titleLength: 255, strokes: 20000, points: 200000});

const id = {id: {default: null}};
/** "12 KB" for a file size in bytes (the attachment chip). */
export function sizeText(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
const attr = (el, name) => el.getAttribute(name);
const num = v => (v === null || v === undefined || v === '' ? null : Number(v));

// ---------------------------------------------------------------------------------------------
// ProseMirror schema of a page body

export const schema = new Schema({
  nodes: {
    doc: {content: 'container*'},
    /** A note container (OneNote "outline"): free-positioned on the page canvas, CSS px from the page origin. */
    container: {
      content: 'block+',
      attrs: {...id, x: {default: 48}, y: {default: 96}, width: {default: null}},
      isolating: true, defining: true, selectable: true, draggable: false,
      parseDOM: [{tag: 'div[data-slate-container]', getAttrs: el => ({id: attr(el, 'data-id'), x: num(attr(el, 'data-x')) ?? 48, y: num(attr(el, 'data-y')) ?? 96, width: num(attr(el, 'data-width'))})}],
      toDOM: n => ['div', {'data-slate-container': '', 'data-id': n.attrs.id, 'data-x': String(n.attrs.x), 'data-y': String(n.attrs.y), ...(n.attrs.width ? {'data-width': String(n.attrs.width)} : {})}, 0],
    },
    paragraph: {
      content: 'inline*', group: 'block',
      attrs: {...id, style: {default: 'normal'}, align: {default: null}, indent: {default: 0}, dir: {default: null}, tags: {default: []}, spacing: {default: null}, audio: {default: null}},
      parseDOM: [
        {tag: 'p', getAttrs: el => ({style: attr(el, 'data-style') || 'normal', align: el.style?.textAlign || null})},
        ...[1, 2, 3, 4, 5, 6].map(level => ({tag: `h${level}`, attrs: {style: `h${level}`}})),
        {tag: 'blockquote', attrs: {style: 'quote'}},
        {tag: 'pre', attrs: {style: 'code'}, preserveWhitespace: 'full'},
        {tag: 'cite', attrs: {style: 'citation'}},
      ],
      toDOM: n => {
        const tag = /^h[1-6]$/.test(n.attrs.style) ? n.attrs.style : n.attrs.style === 'code' ? 'pre' : 'p';
        const style = [n.attrs.align ? `text-align:${n.attrs.align}` : '', n.attrs.indent ? `margin-left:${n.attrs.indent * 0.5}in` : ''].filter(Boolean).join(';');
        return [tag, {'data-id': n.attrs.id, 'data-style': n.attrs.style, ...(n.attrs.dir ? {dir: n.attrs.dir} : {}), ...(style ? {style} : {}),
          ...(n.attrs.audio ? {'data-audio-media': n.attrs.audio.media, 'data-audio-at': String(n.attrs.audio.t)} : {})}, 0];
      },
    },
    bulletList: {
      content: 'listItem+', group: 'block', attrs: {...id, symbol: {default: null}},
      parseDOM: [{tag: 'ul'}], toDOM: n => ['ul', {'data-id': n.attrs.id}, 0],
    },
    orderedList: {
      content: 'listItem+', group: 'block', attrs: {...id, start: {default: 1}, format: {default: 'decimal'}},
      parseDOM: [{tag: 'ol', getAttrs: el => ({start: num(attr(el, 'start')) ?? 1})}],
      toDOM: n => ['ol', {'data-id': n.attrs.id, ...(n.attrs.start !== 1 ? {start: String(n.attrs.start)} : {}), 'data-format': n.attrs.format}, 0],
    },
    listItem: {
      content: 'paragraph block*', attrs: {...id}, defining: true,
      parseDOM: [{tag: 'li'}], toDOM: n => ['li', {'data-id': n.attrs.id}, 0],
    },
    table: {
      content: 'tableRow+', group: 'block', isolating: true,
      attrs: {...id, hideBorders: {default: false}, headerRow: {default: false}, sortHeader: {default: false}, widths: {default: null}},
      parseDOM: [{tag: 'table'}], toDOM: n => ['table', {'data-id': n.attrs.id, ...(n.attrs.hideBorders ? {'data-hide-borders': ''} : {}), ...(n.attrs.headerRow ? {'data-header-row': ''} : {})}, ['tbody', 0]],
    },
    tableRow: {content: 'tableCell+', attrs: {...id}, parseDOM: [{tag: 'tr'}], toDOM: n => ['tr', {'data-id': n.attrs.id}, 0]},
    tableCell: {
      content: 'block+', isolating: true, attrs: {...id, shading: {default: null}},
      parseDOM: [{tag: 'td'}, {tag: 'th'}],
      toDOM: n => ['td', {'data-id': n.attrs.id, ...(n.attrs.shading ? {style: `background:${n.attrs.shading}`} : {})}, 0],
    },
    text: {group: 'inline'},
    hardBreak: {inline: true, group: 'inline', selectable: false, parseDOM: [{tag: 'br'}], toDOM: () => ['br']},
    image: {
      inline: true, group: 'inline', atom: true, draggable: true,
      attrs: {...id, src: {default: ''}, alt: {default: ''}, title: {default: null}, width: {default: null}, height: {default: null}},
      parseDOM: [{tag: 'img[src]', getAttrs: el => ({src: attr(el, 'src'), alt: attr(el, 'alt') ?? '', width: num(attr(el, 'width')), height: num(attr(el, 'height'))})}],
      toDOM: n => ['img', {'data-id': n.attrs.id, src: n.attrs.src, alt: n.attrs.alt, ...(n.attrs.width ? {width: String(n.attrs.width)} : {}), ...(n.attrs.height ? {height: String(n.attrs.height)} : {})}],
    },
    /** A file on the page (Insert › File Attachment / File Printout): stored inline as data or a path. */
    attachment: {
      inline: true, group: 'inline', atom: true,
      attrs: {...id, name: {default: ''}, mime: {default: null}, size: {default: null}, data: {default: null}, path: {default: null}},
      toDOM: n => ['span', {'data-id': n.attrs.id, 'data-attachment': n.attrs.name, 'data-mime': n.attrs.mime ?? '', title: n.attrs.name, contenteditable: 'false'},
        ['i', {class: 'slate-att-icon'}], ['span', {class: 'slate-att-name'}, n.attrs.name], ...(n.attrs.size ? [['span', {class: 'slate-att-size'}, sizeText(n.attrs.size)]] : [])],
    },
    /** Audio or video recorded or inserted on the page (Insert › Record Audio / Video). */
    media: {
      inline: true, group: 'inline', atom: true,
      attrs: {...id, kind: {default: 'audio'}, src: {default: ''}, name: {default: ''}, duration: {default: null}, recorded: {default: null}, mime: {default: null}},
      toDOM: n => ['span', {'data-id': n.attrs.id, 'data-media': n.attrs.kind, ...(n.attrs.duration !== null ? {'data-duration': String(n.attrs.duration)} : {})}, n.attrs.name],
    },
    /** An equation (Insert › Equation), linear format text. */
    equation: {
      inline: true, group: 'inline', atom: true,
      attrs: {...id, linear: {default: ''}, display: {default: false}, format: {default: 'professional'}, normalText: {default: false}},
      toDOM: n => ['span', {'data-id': n.attrs.id, 'data-equation': '', 'data-linear': n.attrs.linear, ...(n.attrs.display ? {'data-display': ''} : {}),
        ...(n.attrs.format === 'linear' ? {'data-format': 'linear'} : {}), ...(n.attrs.normalText ? {'data-normal-text': ''} : {})}, n.attrs.linear],
    },
    /** A worksheet on the page (Insert > Files > Spreadsheet): typed cells and what each shows (core/slate/lib/sheet.mjs). */
    spreadsheet: {
      inline: true, group: 'inline', atom: true, draggable: true,
      attrs: {...id, rows: {default: 6}, cols: {default: 5}, cells: {default: {}}, shown: {default: {}}, title: {default: ''}},
      parseDOM: [{tag: 'span[data-spreadsheet]', getAttrs: el => {
        try {
          const j = JSON.parse(attr(el, 'data-spreadsheet') || '{}');
          const rows = Math.max(1, Math.min(100, Math.round(Number(j.rows) || 6))), cols = Math.max(1, Math.min(26, Math.round(Number(j.cols) || 5)));
          const keep = o => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).slice(0, 2600).map(([k, v]) => [String(k).slice(0, 5), String(v).slice(0, 500)]));
          return {rows, cols, cells: keep(j.cells), shown: keep(j.shown), title: String(j.title ?? '').slice(0, 120)};
        } catch { return false; }
      }}],
      toDOM: n => ['span', {'data-id': n.attrs.id, 'data-spreadsheet': JSON.stringify({rows: n.attrs.rows, cols: n.attrs.cols, cells: n.attrs.cells, shown: n.attrs.shown, title: n.attrs.title}), contenteditable: 'false'},
        n.attrs.title || 'Spreadsheet'],
    },
    /** A diagram on the page (Insert > Files > Diagram): an outline the app draws (core/slate/lib/diagram.mjs). */
    diagram: {
      inline: true, group: 'inline', atom: true, draggable: true,
      attrs: {...id, kind: {default: 'flowchart'}, text: {default: ''}},
      parseDOM: [{tag: 'span[data-diagram]', getAttrs: el => ({kind: ['flowchart', 'hierarchy', 'process', 'cycle'].includes(attr(el, 'data-diagram')) ? attr(el, 'data-diagram') : 'flowchart', text: String(attr(el, 'data-text') ?? '').slice(0, 4000)})}],
      toDOM: n => ['span', {'data-id': n.attrs.id, 'data-diagram': n.attrs.kind, 'data-text': n.attrs.text, contenteditable: 'false'}, 'Diagram'],
    },
  },
  marks: {
    bold: {parseDOM: [{tag: 'strong'}, {tag: 'b'}, {style: 'font-weight=bold'}], toDOM: () => ['strong', 0]},
    italic: {parseDOM: [{tag: 'em'}, {tag: 'i'}, {style: 'font-style=italic'}], toDOM: () => ['em', 0]},
    underline: {parseDOM: [{tag: 'u'}], toDOM: () => ['u', 0]},
    strike: {parseDOM: [{tag: 's'}, {tag: 'del'}, {tag: 'strike'}], toDOM: () => ['s', 0]},
    subscript: {excludes: 'superscript', parseDOM: [{tag: 'sub'}], toDOM: () => ['sub', 0]},
    superscript: {excludes: 'subscript', parseDOM: [{tag: 'sup'}], toDOM: () => ['sup', 0]},
    highlight: {attrs: {color: {default: '#ffff00'}}, parseDOM: [{tag: 'mark'}], toDOM: m => ['mark', {style: `background:${m.attrs.color}`}, 0]},
    textStyle: {
      attrs: {color: {default: null}, fontFamily: {default: null}, fontSize: {default: null}},
      parseDOM: [{tag: 'span[style]', getAttrs: el => {
        const st = el.style;
        const fontSize = st?.fontSize && /pt$/.test(st.fontSize) ? Number.parseFloat(st.fontSize) : null;
        const v = {color: st?.color || null, fontFamily: st?.fontFamily || null, fontSize};
        return v.color || v.fontFamily || v.fontSize ? v : false;
      }}],
      toDOM: m => ['span', {style: [m.attrs.color ? `color:${m.attrs.color}` : '', m.attrs.fontFamily ? `font-family:${m.attrs.fontFamily}` : '', m.attrs.fontSize ? `font-size:${m.attrs.fontSize}pt` : ''].filter(Boolean).join(';')}, 0],
    },
    link: {
      attrs: {href: {default: ''}, title: {default: null}}, inclusive: false,
      parseDOM: [{tag: 'a[href]', getAttrs: el => ({href: attr(el, 'href'), title: attr(el, 'title')})}],
      toDOM: m => ['a', {href: m.attrs.href, ...(m.attrs.title ? {title: m.attrs.title} : {}), rel: 'noopener noreferrer'}, 0],
    },
    /** Review > Language > Set Proofing Language: the language of a run of text, or "do not check spelling". */
    language: {
      attrs: {lang: {default: 'en-US'}, noCheck: {default: false}}, inclusive: false,
      parseDOM: [{tag: 'span[lang]', getAttrs: el => ({lang: attr(el, 'lang') || 'en-US', noCheck: attr(el, 'spellcheck') === 'false'})}],
      toDOM: m => ['span', {lang: m.attrs.lang, ...(m.attrs.noCheck ? {spellcheck: 'false'} : {})}, 0],
    },
  },
});

/** The most a recording on a page holds (as base64 text of its data URL), about 21 MB of sound or picture. */
export const MAX_RECORDING_CHARS = 28_000_000;

/** Node types that carry a block id (every node except text and hard breaks). */
export const ID_NODES = new Set(['container', 'paragraph', 'bulletList', 'orderedList', 'listItem', 'table', 'tableRow', 'tableCell',
  'image', 'attachment', 'media', 'equation', 'spreadsheet', 'diagram']);
/** Inline leaves: one U+FFFC each in text offsets (the automation.mjs convention). */
export const OBJECT_CHAR = '￼';

// ---------------------------------------------------------------------------------------------
// Body JSON <-> ProseMirror node, cached by object identity (bodies are immutable)

const nodeCache = new WeakMap();

/** The ProseMirror node of a page body (JSON). Cached: unchanged pages are parsed once. */
export function nodeOf(body) {
  if (!body || typeof body !== 'object') throw new CommandError('failed', 'A page body is missing');
  let node = nodeCache.get(body);
  if (!node) {
    try { node = schema.nodeFromJSON(body); } catch (e) { throw new CommandError('failed', `A page body is not valid: ${e?.message ?? e}`); }
    nodeCache.set(body, node);
  }
  return node;
}

/**
 * JSON of a node (plain objects: ProseMirror's attrs objects have no prototype), remembered so
 * nodeOf(json) returns the same node without parsing.
 */
export function jsonOf(node) {
  const json = JSON.parse(JSON.stringify(node.toJSON()));
  nodeCache.set(json, node);
  return json;
}

export const emptyBody = () => ({type: 'doc'});

/** Every id-carrying node must have a unique string id; containers have finite coordinates. */
export function checkBody(doc) {
  try { doc.check(); } catch (e) { throw new CommandError('invalid_params', `The page content is not valid: ${e?.message ?? e}`); }
  const seen = new Set();
  let problem = null;
  doc.descendants(node => {
    if (problem) return false;
    if (!ID_NODES.has(node.type.name)) return true;
    const nid = node.attrs.id;
    if (typeof nid !== 'string' || !nid || nid.length > 80) { problem = `a ${node.type.name} has no id`; return false; }
    if (seen.has(nid)) { problem = `the id ${nid} is used twice on the page`; return false; }
    seen.add(nid);
    if (node.type.name === 'container') {
      const {x, y, width} = node.attrs;
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < -10000 || y < -10000 || x > 100000 || y > 1000000) { problem = `container ${nid} has an invalid position`; return false; }
      if (width !== null && (!Number.isFinite(width) || width < 16 || width > 20000)) { problem = `container ${nid} has an invalid width`; return false; }
    }
    if (node.type.name === 'media') {
      const a = node.attrs;
      if (a.kind !== 'audio' && a.kind !== 'video') { problem = `recording ${nid} is neither audio nor video`; return false; }
      if (typeof a.src !== 'string' || (a.src && !(/^data:(audio|video)\//.test(a.src.slice(0, 12)) && a.src.slice(0, 200).includes(';base64,')))) { problem = `recording ${nid} has no valid audio or video data`; return false; }
      if (a.src.length > MAX_RECORDING_CHARS) { problem = `recording ${nid} is larger than ${MAX_RECORDING_CHARS / 1_000_000} MB`; return false; }
      if (a.duration !== null && (!Number.isFinite(a.duration) || a.duration < 0)) { problem = `recording ${nid} has an invalid length`; return false; }
    }
    if (node.type.name === 'paragraph') {
      const a = node.attrs;
      if (a.audio !== null && !(a.audio && typeof a.audio.media === 'string' && Number.isFinite(a.audio.t) && a.audio.t >= 0)) { problem = `paragraph ${nid} has an invalid recording link`; return false; }
      if (!PARAGRAPH_STYLES.includes(a.style)) { problem = `paragraph ${nid} has an unknown style ${a.style}`; return false; }
      if (!Number.isInteger(a.indent) || a.indent < 0 || a.indent > 20) { problem = `paragraph ${nid} has an invalid indent`; return false; }
      if (!Array.isArray(a.tags)) { problem = `paragraph ${nid} has invalid tags`; return false; }
    }
    return true;
  });
  if (problem) throw new CommandError('invalid_params', `The page content is not valid: ${problem}`);
  return doc;
}

// ---------------------------------------------------------------------------------------------
// App op: ProseMirror steps on one page

/**
 * Apply `{type:'steps', page, steps, modified}` to the notebook content. Returns the new content
 * (only the page record and the `pages` map are copied) and the inverse op. A step that does not
 * apply throws, so the kernel rolls the whole command back.
 */
export function apply(content, op) {
  if (!op || op.type !== 'steps') throw new CommandError('failed', `Unknown Slate operation ${op?.type}`);
  const page = content?.pages?.[op.page];
  if (!page) throw new CommandError('not_found', `No page ${op.page}`, {address: `/pg:${op.page}`});
  if (!Array.isArray(op.steps)) throw new CommandError('invalid_params', 'steps must be an array');
  const before = nodeOf(page.body);
  let doc = before;
  const inverse = [];
  const mapping = new Mapping();
  for (const [i, json] of op.steps.entries()) {
    let step;
    try { step = Step.fromJSON(schema, json); } catch (e) { throw new CommandError('invalid_params', `steps.${i} is not a ProseMirror step: ${e?.message ?? e}`, {path: `/steps/${i}`}); }
    let result;
    try { result = step.apply(doc); } catch (e) { result = {failed: String(e?.message ?? e)}; }
    if (result.failed) throw new CommandError('failed', `steps.${i} does not apply to page ${op.page}: ${result.failed}`, {path: `/steps/${i}`});
    inverse.push(step.invert(doc).toJSON());
    mapping.appendMap(step.getMap());
    doc = result.doc;
  }
  checkBody(doc);
  const body = jsonOf(doc);
  // Remember what the steps did for address mapping (anchors, selection): not enumerable, so it
  // never reaches JSON, journals or deep-equality checks.
  Object.defineProperty(op, 'trace', {value: {page: op.page, before, after: doc, mapping}, configurable: true});
  const next = {...page, body, ...(op.modified ? {modified: op.modified} : {}), ...(op.by ? {modifiedBy: op.by} : {})};
  if (op.by === null) delete next.modifiedBy;
  return {
    content: {...content, pages: {...content.pages, [op.page]: next}},
    inverse: {type: 'steps', page: op.page, steps: inverse.reverse(), ...(op.modified ? {modified: page.modified} : {}), ...(op.by !== undefined ? {by: page.modifiedBy ?? null} : {})},
  };
}

// ---------------------------------------------------------------------------------------------
// New content and validation (core/model.mjs createFile / validateFile for schema 2)

const now = () => new Date().toISOString();
const uid = () => {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => '0123456789abcdefghijklmnopqrstuvwxyz'[b % 36]).join('');
};

/** OneNote's section colours, assigned in turn (also used by the interim outline). */
export const SECTION_COLORS = Object.freeze(['#8aa8e4', '#91ba6e', '#e7a87e', '#bd94d3', '#e6c16a', '#7fc6c4', '#e48fa0', '#b0b0b0']);
/** Notebook colours (Notebook Properties › Color). */
export const NOTEBOOK_COLORS = Object.freeze(['#7f6fd1', '#4a8fdd', '#3fa68c', '#d4884a', '#c45d8e', '#6d7a8a']);

/** A page record (OneNote: "Untitled page", created now, no containers). */
export function newPageRecord({id, title = '', created, rule = null}) {
  return {id, title, created, modified: created, color: null, rule: rule ?? {pattern: 'none', color: DEFAULT_RULE_COLOR},
    titleHidden: false, paperSize: null, body: emptyBody(), ink: []};
}

/** A new notebook as OneNote creates one: a "New Section 1" with one untitled page. */
export function createContent(title = 'My Notebook', opts = {}) {
  const make = opts.uid ?? uid;
  const created = opts.now ?? now();
  const nb = `nb${make()}`, sec = `s${make()}`, pg = `p${make()}`;
  return {
    format: NOTEBOOK_FORMAT, version: CONTENT_VERSION,
    notebook: {id: nb, name: String(title).slice(0, LIMITS.nameLength) || 'My Notebook', color: NOTEBOOK_COLORS[0], created, path: null},
    tree: [sec],
    groups: {},
    sections: {[sec]: {id: sec, name: 'New Section 1', color: SECTION_COLORS[0], created, pages: [{id: pg, level: 0}]}},
    pages: {[pg]: newPageRecord({id: pg, created})},
  };
}

export const isNotebook = content => !!content && typeof content === 'object' && content.format === NOTEBOOK_FORMAT;

const bad = message => { throw new Error(`Invalid notebook: ${message}`); };
const isId = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(x);
const isName = x => typeof x === 'string' && x.length <= LIMITS.nameLength;
const isColor = x => x === null || (typeof x === 'string' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(x));
const isTime = x => typeof x === 'string' && x.length <= 40 && !Number.isNaN(Date.parse(x));
/**
 * A notebook's folder: a plain absolute local path (a drive letter or a leading slash), at most 1024 characters, with no control
 * characters, no ".." segment, and not a UNC or device path (two leading separators). It only records where the notebook lives:
 * the folder IO is granted by the system folder dialog (electron/notebook-folders.cjs), never by this value.
 */
const isNotebookPath = p => typeof p === 'string' && p.length > 0 && p.length <= 1024
  && /^([A-Za-z]:[\\/]|\/(?![\\/]))/.test(p) && !/[\u0000-\u001f]/.test(p) && !p.split(/[\\/]+/).includes('..');
const validatedBodies = new WeakSet();

/** Throws (plain Error, as core/model.mjs expects) when the content is not a valid notebook. */
export function validateContent(c) {
  if (!isNotebook(c)) bad('not a Slate notebook');
  if (c.version !== CONTENT_VERSION) bad(`unsupported version ${c.version}`);
  const nb = c.notebook;
  if (!nb || !isId(nb.id) || !isName(nb.name) || !isColor(nb.color ?? null) || !isTime(nb.created)) bad('notebook record');
  if (nb.path !== null && nb.path !== undefined && !isNotebookPath(nb.path)) bad('notebook path');
  for (const key of ['groups', 'sections', 'pages']) if (!c[key] || typeof c[key] !== 'object' || Array.isArray(c[key])) bad(key);
  if (!Array.isArray(c.tree)) bad('tree');
  const sectionIds = Object.keys(c.sections), groupIds = Object.keys(c.groups), pageIds = Object.keys(c.pages);
  if (sectionIds.length > LIMITS.sections || groupIds.length > LIMITS.groups || pageIds.length > LIMITS.pages) bad('too many items');
  // The tree reaches every section and group exactly once.
  const placed = new Set();
  const visit = (items, depth) => {
    if (!Array.isArray(items) || depth > 8) bad('section group nesting');
    for (const item of items) {
      if (placed.has(item)) bad(`${item} appears twice`);
      placed.add(item);
      if (c.sections[item]) continue;
      const g = c.groups[item];
      if (!g) bad(`tree names unknown item ${item}`);
      visit(g.items, depth + 1);
    }
  };
  visit(c.tree, 0);
  if (placed.size !== sectionIds.length + groupIds.length) bad('a section or group is not in the tree');
  for (const g of Object.values(c.groups)) if (!isId(g.id) || c.groups[g.id] !== g || !isName(g.name)) bad('section group record');
  const onPage = new Set();
  for (const s of Object.values(c.sections)) {
    if (!isId(s.id) || c.sections[s.id] !== s || !isName(s.name) || !isColor(s.color ?? null) || !Array.isArray(s.pages)) bad(`section ${s?.id}`);
    for (const entry of s.pages) {
      if (!entry || !c.pages[entry.id]) bad(`section ${s.id} lists unknown page ${entry?.id}`);
      if (!Number.isInteger(entry.level) || entry.level < 0 || entry.level > MAX_LEVEL) bad(`page ${entry.id} level`);
      if (onPage.has(entry.id)) bad(`page ${entry.id} is in two places`);
      onPage.add(entry.id);
    }
  }
  if (onPage.size !== pageIds.length) bad('a page is in no section');
  for (const p of Object.values(c.pages)) {
    if (!isId(p.id) || c.pages[p.id] !== p) bad(`page ${p?.id}`);
    if (typeof p.title !== 'string' || p.title.length > LIMITS.titleLength) bad(`page ${p.id} title`);
    if (!isTime(p.created) || !isTime(p.modified)) bad(`page ${p.id} dates`);
    if (!isColor(p.color ?? null)) bad(`page ${p.id} color`);
    if (!p.rule || !RULE_PATTERNS.includes(p.rule.pattern) || !isColor(p.rule.color)) bad(`page ${p.id} rule lines`);
    if (!Array.isArray(p.ink) || p.ink.length > LIMITS.strokes) bad(`page ${p.id} ink`);
    for (const st of p.ink) {
      if (!st || !isId(st.id) || !INK_KINDS.includes(st.tool) || !isColor(st.color) || !Number.isFinite(st.width) || st.width <= 0 || st.width > 200
        || !Array.isArray(st.points) || st.points.length < 2 || st.points.length % 2 || st.points.length > LIMITS.points || !st.points.every(Number.isFinite)
        || (st.fx !== undefined && st.fx !== null && !INK_FX.includes(st.fx)) || (st.group !== undefined && !isId(st.group)) || (st.shape !== undefined && typeof st.shape !== 'string')) bad(`page ${p.id} stroke ${st?.id}`);
    }
    if (!validatedBodies.has(p.body)) {
      try { checkBody(nodeOf(p.body)); } catch (e) { bad(`page ${p.id}: ${e.message}`); }
      validatedBodies.add(p.body);
    }
  }
  return c;
}
