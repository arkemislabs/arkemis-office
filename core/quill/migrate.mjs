// Schema 1 → schema 2 for Quill documents (docs/architecture.md section 16.1): the TipTap /
// ProseMirror JSON the legacy RichEditor stores (`{doc, headerFooter?, page?}`) becomes the
// translated wordcraft document model (core/quill/model). Arkemis glue, no upstream counterpart;
// the targets are upstream's (wordcraft crates/doc at aadb077e072b7de05f724e359d8db82e151f125c):
// headings take Heading 1–6, lists become numbering (a list per bulleted kind, a restart per
// numbered list), block quotes take Quote, code blocks HTML Preformatted, horizontal rules the
// paragraph bottom border Word's AutoFormat draws, page breaks U+000C, PAGE/NUMPAGES fields field
// objects, pictures media plus image objects, tables the OOXML grid with gridSpan/vMerge, headers
// and footers parts on the last section, and the page setup the section.
//
// What schema 1 holds and schema 2 has no place for is listed in MIGRATION_DROPS. No DOM, no Node
// built-ins.

import {createContent} from './model/content.mjs';
import {newId} from './model/ids.mjs';
import {OBJ, PAGE_BREAK, LINE_BREAK, defaultFloat, normalize} from './model/para.mjs';
import {addList, level as listLevel} from './model/numbering.mjs';
import {parseRgb, borderStyleFromOoxml, UNDERLINES, charIsEmpty} from './model/props.mjs';
import {textWidth, setLandscape} from './model/section.mjs';
import {style as makeStyle} from './model/styles.mjs';
import {bodyFromBlocks} from './model/body.mjs';

/** Schema-1 attributes with no schema-2 home (kept out of the migrated document). */
export const MIGRATION_DROPS = Object.freeze(['codeBlock.attrs.language', 'link.attrs.target', 'image.attrs.title (kept as alt title)',
  'tableHeader cells outside a header row (become normal cells)']);

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const TEXTBLOCK = new Set(['paragraph', 'heading', 'codeBlock']);
const PX = 0.75;

/** Whether `content` is schema-1 Quill content. */
export const isSchema1 = content => isObj(content) && isObj(content.doc) && content.doc.type === 'doc';

/** A CSS colour (`#rgb`, `#rrggbb[aa]`, `rgb(r, g, b)`) as an Rgb, or null. */
export function cssColor(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(t);
  if (m) return [...m[1]].map(c => parseInt(c + c, 16));
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(t);
  if (m) return parseRgb(m[1]);
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(t);
  if (m) return [m[1], m[2], m[3]].map(x => Math.min(255, Number(x)));
  return null;
}

function decodeBase64(b64) {
  try {
    if (typeof globalThis.atob === 'function') {
      const s = globalThis.atob(b64);
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    }
  } catch { /* not base64 */ }
  return null;
}

/** Pixel size of a PNG, GIF, JPEG, BMP or WebP image from its bytes, or null. */
export function imageSize(bytes) {
  if (!bytes || bytes.length < 24) return null;
  const u16be = i => (bytes[i] << 8) | bytes[i + 1];
  const u32be = i => ((bytes[i] << 24) >>> 0) + (bytes[i + 1] << 16) + (bytes[i + 2] << 8) + bytes[i + 3];
  const u16le = i => bytes[i] | (bytes[i + 1] << 8);
  const i32le = i => bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return [u32be(16), u32be(20)];
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return [u16le(6), u16le(8)];
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return [Math.abs(i32le(18)), Math.abs(i32le(22))];
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) {
    const kind = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (kind === 'VP8 ' && bytes.length >= 30) return [u16le(26) & 0x3fff, u16le(28) & 0x3fff];
    if (kind === 'VP8L' && bytes.length >= 25) { const b = bytes; return [1 + (((b[22] & 0x3f) << 8) | b[21]), 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6))]; }
    if (kind === 'VP8X' && bytes.length >= 30) return [1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))];
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [u16be(i + 7), u16be(i + 5)];
      i += 2 + u16be(i + 2);
    }
  }
  return null;
}

const MIME_EXT = {'image/png': 'png', 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/webp': 'webp',
  'image/svg+xml': 'svg', 'image/tiff': 'tiff', 'image/x-emf': 'emf', 'image/x-wmf': 'wmf'};

const num = (v, lo, hi) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

/** Migrate schema-1 Quill content to schema 2. Content already in schema 2 is returned as is. */
export function migrate(content) {
  if (!isSchema1(content)) {
    if (isObj(content) && isObj(content.body) && Array.isArray(content.body.chunks)) return content;
    throw new Error('Not Quill schema-1 content');
  }
  const out = createContent();
  const ids = new Set();
  const mkId = () => { let id = newId(); while (ids.has(id)) id = newId(); ids.add(id); return id; };
  out.lastSection = {...out.lastSection, id: mkId()};

  // Page setup: schema 1 showed A4 portrait with 1" margins when it said nothing.
  const page = isObj(content.page) ? content.page : {size: 'A4', orientation: 'portrait', margins: 'normal'};
  let sect = out.lastSection;
  if (page.size === 'A4') sect = {...sect, pageW: 595.3, pageH: 841.9};
  else if (page.size === 'Letter') sect = {...sect, pageW: 612, pageH: 792};
  const margin = {normal: 72, narrow: 36, wide: 108}[page.margins] ?? 72;
  sect = {...sect, marginTop: margin, marginBottom: margin, marginLeft: margin, marginRight: margin};
  if (page.orientation === 'landscape') sect = setLandscape(sect, true);
  out.lastSection = sect;
  const width = textWidth(sect);

  const state = {numbering: out.numbering, bulletNum: null, orderedAbstract: null, styles: out.styles, media: out.media};
  const addStyle = st => { if (!state.styles.styles.some(s => s.id === st.id)) state.styles = {...state.styles, styles: [...state.styles.styles, st]}; };

  const mediaKey = (b64, ext) => {
    for (const [k, v] of Object.entries(state.media)) if (v === b64) return k;
    let i = Object.keys(state.media).length + 1;
    let key = `image${i}.${ext}`;
    while (Object.hasOwn(state.media, key)) key = `image${++i}.${ext}`;
    state.media = {...state.media, [key]: b64};
    return key;
  };

  function charProps(marks) {
    const c = {};
    for (const m of marks || []) {
      if (!isObj(m)) continue;
      const a = m.attrs || {};
      switch (m.type) {
        case 'bold': c.bold = true; break;
        case 'italic': c.italic = true; break;
        case 'strike': c.strike = true; break;
        case 'underline': c.underline = UNDERLINES.includes(a.style) && a.style !== 'none' ? a.style : 'single'; break;
        case 'code':
          addStyle(makeStyle({id: 'HTMLCode', name: 'HTML Code', kind: 'character', basedOn: 'DefaultParagraphFont', chr: {font: 'Courier New', size: 10},
            priority: 99, builtin: true}));
          c.style = 'HTMLCode';
          break;
        case 'link':
          if (typeof a.href === 'string' && a.href) { c.link = a.href; if (!c.style) c.style = 'Hyperlink'; }
          break;
        case 'textStyle': {
          if (typeof a.fontFamily === 'string' && a.fontFamily.trim()) c.font = a.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
          const size = num(a.fontSize, 1, 1638);
          if (size !== null) c.size = size;
          const color = cssColor(a.color);
          if (color) c.color = {Rgb: color};
          const bg = cssColor(a.backgroundColor);
          if (bg) c.shading = bg;
          if (a.verticalAlign === 'sub') c.vertAlign = 'subscript';
          else if (a.verticalAlign === 'super') c.vertAlign = 'superscript';
          break;
        }
        default: break;
      }
    }
    return c;
  }

  function paraProps(attrs = {}) {
    const p = {};
    if (['left', 'center', 'right', 'justify'].includes(attrs.textAlign)) p.align = attrs.textAlign;
    const il = num(attrs.indentLeft, 0, 720), ir = num(attrs.indentRight, 0, 720), fi = num(attrs.indentFirstLine, -720, 720);
    if (il !== null) p.indentLeft = il;
    if (ir !== null) p.indentRight = ir;
    if (fi !== null) p.indentFirst = fi;
    const lh = num(attrs.lineHeight, 0.06, 132);
    if (lh !== null) p.lineSpacing = {rule: 'multiple', value: lh};
    const sb = num(attrs.spaceBefore, 0, 1584), sa = num(attrs.spaceAfter, 0, 1584);
    if (sb !== null) p.spaceBefore = sb;
    if (sa !== null) p.spaceAfter = sa;
    if (typeof attrs.paragraphShading === 'string' && attrs.paragraphShading !== 'auto') { const c = cssColor(attrs.paragraphShading); if (c) p.shading = c; }
    if (isObj(attrs.paragraphBorders)) {
      const borders = {};
      for (const side of ['top', 'bottom', 'left', 'right', 'between']) {
        const b = attrs.paragraphBorders[side];
        if (!isObj(b)) continue;
        borders[side] = {style: borderStyleFromOoxml(b.style), width: num(b.width, 0, 12) ?? 0, color: b.color === 'auto' ? null : cssColor(b.color), space: num(b.space, 0, 31) ?? 0};
      }
      if (Object.keys(borders).length) p.borders = borders;
    }
    return p;
  }

  /** A paragraph from a textblock's inline content. */
  function makePara(node, props = {}) {
    const p = {kind: 'para', id: mkId(), text: '', runs: []};
    const objects = [];
    const runs = [];
    let lastProps = null;
    const add = (text, cp) => { if (!text) return; p.text += text; runs.push(charIsEmpty(cp) ? {len: text.length} : {len: text.length, props: cp}); lastProps = cp; };
    for (const n of node.content || []) {
      if (!isObj(n)) continue;
      const cp = charProps(n.marks);
      if (n.type === 'text') add(String(n.text ?? '').split(OBJ).join(''), cp);
      else if (n.type === 'hardBreak') add(LINE_BREAK, cp);
      else if (n.type === 'pageBreak') add(PAGE_BREAK, cp);
      else if (n.type === 'wordField') {
        objects.push({type: 'field', instr: n.attrs?.kind === 'NUMPAGES' ? 'NUMPAGES' : 'PAGE', result: '', dirty: true, oid: mkId()});
        add(OBJ, cp);
      } else if (n.type === 'image') {
        const o = imageObject(n);
        if (o) { objects.push(o); add(OBJ, cp); }
      }
    }
    p.runs = runs;
    if (objects.length) p.objects = objects;
    if (!charIsEmpty(props)) p.props = props;
    if (!p.text.length && lastProps === null) { /* an empty paragraph keeps no mark */ }
    normalize(p);
    return p;
  }

  function imageObject(n) {
    const src = typeof n.attrs?.src === 'string' ? n.attrs.src : '';
    const m = /^data:([a-z0-9.+/-]+);base64,(.*)$/is.exec(src);
    const alt = typeof n.attrs?.alt === 'string' ? n.attrs.alt : '';
    const title = typeof n.attrs?.title === 'string' ? n.attrs.title : '';
    if (!m) {
      // A linked (not embedded) picture: kept as the HTML it was, for round trip.
      const esc = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      return {type: 'opaque', format: 'html', xml: `<img src="${esc(src)}" alt="${esc(alt)}"${title ? ` title="${esc(title)}"` : ''}>`, text: '', oid: mkId()};
    }
    const b64 = m[2].replace(/\s+/g, '');
    const ext = MIME_EXT[m[1].toLowerCase()] ?? 'png';
    const key = mediaKey(b64, ext);
    const nat = imageSize(decodeBase64(b64));
    let w = num(n.attrs?.width, 1, 100_000), h = num(n.attrs?.height, 1, 100_000);
    if (w === null && h === null && nat) [w, h] = nat;
    else if (w !== null && h === null) h = nat && nat[0] ? w * nat[1] / nat[0] : w;
    else if (h !== null && w === null) w = nat && nat[1] ? h * nat[0] / nat[1] : h;
    if (w === null || h === null) [w, h] = [96, 96];
    let wp = w * PX, hp = h * PX;
    if (wp > width) { hp = hp * width / wp; wp = width; }
    const float = defaultFloat();
    if (title) float.alt = {title};
    return {type: 'image', media: key, w: wp, h: hp, alt, float, crop: [0, 0, 0, 0], oid: mkId()};
  }

  function listNum(ordered, start, lvl) {
    if (!ordered) {
      if (state.bulletNum === null) {
        const r = addList(state.numbering, 'bullet');
        state.numbering = r.numbering; state.bulletNum = r.num;
      }
      return state.bulletNum;
    }
    if (state.orderedAbstract === null) {
      const r = addList(state.numbering, 'numbered');
      state.numbering = r.numbering;
      state.orderedAbstract = state.numbering.nums.find(x => x.id === r.num).abstractId;
      const n = state.numbering.nums.find(x => x.id === r.num);
      if (start !== 1 || lvl !== 0) state.numbering = {...state.numbering, nums: state.numbering.nums.map(x => (x === n ? {...x, startOverrides: [[lvl, start]]} : x))};
      return r.num;
    }
    const ids = state.numbering.nums.map(x => x.id);
    const id = Math.max(0, ...ids) + 1;
    state.numbering = {...state.numbering, nums: [...state.numbering.nums, {id, abstractId: state.orderedAbstract, startOverrides: [[lvl, start]]}]};
    return id;
  }

  /** Convert block nodes into `out`; `list` = {num, level, first} for list item paragraphs. */
  function blocks(nodes, ctx, outBlocks) {
    for (const node of nodes || []) {
      if (!isObj(node)) continue;
      switch (node.type) {
        case 'paragraph': case 'heading': {
          const props = paraProps(node.attrs || {});
          if (node.type === 'heading') props.style = `Heading${Math.max(1, Math.min(6, Number(node.attrs?.level) || 1))}`;
          else if (ctx.quote) props.style = 'Quote';
          if (ctx.list) {
            if (!props.style) props.style = 'ListParagraph';
            if (ctx.list.first) { props.numbering = {num: ctx.list.num, level: ctx.list.level}; ctx.list.first = false; }
            else if (props.indentLeft === undefined) props.indentLeft = 36 * (ctx.list.level + 1);
          }
          outBlocks.push(makePara(node, props));
          break;
        }
        case 'codeBlock': {
          addStyle(makeStyle({id: 'HTMLPreformatted', name: 'HTML Preformatted', basedOn: 'Normal', priority: 99, builtin: true,
            para: {spaceAfter: 0, lineSpacing: {rule: 'multiple', value: 1}}, chr: {font: 'Courier New', size: 10}}));
          const text = (node.content || []).map(n => (n?.type === 'text' ? String(n.text ?? '') : '')).join('');
          outBlocks.push(makePara({content: [{type: 'text', text}]}, {style: 'HTMLPreformatted'}));
          break;
        }
        case 'blockquote': blocks(node.content, {...ctx, quote: true}, outBlocks); break;
        case 'horizontalRule':
          outBlocks.push(makePara({content: []}, {borders: {bottom: {style: 'single', width: 1.5, color: null, space: 1}}}));
          break;
        case 'bulletList': case 'orderedList': {
          const ordered = node.type === 'orderedList';
          const lvl = ctx.list ? Math.min(ctx.list.level + 1, 8) : 0;
          const numId = listNum(ordered, Math.max(0, Math.floor(Number(node.attrs?.start ?? 1)) || 0), lvl);
          for (const item of node.content || []) {
            if (item?.type !== 'listItem') continue;
            blocks(item.content, {...ctx, list: {num: numId, level: lvl, first: true}}, outBlocks);
          }
          break;
        }
        case 'image': {
          const p = makePara({content: [node]}, ctx.quote ? {style: 'Quote'} : {});
          outBlocks.push(p);
          break;
        }
        case 'table': outBlocks.push(table(node)); break;
        default:
          if (Array.isArray(node.content)) blocks(node.content, ctx, outBlocks);
      }
    }
  }

  function cellProps(attrs = {}, span) {
    const p = {span};
    const bg = cssColor(attrs.backgroundColor);
    if (bg) p.shading = bg;
    if (['top', 'center', 'bottom'].includes(attrs.verticalAlign)) p.valign = attrs.verticalAlign;
    if (isObj(attrs.cellBorders)) {
      const borders = {};
      for (const side of ['top', 'bottom', 'left', 'right']) {
        const b = attrs.cellBorders[side];
        if (!isObj(b)) continue;
        borders[side] = {style: borderStyleFromOoxml(b.style), width: num(b.size, 0, 12) ?? 0, color: b.color === 'auto' ? null : cssColor(b.color), space: 0};
      }
      if (Object.keys(borders).length) p.borders = borders;
    }
    return p;
  }

  function table(node) {
    const pmRows = (node.content || []).filter(r => r?.type === 'tableRow');
    const pending = [];
    const rows = [];
    const widths = [];
    for (const pmRow of pmRows) {
      const cells = [];
      const pmCells = (pmRow.content || []).filter(c => c?.type === 'tableCell' || c?.type === 'tableHeader');
      let g = 0, k = 0;
      while (k < pmCells.length || pending.slice(g).some(x => x && x.left > 0)) {
        const p = pending[g];
        if (p && p.left > 0) {
          cells.push({id: mkId(), props: {...p.props, vmerge: 'continue'}, blocks: [makePara({content: []})]});
          p.left -= 1;
          g += p.props.span;
          continue;
        }
        if (k >= pmCells.length) { g += 1; continue; }
        const c = pmCells[k++];
        const a = c.attrs || {};
        const span = Math.max(1, Math.min(63, Math.floor(Number(a.colspan) || 1)));
        const rowspan = Math.max(1, Math.floor(Number(a.rowspan) || 1));
        const props = cellProps(a, span);
        if (Array.isArray(a.colwidth)) a.colwidth.forEach((w, i) => { const v = num(w, 1, 100_000); if (v !== null && widths[g + i] === undefined) widths[g + i] = v * PX; });
        if (rowspan > 1) { props.vmerge = 'restart'; pending[g] = {left: rowspan - 1, props: {span, ...(props.shading ? {shading: props.shading} : {}), ...(props.borders ? {borders: props.borders} : {})}}; }
        const inner = [];
        blocks(c.content, {}, inner);
        if (!inner.length || inner[inner.length - 1].kind === 'table') inner.push(makePara({content: []}));
        cells.push({id: mkId(), props, blocks: inner});
        g += span;
      }
      const row = {id: mkId(), props: {}, cells};
      if (pmCells.length && pmCells.every(c => c.type === 'tableHeader') && rows.length === 0) row.props.header = true;
      rows.push(row);
    }
    const cols = Math.max(1, ...rows.map(r => r.cells.reduce((s, c) => s + (c.props.span ?? 1), 0)));
    const known = widths.filter(w => w !== undefined);
    const rest = Math.max(0, width - known.reduce((s, w) => s + w, 0));
    const missing = cols - known.length;
    const grid = Array.from({length: cols}, (_, i) => widths[i] ?? (missing > 0 ? Math.max(rest / missing, 6) : width / cols));
    for (const r of rows) {
      let g = 0;
      for (const c of r.cells) { c.props.width = grid.slice(g, g + (c.props.span ?? 1)).reduce((s, w) => s + w, 0); g += c.props.span ?? 1; }
    }
    const props = {style: 'TableGrid'};
    const align = node.attrs?.tableAlign;
    if (align === 'center' || align === 'right') props.align = align;
    if (!rows.length) rows.push({id: mkId(), props: {}, cells: [{id: mkId(), props: {span: 1, width}, blocks: [makePara({content: []})]}]});
    return {kind: 'table', id: mkId(), props, grid, rows};
  }

  const body = [];
  blocks(content.doc.content, {}, body);
  if (!body.length || body[body.length - 1].kind === 'table') body.push(makePara({content: []}));

  // Headers and footers: one part per variant, on the last (only) section.
  const hf = isObj(content.headerFooter) ? content.headerFooter : {};
  const parts = {};
  let nextPart = 1;
  const headers = {default: null, first: null, even: null}, footers = {default: null, first: null, even: null};
  for (const [key, kind, set] of [['headers', 'header', headers], ['footers', 'footer', footers]]) {
    for (const which of ['default', 'first', 'even']) {
      const story = hf[key]?.[which];
      if (!isObj(story) || story.type !== 'doc') continue;
      const bl = [];
      blocks(story.content, {}, bl);
      if (!bl.length || bl[bl.length - 1].kind === 'table') bl.push(makePara({content: []}, {style: kind === 'header' ? 'Header' : 'Footer'}));
      for (const b of bl) if (b.kind === 'para' && !b.props?.style) b.props = {...(b.props || {}), style: kind === 'header' ? 'Header' : 'Footer'};
      parts[nextPart] = {kind, blocks: bl};
      set[which] = nextPart++;
    }
  }
  out.lastSection = {...out.lastSection, headers, footers, titlePage: hf.differentFirstPage === true};
  if (hf.evenAndOdd === true) out.settings = {...out.settings, evenOddHeaders: true};

  out.body = bodyFromBlocks(body);
  out.parts = parts;
  out.numbering = state.numbering;
  out.styles = state.styles;
  out.media = state.media;
  void listLevel;
  return out;
}

/** Migrate a schema-1 Quill file to schema 2 (a new file object; the input is unchanged). */
export function migrateFile(file) {
  if (file?.schema === 2) return file;
  if (file?.kind !== 'quill' || file?.schema !== 1) throw new Error('Not a schema-1 Quill file');
  return {...file, schema: 2, content: migrate(file.content)};
}
