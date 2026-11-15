// Insert tab: pages (page break, blank page, cover page), tables, pictures, shapes, text boxes,
// links and bookmarks, headers, footers and page numbers, date & time, symbols, fields, drop caps,
// the horizontal line.
//
// Translated from wordcraft (ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c):
//   crates/engine/src/cmd/insert.rs                 the command table (ids, labels, params, `when`)
//   crates/engine/src/cmd/insert/objects.rs         insert_block_at_caret, table, picture,
//                                                   place_picture, shape, text_box
//   crates/engine/src/cmd/insert/items.rs           page_number, date_time, format_date(_parts),
//                                                   symbol, field, cover_page, drop_cap(_off),
//                                                   drop_cap_state
//   crates/engine/src/cmd/insert/links.rs           link_targets, place_target, link,
//                                                   bookmark_name_ok, bookmark_range/span,
//                                                   remove_bookmark, bookmark, delete_bookmark
//   crates/engine/src/cmd/insert/header_footer.rs   hf_part, three_column_hf, header_footer,
//                                                   edit_hf, shown_hf, create_hf, page_hf_part,
//                                                   new_empty_headers, strip_headers
//   crates/engine/src/cmd/references/toc.rs         headings, heading_style_level, toc_bookmark
//                                                   (what Link › Place in This Document lists)
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Upstream Session state these commands keep lives in the kernel's per-document view state
// (`ctx.setView`, never undoable): `hfReturn` (where Close Header and Footer goes back to),
// `newHeaderParts` (headers made by Edit Header that Close takes away again while empty), and the
// pending typing formatting the format family keeps (`pendingFormat`).
//
// insert.icon (Insert › Illustrations › Icons) is translated from insert/objects.rs `icon` over the library of
// wordcraft_render::icon_lib (core/quill/lib/icon-lib.mjs): the icon is drawn to a PNG picture and placed like a picture.
//
// Not translated here (they stay hidden, see openIssues of this unit): metafile pictures (WMF/EMF), and a selected Drawing Canvas
// taking in a new picture/shape/text box (cmd/canvas.rs add_member, the canvas family's).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import * as P from '../model/para.mjs';
import {BODY, samePath} from '../model/document.mjs';
import {isConnector, isOpen} from '../model/connector.mjs';
import {kindOfPreset, presetOfKind, isOpenPreset} from '../lib/shape-presets.mjs';
import {parseRgb, BLACK, WHITE, border as mkBorder, bordersAll} from '../model/props.mjs';
import {findStyle, resolvePara, resolveChar, MAX_DROP_CAP_DISTANCE} from '../model/styles.mjs';
import {isSymbolFont} from '../model/symbol-fonts.mjs';
import {textWidth} from '../model/section.mjs';
import {newTable} from '../model/table.mjs';
import {Counters} from '../model/numbering.mjs';
import {layout} from '../layout/index.mjs';
import * as T from '../lib/table-session.mjs';
import {bytesOf, base64Encode, imageExt, probe} from '../lib/insert-objects.mjs';
import {applyChar, fmt} from '../lib/format-target.mjs';
import {newFloat} from '../lib/default-layout.mjs';
import {findIcon, searchIcons, parseCategory, iconPng} from '../lib/icon-lib.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/engine/src/cmd/insert.rs',
  'crates/engine/src/cmd/insert/objects.rs', 'crates/engine/src/cmd/insert/items.rs', 'crates/engine/src/cmd/insert/links.rs',
  'crates/engine/src/cmd/insert/header_footer.rs', 'crates/engine/src/cmd/references/toc.rs']};

const {failed, params: badParams} = T;
const run = f => (ctx, p) => f(T.open(ctx), p ?? {});
const field = (instr, result = '') => ({type: 'field', instr, result});

// ---- pages ---------------------------------------------------------------------------------------

function pageBreak(S) { T.typeText(S, '\u000C'); return T.finish(S); }

function blankPage(S) {
  T.typeText(S, '\u000C');
  const at = T.splitPara(S, S.sel.focus);
  S.d.insertText(at, '\u000C', {});
  T.setCaret(S, at);
  return T.finish(S);
}

// ---- dates (items.rs) ----------------------------------------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Thursday', 'Friday', 'Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday'];

/** Format a date and time with a Word picture; `daysSince` (days since 1970-01-01) gives the weekday (format_date_parts). */
export function formatDateParts(fmt0, y, m, d, [hh, mm, ss], daysSince) {
  const month = MONTHS[Math.max(0, m - 1)] ?? 'January';
  const day = DAYS[((daysSince % 7) + 7) % 7] ?? 'Monday';
  const pad = (n, w) => String(n).padStart(w, '0');
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  const chars = [...fmt0];
  let out = '';
  for (let i = 0; i < chars.length;) {
    const c = chars[i];
    if (chars.slice(i, i + 5).join('').toLowerCase() === 'am/pm') { out += hh < 12 ? 'AM' : 'PM'; i += 5; continue; }
    let n = 1;
    while (chars[i + n] === c) n++;
    const k = c;
    if ((k === 'y' || k === 'Y') && n >= 4) out += pad(y, 4);
    else if (k === 'y' || k === 'Y') out += pad(((y % 100) + 100) % 100, 2);
    else if (k === 'M' && n >= 4) out += month;
    else if (k === 'M' && n === 3) out += month.slice(0, 3);
    else if (k === 'M' && n === 2) out += pad(m, 2);
    else if (k === 'M') out += String(m);
    else if ((k === 'd' || k === 'D') && n >= 4) out += day;
    else if ((k === 'd' || k === 'D') && n === 3) out += day.slice(0, 3);
    else if ((k === 'd' || k === 'D') && n === 2) out += pad(d, 2);
    else if (k === 'd' || k === 'D') out += String(d);
    else if (k === 'H') out += n >= 2 ? pad(hh, 2) : String(hh);
    else if (k === 'h') out += n >= 2 ? pad(h12, 2) : String(h12);
    else if (k === 'm') out += n >= 2 ? pad(mm, 2) : String(mm);
    else if (k === 's') out += n >= 2 ? pad(ss, 2) : String(ss);
    else if (k === 'a' || k === 'A') out += hh < 12 ? 'AM' : 'PM';
    else out += c.repeat(n);
    i += n;
  }
  return out;
}

/** Today's date (UTC, as upstream's now_iso) under a Word picture (format_date). */
export function formatDate(fmt0, ms) {
  const iso = new Date(ms).toISOString();
  const num = (a, b, dflt) => { const v = Number(iso.slice(a, b)); return Number.isFinite(v) ? v : dflt; };
  return formatDateParts(fmt0, num(0, 4, 2026), num(5, 7, 1), num(8, 10, 1), [num(11, 13, 0), num(14, 16, 0), num(17, 19, 0)], Math.floor(ms / 86_400_000));
}
const nowMs = S => S.ctx.host?.now?.() ?? Date.now();

function dateTime(S, p) {
  const f = p.format ?? 'M/d/yyyy';
  const text = formatDate(f, nowMs(S));
  if (p.update) {
    const props = T.typingProps(S);
    const at = T.deleteSelection(S);
    const end = S.d.insertObject(at, field(`DATE \\@ "${f}"`, text), props);
    T.setCaret(S, end);
  } else T.typeText(S, text);
  return T.finish(S);
}

// ---- symbol, field (items.rs) ----------------------------------------------------------------------

function symbol(S, p) {
  const c = p.char;
  if (!c || [...c].length > 64) throw badParams('char: 1–64 characters');
  const font = typeof p.font === 'string' && p.font.trim() ? p.font.trim() : null;
  if (!font) { T.typeText(S, c); return T.finish(S); }
  if (font.length > 256) throw badParams('font: a family name');
  const base = T.typingProps(S);
  const symbolFont = isSymbolFont(font);
  for (const ch of c) {
    const props = {...base};
    const cp = ch.codePointAt(0);
    if (cp <= 0xffff && (symbolFont || (cp >= 0xf020 && cp <= 0xf0ff))) props.symFont = font; else props.font = font;
    S.pending = props;
    T.typeText(S, ch);
  }
  // Typing on after the symbol goes on in the text's own font.
  S.pending = base;
  S.nextPending = base;
  return T.finish(S);
}

/** DATE / TIME results as Update Field computes them (the `\@` picture, Word's defaults). */
function dateFieldResult(instr, ms) {
  const name = String(instr).trim().split(/\s+/)[0]?.toUpperCase();
  if (name !== 'DATE' && name !== 'TIME') return null;
  const m = /\\@\s*"([^"]*)"|\\@\s*(\S+)/.exec(instr);
  return formatDate(m ? (m[1] ?? m[2]) : name === 'DATE' ? 'M/d/yyyy' : 'h:mm am/pm', ms);
}

function insertField(S, instr0, result0) {
  const instr = String(instr0 ?? '').trim();
  if (!instr || instr.length > 4096) throw badParams('bad field code');
  const props = T.typingProps(S);
  const at = T.deleteSelection(S);
  const end = S.d.insertObject(at, field(instr, result0 ?? dateFieldResult(instr, nowMs(S)) ?? ''), props);
  T.setCaret(S, end);
  const out = T.finish(S);
  // Update Field works the new field out (references.updateFields, the references family's).
  if (S.ctx.registry?.has?.('references.updateFields')) {
    try { S.ctx.run('references.updateFields', {}); } catch { /* a field that can't update keeps its result, as upstream ignores the error */ }
  }
  return out;
}

// ---- cover page ----------------------------------------------------------------------------------

function coverPage(S, p) {
  const title = p.title ?? 'Document Title';
  const subtitle = p.subtitle ?? 'Document subtitle';
  const author = p.author ?? S.author;
  const accent = [0x15, 0x60, 0x82];
  const mk = () => S.d.newId();
  const blocks = [];
  for (let i = 0; i < 8; i++) blocks.push(P.newParagraph(mk()));
  const t = P.styled(P.paragraphWithText(title, {size: 44, color: {Rgb: accent}}, mk()), 'Title');
  t.props = {...(t.props ?? {}), borders: {bottom: mkBorder('single', 2, accent, 6)}};
  blocks.push(t);
  blocks.push(P.styled(P.paragraphWithText(subtitle, {}, mk()), 'Subtitle'));
  for (let i = 0; i < 14; i++) blocks.push(P.newParagraph(mk()));
  blocks.push(P.paragraphWithText(author, {bold: true, color: {Rgb: accent}}, mk()));
  const date = P.paragraphWithText(formatDate('MMMM d, yyyy', nowMs(S)), {}, mk());
  P.insertText(date, date.text.length, '\u000C', {});
  blocks.push(date);
  const start = S.d.startOf(BODY);
  S.d.splitParagraph(start);
  S.d.insertFragment(start, {blocks});
  T.setCaret(S, S.d.startOf(BODY));
  return T.finish(S);
}

// ---- drop cap ---------------------------------------------------------------------------------------

/** Why Insert › Drop Cap is off at the caret (drop_cap_off). */
function dropCapOff(ctx) {
  const st = T.ready(ctx);
  if (!st.enabled) return st;
  const all = ctx.model.selection(ctx);
  const f = (all[ctx.selection?.primary ?? 0] ?? all[0]).focus;
  if (f.path.length >= 4) return {enabled: false, reason: 'drop caps can\'t go in a table'};
  const p = ctx.model.open(ctx).paraAt(f);
  const first = p ? [...p.text][0] : undefined;
  if (first === undefined) return {enabled: false, reason: 'the paragraph is empty'};
  if (/\s/u.test(first)) return {enabled: false, reason: 'the paragraph starts with a space'};
  return {enabled: true};
}

/** Insert › Drop Cap at the caret: the menu's highlight and the dialog's values (drop_cap_state). */
export function dropCapState(ctx) {
  const all = ctx.model.selection(ctx);
  const f = (all[ctx.selection?.primary ?? 0] ?? all[0]).focus;
  const para = ctx.model.open(ctx).paraAt(f);
  const props = para?.props ?? {};
  const rp = resolvePara(ctx.doc.styles, props);
  const first = para ? P.propsAt(para, 0) ?? {} : {};
  const textFont = resolveChar(ctx.doc.styles, props.style ?? null, first).font ?? null;
  const n = rp.dropCap ?? 0;
  return {position: n === 0 ? 'none' : rp.dropCapMargin ? 'margin' : 'dropped', lines: n === 0 ? 3 : n,
    distance: n === 0 ? 0 : rp.dropCapDistance ?? 0, font: n > 0 ? rp.dropCapFont ?? null : null, textFont};
}

function dropCap(ctx, p) {
  const lines0 = typeof p.lines === 'number' && Number.isFinite(p.lines) ? p.lines : null;
  const none = p.position === 'none' || lines0 === 0;
  const margin = p.position === 'margin';
  const lines = lines0 === null ? 3 : Math.max(1, Math.min(10, Math.round(lines0)));
  const distance = typeof p.distance === 'number' ? Math.max(0, Math.min(MAX_DROP_CAP_DISTANCE, p.distance)) : 0;
  const font = typeof p.font === 'string' && p.font.trim() ? [...p.font.trim()].slice(0, 64).join('') : null;
  return fmt(ctx, pp => {
    const set = (k, v) => { if (v === null || v === undefined) delete pp[k]; else pp[k] = v; };
    set('dropCap', none ? null : lines);
    set('dropCapMargin', !none && margin ? true : null);
    set('dropCapDistance', !none && distance > 0 ? distance : null);
    set('dropCapFont', none ? null : font);
    return pp;
  });
}

// ---- tables, pictures, shapes, text boxes (objects.rs) ------------------------------------------------

/** Insert a block after the caret's paragraph, splitting it mid-paragraph (insert_block_at_caret). */
function insertBlockAtCaret(S, block) {
  const at = T.deleteSelection(S);
  const len = S.d.paraAt(at)?.text.length ?? 0;
  let insertAt;
  if (at.off === 0) insertAt = at.path;
  else {
    const nw = S.d.splitParagraph(at);
    insertAt = at.off >= len ? [...at.path.slice(0, -1), at.path[at.path.length - 1] + 1] : nw.path;
  }
  S.d.insertBlock(at.story, insertAt, block);
  // Word keeps a paragraph after a table.
  const next = [...insertAt.slice(0, -1), insertAt[insertAt.length - 1] + 1];
  if (!S.d.block(at.story, next)) S.d.insertBlock(at.story, next, P.newParagraph(S.d.newId()));
  return insertAt;
}

function insertTable(S, p) {
  const rows = Math.max(1, Math.min(1000, Math.floor(p.rows ?? 2)));
  const cols = Math.max(1, Math.min(63, Math.floor(p.cols ?? 2)));
  const width = T.firstTextWidth(S);
  let t = newTable(rows, cols, width, () => S.d.newId());
  if (p.style) {
    const st = findStyle(S.d.c.styles, p.style);
    if (!st) throw badParams(`no table style \`${p.style}\``);
    t = {...t, props: {...t.props, style: st.id}};
  }
  // A table inserted in a right-to-left paragraph is a right-to-left table (#2634).
  const fp = S.d.paraAt(S.sel.focus);
  if (fp && resolvePara(S.d.c.styles, fp.props ?? {}).bidi) t = {...t, props: {...t.props, bidiVisual: true}};
  const story = S.sel.focus.story;
  const path = insertBlockAtCaret(S, t);
  T.setCaret(S, {story, path: [...path, 0, 0, 0], off: 0});
  T.finish(S);
  return {table: S.ctx.model.addressOf(S.ctx, {story, path: [...path, 0, 0, 0], off: 0}).replace(/\/r:.*$/, ''), path};
}

/** Insert an encoded picture at the selection, fitted to the text width (place_picture). */
function placePicture(S, bytes, width, alt) {
  if (bytes.length > 200 << 20) throw failed('image is larger than 200 MB');
  const pr = probe(bytes);
  if (pr.refused) throw failed(pr.refused);
  if (pr.notPicture || !pr.width || !pr.height) throw failed('not a supported image (PNG, JPEG, GIF, WebP, BMP, WMF, EMF)');
  const key = S.d.addMedia(base64Encode(bytes), imageExt(bytes));
  const maxW = T.firstTextWidth(S);
  let w = pr.width * 0.75, h = pr.height * 0.75;
  if (typeof width === 'number') { const k = Math.max(width, 4) / Math.max(w, 1); w *= k; h *= k; }
  if (w > maxW) { h *= maxW / w; w = maxW; }
  const obj = {type: 'image', media: key, w, h, alt: alt ?? '', float: newFloat(S), crop: [0, 0, 0, 0]};
  const props = T.typingProps(S);
  const at = T.deleteSelection(S);
  const end = S.d.insertObject(at, obj, props);
  T.setCaret(S, end);
  T.finish(S);
  return {media: key, width: w, height: h};
}

/**
 * Insert › Icons (insert.icon): a library icon as a PNG picture `size` points square (default 1 inch) in `color` (default black), at
 * about 300 pixels an inch. Without an `id` it lists the library, narrowed by `query` and `category`.
 */
function listIcons(p) {
  const category = p.category === undefined ? null : parseCategory(p.category);
  return {icons: searchIcons(p.query ?? '', category).map(i => ({id: i.id, name: i.name, category: i.category, keywords: i.keywords}))};
}
function icon(S, p) {
  const ic = findIcon(p.id);
  if (!ic) throw badParams(`no icon ${JSON.stringify(p.id)} (insert.icon without an id lists them)`);
  const ink = p.color === undefined ? BLACK : parseRgb(p.color);
  if (!ink) throw badParams(`bad color ${JSON.stringify(p.color)}: use RRGGBB`);
  const size = Math.min(1584, Math.max(4, Number.isFinite(p.size) ? p.size : 72));
  const px = Math.min(1024, Math.max(64, Math.round((size * 300) / 72)));
  const r = placePicture(S, iconPng(ic, px, ink), size, ic.name);
  return {...r, icon: ic.id};
}

async function picture(ctx, p) {
  let bytes;
  if (typeof p.data === 'string') {
    bytes = bytesOf(p.data);
    if (!bytes) throw badParams('bad base64 data');
  } else if (typeof p.path === 'string') {
    // Upstream reads the file itself (crate::io::read_file); here the host reads it.
    if (typeof ctx.host?.readFile !== 'function') throw new CommandError('unavailable', 'reading a picture by path is not available here; pass `data` (base64)');
    const got = await ctx.host.readFile(p.path);
    bytes = typeof got === 'string' ? bytesOf(got) : new Uint8Array(got);
  } else {
    // No picture given: the app opens Insert Picture (upstream's ui request), the system Open dialog.
    if (typeof ctx.host?.pickImage !== 'function') return {...T.selResult(T.open(ctx)), ui: {open: 'insertPicture'}};
    const url = await ctx.host.pickImage();
    if (!url) return T.selResult(T.open(ctx));
    bytes = bytesOf(url);
  }
  return placePicture(T.open(ctx), bytes, p.width, p.alt);
}

const SHAPES = ['rectangle', 'roundedRectangle', 'ellipse', 'triangle', 'diamond', 'line', 'arrow', 'star', 'heart', 'straightConnector', 'elbowConnector', 'curvedConnector'];

function shape(S, p) {
  // The gallery's preset (core/quill/lib/shape-presets.mjs): Word's own kind, or the preset's name; connectors take their arrowhead.
  if (p.preset === 'textBox') return textBox(S, {});
  if (p.preset !== undefined) {
    const k = kindOfPreset(p.preset);
    if (!k) throw badParams('unknown shape ' + p.preset);
    p = {...p, kind: k, ...(p.preset === 'straightConnector1' && p.arrow === undefined ? {arrow: 'end'} : {})};
  }
  const kind = p.kind ?? 'rectangle';
  const w = Math.max(4, Math.min(2000, p.width ?? 108));
  const open = isOpen(kind) || isOpenPreset(presetOfKind(kind));
  const h = Math.max(isConnector(kind) || open ? 0 : 1, Math.min(2000, p.height ?? (kind === 'line' ? 1 : 72)));
  const fill = typeof p.fill === 'string' ? parseRgb(p.fill) : open ? null : [0x15, 0x60, 0x82];
  const arrows = {end: [false, true], start: [true, false], both: [true, true], none: [false, false]}[p.arrow ?? 'none'];
  if (!arrows) throw badParams(`\`arrow\`: none, start, end or both, not \`${p.arrow}\``);
  const extra = {};
  if (arrows[0]) extra.arrowStart = true;
  if (arrows[1]) extra.arrowEnd = true;
  // Connectors float in front of the text, so they can be glued to floating shapes.
  const float = isConnector(kind) ? {...P.defaultFloat(), wrap: 'inFrontOfText'} : newFloat(S);
  const stroke = (typeof p.stroke === 'string' ? parseRgb(p.stroke) : null) ?? [0x0e, 0x40, 0x5a];
  const obj = {type: 'shape', kind, w, h, fill, stroke, strokeWidth: 1, float, ...(Object.keys(extra).length ? {extra} : {})};
  // Word draws a new shape beside what is selected and never deletes it; it becomes the selection.
  const props = T.typingProps(S);
  const [, at] = T.ordered(S.sel);
  const end = S.d.insertObject(at, obj, props);
  S.sel = {anchor: T.clonePos(at), focus: end};
  S.cells = null;
  return T.finish(S);
}

function textBox(S, p) {
  const w = Math.max(18, Math.min(2000, p.width ?? 144));
  const h = Math.max(18, Math.min(2000, p.height ?? 72));
  const id = S.d.tryAddPart('textBox', [P.paragraphWithText(p.text ?? '', {}, S.d.newId())]);
  const obj = {type: 'shape', kind: 'textBox', w, h, fill: [...WHITE], stroke: [0, 0, 0], strokeWidth: 0.75, float: newFloat(S), story: id};
  const props = T.typingProps(S);
  const at = T.deleteSelection(S);
  S.d.insertObject(at, obj, props);
  // Like Word, type straight into the new box.
  T.setCaret(S, S.d.endOf(id));
  T.finish(S);
  return {story: id};
}

// ---- links and bookmarks (links.rs, references/toc.rs) ---------------------------------------------------

/** The heading level (1–9) of a built-in heading style (heading_style_level). */
const headingStyleLevel = p => { const m = /^Heading\s*(\d+)$/.exec(p.props?.style ?? ''); const l = m ? Number(m[1]) : 0; return l >= 1 && l <= 9 ? l : null; };

/** The body's headings as TOC \o "1-9" \u collects them: [block, level, text, lead] (headings). */
export function headings(d) {
  const out = [];
  const counters = new Counters();
  for (const path of d.paraPaths(BODY)) {
    const p = d.para(BODY, path);
    if (!p) continue;
    let n = p.props?.numbering ?? resolvePara(d.c.styles, p.props ?? {}).numbering;
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
    let lead = 0;
    while (p.text[lead] === '\u000C') lead++;
    const ol = p.props?.outlineLevel;
    const byOutline = typeof ol === 'number' && ol < 9 ? ol + 1 : null;
    const hidden = ol === 9;
    let byHeading = headingStyleLevel(p);
    if (byHeading === null) { const rl = resolvePara(d.c.styles, {style: p.props?.style}).outlineLevel; byHeading = typeof rl === 'number' ? rl + 1 : null; }
    if (byHeading !== null && !(byHeading >= 1 && byHeading <= 9)) byHeading = null;
    const l = byOutline ?? (hidden ? null : byHeading);
    if (l !== null && path.length === 1) {
      const t = P.plainText(p).replace(/[\u000C\n\t]/g, ' ').trim();
      if (t) out.push([path[0], l, number ? `${number}${t}` : t, lead]);
    }
  }
  return out;
}

/** Bookmark a heading with a hidden _Toc bookmark (toc_bookmark / bookmark_heading). */
function tocBookmark(S, i, lead) {
  const path = [i];
  const para = S.d.para(BODY, path);
  if (!para) throw failed('heading is gone');
  const o = P.objectAt(para, lead);
  if (o?.type === 'bookmarkStart' && o.name.startsWith('_Toc')) return o.name;
  const next = Math.max(0, ...S.d.bookmarks().map(([n]) => (/^_Toc(\d+)$/.exec(n) ? Number(/^_Toc(\d+)$/.exec(n)[1]) : 0))) + 1;
  const name = `_Toc${String(next).padStart(9, '0')}`;
  const end = para.text.length;
  S.d.insertObject({story: BODY, path, off: end}, {type: 'bookmarkEnd', name}, {});
  S.d.insertObject({story: BODY, path, off: lead}, {type: 'bookmarkStart', name}, {});
  for (const k of ['anchor', 'focus']) {
    const q = S.sel[k];
    if (q.story === BODY && samePath(q.path, path)) {
      if (q.off > end) q.off += 2; else if (q.off >= lead && q.off > 0) q.off += 1;
    }
  }
  return name;
}

function linkTargets(ctx) {
  const d = ctx.model.open(ctx);
  const hs = headings(d).map(([block, level, text]) => ({block, level, text, address: ctx.model.addressOf(ctx, {story: BODY, path: [block], off: 0}).replace(/\/t:.*$/, '')}));
  const bookmarks = [];
  for (const [name] of d.bookmarks()) if (!name.startsWith('_') && !bookmarks.includes(name)) bookmarks.push(name);
  return {top: true, headings: hs, bookmarks};
}

function placeTarget(S, p) {
  if (p.top === true) return ['#_top', 'Top of the Document'];
  if (typeof p.bookmark === 'string') {
    if (!S.d.bookmarks().some(([n]) => n === p.bookmark)) throw badParams(`no bookmark \`${p.bookmark}\``);
    return [`#${p.bookmark}`, p.bookmark];
  }
  if (p.heading !== undefined) {
    let block = p.heading;
    if (typeof block === 'string') { try { block = S.ctx.model.position(S.ctx, block).path[0]; } catch { throw badParams(`block ${p.heading} is not a heading`); } }
    const h = headings(S.d).find(x => x[0] === block);
    if (!h) throw badParams(`block ${p.heading} is not a heading`);
    const name = tocBookmark(S, h[0], h[3]);
    return [`#${name}`, h[2]];
  }
  return null;
}

function link(S, p) {
  let url, label;
  if (typeof p.url === 'string') { url = p.url; label = p.url; } else {
    const t = placeTarget(S, p);
    if (!t) return {...T.finish(S), ui: {open: 'link'}};
    [url, label] = t;
  }
  if (!url || url.length > 4096) throw badParams('bad url');
  const tip = typeof p.tooltip === 'string' ? p.tooltip.trim().slice(0, 255) : '';
  if (T.isCollapsed(S.sel)) {
    const text = p.text ?? label;
    const props = {...T.typingProps(S), link: url, style: 'Hyperlink', ...(tip ? {linkTip: tip} : {})};
    const end = S.d.insertText(S.sel.focus, text, props);
    T.setCaret(S, end);
    S.nextPending = {};
  } else {
    const [a, b] = T.ordered(S.sel);
    S.d.formatRange(a, b, c => { const o = {...c, link: url, style: 'Hyperlink'}; if (tip) o.linkTip = tip; else delete o.linkTip; return o; });
  }
  return T.finish(S);
}

/** Whether `name` can name a bookmark (bookmark_name_ok). */
export function bookmarkNameOk(name) {
  const chars = [...name];
  return chars.length > 0 && chars.length <= 40 && /[\p{L}_]/u.test(chars[0]) && chars.every(c => /^[\p{L}\p{N}_]$/u.test(c));
}

/** Remove bookmark `name`'s marks everywhere, keeping the selection on the same text (remove_bookmark). */
function removeBookmark(S, name) {
  let found = false;
  const stories = [BODY, ...Object.keys(S.d.c.parts).map(Number)];
  for (const story of stories) {
    for (const path of S.d.paraPaths(story)) {
      const p = S.d.para(story, path);
      if (!p) continue;
      const marks = [];
      for (const [off, o] of P.objectsWithOffsets(p)) {
        if (o.type === 'bookmarkStart' && o.name === name) { found = true; marks.push(off); } else if (o.type === 'bookmarkEnd' && o.name === name) marks.push(off);
      }
      if (!marks.length) continue;
      for (const off of marks.reverse()) {
        S.d.deleteRange({story, path, off}, {story, path, off: off + 1});
        for (const k of ['anchor', 'focus']) { const q = S.sel[k]; if (q.story === story && samePath(q.path, path) && q.off > off) q.off -= 1; }
      }
    }
  }
  S.sel = {anchor: S.d.clamp(S.sel.anchor), focus: S.d.clamp(S.sel.focus)};
  return found;
}

function bookmark(S, p) {
  const name = String(p.name ?? '').trim();
  if (!bookmarkNameOk(name)) throw badParams('bookmark names start with a letter, have no spaces and at most 40 characters');
  removeBookmark(S, name);
  const [a, b] = T.ordered(S.sel);
  S.d.insertObject(b, {type: 'bookmarkEnd', name}, {});
  S.d.insertObject(a, {type: 'bookmarkStart', name}, {});
  // The selection keeps covering the same text (inside the bookmark).
  const shift = (q, isEnd) => { if (q.story === a.story && samePath(q.path, a.path) && (q.off > a.off || (q.off === a.off && isEnd && !T.isCollapsed(S.sel)))) q.off += 1; };
  const [x, y] = T.ordered(S.sel);
  shift(y, true);
  if (x !== y) shift(x, false);
  S.sel = {anchor: S.d.clamp(S.sel.anchor), focus: S.d.clamp(S.sel.focus)};
  return T.finish(S);
}

function deleteBookmark(S, p) {
  const name = String(p.name ?? '').trim();
  if (!removeBookmark(S, name)) throw badParams(`no bookmark \`${name}\``);
  return T.finish(S);
}

/** Where bookmark `name` is: from just after its start mark to its end mark (bookmark_range). */
export function bookmarkRange(d, name) {
  const got = d.bookmarks().find(([n]) => n === name);
  if (!got) return null;
  const start = got[1];
  const from = {...start, path: [...start.path], off: start.off + 1};
  let end = null;
  const paths = d.paraPaths(start.story);
  const i0 = paths.findIndex(q => samePath(q, start.path));
  for (const path of paths.slice(Math.max(0, i0))) {
    const para = d.para(start.story, path);
    if (!para) continue;
    const hit = P.objectsWithOffsets(para).find(([off, o]) => (!samePath(path, start.path) || off > start.off) && o.type === 'bookmarkEnd' && o.name === name);
    if (hit) { end = {story: start.story, path, off: hit[0]}; break; }
  }
  return [from, end ?? from];
}

// ---- headers and footers (header_footer.rs) ----------------------------------------------------------

const layoutOf = S => layout(S.d.c);

/** The header (footer) of the caret's section in the slot the caret's page uses, made when there is none (hf_part). */
function hfPart(S, header) {
  const block = S.sel.focus.path[0] ?? 0;
  const lay = layoutOf(S);
  const page = S.sel.focus.story === BODY ? lay.pageOf(S.sel.focus) : (S.ctx.view?.pageHint ?? 0);
  const slot = (page !== null && lay.pages[page]?.hfSlot) || 'default';
  const sect = S.d.sectionOfBlock(block);
  const set = header ? sect.headers : sect.footers;
  const existing = set?.[slot] ?? null;
  if (existing !== null && existing !== undefined && S.d.c.parts[existing]) return existing;
  const id = S.d.addPart(header ? 'header' : 'footer', [P.styled(P.newParagraph(S.d.newId()), header ? 'Header' : 'Footer')]);
  S.d.updateSection(block, sc => { const k = header ? 'headers' : 'footers'; sc[k] = {...(sc[k] ?? {}), [slot]: id}; });
  return id;
}

/** Three independently editable cells spanning the section's text width (three_column_hf). */
function threeColumnHf(S, style) {
  const block = S.sel.focus.path[0] ?? 0;
  const sections = S.d.sections();
  const i = sections.findIndex(([end]) => block <= end);
  const own = i >= 0 && i + 1 < sections.length ? sections[i] : null;
  const width = own ? textWidth(own[1]) : textWidth(S.d.c.lastSection);
  const mk = () => S.d.newId();
  let t = newTable(1, 3, width, mk);
  t = {...t, props: {...t.props, style: 'TableNormal', width, fixed: true, borders: bordersAll(mkBorder())}};
  t.rows = t.rows.map(row => ({...row, cells: row.cells.map((cell, k) => {
    const para = P.styled(P.newParagraph(mk()), style);
    para.props = {...para.props, align: ['left', 'center', 'right'][k]};
    return {...cell, blocks: [para]};
  })}));
  return [t, P.styled(P.newParagraph(mk()), style)];
}

/** Remember where Close Header and Footer goes back to (session/run.rs: entering a header from the body). */
function enterHf(S, before) {
  if (before.focus.story === BODY) S.ctx.setView({hfReturn: {anchor: S.ctx.model.addressOf(S.ctx, before.anchor), focus: S.ctx.model.addressOf(S.ctx, before.focus)}});
}
const snapshot = S => ({anchor: T.clonePos(S.sel.anchor), focus: T.clonePos(S.sel.focus)});
function noteNewPart(S, id) {
  const list = Array.isArray(S.ctx.view?.newHeaderParts) ? S.ctx.view.newHeaderParts : [];
  if (!list.includes(id)) S.ctx.setView({newHeaderParts: [...list, id]});
}

function headerFooter(S, p, header) {
  const before = snapshot(S);
  const id = hfPart(S, header);
  const style = header ? 'Header' : 'Footer';
  const mk = () => S.d.newId();
  if (typeof p.text === 'string') {
    S.d.setStory(id, p.text.split('\n').map(l => P.styled(P.paragraphWithText(l, {}, mk()), style)));
  } else if (p.preset === 'blankThree') {
    S.d.setStory(id, threeColumnHf(S, style));
  } else if (p.preset) {
    const para = P.styled(P.newParagraph(mk()), style);
    if (p.preset === 'title') {
      P.insertText(para, 0, S.d.c.core?.title ? S.d.c.core.title : '[Document title]', {});
      para.props = {...para.props, align: 'center'};
    } else if (p.preset === 'pageNumber') {
      para.props = {...para.props, align: 'center'};
      P.insertObject(para, 0, {...field('PAGE', '1'), oid: mk()}, {});
    } else P.insertText(para, 0, '[Type here]', {});
    S.d.setStory(id, [para]);
  }
  T.setCaret(S, S.d.startOf(id));
  T.finish(S);
  enterHf(S, before);
  return {story: id};
}

function pageNumber(S, p) {
  const position = p.position ?? 'bottom';
  const align = {left: 'left', right: 'right'}[p.align] ?? 'center';
  const xOfY = typeof p.format === 'string' && p.format.includes('of');
  const mk = () => S.d.newId();
  if (position === 'current') {
    const props = T.typingProps(S);
    const at = T.deleteSelection(S);
    const end = S.d.insertObject(at, field('PAGE', '1'), props);
    T.setCaret(S, end);
    return T.finish(S);
  }
  const header = position === 'top';
  const id = hfPart(S, header);
  const para = P.styled(P.newParagraph(mk()), header ? 'Header' : 'Footer');
  para.props = {...para.props, align, tabs: [{pos: 0, align: 'clear', leader: 'none'}]};
  if (xOfY) {
    P.insertText(para, 0, 'Page  of ', {});
    P.insertObject(para, 5, {...field('PAGE', '1'), oid: mk()}, {bold: true});
    P.insertObject(para, para.text.length, {...field('NUMPAGES', '1'), oid: mk()}, {bold: true});
  } else P.insertObject(para, 0, {...field('PAGE', '1'), oid: mk()}, {});
  S.d.setStory(id, [para]);
  T.finish(S);
  return {story: id};
}

/** The header (footer) page `page` shows, if any (shown_hf). */
function shownHf(S, page, header) {
  const lay = layoutOf(S);
  const pg = lay.pages[page];
  if (!pg) throw badParams(`no page ${page}`);
  const id = header ? pg.headerStory : pg.footerStory;
  return id !== null && id !== undefined && S.d.c.parts[id] ? id : null;
}

// Upstream's Edit Header is `.pure()` and makes a missing header with a nested
// `s.run("insert.createHeader")`, its own undo step. The kernel refuses document changes from a
// read command, so here it is an edit command: going into an existing header changes nothing and
// leaves no undo step (the kernel records none for an empty transaction); making one is one undo
// step, as upstream.
function editHf(ctx, p, header) {
  const S = T.open(ctx);
  let page = typeof p.page === 'number' ? p.page : null;
  if (page === null && S.sel.focus.story === BODY) page = layoutOf(S).pageOf(S.sel.focus);
  let shown;
  if (page !== null && page !== undefined) shown = shownHf(S, page, header);
  else {
    const block = S.sel.focus.path[0] ?? 0;
    const sec = S.d.sectionOfBlock(block);
    const id = header ? sec.headers?.default : sec.footers?.default;
    shown = id !== null && id !== undefined && S.d.c.parts[id] ? id : null;
  }
  if (shown === null) return ctx.run(header ? 'insert.createHeader' : 'insert.createFooter', page === null || page === undefined ? {} : {page});
  if (page !== null && page !== undefined) ctx.setView({pageHint: page});
  const before = snapshot(S);
  T.setCaret(S, S.d.endOf(shown));
  T.finish(S);
  enterHf(S, before);
  return {story: shown};
}

function createHf(S, p, header) {
  const before = snapshot(S);
  let id;
  if (typeof p.page === 'number') {
    S.ctx.setView({pageHint: p.page});
    id = shownHf(S, p.page, header);
    if (id === null) {
      const lay = layoutOf(S);
      const slot = lay.pages[p.page]?.hfSlot ?? 'default';
      const block = S.d.sections()[0]?.[0] ?? 0;
      id = S.d.addPart(header ? 'header' : 'footer', [P.styled(P.newParagraph(S.d.newId()), header ? 'Header' : 'Footer')]);
      S.d.updateSection(block, sc => { const k = header ? 'headers' : 'footers'; sc[k] = {...(sc[k] ?? {}), [slot]: id}; });
      noteNewPart(S, id);
    }
  } else {
    const n = Object.keys(S.d.c.parts).length;
    id = hfPart(S, header);
    if (Object.keys(S.d.c.parts).length > n) noteNewPart(S, id);
  }
  T.setCaret(S, S.d.endOf(id));
  T.finish(S);
  enterHf(S, before);
  return {story: id};
}

/** Headers/footers Edit Header made that are still one empty paragraph (new_empty_headers). */
function newEmptyHeaders(ctx, content) {
  const list = Array.isArray(ctx.view?.newHeaderParts) ? ctx.view.newHeaderParts : [];
  return list.filter(id => {
    const part = content.parts[id];
    return part && (part.kind === 'header' || part.kind === 'footer') && part.blocks.length === 1
      && part.blocks[0].kind === 'para' && part.blocks[0].text === '' && !(part.blocks[0].objects?.length);
  });
}

/** Take headers/footers `ids` out of the document and every section that refers to them (strip_headers). */
function stripHeaders(d, ids) {
  if (!ids.length) return false;
  const clear = set => { if (!set) return set; const out = {...set}; for (const k of ['default', 'first', 'even']) if (ids.includes(out[k])) out[k] = null; return out; };
  d.setField('lastSection', {...d.c.lastSection, headers: clear(d.c.lastSection.headers), footers: clear(d.c.lastSection.footers)});
  for (const path of d.paraPaths(BODY)) {
    const para = d.para(BODY, path);
    if (!para?.section) continue;
    const q = d.paraMut(BODY, path);
    q.section = {...q.section, headers: clear(q.section.headers), footers: clear(q.section.footers)};
  }
  let any = false;
  for (const id of ids) any = d.removePart(id) || any;
  return any;
}

function closeHeader(ctx) {
  const S = T.open(ctx);
  const inHf = S.sel.focus.story !== BODY && ['header', 'footer'].includes(S.d.c.parts[S.sel.focus.story]?.kind);
  const back = inHf ? ctx.view?.hfReturn ?? null : null;
  ctx.setView({hfReturn: null});
  if (newEmptyHeaders(ctx, ctx.doc).length) {
    try { ctx.run('insert.removeEmptyHeaders', {}); } catch { /* a protected document keeps it; the caret still leaves */ }
  }
  let sel = null;
  if (back) { try { sel = {anchor: ctx.model.position(ctx, back.anchor), focus: ctx.model.position(ctx, back.focus)}; } catch { sel = null; } }
  const d = ctx.model.open(ctx);
  if (!sel) { const st = d.startOf(BODY); sel = {anchor: st, focus: st}; }
  ctx.model.setSelection(ctx, [sel]);
  return {anchor: ctx.model.addressOf(ctx, sel.anchor), focus: ctx.model.addressOf(ctx, sel.focus)};
}

// ---- the command table ------------------------------------------------------------------------------

const ready = T.ready;
const notInTextBox = ctx => {
  const st = ready(ctx);
  if (!st.enabled) return st;
  const all = ctx.model.selection(ctx);
  const f = (all[ctx.selection?.primary ?? 0] ?? all[0]).focus;
  return f.story !== BODY && ctx.doc.parts[f.story]?.kind === 'textBox' ? {enabled: false, reason: 'text boxes can\'t go inside a text box'} : st;
};
const hfState = header => ctx => {
  const st = ready(ctx);
  if (!st.enabled) return st;
  return st;
};

export default defineCommands({
  family: 'insert',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'insert.pageBreak', label: 'Page Break', risk: 'edit', state: ready,
      description: 'Page Break (Insert › Pages): the text after the caret starts on the next page.',
      params: s.object({}), run: run(pageBreak)},
    {id: 'insert.blankPage', label: 'Blank Page', risk: 'edit', state: ready,
      description: 'Blank Page (Insert › Pages): an empty page at the caret.',
      params: s.object({}), run: run(blankPage)},
    {id: 'insert.coverPage', label: 'Cover Page', risk: 'edit', state: ready,
      description: 'Cover Page (Insert › Pages): a title page at the start of the document with title, subtitle, author and date.',
      params: s.object({title: s.optional(s.string({max: 4096})), subtitle: s.optional(s.string({max: 4096})), author: s.optional(s.string({max: 4096}))}),
      run: run(coverPage)},
    {id: 'insert.table', label: 'Table', risk: 'edit', state: ready, dialog: 'dialog.insertTable',
      description: 'Table (Insert › Tables): a rows × columns table after the caret\'s paragraph, the caret in its first cell.',
      params: s.object({rows: s.integer({min: 1, max: 32767}), cols: s.integer({min: 1, max: 63}), style: s.optional(s.string({max: 256}))}),
      run: run(insertTable)},
    {id: 'insert.picture', label: 'Pictures', risk: 'edit', state: ready,
      description: 'Pictures (Insert › Illustrations): a picture (PNG, JPEG, GIF, WebP, BMP, TIFF) at the caret, fitted to the text width; without one, the system Insert Picture dialog.',
      params: s.object({path: s.optional(s.string({max: 4096})), data: s.optional(s.string({max: 300_000_000})), width: s.optional(s.number({min: 0, max: 100000})),
        alt: s.optional(s.string({max: 10000}))}),
      run: picture},
    {id: 'insert.icon', label: 'Icons', risk: 'edit', state: ready, dialog: 'dialog.icons',
      description: 'Icons (Insert › Illustrations): a library icon (by `id`; `color` RRGGBB, `size` in points) as a picture at the caret; without an `id`, lists the icons matching `query` and `category`.',
      params: s.object({id: s.optional(s.string({max: 64})), query: s.optional(s.string({max: 256})), category: s.optional(s.string({max: 64})), color: s.optional(s.string({max: 16})),
        size: s.optional(s.number({min: 4, max: 1584}))}),
      run: (ctx, p) => (p?.id === undefined ? listIcons(p ?? {}) : icon(T.open(ctx), p))},
    {id: 'insert.shape', label: 'Shapes', risk: 'edit', state: ready,
      description: 'Shapes (Insert › Illustrations): a shape after the selection, selected: `preset` any of the 180 preset shapes by their OOXML name (rect, wedgeRectCallout, chevron, flowChartProcess, star8 ...), or `kind` rectangle, roundedRectangle, ellipse, triangle, diamond, line, arrow, star, heart or a connector.',
      params: s.object({kind: s.optional(s.enum(SHAPES)), preset: s.optional(s.string({max: 40})), width: s.optional(s.number()), height: s.optional(s.number()), fill: s.optional(s.color()),
        stroke: s.optional(s.color()), arrow: s.optional(s.enum(['none', 'start', 'end', 'both']))}),
      run: run(shape)},
    {id: 'insert.textBox', label: 'Text Box', risk: 'edit', state: notInTextBox,
      description: 'Text Box (Insert › Text): a text box at the caret with the caret inside it.',
      params: s.object({text: s.optional(s.string({max: 100000})), width: s.optional(s.number()), height: s.optional(s.number()), draw: s.optional(s.boolean())}),
      run: (ctx, p) => { const st = notInTextBox(ctx); if (!st.enabled) throw T.disabled(st.reason); return textBox(T.open(ctx), p ?? {}); }},
    {id: 'insert.link', label: 'Link', risk: 'edit', shortcut: 'Mod+K', state: ready, dialog: 'dialog.link',
      description: 'Link (Insert › Links): a hyperlink to a web page or e-mail address, or to a bookmark, a heading or the top of this document.',
      params: s.object({url: s.optional(s.string({max: 4096})), bookmark: s.optional(s.string({max: 64})), heading: s.optional(s.union([s.integer({min: 0}), s.string({max: 512})])),
        top: s.optional(s.boolean()), text: s.optional(s.string({max: 4096})), tooltip: s.optional(s.string({max: 255}))}),
      run: run(link)},
    {id: 'link.targets', label: 'Link', risk: 'read', state: ready,
      description: 'The places in this document a link can go to: the top, the headings and the bookmarks.',
      params: s.object({}), run: ctx => linkTargets(ctx)},
    {id: 'insert.removeLink', label: 'Remove Hyperlink', risk: 'edit', state: ready,
      description: 'Remove Hyperlink (Insert › Links): the selected text stops being a link.',
      params: s.object({}),
      run: ctx => applyChar(ctx, c => { delete c.link; delete c.linkTip; if (c.style === 'Hyperlink') delete c.style; return c; })},
    {id: 'insert.bookmark', label: 'Bookmark', risk: 'edit', shortcut: 'Mod+Shift+F5', state: ready, dialog: 'dialog.bookmark',
      description: 'Bookmark (Insert › Links): name the selection (or the caret) as a bookmark; an existing one of that name moves here.',
      params: s.object({name: s.string({min: 1, max: 64})}), run: run(bookmark)},
    {id: 'insert.deleteBookmark', label: 'Delete Bookmark', risk: 'edit', state: ready,
      description: 'Delete Bookmark (Insert › Links › Bookmark): remove a bookmark; the text stays.',
      params: s.object({name: s.string({min: 1, max: 64})}), run: run(deleteBookmark)},
    {id: 'insert.header', label: 'Header', risk: 'edit', state: ready,
      description: 'Header (Insert › Header & Footer): the caret page\'s header, blank, three-column or with the title, and the caret in it.',
      params: s.object({text: s.optional(s.string({max: 100000})), preset: s.optional(s.enum(['blank', 'blankThree', 'title']))}),
      run: run((S, p) => headerFooter(S, p, true))},
    {id: 'insert.footer', label: 'Footer', risk: 'edit', state: ready,
      description: 'Footer (Insert › Header & Footer): the caret page\'s footer, blank, three-column or with the page number, and the caret in it.',
      params: s.object({text: s.optional(s.string({max: 100000})), preset: s.optional(s.enum(['blank', 'blankThree', 'pageNumber']))}),
      run: run((S, p) => headerFooter(S, p, false))},
    {id: 'insert.pageNumber', label: 'Page Number', risk: 'edit', state: ready,
      description: 'Page Number (Insert › Header & Footer): a PAGE field at the top or bottom of the page (or "Page X of Y"), or at the caret.',
      params: s.object({position: s.optional(s.enum(['top', 'bottom', 'current', 'margin'])), align: s.optional(s.enum(['left', 'center', 'right'])), format: s.optional(s.string({max: 64}))}),
      run: run(pageNumber)},
    {id: 'insert.editHeader', label: 'Edit Header', risk: 'edit', state: hfState(true),
      description: 'Edit Header (Insert › Header & Footer › Header): the caret goes into the header the page shows, made if it has none.',
      params: s.object({page: s.optional(s.integer({min: 0}))}), run: (ctx, p) => editHf(ctx, p ?? {}, true)},
    {id: 'insert.editFooter', label: 'Edit Footer', risk: 'edit', state: hfState(false),
      description: 'Edit Footer (Insert › Header & Footer › Footer): the caret goes into the footer the page shows, made if it has none.',
      params: s.object({page: s.optional(s.integer({min: 0}))}), run: (ctx, p) => editHf(ctx, p ?? {}, false)},
    {id: 'insert.createHeader', label: 'Header', risk: 'edit', state: ready,
      description: 'The header the page shows, created if it has none, with the caret in it.',
      params: s.object({page: s.optional(s.integer({min: 0}))}), run: run((S, p) => createHf(S, p, true))},
    {id: 'insert.createFooter', label: 'Footer', risk: 'edit', state: ready,
      description: 'The footer the page shows, created if it has none, with the caret in it.',
      params: s.object({page: s.optional(s.integer({min: 0}))}), run: run((S, p) => createHf(S, p, false))},
    {id: 'insert.closeHeader', label: 'Close Header and Footer', risk: 'edit', state: ready,
      description: 'Close Header and Footer: back to where the caret was in the body; a header made and left empty goes again.',
      params: s.object({}), run: ctx => closeHeader(ctx)},
    {id: 'insert.removeEmptyHeaders', label: 'Close Header and Footer', risk: 'edit', state: ready,
      description: 'Take away the headers and footers Edit Header made that are still empty.',
      params: s.object({}),
      run: ctx => {
        ctx.model.edit(ctx, d => stripHeaders(d, newEmptyHeaders(ctx, ctx.doc)));
        // Run on its own with the caret in a header it took away, the caret goes back to the body
        // (upstream leaves that to Close Header, which runs this first).
        let inside = true;
        try { ctx.model.selection(ctx); } catch { inside = false; }
        if (!inside) {
          const back = ctx.view?.hfReturn;
          let sel = null;
          if (back) { try { sel = {anchor: ctx.model.position(ctx, back.anchor), focus: ctx.model.position(ctx, back.focus)}; } catch { sel = null; } }
          if (!sel) { const st = ctx.model.open(ctx).startOf(BODY); sel = {anchor: st, focus: st}; }
          ctx.model.setSelection(ctx, [sel]);
        }
        return T.selResult(T.open(ctx));
      }},
    {id: 'insert.removeHeader', label: 'Remove Header', risk: 'edit', state: ready,
      description: 'Remove Header (Insert › Header & Footer › Header): no section shows a header any more.',
      params: s.object({}),
      run: run(S => {
        S.d.setField('lastSection', {...S.d.c.lastSection, headers: {default: null, first: null, even: null}});
        for (const path of S.d.paraPaths(BODY)) {
          if (!S.d.para(BODY, path)?.section) continue;
          const q = S.d.paraMut(BODY, path);
          q.section = {...q.section, headers: {default: null, first: null, even: null}};
        }
        return T.finish(S);
      })},
    {id: 'insert.removeFooter', label: 'Remove Footer', risk: 'edit', state: ready,
      description: 'Remove Footer (Insert › Header & Footer › Footer): the last section shows no footer.',
      params: s.object({}),
      run: run(S => { S.d.setField('lastSection', {...S.d.c.lastSection, footers: {default: null, first: null, even: null}}); return T.finish(S); })},
    {id: 'insert.dateTime', label: 'Date & Time', risk: 'edit', state: ready, dialog: 'dialog.dateTime',
      description: 'Date & Time (Insert › Text): today\'s date in a Word picture (M/d/yyyy, MMMM d, yyyy…), as text or a DATE field that updates.',
      params: s.object({format: s.optional(s.string({min: 1, max: 256})), update: s.optional(s.boolean())}), run: run(dateTime)},
    {id: 'insert.symbol', label: 'Symbol', risk: 'edit', state: ready, dialog: 'dialog.symbol',
      description: 'Symbol (Insert › Symbols): a character at the caret, in its own font when one is named.',
      params: s.object({char: s.string({min: 1, max: 256}), font: s.optional(s.string({max: 512}))}), run: run(symbol)},
    {id: 'insert.field', label: 'Field', risk: 'edit', shortcut: 'Mod+F9', state: ready, dialog: 'dialog.field',
      description: 'Field (Insert › Text › Quick Parts): a field (DATE, PAGE, AUTHOR, =formula…) at the caret.',
      params: s.object({instr: s.string({min: 1, max: 4096}), result: s.optional(s.string({max: 100000}))}),
      run: run((S, p) => insertField(S, p.instr, p.result))},
    {id: 'insert.dateField', label: 'Insert Date Field', risk: 'edit', shortcut: 'Alt+Shift+D', state: ready,
      description: 'A DATE field at the caret (Alt+Shift+D).', params: s.object({}), run: run(S => insertField(S, 'DATE'))},
    {id: 'insert.timeField', label: 'Insert Time Field', risk: 'edit', shortcut: 'Alt+Shift+T', state: ready,
      description: 'A TIME field at the caret (Alt+Shift+T).', params: s.object({}), run: run(S => insertField(S, 'TIME'))},
    {id: 'insert.pageField', label: 'Insert Page Field', risk: 'edit', shortcut: 'Alt+Shift+P', state: ready,
      description: 'A PAGE field at the caret (Alt+Shift+P).', params: s.object({}), run: run(S => insertField(S, 'PAGE'))},
    {id: 'insert.dropCap', label: 'Drop Cap', risk: 'edit', dialog: 'dialog.dropCap',
      description: 'Drop Cap (Insert › Text): the paragraph\'s first letter dropped into the text or hung in the margin, lines tall.',
      params: s.object({position: s.optional(s.enum(['none', 'dropped', 'margin'])), lines: s.optional(s.number({min: 0, max: 10})),
        distance: s.optional(s.number({min: 0, max: 1584})), font: s.optional(s.string({max: 256}))}),
      state(ctx, p) {
        const st = dropCapOff(ctx);
        if (!st.enabled) return st;
        const cur = dropCapState(ctx);
        return {enabled: true, checked: p?.position ? cur.position === p.position : undefined, value: cur};
      },
      run: (ctx, p) => { const st = dropCapOff(ctx); if (!st.enabled) throw T.disabled(st.reason); return dropCap(ctx, p ?? {}); }},
    {id: 'insert.horizontalLine', label: 'Horizontal Line', risk: 'edit', state: ready,
      description: 'Horizontal Line (Home › Paragraph › Borders): a 1.5 pt line below the selected paragraphs.',
      params: s.object({}),
      run: ctx => fmt(ctx, pp => ({...pp, borders: {bottom: mkBorder('single', 1.5, null, 0)}}))},
  ],
});
