// Reading an AcroForm (ISO 32000-2 section 12.7) from a pdf-lib document: the field tree
// flattened to terminal fields, each with its widgets (page, rectangle, on-state), the
// attributes it inherits (/FT /Ff /V /DV /DA /Q /MaxLen), choice options, tooltip, format,
// validate and calculate scripts and the push button action.
//
// Translated from printcraft crates/forms/src/lib.rs (Field, Widget, flags), read.rs (enumerate,
// walk, adopt_page_fields, button_action, actions_of, field_flags), tab_order.rs (rank_tabs) and
// appearance.rs (parse_da, mk_rotation, border_width, list_rows_of) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// pdf-lib (pure JS) is the cos layer; no DOM, no Node built-ins.
//
// A Field is plain JSON: {name, id, kind, value: [], defaultValue: [], flags, maxLen, options: [[export, display]],
// da, quadding, tooltip, widgets: [Widget], actions: {format, validate, calculate, scripts, unsupported}, button}.
// A Widget: {id, page, rect, onState, state, tab, locked, hidden, readOnly, rotation, caption, list, round, look}.

import {PDFName, PDFRef, PDFDict, PDFArray, PDFNumber, PDFString, PDFHexString, PDFBool, PDFStream, PDFRawStream, decodePDFRawStream} from 'pdf-lib';
import {parseFormat, parseValidate, parseCalculate, buttonScript, NONE} from './form-af.mjs';

export const FLAG = Object.freeze({
  READ_ONLY: 1, REQUIRED: 1 << 1, MULTILINE: 1 << 12, PASSWORD: 1 << 13, NO_TOGGLE_TO_OFF: 1 << 14, RADIO: 1 << 15, PUSH_BUTTON: 1 << 16,
  COMBO: 1 << 17, EDIT: 1 << 18, SORT: 1 << 19, FILE_SELECT: 1 << 20, MULTI_SELECT: 1 << 21, DO_NOT_SPELL_CHECK: 1 << 22, DO_NOT_SCROLL: 1 << 23,
  COMB: 1 << 24, RADIOS_IN_UNISON: 1 << 25, RICH_TEXT: 1 << 25, COMMIT_ON_SEL_CHANGE: 1 << 26,
});
export const KINDS = Object.freeze(['text', 'checkbox', 'radio', 'pushbutton', 'combo', 'list', 'signature']);
export const DEFAULT_DA = '/Helv 0 Tf 0 g';
const MAX_DEPTH = 64;

export const N = k => PDFName.of(k);
export const keyOf = r => `${r.objectNumber} ${r.generationNumber}`;
export const refOfKey = k => { const [a, b] = k.split(' ').map(Number); return PDFRef.of(a, b); };

/** The object a value stands for (a reference is followed). */
export const res = (ctx, o) => (o instanceof PDFRef ? ctx.lookup(o) : o);
/** A dictionary entry, references followed. */
export const get = (ctx, d, k) => (d instanceof PDFDict ? res(ctx, d.get(N(k))) : undefined);
export const dictAt = (ctx, d, k) => { const v = get(ctx, d, k); return v instanceof PDFDict ? v : null; };
export const arrAt = (ctx, d, k) => { const v = get(ctx, d, k); return v instanceof PDFArray ? v : null; };

/** A string object's or name's text. */
export function textOf(o) {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText();
  if (o instanceof PDFName) return o.decodeText();
  return null;
}
export const textAt = (ctx, d, k) => textOf(get(ctx, d, k));
export const intAt = (ctx, d, k) => { const v = get(ctx, d, k); return v instanceof PDFNumber ? Math.trunc(v.asNumber()) : undefined; };
export const numAt = (ctx, d, k) => { const v = get(ctx, d, k); return v instanceof PDFNumber ? v.asNumber() : undefined; };
export const nameAt = (ctx, d, k) => { const v = get(ctx, d, k); return v instanceof PDFName ? v.decodeText() : undefined; };
export const boolAt = (ctx, d, k) => { const v = get(ctx, d, k); return v instanceof PDFBool ? v.asBoolean() : undefined; };
export function numsAt(ctx, d, k) {
  const a = arrAt(ctx, d, k);
  if (!a) return null;
  const out = [];
  for (let i = 0; i < a.size(); i++) { const v = res(ctx, a.get(i)); if (!(v instanceof PDFNumber)) return null; out.push(v.asNumber()); }
  return out;
}

/** A stream's decoded text (a JavaScript stream), or null. */
export function streamText(o) {
  try {
    if (o instanceof PDFRawStream) return new TextDecoder('utf-8').decode(decodePDFRawStream(o).decode());
    if (o instanceof PDFStream) return new TextDecoder('utf-8').decode(o.getUnencodedContents());
  } catch { /* an undecodable stream has no script */ }
  return null;
}

/** An action dictionary's JavaScript (/JS string or stream). */
export function scriptOf(ctx, action) {
  const a = res(ctx, action);
  if (!(a instanceof PDFDict)) return null;
  const js = get(ctx, a, 'JS');
  return textOf(js) ?? streamText(js);
}

/** The leaf pages' objects in order. */
export const pageRefs = pdf => pdf.getPages().map(p => p.ref);

/** The AcroForm dictionary, or null. */
export function acroform(pdf) {
  const d = pdf.catalog.lookup(N('AcroForm'));
  return d instanceof PDFDict ? d : null;
}

/** appearance.rs `parse_da`: font resource name, size (0 = auto) and colour operation. */
export function parseDa(da) {
  const toks = String(da ?? '').split(/\s+/).filter(Boolean);
  const out = {font: 'Helv', size: 0, color: '0 g'};
  const isNum = x => x !== undefined && Number.isFinite(Number(x));
  toks.forEach((t, i) => {
    if (t === 'Tf' && i >= 2) { out.font = toks[i - 2].replace(/^\//, ''); const s = Number(toks[i - 1]); out.size = Number.isFinite(s) && s >= 0 ? Math.min(s, 300) : 0; }
    else if (t === 'g' && i >= 1 && isNum(toks[i - 1])) out.color = `${toks[i - 1]} g`;
    else if (t === 'rg' && i >= 3 && toks.slice(i - 3, i).every(isNum)) out.color = `${toks.slice(i - 3, i).join(' ')} rg`;
    else if (t === 'k' && i >= 4 && toks.slice(i - 4, i).every(isNum)) out.color = `${toks.slice(i - 4, i).join(' ')} k`;
  });
  return out;
}

/** A DA colour operation as RGB (g, rg, k), or null. */
export function colorOfOp(op) {
  const m = /^([\d.\s-]+)\s(g|rg|k)$/.exec(String(op ?? '').trim());
  if (!m) return null;
  const v = m[1].trim().split(/\s+/).map(Number);
  if (m[2] === 'g') return [v[0], v[0], v[0]];
  if (m[2] === 'rg') return v;
  return [(1 - v[0]) * (1 - v[3]), (1 - v[1]) * (1 - v[3]), (1 - v[2]) * (1 - v[3])];
}

function colorAt(ctx, mk, k) {
  const v = numsAt(ctx, mk, k);
  if (!v) return null;
  if (v.length === 1) return [v[0], v[0], v[0]];
  if (v.length === 3) return v;
  if (v.length === 4) return [(1 - v[0]) * (1 - v[3]), (1 - v[1]) * (1 - v[3]), (1 - v[2]) * (1 - v[3])];
  return null;
}

/** appearance.rs `mk_rotation`: /MK /R as 0, 90, 180 or 270. */
export function mkRotation(ctx, wd) {
  const mk = dictAt(ctx, wd, 'MK');
  const r = mk ? intAt(ctx, mk, 'R') : undefined;
  return r === 90 || r === 180 || r === 270 ? r : 0;
}

/** The widget's border width as the appearance draws it (appearance.rs `border_width`). */
export function borderWidth(ctx, wd) {
  const mk = dictAt(ctx, wd, 'MK');
  const bs = dictAt(ctx, wd, 'BS');
  const bw = Math.max(0, bs ? numAt(ctx, bs, 'W') ?? 1 : 1);
  if (!colorAt(ctx, mk, 'BC') || bw <= 0) return 0;
  const s = bs ? nameAt(ctx, bs, 'S') : undefined;
  return s === 'B' || s === 'I' ? 2 * bw : bw;
}

/** appearance.rs `list_rows_of`: where a list box draws its options. */
export function listRowsOf(ctx, fieldDa, field, wd) {
  const da = parseDa(textAt(ctx, wd, 'DA') ?? fieldDa);
  const size = da.size > 0 ? da.size : 12;
  const ti = intAt(ctx, wd, 'TI') ?? (field ? intAt(ctx, field, 'TI') : undefined) ?? 0;
  return {top: Math.max(0, ti), inset: 2 + borderWidth(ctx, wd), row: size * 1.15, size};
}

/** The look of a widget (Appearance tab): border, fill, thickness, style, text colour, font, size. */
export function lookOf(ctx, wd, da) {
  const mk = dictAt(ctx, wd, 'MK');
  const bs = dictAt(ctx, wd, 'BS');
  const d = parseDa(textAt(ctx, wd, 'DA') ?? da);
  return {border: colorAt(ctx, mk, 'BC'), fill: colorAt(ctx, mk, 'BG'), width: bs ? numAt(ctx, bs, 'W') ?? 1 : 1, style: (bs ? nameAt(ctx, bs, 'S') : undefined) ?? 'S',
    text: colorOfOp(d.color) ?? [0, 0, 0], font: d.font, size: d.size};
}

const normalize = r => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];

/** The field name a field or widget belongs to, from the partial names up its /Parent chain. */
function qualifiedName(ctx, ref) {
  const parts = [];
  const seen = new Set();
  let cur = ref;
  while (cur instanceof PDFRef && seen.size <= 64 && !seen.has(keyOf(cur))) {
    seen.add(keyOf(cur));
    const d = ctx.lookup(cur);
    if (!(d instanceof PDFDict)) break;
    const t = textAt(ctx, d, 'T');
    if (t !== null) parts.push(t);
    cur = d.get(N('Parent'));
  }
  return parts.length ? parts.reverse().join('.') : null;
}

/** A push button's mouse-up action (/A, or /AA /U, on the field or its widget). */
function buttonAction(ctx, d, widgetRefs, pages) {
  if (boolAt(ctx, d, 'PCXfaImage')) return {kind: 'importIcon'};
  const pick = dict => dict.get(N('A')) ?? res(ctx, dict.get(N('AA')))?.get?.(N('U'));
  let action = pick(d);
  if (!action) for (const w of widgetRefs) { const wd = ctx.lookup(w); if (wd instanceof PDFDict && (action = pick(wd))) break; }
  const a = res(ctx, action);
  if (!(a instanceof PDFDict)) return null;
  const texts = o => { const v = res(ctx, o); return v instanceof PDFArray ? v.asArray().map(x => textOf(res(ctx, x))).filter(x => x !== null) : textOf(v) !== null ? [textOf(v)] : []; };
  switch (nameAt(ctx, a, 'S')) {
    case 'ResetForm': {
      const f = arrAt(ctx, a, 'Fields');
      const names = f ? f.asArray().map(o => (o instanceof PDFRef ? qualifiedName(ctx, o) : textOf(res(ctx, o)))).filter(x => x !== null) : [];
      return {kind: 'reset', fields: names, exclude: ((intAt(ctx, a, 'Flags') ?? 0) & 1) !== 0};
    }
    case 'Named': return {kind: 'named', name: nameAt(ctx, a, 'N') ?? ''};
    case 'URI': return {kind: 'uri', uri: textAt(ctx, a, 'URI') ?? ''};
    case 'SubmitForm': { const f = get(ctx, a, 'F'); return {kind: 'submit', url: f instanceof PDFDict ? textAt(ctx, f, 'F') ?? '' : textOf(f) ?? ''}; }
    case 'GoTo': {
      const dest = arrAt(ctx, a, 'D');
      const target = dest?.get(0);
      const page = target instanceof PDFRef ? pages.findIndex(p => p === target) : -1;
      return page >= 0 ? {kind: 'goto', page} : {kind: 'script', script: 'GoTo'};
    }
    case 'Hide': {
      const t = get(ctx, a, 'T');
      const one = o => (o instanceof PDFRef ? qualifiedName(ctx, o) ?? textOf(res(ctx, o)) : textOf(o));
      const names = t instanceof PDFArray ? t.asArray().map(one).filter(x => x !== null) : t === undefined ? [] : [one(a.get(N('T')))].filter(x => x !== null);
      return {kind: 'showhide', fields: names, hide: boolAt(ctx, a, 'H') !== false};
    }
    case 'JavaScript': { const js = scriptOf(ctx, action); return js === null ? null : buttonScript(js); }
    default: return {kind: 'script', script: nameAt(ctx, a, 'S') ?? ''};
  }
}

/** A field's format/keystroke, validate and calculate scripts (field dictionary, or its only widget's). */
function actionsOf(ctx, d, widgetRefs) {
  let aa = dictAt(ctx, d, 'AA');
  if (!aa && widgetRefs.length === 1) { const w = ctx.lookup(widgetRefs[0]); aa = w instanceof PDFDict ? dictAt(ctx, w, 'AA') : null; }
  const out = {format: NONE, validate: NONE, calculate: NONE, unsupported: [], scripts: {}};
  if (!aa) return out;
  const js = k => { const a = aa.get(N(k)); return a ? scriptOf(ctx, a) : null; };
  const f = js('F');
  if (f !== null) {
    const fm = parseFormat(f);
    if (fm) out.format = fm; else if (f.trim()) { out.unsupported.push('format'); out.scripts.format = f; }
  }
  const k = js('K');
  if (k !== null && out.format.kind === 'none') {
    const fm = parseFormat(k);
    if (fm?.kind === 'mask') out.format = fm; else if (!fm && k.trim()) { out.unsupported.push('keystroke'); out.scripts.keystroke = k; }
  }
  const v = js('V');
  if (v !== null) { const vv = parseValidate(v); if (vv) out.validate = vv; else if (v.trim()) { out.unsupported.push('validate'); out.scripts.validate = v; } }
  const c = js('C');
  if (c !== null) { const cc = parseCalculate(c); if (cc) out.calculate = cc; else if (c.trim()) { out.unsupported.push('calculate'); out.scripts.calculate = c; } }
  return out;
}

function valuesOf(ctx, o) {
  const v = res(ctx, o);
  if (v === undefined) return [];
  if (v instanceof PDFArray) return v.asArray().map(x => textOf(res(ctx, x))).filter(x => x !== null);
  if (v instanceof PDFStream || v instanceof PDFRawStream) { const t = streamText(v); return t === null ? [] : [t]; }
  const t = textOf(v);
  return t !== null && t !== 'Off' && t !== '' ? [t] : [];
}

const fieldFlags = (ctx, d) => { const f = intAt(ctx, d, 'Ff'); return f === undefined ? undefined : f >>> 0; };

/** The trigger actions of the Actions tab (first widget): [[trigger, action]]. */
export const TRIGGERS = Object.freeze([['mouse_up', 'Mouse Up', null], ['mouse_down', 'Mouse Down', 'D'], ['mouse_enter', 'Mouse Enter', 'E'], ['mouse_exit', 'Mouse Exit', 'X'],
  ['on_focus', 'On Focus', 'Fo'], ['on_blur', 'On Blur', 'Bl']]);

function readAction(ctx, o, pages) {
  const a = res(ctx, o);
  if (!(a instanceof PDFDict)) return null;
  const texts = x => { const v = res(ctx, x); return v instanceof PDFArray ? v.asArray().map(y => textOf(res(ctx, y))).filter(y => y !== null) : textOf(v) !== null ? [textOf(v)] : []; };
  switch (nameAt(ctx, a, 'S')) {
    case 'JavaScript': return {kind: 'javascript', script: scriptOf(ctx, o) ?? ''};
    case 'URI': return {kind: 'uri', uri: textAt(ctx, a, 'URI') ?? ''};
    case 'ResetForm': return {kind: 'reset', fields: texts(a.get(N('Fields')))};
    case 'Named': return {kind: 'named', name: nameAt(ctx, a, 'N') ?? ''};
    case 'GoTo': { const t = arrAt(ctx, a, 'D')?.get(0); const p = t instanceof PDFRef ? pages.findIndex(x => x === t) : -1; return p >= 0 ? {kind: 'goto', page: p} : null; }
    case 'Hide': return {kind: 'showhide', fields: texts(a.get(N('T'))), hide: boolAt(ctx, a, 'H') !== false};
    case 'SubmitForm': { const f = get(ctx, a, 'F'); return {kind: 'submit', url: f instanceof PDFDict ? textAt(ctx, f, 'F') ?? '' : textOf(f) ?? ''}; }
    default: return {kind: 'other', name: nameAt(ctx, a, 'S') ?? ''};
  }
}

/** Every terminal field of the form, widgets and tab ranks. */
export function readFields(pdf) {
  const ctx = pdf.context;
  const af = acroform(pdf);
  const pages = pageRefs(pdf);
  const pageOf = new Map(), annotIndex = new Map();
  pages.forEach((p, i) => {
    const arr = res(ctx, ctx.lookup(p)?.get?.(N('Annots')));
    if (!(arr instanceof PDFArray)) return;
    arr.asArray().forEach((e, k) => { if (e instanceof PDFRef) { const key = keyOf(e); if (!pageOf.has(key)) { pageOf.set(key, i); annotIndex.set(key, k); } } });
  });
  const base = {name: '', da: af ? textAt(ctx, af, 'DA') ?? undefined : undefined, q: af ? intAt(ctx, af, 'Q') : undefined};
  const out = [];
  const seen = {fields: new Set(), widgets: new Set()};
  const walk = (ref, parent, depth) => {
    if (depth > MAX_DEPTH || seen.fields.has(keyOf(ref))) return;
    seen.fields.add(keyOf(ref));
    const d = ctx.lookup(ref);
    if (!(d instanceof PDFDict)) return;
    const inh = {...parent};
    const t = textAt(ctx, d, 'T');
    if (t !== null) inh.name = inh.name ? `${inh.name}.${t}` : t;
    const ft = nameAt(ctx, d, 'FT'); if (ft !== undefined) inh.ft = ft;
    const ff = fieldFlags(ctx, d); if (ff !== undefined) inh.ff = ff;
    if (d.has(N('V'))) inh.v = d.get(N('V'));
    if (d.has(N('DV'))) inh.dv = d.get(N('DV'));
    const da = textAt(ctx, d, 'DA'); if (da !== null) inh.da = da;
    const q = intAt(ctx, d, 'Q'); if (q !== undefined) inh.q = q;
    const ml = intAt(ctx, d, 'MaxLen'); if (ml !== undefined) inh.maxLen = ml > 0 ? ml : undefined;
    const kidsArr = arrAt(ctx, d, 'Kids');
    const kids = kidsArr ? kidsArr.asArray().filter(k => k instanceof PDFRef) : [];
    const fieldKids = kids.filter(k => { const kd = ctx.lookup(k); return kd instanceof PDFDict && kd.has(N('T')); });
    if (fieldKids.length) { for (const k of fieldKids) walk(k, inh, depth + 1); return; }
    const flags = inh.ff ?? 0;
    let kind;
    if (inh.ft === 'Tx') kind = 'text';
    else if (inh.ft === 'Btn') kind = flags & FLAG.PUSH_BUTTON ? 'pushbutton' : flags & FLAG.RADIO ? 'radio' : 'checkbox';
    else if (inh.ft === 'Ch') kind = flags & FLAG.COMBO ? 'combo' : 'list';
    else if (inh.ft === 'Sig') kind = 'signature';
    else return;
    const widgetRefs = (d.has(N('Rect')) ? [ref] : kids).filter(w => { const k = keyOf(w); if (seen.widgets.has(k)) return false; seen.widgets.add(k); return true; });
    const fda = inh.da ?? DEFAULT_DA;
    const widgets = [];
    for (const w of widgetRefs) {
      const wd = ctx.lookup(w);
      if (!(wd instanceof PDFDict)) continue;
      const rect = numsAt(ctx, wd, 'Rect');
      const r = rect && rect.length === 4 ? normalize(rect) : [0, 0, 0, 0];
      const af2 = intAt(ctx, wd, 'F') ?? 0;
      const ownFf = w === ref ? 0 : fieldFlags(ctx, wd) ?? 0;
      const apN = dictAt(ctx, dictAt(ctx, wd, 'AP'), 'N');
      let onState = null;
      if (apN && !(apN instanceof PDFStream)) for (const k of apN.keys()) { const nm = k.decodeText(); if (nm !== 'Off') { onState = nm; break; } }
      const key = keyOf(w);
      const mk = dictAt(ctx, wd, 'MK');
      const cap = kind === 'pushbutton' && mk ? textAt(ctx, mk, 'CA') : null;
      widgets.push({
        id: key, page: pageOf.get(key) ?? null, rect: r, onState: kind === 'checkbox' || kind === 'radio' ? onState : null, state: nameAt(ctx, wd, 'AS') ?? null,
        tab: Number.MAX_SAFE_INTEGER, annotIndex: annotIndex.get(key) ?? Number.MAX_SAFE_INTEGER, locked: (af2 & 128) !== 0, hidden: (af2 & (2 | 32)) !== 0,
        readOnly: ((flags | ownFf) & FLAG.READ_ONLY) !== 0, rotation: mkRotation(ctx, wd), caption: cap, list: kind === 'list' ? listRowsOf(ctx, fda, d, wd) : null,
        round: kind === 'radio', look: lookOf(ctx, wd, fda),
      });
    }
    const optArr = arrAt(ctx, d, 'Opt') ?? (inh.ft === 'Ch' ? null : arrAt(ctx, d, 'Opt'));
    const options = [];
    if (optArr) for (const o of optArr.asArray()) {
      const v = res(ctx, o);
      if (v instanceof PDFArray && v.size() >= 2) { const e = textOf(res(ctx, v.get(0))), s = textOf(res(ctx, v.get(1))); if (e !== null && s !== null) options.push([e, s]); }
      else { const s = textOf(v); if (s !== null) options.push([s, s]); }
    }
    const triggers = [];
    const w0 = widgets[0] ? ctx.lookup(refOfKey(widgets[0].id)) : null;
    if (w0 instanceof PDFDict) {
      const aa = dictAt(ctx, w0, 'AA');
      for (const [id, label, key] of TRIGGERS) {
        const o = key === null ? w0.get(N('A')) ?? aa?.get(N('U')) : aa?.get(N(key));
        const a = o ? readAction(ctx, o, pages) : null;
        if (a) triggers.push([id, a]);
      }
    }
    const CHECK_CODES = {4: 'Check', l: 'Circle', 8: 'Cross', u: 'Diamond', n: 'Square', H: 'Star'};
    const w0d = widgets[0] ? ctx.lookup(refOfKey(widgets[0].id)) : null;
    const ca = w0d instanceof PDFDict ? textAt(ctx, dictAt(ctx, w0d, 'MK'), 'CA') : null;
    out.push({
      checkStyle: kind === 'checkbox' || kind === 'radio' ? CHECK_CODES[ca] ?? (kind === 'radio' ? 'Circle' : 'Check') : null,
      name: inh.name, id: keyOf(ref), kind, value: valuesOf(ctx, inh.v), defaultValue: valuesOf(ctx, inh.dv), flags, maxLen: inh.maxLen ?? null, options, da: fda, quadding: inh.q ?? 0,
      tooltip: textAt(ctx, d, 'TU'), widgets, actions: actionsOf(ctx, d, widgetRefs), button: kind === 'pushbutton' ? buttonAction(ctx, d, widgetRefs, pages) : null, triggers,
    });
  };
  if (af) { const fl = arrAt(ctx, af, 'Fields'); if (fl) for (const f of fl.asArray()) if (f instanceof PDFRef) walk(f, base, 0); }
  // Widgets no /Fields entry reaches are adopted as fields (read.rs adopt_page_fields).
  pages.forEach(p => {
    const arr = res(ctx, ctx.lookup(p)?.get?.(N('Annots')));
    if (!(arr instanceof PDFArray)) return;
    for (const e of arr.asArray()) {
      if (!(e instanceof PDFRef)) continue;
      const k = keyOf(e);
      if (seen.fields.has(k) || seen.widgets.has(k)) continue;
      const d = ctx.lookup(e);
      if (!(d instanceof PDFDict) || nameAt(ctx, d, 'Subtype') !== 'Widget') continue;
      if (!d.has(N('FT')) && !d.has(N('T')) && !d.has(N('Parent'))) continue;
      let top = e;
      const visited = new Set([k]);
      let ok = true;
      for (;;) {
        const parent = ctx.lookup(top)?.get?.(N('Parent'));
        if (!(parent instanceof PDFRef)) { ok = !seen.fields.has(keyOf(top)); break; }
        if (visited.has(keyOf(parent)) || visited.size > 64 || seen.fields.has(keyOf(parent))) { ok = false; break; }
        visited.add(keyOf(parent));
        top = parent;
      }
      if (ok) walk(top, base, 0);
    }
  });
  rankTabs(pdf, pages, out);
  return out;
}

/** The page's tab order (/Tabs): R rows, C columns, S structure, or unspecified (annotation order). */
export function tabOrderOf(ctx, pageRef) {
  const t = nameAt(ctx, ctx.lookup(pageRef), 'Tabs');
  return t === 'R' ? 'row' : t === 'C' ? 'column' : t === 'S' ? 'structure' : 'annotations';
}

function rightToLeft(pdf) {
  const prefs = dictAt(pdf.context, pdf.catalog, 'ViewerPreferences');
  return !!prefs && nameAt(pdf.context, prefs, 'Direction') === 'R2L';
}

/** tab_order.rs `rank_tabs`: every widget's place in the document's tab order. */
function rankTabs(pdf, pages, fields) {
  const ctx = pdf.context;
  const items = [];
  fields.forEach((f, fi) => f.widgets.forEach((w, wi) => { if (w.page !== null) items.push({page: w.page, fi, wi, rect: w.rect, annot: w.annotIndex}); }));
  if (rightToLeft(pdf)) for (const i of items) i.rect = [-i.rect[2], i.rect[1], -i.rect[0], i.rect[3]];
  const ordered = [];
  pages.forEach((p, pi) => {
    const on = items.filter(i => i.page === pi);
    if (!on.length) return;
    const tabs = tabOrderOf(ctx, p);
    if (tabs === 'row' || tabs === 'column') {
      const row = tabs === 'row';
      on.sort((a, b) => (row ? b.rect[3] - a.rect[3] : a.rect[0] - b.rect[0]));
      const groups = [];
      for (const it of on) {
        const g = groups[groups.length - 1];
        const fits = g && (row ? Math.abs(g[0].rect[3] - it.rect[3]) < Math.max((g[0].rect[3] - g[0].rect[1]) / 2, 2) : Math.abs(it.rect[0] - g[0].rect[0]) < Math.max((g[0].rect[2] - g[0].rect[0]) / 2, 2));
        if (fits) g.push(it); else groups.push([it]);
      }
      for (const g of groups) { g.sort((a, b) => (row ? a.rect[0] - b.rect[0] : b.rect[3] - a.rect[3])); ordered.push(...g); }
    } else { on.sort((a, b) => a.annot - b.annot); ordered.push(...on); }
  });
  ordered.forEach((it, rank) => { fields[it.fi].widgets[it.wi].tab = rank; });
}

/** The field named `name` (its first match) in a reading. */
export const fieldNamed = (fields, name) => fields.find(f => f.name === name) ?? null;

/** The first model page of each source page (a duplicated page's copy comes after the page it copies). */
function pageIdBySource(pages) {
  const by = new Map();
  for (const p of pages) { const prev = by.get(p.sourceIndex); if (!prev || (prev.duplicateOf && !p.duplicateOf)) by.set(p.sourceIndex, p); }
  return by;
}

/** Fields as the model stores them: each widget carries its model page id (widgets on pages the model dropped are left out). */
export function modelFields(fields, pages) {
  const by = pageIdBySource(pages);
  return fields.map(f => ({
    ...f, type: f.kind, readOnly: (f.flags & 1) !== 0, required: (f.flags & 2) !== 0,
    widgets: f.widgets.map(w => ({...w, pageId: w.page === null ? null : by.get(w.page)?.id ?? null})),
  }));
}
