// Developer › Controls (U:quill/developer): the nine content controls (Rich Text, Plain Text, Picture, Building Block
// Gallery, Check Box, Combo Box, Drop-Down List, Date Picker, Repeating Section), Design Mode, Properties (the Content
// Control Properties dialog), and the commands the controls answer to: Content Control at Selection, Toggle Check Box,
// Choose List Item, Set Date, Remove Content Control.
//
// Translated from wordcraft crates/engine/src/cmd/controls.rs (`specs`, `insert`, `insert_block`, `describe`,
// `properties`, `toggle_check_box`, `choose_item`, `set_date`, `remove_control`) at
// aadb077e072b7de05f724e359d8db82e151f125c; checked again against wordcraft 0.13.1 (f2dfa0d). MIT, see
// assets/third-party-licenses/artcraft-reference.txt. The control model, its pairing and what typing does inside one are
// core/quill/model/ranges.mjs and core/quill/lib/text-edit.mjs (upstream control.rs and controls.rs prepare_edit); the
// .docx round trip (w:sdt) is formats/docx-read.mjs and docx-write.mjs.
//
// A control wraps the selection (Rich Text, Plain Text and Picture, when something is selected) or is inserted at the
// caret with its placeholder showing (the PlaceholderText style); typing replaces the placeholder. A Rich Text control
// round whole paragraphs or over several, a Repeating Section and a Building Block Gallery are block-level (markers at the
// edges of the paragraphs). Locks, temporary controls, the entries of a combo box and drop-down list, a date's format and
// a check box's symbols are the control's properties. Design Mode (view state) shows where controls start and end. Not here
// (their controls stay hidden): Legacy Tools, Group and the XML Mapping pane (not upstream), and data binding to custom XML.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import * as T from '../lib/table-session.mjs';
import * as P from '../model/para.mjs';
import {UPSTREAM_COMMIT, posParam, samePath, samePos} from '../lib/caret-session.mjs';
import {BODY, cmpPos} from '../model/document.mjs';
import {
  contentControl, checkBoxKind, CHECKED, UNCHECKED, controlContentStart, lockCanEdit, lockCanDelete, controlKindName, controlItems,
  listItemValue, placeholderShown, controlLockFromFlags, MAX_CONTROL_TEXT, MAX_LIST_ITEMS,
} from '../model/ranges.mjs';
import {ensurePlaceholderStyle, contentProps, contentBase, CANT_DELETE, CANT_EDIT} from '../lib/text-edit.mjs';
import {formatDateParts} from './insert.mjs';
import {getStyle} from '../model/styles.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/controls.rs', 'crates/ui-egui/src/ribbon/review.rs']};

const bad = m => new CommandError('invalid_params', m);
const failed = m => new CommandError('failed', m);
const disabled = m => new CommandError('disabled', m);
const POS = s.union([
  s.string({min: 1, max: 4096}),
  s.object({story: s.optional(s.any()), path: s.array(s.integer({min: 0}), {max: 64}), off: s.integer({min: 0})}),
  s.object({block: s.integer({min: 0}), off: s.optional(s.integer({min: 0}))}),
], {description: 'An address (/body/b:<id>/t:4), {story, path, off} or {block, off}'});
const WHICH = {control: s.optional(s.string({min: 1, max: 1024, description: 'the control\'s tag or title (default: the one at the selection)'})), at: s.optional(POS)};
const NAMED = {title: s.optional(s.string({max: 4096})), tag: s.optional(s.string({max: 4096}))};
const ITEMS = s.optional(s.array(s.any(), {max: MAX_LIST_ITEMS * 2}));
const OBJ = P.OBJ;

// ---- params, as upstream reads them -----------------------------------------------------------------------------

/** A string param without control characters, cut to what a control keeps (short). */
const short = v => (typeof v === 'string' ? [...v].filter(c => !/[\u0000-\u001f\u007f-\u009f]/.test(c) && c !== OBJ).slice(0, MAX_CONTROL_TEXT).join('') : undefined);

/** List entries from `items`: text, or {display, value} (the value is the display text when left out); entries with no text are dropped (items_param). */
function itemsParam(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const i of v.slice(0, MAX_LIST_ITEMS)) {
    if (typeof i === 'string') out.push({display: short(i), value: short(i)});
    else if (i && typeof i === 'object' && typeof i.display === 'string') {
      const display = short(i.display);
      out.push({display, value: typeof i.value === 'string' ? short(i.value) : display});
    }
  }
  return out.filter(i => i.display);
}

/** One character that is not a control or the object character (symbol_param). */
const symbolParam = t => {
  if (typeof t !== 'string') return null;
  const cs = [...t];
  return cs.length === 1 && !/[\u0000-\u001f\u007f-\u009f]/.test(cs[0]) && cs[0] !== OBJ ? cs[0] : null;
};

/** `YYYY-MM-DD` (a full date-time is fine too): {y, m, d, days} checked, or null (parse_date). */
export function parseDate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(text ?? '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return null;
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return {y, m: mo, d, days: Math.floor(t / 86_400_000)};
}
/** A date as its control shows it (the Word picture `format`) (format_date_value). */
export const formatDateValue = (format, {y, m, d, days}) => formatDateParts(format, y, m, d, [0, 0, 0], days);
const isoDate = ({y, m, d}) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00Z`;

// ---- finding controls ---------------------------------------------------------------------------------------

/** Controls around paragraph content (not the ones kept on tables, rows and cells). */
const rangesIn = (d, story) => d.controlRanges(story).filter(r => Number.isInteger(r.start.off) && Number.isInteger(r.end.off));
const sameStart = (a, b) => a.story === b.story && a.off === b.off && samePath(a.path, b.path);
const refind = (d, r) => rangesIn(d, r.start.story).find(x => sameStart(x.start, r.start)) ?? null;

/** The control at `at`, also when `at` is just outside its markers (a click beside a check box) (control_near). */
function controlNear(S, at) {
  const here = S.d.controlAt(S.d.clamp(at));
  if (here && Number.isInteger(here.start.off)) return here;
  const para = S.d.paraAt(at);
  if (!para) return null;
  if (P.objectAt(para, at.off)?.type === 'controlStart') return S.d.controlAt({...at, off: at.off + 1});
  if (at.off >= 1 && P.objectAt(para, at.off - 1)?.type === 'controlEnd') return S.d.controlAt({...at, off: at.off - 1});
  return null;
}

/** The control a command acts on: `control` (a tag or title) in the caret's story, else the one at `at`, else the one at the caret (target). */
function target(S, p) {
  if (typeof p.control === 'string' && p.control) {
    for (const st of new Set([S.sel.focus.story, BODY])) {
      const hits = rangesIn(S.d, st).filter(r => r.control.tag === p.control || r.control.title === p.control).sort((a, b) => cmpPos(a.start, b.start));
      if (hits.length) return hits[0];
    }
    throw failed(`no content control is called "${p.control}"`);
  }
  const at = p.at !== undefined ? posParam(S.ctx, p.at, 'at') : S.sel.focus;
  const r = controlNear(S, at);
  if (!r) throw disabled("the selection isn't in a content control");
  return r;
}

/** state(): a control holds the selection (or the command names the control: `control`, `at`). */
function inControl(ctx, p) {
  const st = T.ready(ctx);
  if (!st.enabled) return st;
  if (p?.control !== undefined || p?.at !== undefined) return st;
  try {
    const d = ctx.model.open(ctx);
    const all = ctx.model.selection(ctx);
    const f = (all[ctx.selection?.primary ?? 0] ?? all[0]).focus;
    return d.controlAt(d.clamp(f)) ? {enabled: true} : {enabled: false, reason: 'Place the cursor in a content control'};
  } catch { return {enabled: false, reason: 'Place the cursor in a content control'}; }
}

/** An id no control in the document has (new_id). */
function newId(S) {
  const used = new Set();
  for (const st of [BODY, ...Object.keys(S.d.c.parts ?? {}).map(Number)]) for (const r of S.d.controlRanges(st)) if (Number.isInteger(r.control.id)) used.add(r.control.id);
  let id = 1_000_000 + used.size;
  while (used.has(id)) id++;
  return id;
}

// ---- the formatting a control's text takes ------------------------------------------------------------------

const placeholderProps = (S, base) => { const p = {...base, style: ensurePlaceholderStyle(S)}; delete p.link; return p; };

/** Replace a control's content with `text` in `props`; returns the position after the text (set_content). */
function setContent(S, r, text, props) {
  const a = controlContentStart(r);
  S.d.deleteRange(a, r.end);
  return S.d.insertText(a, text, props);
}

// ---- inserting ----------------------------------------------------------------------------------------------

const KINDS = {
  richText: () => ({type: 'richText'}),
  plainText: () => ({type: 'text', multiLine: false}),
  picture: () => ({type: 'picture'}),
  buildingBlock: () => ({type: 'gallery', list: true, gallery: 'Quick Parts', category: 'General', unique: false}),
  checkBox: () => checkBoxKind(),
  comboBox: () => ({type: 'comboBox', items: [], lastValue: ''}),
  dropDown: () => ({type: 'dropDown', items: [], lastValue: ''}),
  datePicker: () => ({type: 'date', fullDate: '', format: 'M/d/yyyy', lid: 'en-US', calendar: 'gregorian', storeAs: 'dateTime'}),
  repeatingSection: () => ({type: 'repeatingSection', title: '', noInsertDelete: false}),
};

function insert(ctx, name, p) {
  const S = T.open(ctx);
  const ctl = {...contentControl(KINDS[name]()), id: newId(S)};
  const title = short(p.title), tag = short(p.tag);
  if (title !== undefined) ctl.title = title;
  if (tag !== undefined) ctl.tag = tag;
  const k = ctl.kind;
  if (k.type === 'comboBox' || k.type === 'dropDown') { const i = itemsParam(p.items); if (i) k.items = i; }
  else if (k.type === 'date') { const f = short(p.format); if (f && f.trim()) k.format = f; }
  else if (k.type === 'checkBox') k.checked = p.checked === true;
  const [a, b] = T.ordered(S.sel);
  if (a.story !== b.story || !S.d.paraAt(a) || !S.d.paraAt(b)) throw failed('no paragraph at the selection');
  const inside = S.d.controlAt(S.d.clamp(a));
  if (inside && !lockCanEdit(inside.control.lock)) throw disabled(CANT_EDIT);
  const pb = S.d.paraAt(b);
  const wholePara = samePath(a.path, b.path) && a.off === 0 && pb.text.length > 0 && b.off === pb.text.length;
  const block = k.type === 'repeatingSection' || k.type === 'gallery' || !samePath(a.path, b.path) || wholePara;
  if (block && (k.type === 'richText' || k.type === 'repeatingSection' || k.type === 'gallery')) return insertBlock(S, ctl, a, b);
  // An inline control: around the selection (text and pictures), else at the caret with its placeholder or value.
  const wraps = !samePos(a, b) && samePath(a.path, b.path) && (k.type === 'richText' || k.type === 'text' || k.type === 'picture');
  const base = contentProps(S, P.propsOfChar(S.d.paraAt(a), a.off) ?? {});
  if (wraps) {
    S.d.insertObject(b, {type: 'controlEnd'}, base);
    S.d.insertObject(a, {type: 'controlStart', control: ctl}, base);
    S.sel = {anchor: {...a, path: [...a.path], off: a.off + 1}, focus: {...b, path: [...b.path], off: b.off + 1}};
    return T.finish(S);
  }
  let at = T.deleteSelection(S);
  at = S.d.typingPos(at);
  let text, props;
  if (k.type === 'checkBox') { text = k.checked ? k.checkedChar : k.uncheckedChar; props = base; }
  else if (k.type === 'date' && p.date !== undefined) {
    const date = parseDate(p.date);
    if (!date) throw bad('date: YYYY-MM-DD');
    k.fullDate = isoDate(date);
    text = formatDateValue(k.format, date);
    props = base;
  } else {
    ctl.showingPlaceholder = true;
    text = placeholderShown(ctl);
    props = placeholderProps(S, base);
  }
  const afterStart = S.d.insertObject(at, {type: 'controlStart', control: ctl}, base);
  const end = text ? S.d.insertText(afterStart, text, props) : afterStart;
  S.d.insertObject(end, {type: 'controlEnd'}, base);
  S.sel = T.caret(afterStart);
  return T.finish(S);
}

/** A block-level control around the paragraphs from `a`'s to `b`'s (the same list of blocks) (insert_block). */
function insertBlock(S, ctl, a, b) {
  const story = a.story;
  const parentOf = path => path.slice(0, -1);
  const last = samePath(parentOf(b.path), parentOf(a.path)) ? b.path : a.path;
  ctl.block = true;
  const first = S.d.para(story, a.path);
  const lastPara = S.d.para(story, last);
  const empty = samePath(a.path, last) && first.text.length === 0;
  const base = contentProps(S, P.propsOfChar(first, 0) ?? {});
  const item = ctl.kind.type === 'repeatingSection' ? {...contentControl({type: 'repeatingSectionItem'}), block: true, id: ctl.id + 1} : null;
  if (empty && placeholderShown(ctl)) {
    ctl.showingPlaceholder = true;
    S.d.insertText({story, path: [...a.path], off: 0}, placeholderShown(ctl), placeholderProps(S, base));
  }
  const endOff = S.d.para(story, last).text.length;
  const endProps = P.propsOfChar(lastPara, Math.max(0, endOff - 1)) ?? {};
  let end = {story, path: [...last], off: endOff};
  if (item) end = S.d.insertObject(end, {type: 'controlEnd'}, endProps);
  S.d.insertObject(end, {type: 'controlEnd'}, endProps);
  let at = {story, path: [...a.path], off: 0};
  at = S.d.insertObject(at, {type: 'controlStart', control: ctl}, base);
  if (item) at = S.d.insertObject(at, {type: 'controlStart', control: item}, base);
  S.sel = T.caret(at);
  return T.finish(S);
}

// ---- acting on a control ------------------------------------------------------------------------------------

const pos = p => ({story: p.story, path: [...p.path], off: p.off});

/** What a command or dialog needs to know about a control (describe). */
export function info(S, r) {
  if (!r) return null;
  const c = r.control, k = c.kind ?? {type: 'richText'};
  const out = {
    type: controlKindName(k), title: c.title ?? '', tag: c.tag ?? '', id: c.id ?? null, lockDelete: !lockCanDelete(c.lock), lockEdit: !lockCanEdit(c.lock), temporary: !!c.temporary,
    block: !!c.block, showingPlaceholder: !!c.showingPlaceholder, placeholder: placeholderShown(c), text: c.showingPlaceholder ? '' : S.d.controlText(r), start: pos(r.start), end: pos(r.end),
  };
  // Word's Show as, Color and Use a style (not in upstream's describe).
  Object.assign(out, {appearance: c.appearance ?? 'boundingBox', color: c.color ? `#${c.color}` : '', style: c.runProps?.style ?? ''});
  if (k.type === 'text') out.multiLine = !!(k.multiLine ?? k.multi_line);
  if (k.type === 'checkBox') Object.assign(out, {checked: !!k.checked, checkedSymbol: k.checkedChar ?? CHECKED, uncheckedSymbol: k.uncheckedChar ?? UNCHECKED, checkedFont: k.checkedFont ?? '', uncheckedFont: k.uncheckedFont ?? ''});
  if (controlItems(k)) Object.assign(out, {items: controlItems(k).map(i => ({display: i.display, value: listItemValue(i)})), value: k.lastValue ?? ''});
  if (k.type === 'date') Object.assign(out, {date: String(k.fullDate ?? '').slice(0, 10), format: k.format, locale: k.lid ?? '', calendar: k.calendar ?? '', storeAs: k.storeAs ?? ''});
  return out;
}

/** The kind's own properties; returns the new content text when the shown value changes (apply_kind_properties). */
function applyKindProperties(c, p) {
  let content = null;
  const k = c.kind;
  if (k.type === 'text') { if (typeof p.multiLine === 'boolean') k.multiLine = p.multiLine; }
  else if (k.type === 'comboBox' || k.type === 'dropDown') { const i = itemsParam(p.items); if (i) k.items = i; }
  else if (k.type === 'date') {
    const f = short(p.format);
    if (f && f.trim()) {
      k.format = f;
      const date = parseDate(k.fullDate);
      if (date && !c.showingPlaceholder) content = formatDateValue(f, date);
    }
    // Word's Locale, Calendar type and Store XML contents as.
    const lid = short(p.locale), cal = short(p.calendar), store = short(p.storeAs);
    if (lid && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lid)) k.lid = lid;
    if (cal && /^[A-Za-z]{3,30}$/.test(cal)) k.calendar = cal;
    if (store && ['dateTime', 'date', 'text'].includes(store)) k.storeAs = store;
  } else if (k.type === 'checkBox') {
    const on = symbolParam(p.checkedSymbol), off = symbolParam(p.uncheckedSymbol);
    if (on) k.checkedChar = on;
    if (off) k.uncheckedChar = off;
    if (typeof p.checkedFont === 'string') k.checkedFont = short(p.checkedFont).trim();
    if (typeof p.uncheckedFont === 'string') k.uncheckedFont = short(p.uncheckedFont).trim();
    content = k.checked ? k.checkedChar : k.uncheckedChar;
  }
  return content;
}

/** The style text typed into the empty control takes (w:rPr / w:rStyle of the control, and its parsed run properties); '' takes it off (Use a style to format text). */
function setControlStyle(c, id) {
  const esc = id.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  let xml = c.rprXml ?? '';
  if (id) {
    if (/<w:rStyle\b[^>]*\/>/.test(xml)) xml = xml.replace(/<w:rStyle\b[^>]*\/>/, `<w:rStyle w:val="${esc}"/>`);
    else if (/<w:rPr\b[^>]*>/.test(xml) && !/<w:rPr\b[^>]*\/>/.test(xml)) xml = xml.replace(/(<w:rPr\b[^>]*>)/, `$1<w:rStyle w:val="${esc}"/>`);
    else xml = `<w:rPr><w:rStyle w:val="${esc}"/></w:rPr>`;
    c.runProps = {...(c.runProps ?? {}), style: id};
  } else {
    xml = xml.replace(/<w:rStyle\b[^>]*\/>/, '');
    if (/^<w:rPr\b[^>]*>\s*<\/w:rPr>$|^<w:rPr\b[^>]*\/>$/.test(xml.trim())) xml = '';
    if (c.runProps) { const {style: _s, ...rest} = c.runProps; c.runProps = Object.keys(rest).length ? rest : undefined; if (!c.runProps) delete c.runProps; }
  }
  if (xml) c.rprXml = xml; else delete c.rprXml;
}

function properties(ctx, p) {
  const S = T.open(ctx);
  const r = target(S, p);
  const c = structuredClone(r.control);
  let content = null;
  const title = short(p.title), tag = short(p.tag);
  if (title !== undefined) c.title = title;
  if (tag !== undefined) c.tag = tag;
  c.lock = controlLockFromFlags(typeof p.lockDelete === 'boolean' ? p.lockDelete : !lockCanDelete(c.lock), typeof p.lockEdit === 'boolean' ? p.lockEdit : !lockCanEdit(c.lock));
  if (typeof p.temporary === 'boolean') c.temporary = p.temporary;
  if (p.appearance === 'boundingBox') delete c.appearance;
  else if (p.appearance === 'tags' || p.appearance === 'hidden') c.appearance = p.appearance;
  if (typeof p.color === 'string') {
    const m = /^#?([0-9a-f]{6})$/i.exec(p.color.trim());
    if (m) c.color = m[1].toUpperCase();
    else if (!p.color.trim()) delete c.color;
    else throw bad('color: #RRGGBB');
  }
  if (typeof p.style === 'string') {
    if (p.style && !getStyle(S.d.c.styles, p.style)) throw bad(`no style \`${p.style}\``);
    setControlStyle(c, p.style);
  }
  const ph = short(p.placeholder);
  if (ph !== undefined && ph.trim()) {
    if (c.showingPlaceholder && ph !== placeholderShown(c)) content = ph;
    c.placeholderText = ph;
  }
  const kc = applyKindProperties(c, p);
  if (kc !== null) content = kc;
  if (content !== null) {
    const base = contentBase(S, r);
    if (c.kind.type === 'checkBox') { const f = c.kind.checked ? c.kind.checkedFont : c.kind.uncheckedFont; if (f) base.font = f; else delete base.font; }
    setContent(S, r, content, c.showingPlaceholder ? placeholderProps(S, base) : base);
  }
  S.d.updateControl(r.start, () => c);
  const again = refind(S.d, r);
  return T.finish(S, again ? info(S, again) : undefined);
}

function toggleCheckBox(ctx, p) {
  const S = T.open(ctx);
  const r = target(S, p);
  const k = r.control.kind;
  if (k?.type !== 'checkBox') throw disabled("the selection isn't in a check box");
  if (!lockCanEdit(r.control.lock)) throw disabled(CANT_EDIT);
  const now = typeof p.value === 'boolean' ? p.value : !k.checked;
  const [ch, font] = now ? [k.checkedChar, k.checkedFont] : [k.uncheckedChar, k.uncheckedFont];
  const props = contentBase(S, r);
  if (font) props.font = font;
  setContent(S, r, ch, props);
  S.d.updateControl(r.start, c => { c.kind = {...c.kind, checked: now}; c.showingPlaceholder = false; });
  return T.finish(S, {checked: now});
}

function chooseItem(ctx, p) {
  const S = T.open(ctx);
  const r = target(S, p);
  const items = controlItems(r.control.kind);
  if (!items) throw disabled("the selection isn't in a combo box or drop-down list");
  if (!lockCanEdit(r.control.lock)) throw disabled(CANT_EDIT);
  let item;
  if (p.index !== undefined) item = items[p.index];
  else if (p.value !== undefined) item = items.find(i => listItemValue(i) === p.value);
  else if (p.text !== undefined) item = items.find(i => i.display === p.text);
  else throw bad('give index, value or text');
  if (!item) throw bad('no such entry');
  const end = setContent(S, r, item.display, contentBase(S, r));
  S.d.updateControl(r.start, c => { c.kind = {...c.kind, lastValue: listItemValue(item)}; c.showingPlaceholder = false; });
  S.sel = T.caret({...end, path: [...end.path], off: end.off + 1});
  return T.finish(S, {display: item.display, value: listItemValue(item)});
}

function setDate(ctx, p) {
  const S = T.open(ctx);
  const r = target(S, p);
  const k = r.control.kind;
  if (k?.type !== 'date') throw disabled("the selection isn't in a date picker");
  if (!lockCanEdit(r.control.lock)) throw disabled(CANT_EDIT);
  const date = parseDate(p.date);
  if (!date) throw bad('date: YYYY-MM-DD');
  const text = formatDateValue(k.format, date);
  const end = setContent(S, r, text, contentBase(S, r));
  S.d.updateControl(r.start, c => { c.kind = {...c.kind, fullDate: isoDate(date)}; c.showingPlaceholder = false; });
  S.sel = T.caret({...end, path: [...end.path], off: end.off + 1});
  return T.finish(S, {date: isoDate(date).slice(0, 10), text});
}

function removeControl(ctx, p) {
  const S = T.open(ctx);
  const r = target(S, p);
  if (!lockCanDelete(r.control.lock)) throw disabled(CANT_DELETE);
  // A placeholder goes with its control; real content stays.
  if (r.control.showingPlaceholder) S.d.deleteRange(controlContentStart(r), r.end);
  const again = S.d.controlAt(controlContentStart(r));
  const end = again && Number.isInteger(again.end.off) ? again.end : r.end;
  S.d._pDelete(end.story, end.path, end.off, end.off + 1);
  S.d._pDelete(r.start.story, r.start.path, r.start.off, r.start.off + 1);
  S.sel = T.caret(S.d.clamp(r.start));
  return T.finish(S);
}

const INSERTS = [
  ['richText', 'Rich Text Content Control', NAMED, 'Rich Text Content Control: formatted text; with text selected the control wraps it, round whole paragraphs it is block-level, else it is inserted at the caret showing its placeholder.'],
  ['plainText', 'Plain Text Content Control', NAMED, 'Plain Text Content Control: one line of text (no line breaks until Properties allows them).'],
  ['picture', 'Picture Content Control', NAMED, 'Picture Content Control: holds a picture.'],
  ['buildingBlock', 'Building Block Gallery Content Control', NAMED, 'Building Block Gallery Content Control: a block-level content control for a building block gallery.'],
  ['checkBox', 'Check Box Content Control', {...NAMED, checked: s.optional(s.boolean())}, 'Check Box Content Control: a box that is checked or not (`checked`); Toggle Check Box changes it.'],
  ['comboBox', 'Combo Box Content Control', {...NAMED, items: ITEMS}, 'Combo Box Content Control: a list of entries (`items`: text or {display, value}).'],
  ['dropDown', 'Drop-Down List Content Control', {...NAMED, items: ITEMS}, 'Drop-Down List Content Control: a list of entries (`items`: text or {display, value}) to choose from.'],
  ['datePicker', 'Date Picker Content Control', {...NAMED, format: s.optional(s.string({max: 4096})), date: s.optional(s.string({max: 64}))},
    'Date Picker Content Control: a date shown in a Word picture (`format`, default M/d/yyyy), set with `date` (YYYY-MM-DD) or Set Date.'],
  ['repeatingSection', 'Repeating Section Content Control', NAMED, 'Repeating Section Content Control: a block-level section that can be repeated, holding one item.'],
];

export default defineCommands({
  family: 'developer',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    ...INSERTS.map(([name, label, shape, description]) => ({
      id: `developer.${name}`, label, risk: 'edit', description, params: s.object(shape), state: T.ready,
      run: (ctx, p) => insert(ctx, name, p),
    })),
    {id: 'developer.designMode', label: 'Design Mode', risk: 'read', effect: 'view',
      description: 'Design Mode: shows where each content control starts and ends and its title; `value` sets it.', params: s.object({value: s.optional(s.boolean())}),
      state: ctx => { const r = T.ready(ctx); return r.enabled ? {enabled: true, checked: !!ctx.view?.designMode} : r; },
      run(ctx, p) { const value = typeof p.value === 'boolean' ? p.value : !ctx.view?.designMode; ctx.setView({designMode: value}); return {designMode: value}; }},
    {id: 'developer.properties', label: 'Properties', risk: 'edit', state: inControl,
      description: 'Properties: the content control at the selection (or `control` by tag or title): title, tag, placeholder, temporary, locks (`lockDelete`, `lockEdit`), `multiLine` (plain text), `format` (date picker), `checkedSymbol` / `uncheckedSymbol` (check box), `items` (combo box, drop-down list). With nothing given the dialog opens.',
      params: s.object({...WHICH, ...NAMED, placeholder: s.optional(s.string({max: 4096})), temporary: s.optional(s.boolean()), lockDelete: s.optional(s.boolean()), lockEdit: s.optional(s.boolean()),
        multiLine: s.optional(s.boolean()), format: s.optional(s.string({max: 4096})), checkedSymbol: s.optional(s.string({max: 16})), uncheckedSymbol: s.optional(s.string({max: 16})), items: ITEMS,
        // Word's own (not upstream): Show as, Color, Use a style, the check box's symbol fonts, the date picker's Locale, Calendar type and Store XML contents as.
        appearance: s.optional(s.enum(['boundingBox', 'tags', 'hidden'])), color: s.optional(s.string({max: 16})), style: s.optional(s.string({max: 253})),
        checkedFont: s.optional(s.string({max: 253})), uncheckedFont: s.optional(s.string({max: 253})), locale: s.optional(s.string({max: 32})), calendar: s.optional(s.string({max: 32})), storeAs: s.optional(s.string({max: 16}))}),
      run: properties},
    {id: 'developer.control', label: 'Content Control at Selection', risk: 'read', effect: 'view', state: T.ready,
      description: 'Content Control at Selection: the control at the selection (or `control` by tag or title, `at`): its type, title, tag, locks, text, and list entries, date or check box state; refused when there is none.',
      params: s.object(WHICH),
      run(ctx, p) { const S = T.open(ctx); return info(S, target(S, p)); }},
    {id: 'developer.toggleCheckBox', label: 'Toggle Check Box', risk: 'edit', state: inControl,
      description: 'Toggle Check Box: checks or clears the check box at the selection (or `control`, `at`); `value` sets it.', params: s.object({...WHICH, value: s.optional(s.boolean())}), run: toggleCheckBox},
    {id: 'developer.chooseItem', label: 'Choose List Item', risk: 'edit', state: inControl,
      description: 'Choose List Item: the entry of the combo box or drop-down list at the selection (or `control`, `at`) by `index`, `value` or display `text`.',
      params: s.object({...WHICH, index: s.optional(s.integer({min: 0})), value: s.optional(s.string({max: 4096})), text: s.optional(s.string({max: 4096}))}), run: chooseItem},
    {id: 'developer.setDate', label: 'Set Date', risk: 'edit', state: inControl,
      description: 'Set Date: the date (YYYY-MM-DD) of the date picker at the selection (or `control`, `at`), shown in its format.', params: s.object({...WHICH, date: s.string({max: 64})}), run: setDate},
    {id: 'developer.removeControl', label: 'Remove Content Control', risk: 'edit', state: inControl,
      description: 'Remove Content Control: takes the control off the content at the selection (or `control`, `at`), keeping what was typed in it; refused while the control can\'t be deleted.',
      params: s.object(WHICH), run: removeControl},
  ],
});
