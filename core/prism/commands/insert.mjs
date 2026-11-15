// Insert tab: shapes, icons, text boxes, pictures, tables, audio, video, WordArt, slide number,
// date and time, symbols, links, action settings and action buttons.
// Translated from deckcraft crates/engine/src/cmd/insert.rs, cmd/insert/picture.rs,
// cmd/insert/text_fields.rs and cmd/insert/links.rs (plus text/editing.rs `insert_field` and
// text/formatting.rs `link_text`, which these commands call) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Not translated yet (the ribbon keeps them hidden): insert.photoAlbum / insert.photoAlbumEdit
// (cmd/insert/album.rs), insert.chart and chart.type / chart.data / chart.options
// (cmd/insert/chart.rs and the chart model), insert.smartArt (cmd/smartart.rs). Audio and video are
// embedded as deckcraft does, but without its media probe (codecs, duration, poster frame):
// `durationMs`, `width`, `height` stay 0 and `playable` reports what the type says.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {
  UPSTREAM_COMMIT, bad, always, hasDoc, hasSlide, hasSelection, hasTextOrShapes, num, str, usize, clamp, rectParam, defaultRect, addShape,
  editShapes, currentSlide, selectIds, mediaBytes, contentType, imageDimensions, fittedSize, addMedia, pictureFill, lineDefault, applyPainted,
  colorScheme, fillSolid, fillNone, writeShape,
} from '../lib/shape-common.mjs';
import {ICONS, findIcon, pathData as iconPath, strokeWidth, VIEW} from '../lib/insert-icons.mjs';
import {fieldText, fromMillis, dateTime, DATE_KINDS} from '../lib/insert-datetime.mjs';
import {editText, fitTextBox, NO_TEXT_POINT, textPositions, bodyOf, ordered} from '../lib/text-session.mjs';
import {insertText} from './text.mjs';
import {CATALOG, info as presetInfo, isLineLike, categoryLabel} from '../model/geom/preset/catalog.mjs';
import {shape as newShape} from '../model/presentation.mjs';
import {bodyFromText} from '../model/text.mjs';
import {newTable} from '../model/table.mjs';
import {remove, insert as insertAt, insertBody, propsAt, format as formatRange} from '../model/edit.mjs';
import {accentStyle, lineStyle} from '../model/style.mjs';
import {textSelection, slideById, xfrmOf, selectText, selectedShapeIds} from '../model/doc.mjs';
import {findShape, slideTitle} from '../model/presentation.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: [
  'crates/engine/src/cmd/insert.rs', 'crates/engine/src/cmd/insert/picture.rs', 'crates/engine/src/cmd/insert/text_fields.rs',
  'crates/engine/src/cmd/insert/links.rs', 'crates/engine/src/cmd/text/editing.rs', 'crates/engine/src/cmd/text/formatting.rs',
  'crates/engine/src/icons.rs', 'crates/text/src/datetime.rs']};

const ID = s.union([s.string({min: 1, max: 64}), s.integer({min: 0})]);
const ids = s.optional(s.array(ID, {max: 5000}));
const rect = s.optional(s.array(s.number(), {min: 4, max: 4, description: '[x, y, w, h] pt'}));

// ---------------------------------------------------------------------------------------------
// Shapes, icons, text boxes (insert.rs)

function insertShape(ctx, p) {
  const preset = str(p, 'preset') ?? 'rect';
  const info = presetInfo(preset);
  if (!info) throw bad('shape.insert', `unknown preset \`${preset}\``);
  const lineLike = isLineLike(preset);
  const r = rectParam(p, 'rect') ?? defaultRect(ctx, 72, lineLike ? 0 : 72);
  const adj = Array.isArray(p.adj) ? p.adj.filter(v => typeof v === 'number') : [];
  const sh = newShape({xfrm: {...r}, geom: adj.length ? {kind: 'preset', name: info.name, adj} : {kind: 'preset', name: info.name},
    style: lineLike ? lineStyle('accent1') : accentStyle('accent1')});
  if (typeof p.flip === 'string') {
    if (p.flip.includes('h')) sh.xfrm.flipH = true;
    if (p.flip.includes('v')) sh.xfrm.flipV = true;
  }
  if (!lineLike) {
    const body = typeof p.text === 'string' ? bodyFromText(p.text) : {body: {}, paragraphs: []};
    body.paragraphs = body.paragraphs.map(pa => ({...pa, props: {...(pa.props ?? {}), align: 'center'}}));
    sh.text = body;
  } else {
    sh.kind = preset.includes('Connector') ? {type: 'connector', start: null, end: null} : {type: 'shape'};
    if (preset === 'straightConnector1') sh.line = {...lineDefault(), tail: {kind: 'triangle', w: 'med', len: 'med'}};
  }
  if (ctx.view?.defaultLook && !lineLike) applyPainted(sh, ctx.view.defaultLook);
  return {id: addShape(ctx, 'shape.insert', sh, true)};
}

function insertIcon(ctx, p) {
  const name = str(p, 'name');
  if (name === undefined) throw bad('insert.icon', 'missing `name`');
  const icon = findIcon(name);
  if (!icon) throw bad('insert.icon', `unknown icon \`${name}\``);
  const d = iconPath(icon.name);
  if (!d) throw bad('insert.icon', `could not build icon \`${icon.name}\``);
  const r = rectParam(p, 'rect') ?? defaultRect(ctx, 72, 72);
  if (r.w < 1 || r.h < 1) throw bad('insert.icon', 'rect needs a positive width and height');
  const sh = newShape({name: icon.label, xfrm: r, geom: {kind: 'custom', paths: [{w: VIEW, h: VIEW, d, fill: 'none', stroke: true}]}, fill: fillNone(),
    line: {...lineDefault(), fill: fillSolid(colorScheme('tx1')), width: strokeWidth(icon, r.w, r.h), cap: 'round', join: 'round'}, style: lineStyle('tx1')});
  return {id: addShape(ctx, 'insert.icon', sh, true)};
}

/** `new_text_box`: a wrapping text box that grows to fit its text. */
export function newTextBox(r, text) {
  const body = bodyFromText(text);
  body.body = {...body.body, wrap: true, autofit: {kind: 'shape'}};
  return newShape({xfrm: r, textBox: true, fill: null, text: body, geom: {kind: 'preset', name: 'rect'}});
}

function textBox(ctx, p) {
  const text = str(p, 'text') ?? '';
  const r = rectParam(p, 'rect') ?? defaultRect(ctx, 216, 36);
  const sh = newTextBox(r, text);
  // Click-to-create (no width) text boxes grow sideways without wrapping.
  if (r.w < 1) {
    sh.xfrm = {...r, w: 100};
    sh.text.body = {...sh.text.body, wrap: false};
  }
  const nid = addShape(ctx, 'insert.textBox', sh, true);
  const sl = currentSlide(ctx, 'insert.textBox');
  fitTextBox(ctx, sl.id, nid, ctx.host);
  // Start typing immediately.
  if (!text) ctx.setSelection(selectText(sl.id, [nid], 0, 0));
  return {id: nid};
}

function table(ctx, p) {
  const rows = clamp(usize(p, 'rows') ?? 2, 1, 75);
  const cols = clamp(usize(p, 'cols') ?? 2, 1, 75);
  const size = ctx.doc.slideSize;
  const w = size.width * 0.8;
  const rh = 40;
  const r = rectParam(p, 'rect') ?? {x: size.width * 0.1, y: Math.max(size.height - rh * rows, 0) / 2, w, h: rh * rows};
  const t = newTable(rows, cols, r.w, r.h / rows);
  if (Array.isArray(p.data)) {
    p.data.forEach((row, ri) => (Array.isArray(row) ? row : []).forEach((v, ci) => {
      const cell = t.rows[ri]?.cells?.[ci];
      if (cell && typeof v === 'string') cell.text = bodyFromText(v);
    }));
  }
  return {id: addShape(ctx, 'insert.table', newShape({xfrm: r, kind: {type: 'table', ...t}}), true)};
}

// ---------------------------------------------------------------------------------------------
// Pictures, audio, video (insert/picture.rs)

async function picture(ctx, pIn) {
  let p = pIn;
  // The UI path (Insert › Pictures › This Device…): the system Open dialog gathers the file.
  if (p.path === undefined && p.data === undefined && ctx.origin !== 'bridge' && typeof ctx.host?.pickImage === 'function') {
    const url = await ctx.host.pickImage();
    if (!url) return null;
    p = {...p, data: String(url), name: p.name ?? 'Picture'};
  }
  const {name, bytes} = await mediaBytes(ctx, p, 'insert.picture');
  const ct = contentType(name, bytes);
  if (!ct.startsWith('image/')) throw bad('insert.picture', `${name} is not a picture`);
  if (ct !== 'image/svg+xml' && ct !== 'image/tiff' && !imageDimensions(bytes)) throw new CommandError('failed', `${name}: the picture can't be read`);
  const [w, h] = fittedSize(ctx, bytes);
  // Into a selected empty picture/content placeholder, if there is one.
  const sl = currentSlide(ctx, 'insert.picture');
  let target = null;
  for (const sid of selectedShapeIds(ctx.doc, ctx.selection)) {
    const x = findShape(sl.shapes, sid);
    const k = x?.ph?.kind;
    if (k && (k === 'picture' || k === 'obj' || k === 'body') && (!x.text || bodyEmpty(x.text))) { target = {id: sid, box: xfrmOf(ctx.doc, sl.id, x)}; break; }
  }
  const given = rectParam(p, 'rect');
  const r = given ?? (target ? target.box : defaultRect(ctx, w, h));
  let crop = [0, 0, 0, 0];
  if (target && !given) {
    const ia = w / Math.max(h, 1e-9), ba = r.w / Math.max(r.h, 1e-9);
    if (ia > ba) { const c = (1 - ba / ia) / 2; crop = [c, 0, c, 0]; } else { const c = (1 - ia / ba) / 2; crop = [0, c, 0, c]; }
  }
  const media = addMedia(ctx, 'insert.picture', name, ct, bytes);
  if (target) {
    // Replace the placeholder with the picture (it keeps the placeholder link).
    const cur = findShape(slideById(ctx.doc, sl.id).shapes, target.id);
    writeShape(ctx, sl.id, {...cur, kind: {type: 'picture', fill: pictureFill(media, crop)}, xfrm: {...r}, ph: cur.ph ? {...cur.ph, kind: 'picture'} : null,
      text: null, descr: name});
    selectIds(ctx, sl.id, [target.id]);
    return {id: target.id};
  }
  return {id: addShape(ctx, 'insert.picture', newShape({xfrm: r, kind: {type: 'picture', fill: pictureFill(media, crop)}, descr: name}), true)};
}
const bodyEmpty = b => (b?.paragraphs ?? []).every(pa => (pa.runs ?? []).every(r => !(r.text ?? '').length && r.kind?.kind !== 'break'));

async function media(ctx, pIn, video) {
  const cmd = video ? 'insert.video' : 'insert.audio';
  let p = pIn;
  // The UI path (Insert › Media › Video / Audio on My PC): the system Open dialog gathers the file.
  if (p.path === undefined && p.data === undefined && ctx.origin !== 'bridge' && typeof ctx.host?.pickMedia === 'function') {
    const got = await ctx.host.pickMedia({video});
    if (!got) return null;
    p = {...p, data: got.data, name: p.name ?? got.name};
  }
  const {name, bytes} = await mediaBytes(ctx, p, cmd);
  const ct = contentType(name, bytes);
  if (video && !ct.startsWith('video/')) throw bad(cmd, `${name} is not a supported video (${ct})`);
  if (!video && !ct.startsWith('audio/') && !ct.startsWith('video/')) throw bad(cmd, `${name} is not a supported audio file (${ct})`);
  const size = ctx.doc.slideSize;
  let r = rectParam(p, 'rect');
  if (!r) {
    if (video) {
      let w = size.width * 0.6, h = size.width * 0.6 * 9 / 16;
      const k = Math.min(size.width * 0.9 / w, size.height * 0.9 / h, 1);
      w *= k; h *= k;
      r = {x: (size.width - w) / 2, y: (size.height - h) / 2, w, h};
    } else r = {x: (size.width - 48) / 2, y: (size.height - 48) / 2, w: 48, h: 48};
  }
  const mid = addMedia(ctx, 'insert.media', name, ct, bytes);
  const clip = {type: 'media', media: mid, video, poster: null, crop: [0, 0, 0, 0], trimStartMs: 0, trimEndMs: 0, fadeInMs: 0, fadeOutMs: 0, volume: 1,
    autoplay: false, loopPlay: false, rewind: false, playAcrossSlides: false, hideWhileNotPlaying: false, fullScreen: false, bookmarks: [], durationMs: 0,
    width: 0, height: 0};
  const nid = addShape(ctx, 'insert.media', newShape({xfrm: r, kind: clip, descr: name}), true);
  return {id: nid, contentType: ct, durationMs: 0, width: 0, height: 0, playable: true, warning: null};
}

// ---------------------------------------------------------------------------------------------
// WordArt, fields, symbols (insert/text_fields.rs, text/editing.rs insert_field)

function wordArt(ctx, p) {
  const text = str(p, 'text') ?? 'Your text here';
  const size = ctx.doc.slideSize;
  const style = usize(p, 'style') ?? 0;
  const sh = newTextBox({x: size.width * 0.2, y: size.height * 0.4, w: size.width * 0.6, h: 80}, text);
  const slot = ['tx1', 'accent1', 'accent2', 'accent4'][style % 4];
  sh.text.paragraphs = sh.text.paragraphs.map(pa => ({...pa, props: {...(pa.props ?? {}), align: 'center'},
    runs: (pa.runs ?? []).map(r => {
      const props = {...(r.props ?? {}), size: 54, bold: style % 2 === 1, fill: fillSolid(colorScheme(slot))};
      if (style % 3 === 2) props.outline = {fill: fillSolid(colorScheme('bg1')), width: 1};
      return {...r, props};
    })}));
  const nid = addShape(ctx, 'insert.wordArt', sh, true);
  fitTextBox(ctx, currentSlide(ctx, 'insert.wordArt').id, nid, ctx.host);
  return {id: nid};
}

/** The WordArt gallery: style n is size 54, bold when odd, filled Text 1 / Accent 1 / Accent 2 / Accent 4 (n % 4), outlined when n % 3 = 2. */
const WA_FILL = ['Text 1', 'Accent 1', 'Accent 2', 'Accent 4'];
export const WORDART_STYLES = Object.freeze(Array.from({length: 6}, (_, n) => ({id: String(n),
  label: `Fill: ${WA_FILL[n % 4]}${n % 2 === 1 ? ', Bold' : ''}${n % 3 === 2 ? '; Outline: Background 1' : ''}`, value: n})));

/** `insert_field`: replace the selection with a field run showing `text`. */
export function insertField(ctx, cmd, field, textIn) {
  const text = textIn ? textIn : '#';
  editText(ctx, cmd, (body, t) => {
    const [a, b] = ordered(t.anchor, t.caret);
    const r = remove(body, a, b);
    const props = propsAt(r.body, r.pos);
    const run = {text, kind: {kind: 'field', field}};
    if (Object.keys(props).length) run.props = props;
    const ins = insertBody(r.body, r.pos, {body: {}, paragraphs: [{level: 0, runs: [run]}]});
    t.anchor = ins.pos;
    t.caret = ins.pos;
    return {body: ins.body};
  });
  return null;
}

function headerFooter(ctx, params, cmd) {
  if (!ctx.registry?.has?.('design.headerFooter')) {
    throw new CommandError('unavailable', `${cmd}: place the insertion point in text; Header and Footer is not translated yet`);
  }
  return ctx.run('design.headerFooter', params);
}

function fieldRun(ctx, field, text, cmd) {
  if (textSelection(ctx.doc, ctx.selection)) return insertField(ctx, cmd, field, text);
  return headerFooter(ctx, {[field === 'slidenum' ? 'slideNumber' : 'date']: true}, cmd);
}

const LANG_MSG = '`language` must be en-US, en-GB, fr-FR, ja-JP or sv-SE';
function canonLang(raw) {
  switch (raw.trim().toLowerCase().replace(/_/g, '-')) {
    case 'en': case 'en-us': return 'en-US';
    case 'en-gb': return 'en-GB';
    case 'fr': case 'fr-fr': return 'fr-FR';
    case 'ja': case 'ja-jp': return 'ja-JP';
    case 'sv': case 'sv-se': return 'sv-SE';
    default: return null;
  }
}
/** `date_opts`: validate {format, update, language} and compute the sample text now. */
export function dateOpts(ctx, p) {
  const C = 'insert.dateTime';
  if (p.format !== undefined && !(typeof p.format === 'string' && DATE_KINDS.includes(p.format))) throw bad(C, '`format` must be datetime1..datetime13');
  if (p.update !== undefined && typeof p.update !== 'boolean') throw bad(C, '`update` must be true or false');
  let lang = null;
  if (p.language !== undefined) {
    const raw = typeof p.language === 'string' && p.language.trim() ? p.language : null;
    if (!raw) throw bad(C, LANG_MSG);
    lang = canonLang(raw);
    if (!lang) throw bad(C, LANG_MSG);
  }
  const format = p.format ?? 'datetime1';
  if (fieldText(format, lang, dateTime(2026, 10, 9, 20, 5, 7)) === null) throw bad(C, "this format isn't available in that language");
  const sample = fieldText(format, lang, fromMillis(ctx.host?.now?.() ?? Date.now())) ?? '';
  return {format, update: p.update ?? true, lang, sample};
}

function stampCaretLang(ctx, lang) {
  editText(ctx, 'insert.dateTime', (body, t) => {
    const pa = body.paragraphs?.[t.caret[0]];
    if (!pa) return {};
    let at = 0;
    const runs = pa.runs.map(r => ({...r}));
    for (const r of runs) {
      const n = r.kind?.kind === 'break' ? 1 : (r.text ?? '').length;
      if (n > 0 && at < t.caret[1] && t.caret[1] <= at + n) {
        r.props = {...(r.props ?? {}), lang};
        const paras = [...body.paragraphs];
        paras[t.caret[0]] = {...pa, runs};
        return {body: {...body, paragraphs: paras}};
      }
      at += n;
    }
    return {};
  });
}

function insertPlain(ctx, text, lang) {
  editText(ctx, 'insert.dateTime', (body, t) => {
    const [a, b] = ordered(t.anchor, t.caret);
    const r = remove(body, a, b);
    const props = propsAt(r.body, r.pos);
    if (lang) props.lang = lang;
    const ins = insertAt(r.body, r.pos, text, props);
    t.anchor = ins.pos;
    t.caret = ins.pos;
    return {body: ins.body};
  });
}

function dateTimeCmd(ctx, p) {
  const apply = ['format', 'update', 'language'].some(k => p[k] !== undefined);
  if (!apply) return {dialog: 'dialog.dateTime'};
  const o = dateOpts(ctx, p);
  if (textSelection(ctx.doc, ctx.selection)) {
    if (o.update) {
      insertField(ctx, 'insert.dateTime', o.format, o.sample);
      if (o.lang) stampCaretLang(ctx, o.lang);
    } else insertPlain(ctx, o.sample, o.lang);
    return {where: 'caret', format: o.format, update: o.update, text: o.sample};
  }
  headerFooter(ctx, {date: true, all: false}, 'insert.dateTime');
  if (!writeDatePlaceholder(ctx, o)) return insertDateBox(ctx, o);
  return {where: 'footer', format: o.format, update: o.update, text: o.sample};
}

function writeDatePlaceholder(ctx, o) {
  const sl = currentSlide(ctx, 'insert.dateTime');
  const sh = (sl.shapes ?? []).find(x => x.ph?.kind === 'date');
  if (!sh) return false;
  const props = {...(sh.text?.paragraphs?.[0]?.runs?.[0]?.props ?? {})};
  if (o.lang) props.lang = o.lang;
  const run = {text: o.sample, ...(Object.keys(props).length ? {props} : {}), ...(o.update ? {kind: {kind: 'field', field: o.format}} : {})};
  const body = sh.text ?? {body: {}, paragraphs: []};
  writeShape(ctx, sl.id, {...sh, text: {...body, paragraphs: [{level: 0, runs: [run]}]}});
  return true;
}

function insertDateBox(ctx, o) {
  const size = ctx.doc.slideSize;
  const y = Math.max(size.height - 48, 0);
  textBox(ctx, {rect: [36, y, 360, 28], text: ''});
  if (o.update) insertField(ctx, 'insert.dateTime', o.format, o.sample);
  else insertText(ctx, 'insert.dateTime', o.sample, {correct: false});
  if (o.lang) stampCaretLang(ctx, o.lang);
  return {where: 'textBox', format: o.format, update: o.update, text: o.sample};
}

function symbol(ctx, p) {
  if (typeof p.text !== 'string') throw bad('insert.symbol', 'missing `text`');
  if (!textSelection(ctx.doc, ctx.selection)) throw bad('insert.symbol', 'place the insertion point in text first');
  return insertText(ctx, 'insert.symbol', p.text, {correct: false});
}

// ---------------------------------------------------------------------------------------------
// Links (insert/links.rs, text/formatting.rs link_text)

/** `link_text`: link the selected text, or insert `display` linked at the caret. */
function linkText(ctx, link, display) {
  const t = textSelection(ctx.doc, ctx.selection);
  if (!t) throw bad('insert.hyperlink', 'not editing text');
  const body = bodyOf(ctx.doc, t);
  const {anchor, caret} = textPositions(body, t);
  const [a, b] = ordered(anchor, caret);
  if (a[0] !== b[0] || a[1] !== b[1]) {
    editText(ctx, 'insert.hyperlink', (bd, sel) => {
      const [x, y] = ordered(sel.anchor, sel.caret);
      return {body: formatRange(bd, x, y, rp => ({...rp, link: structuredClone(link)}))};
    });
    return null;
  }
  if (!display) throw bad('insert.hyperlink', 'nothing to link: select text or give `text`');
  let pos;
  editText(ctx, 'insert.hyperlink', (bd, sel) => {
    const props = {...propsAt(bd, a), link: structuredClone(link)};
    const ins = insertAt(bd, a, display, props);
    sel.anchor = ins.pos;
    sel.caret = ins.pos;
    pos = ins.pos;
    return {body: ins.body};
  });
  return {caret: pos};
}

function hyperlink(ctx, p) {
  let action, display;
  if (typeof p.url === 'string') {
    action = {kind: 'url', url: p.url};
    display = p.url.startsWith('mailto:') ? p.url.slice(7) : p.url;
  } else if (usize(p, 'slide') !== undefined) {
    const sl = ctx.doc.slides[p.slide];
    if (!sl) throw bad('insert.hyperlink', 'no such slide');
    const title = slideTitle(sl);
    action = {kind: 'slide', slide: sl.id};
    display = title || `Slide ${p.slide + 1}`;
  } else if (typeof p.jump === 'string') {
    // Place in This Document: First, Last, Next or Previous Slide.
    action = {kind: {first: 'firstSlide', last: 'lastSlide', next: 'nextSlide', previous: 'previousSlide'}[p.jump]};
    display = {first: 'First Slide', last: 'Last Slide', next: 'Next Slide', previous: 'Previous Slide'}[p.jump];
  } else throw bad('insert.hyperlink', 'missing `url`, `slide` or `jump`');
  if (typeof p.text === 'string') display = p.text;
  const link = {action, tooltip: str(p, 'tooltip') ?? '', highlightClick: p.highlightClick === true};
  if (textSelection(ctx.doc, ctx.selection)) return linkText(ctx, link, display);
  return editShapes(ctx, p, 'insert.hyperlink', sh => { sh.click = structuredClone(link); });
}

const ACTIONS = ['none', 'next', 'previous', 'first', 'last', 'lastViewed', 'endShow', 'playMedia', 'slide', 'url', 'customShow', 'program'];
function shapeAction(ctx, p) {
  const CMD = 'shape.action';
  const on = str(p, 'on') ?? 'click';
  let hover;
  if (on === 'click') hover = false;
  else if (on === 'hover' || on === 'over') hover = true;
  else throw bad(CMD, `\`on\` is click or hover, not \`${on}\``);
  const need = k => { const v = str(p, k); if (v === undefined || !v.trim()) throw bad(CMD, `missing \`${k}\``); return v; };
  let action;
  switch (str(p, 'action') ?? 'none') {
    case 'none': action = null; break;
    case 'next': action = {kind: 'nextSlide'}; break;
    case 'previous': action = {kind: 'previousSlide'}; break;
    case 'first': action = {kind: 'firstSlide'}; break;
    case 'last': action = {kind: 'lastSlide'}; break;
    case 'lastViewed': action = {kind: 'lastViewed'}; break;
    case 'endShow': action = {kind: 'endShow'}; break;
    case 'playMedia': action = {kind: 'playMedia'}; break;
    case 'url': action = {kind: 'url', url: need('url')}; break;
    case 'customShow': {
      const name = need('show');
      if (!(ctx.doc.customShows ?? []).some(c => c.name === name)) throw bad(CMD, `no custom show \`${name}\``);
      action = {kind: 'customShow', name};
      break;
    }
    case 'program': action = {kind: 'program', path: need('path')}; break;
    case 'slide': {
      const i = usize(p, 'slide');
      if (i === undefined) throw bad(CMD, 'missing `slide`');
      const sl = ctx.doc.slides[i];
      if (!sl) throw bad(CMD, 'no such slide');
      action = {kind: 'slide', slide: sl.id};
      break;
    }
    default: throw bad(CMD, `unknown action \`${p.action}\``);
  }
  const link = action ? {action, tooltip: str(p, 'tooltip') ?? '', highlightClick: typeof p.highlight === 'boolean' ? p.highlight : true} : null;
  return editShapes(ctx, p, CMD, sh => { if (hover) sh.hover = link ? structuredClone(link) : null; else sh.click = link ? structuredClone(link) : null; });
}

const BUTTONS = {
  back: ['actionButtonBackPrevious', 'previousSlide'], previous: ['actionButtonBackPrevious', 'previousSlide'],
  forward: ['actionButtonForwardNext', 'nextSlide'], next: ['actionButtonForwardNext', 'nextSlide'],
  beginning: ['actionButtonBeginning', 'firstSlide'], end: ['actionButtonEnd', 'lastSlide'], home: ['actionButtonHome', 'firstSlide'],
  information: ['actionButtonInformation', null], return: ['actionButtonReturn', 'lastViewed'], movie: ['actionButtonMovie', null],
  document: ['actionButtonDocument', null], sound: ['actionButtonSound', null], help: ['actionButtonHelp', null],
};
function actionButton(ctx, p) {
  const [preset, kind] = BUTTONS[str(p, 'kind') ?? 'custom'] ?? ['actionButtonBlank', null];
  const r = rectParam(p, 'rect') ?? defaultRect(ctx, 48, 48);
  const sh = newShape({xfrm: r, geom: {kind: 'preset', name: preset}, style: accentStyle('accent1'),
    click: kind ? {action: {kind}, tooltip: '', highlightClick: true} : null});
  return {id: addShape(ctx, 'insert.actionButton', sh, true)};
}

// ---------------------------------------------------------------------------------------------

const textOrSlide = ctx => hasSlide(ctx);
const presetsList = () => CATALOG.map(i => ({name: i.name, label: i.label, category: categoryLabel(i.category)}));
const iconsList = () => ICONS.map(i => ({name: i.name, label: i.label, category: i.category}));

export default defineCommands({
  family: 'insert',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {id: 'shape.insert', label: 'Shapes', risk: 'edit', state: hasSlide,
      description: '{preset: rect|roundRect|ellipse|triangle|rightArrow|star5|… (see shape.presets), rect: [x,y,w,h] pt, text?: string}',
      params: s.object({preset: s.optional(s.string({min: 1, max: 64})), rect, text: s.optional(s.string({max: 100000})),
        adj: s.optional(s.array(s.number(), {max: 16})), flip: s.optional(s.string({max: 2}))}),
      run: insertShape},
    {id: 'insert.icon', label: 'Icons', risk: 'edit',
      state: ctx => { const st = hasSlide(ctx); return st.enabled ? {enabled: true, value: ICONS.map(i => ({id: i.name, label: i.label, value: i.name, group: i.category}))} : st; },
      description: '{name: star|arrow-right|… (see insert.icons), rect?: [x,y,w,h]}',
      params: s.object({name: s.optional(s.string({max: 64})), rect}), run: insertIcon},
    {id: 'insert.icons', label: 'Icon Gallery', risk: 'read', state: ctx => ({enabled: true, value: iconsList().map(i => ({id: i.name, label: i.label, value: i.name}))}),
      description: '{} → [{name, label, category}]', params: s.object({}), run: iconsList},
    {id: 'shape.presets', label: 'Shape Gallery', risk: 'read', state: always, description: '{} → [{name, label, category}]',
      params: s.object({}), run: presetsList},
    {id: 'insert.textBox', label: 'Text Box', risk: 'edit', state: hasSlide, description: '{rect?: [x,y,w,h], text?: string}',
      params: s.object({rect, text: s.optional(s.string({max: 100000}))}), run: textBox},
    {id: 'insert.picture', label: 'Picture from File…', risk: 'edit', state: hasSlide, description: '{path? | data: base64, name?, rect?: [x,y,w,h]}',
      params: s.object({path: s.optional(s.string({max: 4096})), data: s.optional(s.string()), name: s.optional(s.string({max: 255})), rect}),
      run: picture},
    {id: 'insert.table', label: 'Table…', risk: 'edit', state: hasSlide, dialog: 'dialog.table', description: '{rows, cols, rect?}',
      params: s.object({rows: s.integer({min: 1, max: 75}), cols: s.integer({min: 1, max: 75}), rect, data: s.optional(s.array(s.array(s.any())))}),
      run: table},
    {id: 'insert.audio', label: 'Audio from File…', risk: 'edit', state: hasSlide, description: '{path? | data: base64, name?, rect?}',
      params: s.object({path: s.optional(s.string({max: 4096})), data: s.optional(s.string()), name: s.optional(s.string({max: 255})), rect}),
      run: (ctx, p) => media(ctx, p, false)},
    {id: 'insert.video', label: 'Video from File…', risk: 'edit', state: hasSlide, description: '{path? | data: base64, name?, rect?}',
      params: s.object({path: s.optional(s.string({max: 4096})), data: s.optional(s.string()), name: s.optional(s.string({max: 255})), rect}),
      run: (ctx, p) => media(ctx, p, true)},
    {id: 'insert.wordArt', label: 'WordArt', risk: 'edit',
      state: ctx => { const st = hasSlide(ctx); return st.enabled ? {enabled: true, value: WORDART_STYLES} : st; }, description: '{text?, style?: 0..}',
      params: s.object({text: s.optional(s.string({max: 100000})), style: s.optional(s.integer({min: 0}))}), run: wordArt},
    {id: 'insert.slideNumber', label: 'Slide Number', risk: 'edit', state: hasSlide, description: '{}',
      params: s.object({}), run: ctx => fieldRun(ctx, 'slidenum', '‹#›', 'insert.slideNumber')},
    {id: 'insert.dateTime', label: 'Date & Time', risk: 'edit', state: hasSlide, dialog: 'dialog.dateTime',
      description: '{format?: datetime1..datetime13, update?: bool, language?: en-US|en-GB|fr-FR|ja-JP|sv-SE} — no keys opens the dialog',
      params: s.object({format: s.optional(s.any()), update: s.optional(s.any()), language: s.optional(s.any())}), run: dateTimeCmd},
    {id: 'insert.symbol', label: 'Symbol', risk: 'edit', state: hasSlide, dialog: 'dialog.symbol', description: '{text: character(s)}',
      params: s.object({text: s.string({min: 1, max: 1000})}), run: symbol},
    {id: 'shape.action', label: 'Action Settings', risk: 'edit', state: hasSelection, dialog: 'dialog.action',
      description: '{on?: click|hover, action: none|next|previous|first|last|lastViewed|endShow|playMedia|slide|url|customShow|program, slide?: index, url?, show?: custom show name, path?, highlight?: bool, tooltip?, ids?}',
      params: s.object({on: s.optional(s.string({max: 16})), action: s.optional(s.enum(ACTIONS)), slide: s.optional(s.integer({min: 0})),
        url: s.optional(s.string({max: 4096})), show: s.optional(s.string({max: 255})), path: s.optional(s.string({max: 4096})),
        highlight: s.optional(s.boolean()), tooltip: s.optional(s.string({max: 1000})), ids, id: s.optional(ID)}),
      run: shapeAction},
    {id: 'insert.hyperlink', label: 'Link', risk: 'edit', shortcut: 'Mod+K', state: hasTextOrShapes, dialog: 'dialog.hyperlink',
      description: '{url? | slide?: index | jump?: first|last|next|previous, tooltip?, text?: shown when nothing is selected, highlightClick?, ids?}',
      params: s.object({url: s.optional(s.string({max: 4096})), slide: s.optional(s.integer({min: 0})), jump: s.optional(s.enum(['first', 'last', 'next', 'previous'])), tooltip: s.optional(s.string({max: 1000})),
        text: s.optional(s.string({max: 10000})), highlightClick: s.optional(s.boolean()), ids, id: s.optional(ID)}),
      run: hyperlink},
    {id: 'insert.actionButton', label: 'Action Buttons', risk: 'edit', state: textOrSlide,
      description: '{kind: back|forward|beginning|end|home|information|return|movie|document|sound|help|custom, rect?}',
      params: s.object({kind: s.optional(s.string({max: 32})), rect}), run: actionButton},
  ],
});
