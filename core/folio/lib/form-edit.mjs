// Filling and preparing a form: set values, Clear form, add, change, duplicate and delete fields,
// tab order, calculation order, Flatten, and Align / Distribute / Match size.
//
// Translated from printcraft crates/forms/src/values.rs (set_value, write_value, set_states,
// reset, recalculate, merged_appearance), author.rs, author/lifecycle.rs (add_field,
// delete_field, delete_widget, duplicate_field, split_merged), author/tree.rs (ensure_form,
// attach, detach, clash, free_name), author/edit.rs (set_props), author/look.rs (patch_da,
// patch_widget_look), tab_order.rs (set_tab_order, move_in_tab_order), calc_order.rs and
// crates/ui-egui/src/tools/prepare.rs (arrange) at 3109bb2359759e24ef490e1cdbdba00722b20972.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. pdf-lib is the cos layer.
// No DOM, no Node built-ins.

import {PDFName, PDFRef, PDFDict, PDFArray, PDFNumber, PDFString, PDFHexString, PDFStream, PDFRawStream, PDFBool} from 'pdf-lib';
import {FLAG, N, keyOf, refOfKey, res, get, dictAt, arrAt, textOf, textAt, intAt, numAt, nameAt, numsAt, acroform, pageRefs, readFields, parseDa, tabOrderOf, DEFAULT_DA} from './form-read.mjs';
import {fieldAppearance, checkBoxStates, pushButtonAppearance, signatureAppearance, checkStyleOf, codeOfStyle, BORDER_STYLES, FIELD_FONTS} from './form-appearance.mjs';
import * as af from './form-af.mjs';

export const MIN_FIELD_SIDE = 4;

export class FormError extends Error {
  constructor(message, code = 'invalid') { super(message); this.name = 'FormError'; this.code = code; }
}
const invalid = m => { throw new FormError(m); };
const noField = name => { throw new FormError(`there is no field named "${name}"`, 'not_found'); };

// ── pdf-lib helpers ─────────────────────────────────────────────────────────────────────────

/** A PDF text string object (a literal for ASCII, UTF-16 hex otherwise). */
export function textObj(s) {
  const t = String(s);
  if (/^[\x20-\x7e]*$/.test(t)) return PDFString.of(t.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'));
  return PDFHexString.fromText(t);
}
const nameObj = s => PDFName.of(s);
const num = v => PDFNumber.of(v);
const rgbObj = (ctx, c) => ctx.obj(c.map(v => Math.min(1, Math.max(0, v))));
const rectObj = (ctx, r) => ctx.obj(r.map(v => Math.round(v * 1000) / 1000));
const widgetDict = (ctx, w) => ctx.lookup(refOfKey(w.id));
const fieldDict = (ctx, f) => ctx.lookup(refOfKey(f.id));

/** The form's field list as a reading (call again after a change). */
export const read = pdf => readFields(pdf);
const findField = (fields, name, id) => (id ? fields.find(f => f.id === id) : fields.find(f => f.name === name)) ?? noField(name);

function listOf(ctx, holder, key) {
  const a = arrAt(ctx, holder, key);
  return a ? a.asArray() : [];
}
function setList(ctx, holder, key, list) {
  const raw = holder.get(N(key));
  if (raw instanceof PDFRef && ctx.lookup(raw) instanceof PDFArray) ctx.assign(raw, ctx.obj(list));
  else holder.set(N(key), ctx.obj(list));
}

/** The AcroForm dictionary, creating the form (with /Helv, /TiRo, /Cour in /DR) when needed. */
export function ensureForm(pdf) {
  const ctx = pdf.context;
  let af0 = pdf.catalog.lookup(N('AcroForm'));
  if (!(af0 instanceof PDFDict)) { af0 = ctx.obj({}); pdf.catalog.set(N('AcroForm'), ctx.register(af0)); }
  else if (!(pdf.catalog.get(N('AcroForm')) instanceof PDFRef)) pdf.catalog.set(N('AcroForm'), ctx.register(af0));
  if (!(res(ctx, af0.get(N('Fields'))) instanceof PDFArray)) af0.set(N('Fields'), ctx.obj([]));
  if (!af0.has(N('DA'))) af0.set(N('DA'), textObj(DEFAULT_DA));
  let dr = res(ctx, af0.get(N('DR')));
  if (!(dr instanceof PDFDict)) { dr = ctx.obj({}); af0.set(N('DR'), dr); }
  let fonts = res(ctx, dr.get(N('Font')));
  if (!(fonts instanceof PDFDict)) { fonts = ctx.obj({}); dr.set(N('Font'), fonts); }
  // Each /DR font its own object: Acrobat shows nothing when a font is written inline (#3441).
  for (const k of [...fonts.keys()]) { const v = fonts.get(k); if (v instanceof PDFDict) fonts.set(k, ctx.register(v)); }
  for (const [name, base] of [['Helv', 'Helvetica'], ['TiRo', 'Times-Roman'], ['Cour', 'Courier']]) {
    if (!fonts.has(N(name))) fonts.set(N(name), ctx.register(ctx.obj({Type: 'Font', Subtype: 'Type1', BaseFont: base, Encoding: 'WinAnsiEncoding'})));
  }
  return af0;
}

/** Take a widget annotation off every page's /Annots. */
function dropFromPages(pdf, keys) {
  const ctx = pdf.context;
  for (const p of pageRefs(pdf)) {
    const pd = ctx.lookup(p);
    const arr = arrAt(ctx, pd, 'Annots');
    if (!arr) continue;
    const list = arr.asArray();
    const kept = list.filter(o => !(o instanceof PDFRef && keys.has(keyOf(o))));
    if (kept.length !== list.length) setList(ctx, pd, 'Annots', kept);
  }
}

function addToPage(pdf, pageRef, widgetRef) {
  const ctx = pdf.context;
  const pd = ctx.lookup(pageRef);
  const arr = arrAt(ctx, pd, 'Annots');
  if (arr) { const list = arr.asArray(); list.push(widgetRef); setList(ctx, pd, 'Annots', list); } else pd.set(N('Annots'), ctx.obj([widgetRef]));
}

// ── names and the field tree ────────────────────────────────────────────────────────────────

const MAX_NAME_PARTS = 32;
function nameParts(name) {
  const parts = name.split('.');
  if (parts.length > MAX_NAME_PARTS) invalid(`field names can have at most ${MAX_NAME_PARTS} parts`);
  if (parts.some(p => !p.trim())) invalid("field names can't be empty, or have an empty part between periods");
  return parts;
}
const inside = (a, b) => a.startsWith(`${b}.`);
function clash(name, other) {
  if (name === other) return `a field named "${name}" already exists`;
  if (inside(name, other) || inside(other, name)) return `"${name}" can't be used beside the field "${other}"`;
  return null;
}
function topNames(pdf) {
  const ctx = pdf.context;
  const a = acroform(pdf);
  return a ? listOf(ctx, a, 'Fields').map(o => textAt(ctx, res(ctx, o), 'T')).filter(Boolean) : [];
}
export function freeName(fields, held, base) {
  for (let i = 1; ; i++) {
    const c = `${base}${i}`;
    if (!held.includes(c) && !fields.some(f => f.name === c || f.name.startsWith(`${c}.`))) return c;
  }
}
function childNamed(pdf, parent, name) {
  const ctx = pdf.context;
  const list = parent ? listOf(ctx, parent, 'Kids') : listOf(ctx, acroform(pdf), 'Fields');
  return list.find(o => o instanceof PDFRef && textAt(ctx, ctx.lookup(o), 'T') === name) ?? null;
}
function link(pdf, afd, parentDict, ref) {
  const ctx = pdf.context;
  if (parentDict) { const kids = listOf(ctx, parentDict, 'Kids'); kids.push(ref); setList(ctx, parentDict, 'Kids', kids); }
  else { const l = listOf(ctx, afd, 'Fields'); l.push(ref); setList(ctx, afd, 'Fields', l); }
}
/** Put `fieldRef` in the field tree under the full name `parts` (parents are made where the tree has none). */
function attach(pdf, afd, fieldRef, parts) {
  const ctx = pdf.context;
  const own = parts[parts.length - 1];
  let parentDict = null, parentRef = null;
  for (const part of parts.slice(0, -1)) {
    let r = childNamed(pdf, parentDict, part);
    if (!r) {
      const d = ctx.obj({Kids: []});
      d.set(N('T'), textObj(part));
      if (parentRef) d.set(N('Parent'), parentRef);
      r = ctx.register(d);
      link(pdf, afd, parentDict, r);
    }
    parentRef = r;
    parentDict = ctx.lookup(r);
  }
  const fd = ctx.lookup(fieldRef);
  fd.set(N('T'), textObj(own));
  if (parentRef) fd.set(N('Parent'), parentRef); else fd.delete(N('Parent'));
  link(pdf, afd, parentDict, fieldRef);
}
/** Take a field out of the tree (its parent's /Kids or the form's /Fields). */
function detach(pdf, fieldRef) {
  const ctx = pdf.context;
  const parent = ctx.lookup(fieldRef)?.get?.(N('Parent'));
  const holder = parent instanceof PDFRef ? [ctx.lookup(parent), 'Kids'] : [acroform(pdf), 'Fields'];
  if (!holder[0]) return;
  setList(ctx, holder[0], holder[1], listOf(ctx, holder[0], holder[1]).filter(o => !(o instanceof PDFRef && keyOf(o) === keyOf(fieldRef))));
}
function ancestorSets(ctx, ref, key) {
  const seen = new Set();
  let p = ctx.lookup(ref)?.get?.(N('Parent'));
  while (p instanceof PDFRef && seen.size <= 64 && !seen.has(keyOf(p))) {
    seen.add(keyOf(p));
    const d = ctx.lookup(p);
    if (!(d instanceof PDFDict)) return false;
    if (d.has(N(key))) return true;
    p = d.get(N('Parent'));
  }
  return false;
}

// ── appearances ─────────────────────────────────────────────────────────────────────────────

/** The widget's /AP with its fresh /N: the old /D and /R show the old value, so they go (merged_appearance). */
function setNormalAppearance(ctx, wd, nRef) {
  const old = dictAt(ctx, wd, 'AP');
  const ap = ctx.obj({});
  if (old) for (const [k, v] of old.entries()) if (!['N', 'D', 'R'].includes(k.decodeText())) ap.set(k, v);
  ap.set(N('N'), nRef);
  wd.set(N('AP'), ap);
}

/** Draw (or redraw) one widget of a field from the field's current value. */
export function redrawWidget(pdf, field, wi) {
  const ctx = pdf.context;
  const w = field.widgets[wi];
  const wd = widgetDict(ctx, w);
  if (!(wd instanceof PDFDict)) return null;
  switch (field.kind) {
    case 'text': case 'combo': case 'list': {
      const {ref, undrawn} = fieldAppearance(ctx, field, w, wd, field.value);
      setNormalAppearance(ctx, wd, ref);
      return undrawn;
    }
    case 'pushbutton': setNormalAppearance(ctx, wd, pushButtonAppearance(ctx, field, w, wd)); return null;
    case 'signature': setNormalAppearance(ctx, wd, signatureAppearance(ctx, w, wd)); return null;
    default: {
      // Check boxes and radio buttons: both states drawn again, /AS kept.
      const on = w.onState ?? 'Yes';
      wd.set(N('AP'), checkBoxStates(ctx, field, w, wd, on));
      const isOn = field.value.includes(on) || field.value.includes(field.options.length === field.widgets.length ? field.options[wi]?.[0] : on);
      wd.set(N('AS'), nameObj(isOn && field.value.length ? on : 'Off'));
      return null;
    }
  }
}

/** Redraw every widget (or just `only`) of the field with this name. Returns the first character a font could not draw. */
export function redrawField(pdf, name, only = null) {
  const field = read(pdf).find(f => f.name === name);
  if (!field) return noField(name);
  let undrawn = null;
  field.widgets.forEach((_, i) => { if (only === null || only === i) undrawn ??= redrawWidget(pdf, field, i); });
  return undrawn;
}

// ── values ──────────────────────────────────────────────────────────────────────────────────

const truthyWords = ['yes', 'true', 'on', '1', 'x', 'checked'], falsyWords = ['no', 'false', 'off', '0', 'unchecked'];

/**
 * Build /Opt before modifying the document, keeping the appearance states and the selection: the export value of one button widget changes
 * without changing its appearance state, and widgets sharing that state are kept in sync (author/edit.rs button_export_options, printcraft 8f16855).
 */
function buttonExportOptions(f, index, value) {
  if (!(f.kind === 'checkbox' || f.kind === 'radio')) invalid('only check boxes and radio buttons have an export value');
  if (!value || value === 'Off' || new TextEncoder().encode(value).length > 4096) invalid('export value must be non-empty, at most 4096 bytes, and not Off');
  const widget = f.widgets[index] ?? invalid('button widget index is out of range');
  const state = widget.onState ?? invalid('button has no on appearance state');
  if (f.options.length && f.options.length !== f.widgets.length) invalid('button export options do not match its widgets');
  const previous = exportOf(f, index);
  return f.widgets.map((w, i) => {
    const exported = exportOf(f, i) ?? invalid('button has no on appearance state');
    const same = w.onState === state;
    if (!same && (exported === value || w.onState === value)) invalid('export value conflicts with another button choice');
    if (same && exported !== previous) invalid('widgets with the same appearance state have conflicting export values');
    return same ? value : exported;
  });
}

/** The export value of widget i of a check box or radio group, and the on-state a choice selects. */
export const exportOf = (f, i) => {
  const on = f.widgets[i]?.onState;
  if (!on) return null;
  return f.options.length === f.widgets.length ? f.options[i][0] : on;
};
const stateFor = (f, choice) => {
  const direct = f.widgets.map(w => w.onState).find(s => s === choice);
  if (direct) return direct;
  const i = f.widgets.findIndex((_, k) => exportOf(f, k) === choice);
  return i >= 0 ? f.widgets[i].onState : null;
};

function setStates(pdf, f, on) {
  const ctx = pdf.context;
  const fd = fieldDict(ctx, f);
  fd.set(N('V'), nameObj(on ?? 'Off'));
  f.widgets.forEach((w, i) => {
    const wd = widgetDict(ctx, w);
    const state = on !== null && w.onState === on ? on : 'Off';
    if (!dictAt(ctx, wd, 'AP')) wd.set(N('AP'), checkBoxStates(ctx, f, w, wd, w.onState ?? on ?? 'Yes'));
    wd.set(N('AS'), nameObj(state));
  });
}

/** values.rs `list_scroll`: the first visible row so the picked options show. */
function topShowing(current, selected, visible, count) {
  visible = Math.max(1, visible);
  const lastTop = Math.max(0, count - visible);
  if (!selected.length) return Math.min(current, lastTop);
  const first = Math.min(...selected), last = Math.max(...selected);
  let top;
  if (first >= current && last < current + visible) top = current;
  else if (last - first >= visible || first < current) top = first;
  else top = last + 1 - visible;
  return Math.min(top, lastTop);
}

/** Write a value into a field (without recalculating). `force` lets an import fill a read-only field. */
function writeValue(pdf, f, value, {force = false} = {}) {
  const ctx = pdf.context;
  const fd = fieldDict(ctx, f);
  if (f.flags & FLAG.READ_ONLY && !force) throw new FormError(`"${f.name}" is read-only`, 'read_only');
  switch (f.kind) {
    case 'text': {
      let t = typeof value === 'string' ? value : Array.isArray(value) ? value[0] ?? '' : value === null || value === undefined ? '' : null;
      if (t === null) invalid(`"${f.name}" is a text field and can't take ${JSON.stringify(value)}`);
      if (f.maxLen && [...t].length > f.maxLen) invalid(`"${f.name}" takes at most ${f.maxLen} characters`);
      const k = af.keystroke(f.actions.format, f.name, t);
      if (k.error) throw new FormError(k.error, 'format');
      t = k.value;
      const bad = af.validate(f.actions.validate, t);
      if (bad) invalid(bad);
      const shadow = t === '' && ancestorSets(ctx, refOfKey(f.id), 'V');
      if (t === '' && !shadow) fd.delete(N('V')); else fd.set(N('V'), textObj(t));
      fd.delete(N('RV'));
      f.value = t === '' ? [] : [t];
      return redrawField(pdf, f.name);
    }
    case 'checkbox': {
      const state = f.widgets.find(w => w.onState)?.onState ?? 'Yes';
      let on;
      if (typeof value === 'boolean') on = value;
      else if (Array.isArray(value)) on = value.length > 0 && value[0] !== 'Off';
      else if (value === null || value === undefined) on = false;
      else {
        const t = String(value).trim();
        if (t === state || stateFor(f, t) || truthyWords.includes(t.toLowerCase())) on = true;
        else if (t === '' || falsyWords.includes(t.toLowerCase())) on = false;
        else invalid(`"${f.name}" is a check box: use true or false`);
      }
      setStates(pdf, f, on ? state : null);
      return null;
    }
    case 'radio': {
      let choice = typeof value === 'string' ? (value === '' ? null : value) : value === false || value === null || value === undefined ? null : Array.isArray(value) ? value[0] ?? null : invalid(`"${f.name}" is a radio group: choose one of its options`);
      if (choice !== null) choice = stateFor(f, choice) ?? choice;
      if (choice !== null && !f.widgets.some(w => w.onState === choice)) {
        invalid(`"${f.name}" has no option "${choice}" (options: ${f.widgets.map((_, i) => exportOf(f, i)).filter(Boolean).join(', ')})`);
      }
      if (choice === null && f.flags & FLAG.NO_TOGGLE_TO_OFF && f.value.length && !force) invalid(`"${f.name}" must keep one option selected`);
      setStates(pdf, f, choice);
      return null;
    }
    case 'combo': case 'list': {
      const vals = Array.isArray(value) ? value : value === '' || value === null || value === undefined ? [] : [String(value)];
      if (vals.length > 1 && !(f.kind === 'list' && f.flags & FLAG.MULTI_SELECT)) invalid(`"${f.name}" takes a single value`);
      const exports = [];
      for (const v of vals) {
        const hit = f.options.find(([e, d]) => e === v || d === v);
        if (hit) exports.push(hit[0]);
        else if ((f.kind === 'combo' && f.flags & FLAG.EDIT) || !f.options.length) exports.push(v);
        else invalid(`"${f.name}" has no option "${v}" (options: ${f.options.map(o => o[1]).join(', ')})`);
      }
      const indices = exports.map(e => f.options.findIndex(([x]) => x === e)).filter(i => i >= 0).sort((a, b) => a - b);
      const shadow = exports.length === 0 && ancestorSets(ctx, refOfKey(f.id), 'V');
      if (exports.length === 0) { if (shadow) fd.set(N('V'), textObj('')); else fd.delete(N('V')); }
      else if (exports.length === 1) fd.set(N('V'), textObj(exports[0]));
      else fd.set(N('V'), ctx.obj(exports.map(textObj)));
      if (indices.length) fd.set(N('I'), ctx.obj(indices)); else fd.delete(N('I'));
      if (f.kind === 'list' && f.widgets[0]?.list) {
        const rows = f.widgets[0].list;
        const w = f.widgets[0];
        const height = w.rotation === 90 || w.rotation === 270 ? w.rect[2] - w.rect[0] : w.rect[3] - w.rect[1];
        const visible = Math.max(1, Math.floor((height - rows.inset) / rows.row));
        const top = topShowing(rows.top, indices, visible, f.options.length);
        if (top !== rows.top) { fd.set(N('TI'), num(top)); f.widgets[0].list = {...rows, top}; }
      }
      f.value = exports;
      return redrawField(pdf, f.name);
    }
    case 'pushbutton': return invalid(`"${f.name}" is a button; it has no value`);
    default: return invalid(`"${f.name}" is a signature field; sign it with Fill & Sign or a digital ID`);
  }
}

/** Fields with the same full name are one field (section 12.7.3.1): the value the first took goes to the others. */
function shareToTwins(pdf, all, named, source) {
  const ctx = pdf.context;
  const taken = read(pdf).find(x => x.id === source.id);
  for (const t of named) {
    if (t.id === source.id || t.kind !== source.kind) continue;
    if (t.kind === 'checkbox') setStates(pdf, t, taken.value.length ? t.widgets.find(w => w.onState)?.onState ?? 'Yes' : null);
    else if (t.kind === 'radio') setStates(pdf, t, taken.value[0] && t.widgets.some(w => w.onState === taken.value[0]) ? taken.value[0] : null);
    else if (['text', 'combo', 'list'].includes(t.kind)) {
      const sd = fieldDict(ctx, source), td = fieldDict(ctx, t);
      for (const key of ['V', 'I']) { const v = sd.get(N(key)); if (v) td.set(N(key), v); else td.delete(N(key)); }
      td.delete(N('RV'));
      t.value = taken.value;
      redrawField(pdf, t.name);
    }
  }
}

/** Fill the field `name`, then recalculate. Returns the form's reading. `force`: an import may fill a read-only field. */
export function setValue(pdf, name, value, opts = {}) {
  const all = read(pdf);
  if (!all.length) throw new FormError('the document has no form fields', 'no_form');
  const named = all.filter(f => f.name === name);
  if (!named.length) noField(name);
  const f = named[0];
  writeValue(pdf, f, value, opts);
  if (named.length > 1) shareToTwins(pdf, all, named, f);
  recalculate(pdf);
  return read(pdf);
}

/** Fill several fields, reading the form once and recalculating once. Returns [{name, error?}]. */
export function setValues(pdf, entries, opts = {}) {
  let all = read(pdf);
  const results = [];
  let filled = false;
  for (const [name, value] of entries) {
    const named = all.filter(f => f.name === name);
    if (!named.length) { results.push({name, error: all.length ? `there is no field named "${name}"` : 'the document has no form fields'}); continue; }
    try {
      writeValue(pdf, named[0], value, opts);
      if (named.length > 1) shareToTwins(pdf, all, named, named[0]);
      filled = true;
      results.push({name});
      all = read(pdf);
    } catch (e) {
      if (!(e instanceof FormError)) throw e;
      results.push({name, error: e.message});
      all = read(pdf);
    }
  }
  if (filled) recalculate(pdf);
  return results;
}

/** Clear form (Acrobat Reset Form): back to /DV, for `names` (full names, groups included) or every field. */
export function reset(pdf, names = null, {exclude = false} = {}) {
  const ctx = pdf.context;
  const all = read(pdf);
  if (!all.length) throw new FormError('the document has no form fields', 'no_form');
  const hit = f => !names || !names.length || (names.some(n => f.name === n || f.name.startsWith(`${n}.`)) !== exclude);
  let count = 0;
  for (const f of all) {
    if (!hit(f) || f.kind === 'pushbutton' || f.kind === 'signature') continue;
    const fd = fieldDict(ctx, f);
    const dv = f.defaultValue;
    if (f.kind === 'text') {
      if (dv[0]) fd.set(N('V'), textObj(dv[0])); else fd.delete(N('V'));
      fd.delete(N('RV'));
      f.value = dv.slice(0, 1);
      redrawField(pdf, f.name);
    } else if (f.kind === 'checkbox' || f.kind === 'radio') {
      const d = dv[0] && f.widgets.some(w => w.onState === dv[0]) ? dv[0] : null;
      setStates(pdf, f, d);
    } else {
      const exports = dv.filter(v => f.options.some(([e]) => e === v) || (f.kind === 'combo' && f.flags & FLAG.EDIT));
      if (exports.length === 1) fd.set(N('V'), textObj(exports[0])); else if (exports.length) fd.set(N('V'), ctx.obj(exports.map(textObj))); else fd.delete(N('V'));
      const idx = exports.map(e => f.options.findIndex(([x]) => x === e)).filter(i => i >= 0);
      if (idx.length) fd.set(N('I'), ctx.obj(idx)); else fd.delete(N('I'));
      fd.delete(N('TI'));
      f.value = exports;
      redrawField(pdf, f.name);
    }
    count++;
  }
  recalculate(pdf);
  return count;
}

// ── calculation order and recalculation ─────────────────────────────────────────────────────

const isCalculated = f => f.actions.calculate.kind !== 'none' || !!f.actions.scripts.calculate;
const coEntries = pdf => { const a = acroform(pdf); return a ? listOf(pdf.context, a, 'CO') : []; };

/** calc_order.rs `run_order`: the calculated fields in the order they recalculate, and /CO entries that calculate nothing. */
export function runOrder(pdf, fields) {
  const byId = new Map();
  fields.forEach((f, i) => { if (!byId.has(f.id)) byId.set(f.id, i); });
  const placed = new Set();
  const run = [], extra = [];
  for (const e of coEntries(pdf)) {
    const i = e instanceof PDFRef ? byId.get(keyOf(e)) : undefined;
    const f = i === undefined ? null : fields[i];
    if (f && isCalculated(f) && !placed.has(i)) { placed.add(i); run.push([i, true]); }
    else extra.push(f ? f.name : e instanceof PDFRef ? keyOf(e) : 'not a reference');
  }
  fields.forEach((f, i) => { if (isCalculated(f) && !placed.has(i)) run.push([i, false]); });
  return {run, extra};
}

/** Run every field's Calculate formula in the calculation order, as Acrobat does after any value changes. */
export function recalculate(pdf) {
  const ctx = pdf.context;
  const all = read(pdf);
  if (!all.some(isCalculated)) return 0;
  const {run} = runOrder(pdf, all);
  let changed = 0;
  for (const [i] of run) {
    const f = all[i];
    if (f.actions.calculate.kind === 'none') continue;
    const lookup = n => all.filter(x => x.name === n || x.name.startsWith(`${n}.`)).flatMap(x => (x.value.length ? [x.value[0]] : []));
    const v = af.calculate(f.actions.calculate, lookup);
    if (v === null) continue;
    const current = f.value[0] ?? '';
    if (current !== v && (f.kind === 'text' || f.kind === 'combo')) {
      fieldDict(ctx, f).set(N('V'), textObj(v));
      f.value = [v];
      for (let w = 0; w < f.widgets.length; w++) redrawWidget(pdf, f, w);
      changed++;
    }
  }
  return changed;
}

/** The form's calculation order with each field's reads and what is wrong with its place (calc_order.rs). */
export function calculationOrder(pdf, fields = read(pdf)) {
  const {run, extra} = runOrder(pdf, fields);
  const calc = run.map(([i, listed]) => ({f: fields[i], listed}));
  const reads = calc.map(({f}) => {
    const names = af.calculateReads(f.actions.calculate);
    if (f.actions.scripts.calculate) for (const n of af.calculationReads(f.actions.scripts.calculate)) if (!names.includes(n)) names.push(n);
    return names;
  });
  const links = reads.map(names => {
    const out = new Set();
    for (const name of names) calc.forEach(({f}, k) => { if (f.name === name || f.name.startsWith(`${name}.`)) out.add(k); });
    return [...out].sort((a, b) => a - b);
  });
  const component = components(links);
  // A read finds the field of that name or a field under it (`row` for `row.1`); widget names (`price.0`) are not fields to the scripts either.
  const names = fields.map(f => f.name).sort();
  const found = name => names.includes(name) || names.some(n => n.startsWith(`${name}.`));
  const out = calc.map(({f, listed}, k) => {
    const issues = reads[k].filter(name => !found(name)).map(name => ({kind: 'missing_field', field: name}));
    for (const j of links[k]) if (j > k && component[j] !== component[k]) issues.push({kind: 'runs_too_early', field: calc[j].f.name});
    const looped = links[k].filter(j => component[j] === component[k]).map(j => calc[j].f.name);
    if (looped.length) issues.push({kind: 'cycle', fields: looped});
    if (!listed) issues.push({kind: 'not_in_order'});
    if (f.actions.scripts.calculate && af.readsBuiltNames(f.actions.scripts.calculate)) issues.push({kind: 'built_names'});
    return {name: f.name, reads: reads[k], listed, issues};
  });
  const fixed = fixedOrder(links, component);
  const fixable = extra.length > 0 || out.some(f => !f.listed) || fixed.some((i, k) => i !== k);
  return {fields: out, extra, fixed: fixed.map(i => out[i].name), fixable};
}

function components(links) {
  const n = links.length;
  const index = Array(n).fill(-1), low = Array(n).fill(0), comp = Array(n).fill(-1), on = Array(n).fill(false);
  const stack = [], work = [];
  let next = 0, count = 0;
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    work.push([root, 0]);
    while (work.length) {
      const [v, e] = work.pop();
      if (e === 0) { index[v] = next; low[v] = next; next++; stack.push(v); on[v] = true; }
      const w = links[v][e];
      if (w !== undefined) {
        work.push([v, e + 1]);
        if (index[w] === -1) work.push([w, 0]); else if (on[w]) low[v] = Math.min(low[v], index[w]);
        continue;
      }
      if (low[v] === index[v]) { for (;;) { const x = stack.pop(); on[x] = false; comp[x] = count; if (x === v) break; } count++; }
      if (work.length) { const p = work[work.length - 1][0]; low[p] = Math.min(low[p], low[v]); }
    }
  }
  return comp;
}

function fixedOrder(links, component) {
  const n = links.length;
  const waits = Array(n).fill(0), readers = Array.from({length: n}, () => []);
  links.forEach((read, k) => { for (const j of read) if (component[j] !== component[k]) { waits[k]++; readers[j].push(k); } });
  const ready = [];
  waits.forEach((w, k) => { if (w === 0) ready.push(k); });
  const out = [];
  while (ready.length) {
    ready.sort((a, b) => b - a);
    const k = ready.pop();
    out.push(k);
    for (const r of readers[k]) if (--waits[r] === 0) ready.push(r);
  }
  if (out.length < n) { const placed = new Set(out); for (let k = 0; k < n; k++) if (!placed.has(k)) out.push(k); }
  return out;
}

/** Write /CO afresh: `names` calculate first in that order, then the calculated fields left out in their current order. */
export function setCalculationOrder(pdf, names) {
  const all = read(pdf);
  const {run} = runOrder(pdf, all);
  const byName = new Map();
  for (const [i] of run) { const f = all[i]; if (!byName.has(f.name)) byName.set(f.name, []); byName.get(f.name).push(i); }
  const chosen = new Set(), co = [];
  for (const name of names) {
    const list = byName.get(name);
    if (!list) { if (all.some(f => f.name === name)) invalid(`${name} has no calculation`); noField(name); }
    const i = list.find(k => !chosen.has(k));
    if (i === undefined) continue;
    chosen.add(i); co.push(i);
  }
  for (const [i] of run) if (!chosen.has(i)) co.push(i);
  writeCo(pdf, co.map(i => refOfKey(all[i].id)));
}
function writeCo(pdf, refs) {
  const afd = ensureForm(pdf);
  if (refs.length) afd.set(N('CO'), pdf.context.obj(refs)); else afd.delete(N('CO'));
}
/** A field that gets a calculation joins the end of /CO; one that loses it leaves; one whose calculation changes keeps its place. */
function keepListed(pdf, ref, calculates) {
  const co = coEntries(pdf);
  const has = co.some(o => o instanceof PDFRef && keyOf(o) === keyOf(ref));
  if (!has && calculates) writeCo(pdf, [...co, ref]);
  else if (has && !calculates) writeCo(pdf, co.filter(o => !(o instanceof PDFRef && keyOf(o) === keyOf(ref))));
}
/** Move a calculated field one place earlier or later in the calculation order. */
export function moveInCalculationOrder(pdf, name, earlier) {
  const order = calculationOrder(pdf).fields.map(f => f.name);
  const i = order.indexOf(name);
  if (i < 0) invalid(`${name} has no calculation`);
  const j = earlier ? i - 1 : i + 1;
  if (j < 0 || j >= order.length) return false;
  [order[i], order[j]] = [order[j], order[i]];
  setCalculationOrder(pdf, order);
  return true;
}

// ── adding fields ───────────────────────────────────────────────────────────────────────────

const NEW_BASE = {text: 'Text', date: 'Date', checkbox: 'Check Box', radio: 'Group', combo: 'Dropdown', list: 'List Box', button: 'Button', image: 'Image', signature: 'Signature'};
export const NEW_KINDS = Object.freeze(Object.keys(NEW_BASE));

/** The size in points of a field placed with a single click (prepare.rs `default_size`). */
export const defaultSize = kind => ({text_table: [180, 110], checkbox: [14, 14], radio: [14, 14], list: [144, 54], button: [72, 22], image: [144, 108], signature: [180, 36], date: [108, 22]}[kind] ?? [144, 22]);

function newWidgetEntries(ctx, pageRef, rect) {
  const w = ctx.obj({Type: 'Annot', Subtype: 'Widget', Rect: rect, F: 4, MK: {BC: [0.55, 0.55, 0.55], BG: [1, 1, 1]}, BS: {W: 1, S: 'S'}});
  w.set(N('P'), pageRef);
  return w;
}
const jsAction = (ctx, js) => ctx.obj({S: 'JavaScript', JS: textObj(js)});

/**
 * Add a field on page `page` (0-based) in `rect` (user space). `spec`: {kind, multiline, group, exportValue, options, editable, multi, caption}.
 * Returns {name, widget: id}.
 */
export function addField(pdf, page, rect, spec, name = null) {
  const ctx = pdf.context;
  const pages = pageRefs(pdf);
  const pageRef = pages[page];
  if (!pageRef) invalid(`page ${page + 1} does not exist`);
  const r = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
  if (!r.every(Number.isFinite) || r[2] - r[0] < MIN_FIELD_SIDE || r[3] - r[1] < MIN_FIELD_SIDE) invalid('the field is too small');
  const kind = spec.kind;
  if (!NEW_BASE[kind]) invalid(`unknown field type ${kind}`);
  const existing = read(pdf);
  const group = kind === 'radio' ? spec.group ?? null : null;
  if (kind === 'radio' && group !== null && !String(group).trim()) invalid('a radio group needs a name');
  let fieldName = (name ?? group ?? '').toString().trim();
  if (!fieldName) fieldName = freeName(existing, topNames(pdf), NEW_BASE[kind]);
  const parts = nameParts(fieldName);
  const radioGroup = kind === 'radio' ? existing.find(f => f.kind === 'radio' && f.name === group) ?? null : null;
  if (!radioGroup) { const why = existing.map(f => clash(fieldName, f.name)).find(Boolean); if (why) invalid(why); }
  const afd = ensureForm(pdf);
  const w = newWidgetEntries(ctx, pageRef, rectObj(ctx, r));
  const finalName = radioGroup ? group : fieldName;
  const setDa = da => w.set(N('DA'), textObj(da));
  switch (kind) {
    case 'text': w.set(N('FT'), nameObj('Tx')); setDa('/Helv 0 Tf 0 g'); if (spec.multiline) w.set(N('Ff'), num(FLAG.MULTILINE)); break;
    case 'date':
      w.set(N('FT'), nameObj('Tx')); setDa('/Helv 0 Tf 0 g');
      w.set(N('AA'), ctx.obj({F: jsAction(ctx, 'AFDate_FormatEx("mm/dd/yyyy");'), K: jsAction(ctx, 'AFDate_KeystrokeEx("mm/dd/yyyy");')}));
      break;
    case 'checkbox': w.set(N('FT'), nameObj('Btn')); w.set(N('V'), nameObj('Off')); w.set(N('AS'), nameObj('Off')); setDa('/ZaDb 0 Tf 0 g'); break;
    case 'radio': {
      w.set(N('AS'), nameObj('Off'));
      const ex = String(spec.exportValue ?? 'Choice1');
      if (!ex.trim() || ex === 'Off') invalid('a radio button needs an export value other than Off');
      break;
    }
    case 'combo': case 'list': {
      w.set(N('FT'), nameObj('Ch')); setDa('/Helv 12 Tf 0 g');
      let ff = 0;
      if (kind === 'combo') { ff |= FLAG.COMBO; if (spec.editable) ff |= FLAG.EDIT; } else if (spec.multi) ff |= FLAG.MULTI_SELECT;
      w.set(N('Ff'), num(ff));
      w.set(N('Opt'), ctx.obj((spec.options ?? []).map(textObj)));
      break;
    }
    case 'button': {
      w.set(N('FT'), nameObj('Btn')); w.set(N('Ff'), num(FLAG.PUSH_BUTTON)); setDa('/Helv 0 Tf 0 g');
      const mk = dictAt(ctx, w, 'MK');
      mk.set(N('BG'), rgbObj(ctx, [0.86, 0.86, 0.86]));
      mk.set(N('CA'), textObj(spec.caption ?? ''));
      break;
    }
    case 'image': {
      w.set(N('FT'), nameObj('Btn')); w.set(N('Ff'), num(FLAG.PUSH_BUTTON)); setDa('/Helv 0 Tf 0 g');
      const mk = dictAt(ctx, w, 'MK');
      mk.delete(N('BC')); mk.delete(N('BG')); mk.set(N('TP'), num(1));
      w.set(N('A'), jsAction(ctx, 'event.target.buttonImportIcon();'));
      break;
    }
    default: w.set(N('FT'), nameObj('Sig'));
  }
  const widgetRef = ctx.register(w);
  if (kind === 'radio') {
    let groupRef;
    if (radioGroup) groupRef = refOfKey(radioGroup.id);
    else {
      const g = ctx.obj({FT: 'Btn', Ff: FLAG.RADIO | FLAG.NO_TOGGLE_TO_OFF, Kids: []});
      g.set(N('V'), nameObj('Off')); g.set(N('DA'), textObj('/ZaDb 0 Tf 0 g'));
      groupRef = ctx.register(g);
      attach(pdf, afd, groupRef, parts);
    }
    w.set(N('Parent'), groupRef);
    const gd = ctx.lookup(groupRef);
    const kids = listOf(ctx, gd, 'Kids'); kids.push(widgetRef); setList(ctx, gd, 'Kids', kids);
    const ex = String(spec.exportValue ?? 'Choice1');
    const fake = {kind: 'radio', widgets: [{rect: r}], da: '/ZaDb 0 Tf 0 g', options: [], value: []};
    w.set(N('AP'), checkBoxStates(ctx, fake, {rect: r}, w, ex));
  } else attach(pdf, afd, widgetRef, parts);
  addToPage(pdf, pageRef, widgetRef);
  redrawField(pdf, finalName);
  return {name: finalName, widget: keyOf(widgetRef), page};
}

// ── deleting and duplicating ────────────────────────────────────────────────────────────────

function dropFromCalculationOrder(pdf, gone) {
  const co = coEntries(pdf);
  const kept = co.filter(o => !(o instanceof PDFRef && gone.has(keyOf(o))));
  if (kept.length !== co.length) writeCo(pdf, kept);
}

/** Delete a field: its widgets leave their pages and the field leaves the form. */
export function deleteField(pdf, name) {
  const f = read(pdf).find(x => x.name === name) ?? noField(name);
  deleteFound(pdf, f);
}
function deleteFound(pdf, f) {
  const keys = new Set(f.widgets.map(w => w.id));
  dropFromPages(pdf, keys);
  detach(pdf, refOfKey(f.id));
  dropFromCalculationOrder(pdf, new Set([f.id, ...keys]));
  recalculate(pdf);
}

/** Delete one widget of a field (one radio button, one copy of a duplicated field); the last one takes the field. */
export function deleteWidget(pdf, name, widget) {
  const ctx = pdf.context;
  const f = read(pdf).find(x => x.name === name) ?? noField(name);
  const w = f.widgets[widget];
  if (!w) invalid(`${name} has no widget ${widget + 1}`);
  if (f.widgets.length < 2 || w.id === f.id) { deleteFound(pdf, f); return; }
  const perWidgetOpt = (f.kind === 'checkbox' || f.kind === 'radio') && f.options.length === f.widgets.length;
  const onOnlyHere = w.onState && f.value.includes(w.onState) && !f.widgets.some((o, i) => i !== widget && o.state === w.onState);
  dropFromPages(pdf, new Set([w.id]));
  const fd = fieldDict(ctx, f);
  setList(ctx, fd, 'Kids', listOf(ctx, fd, 'Kids').filter(k => !(k instanceof PDFRef && keyOf(k) === w.id)));
  if (perWidgetOpt) { const opt = listOf(ctx, fd, 'Opt'); if (opt.length === f.widgets.length) setList(ctx, fd, 'Opt', opt.filter((_, i) => i !== widget)); }
  if (onOnlyHere && fd.has(N('V'))) fd.set(N('V'), nameObj('Off'));
  const dv = get(ctx, fd, 'DV');
  if (w.onState && dv instanceof PDFName && dv.decodeText() === w.onState && !f.widgets.some((o, i) => i !== widget && o.onState === w.onState)) fd.set(N('DV'), nameObj('Off'));
}

const WIDGET_KEYS = ['Type', 'Subtype', 'Rect', 'P', 'AP', 'AS', 'MK', 'F', 'BS', 'Border', 'H', 'StructParent', 'A'];
const WIDGET_TRIGGERS = ['E', 'X', 'D', 'U', 'Fo', 'Bl', 'PO', 'PC', 'PV', 'PI'];

function splitMerged(pdf, f) {
  const ctx = pdf.context;
  const d = fieldDict(ctx, f);
  const kid = ctx.obj({});
  for (const k of WIDGET_KEYS) if (d.has(N(k))) kid.set(N(k), d.get(N(k)));
  const aa = dictAt(ctx, d, 'AA');
  let fieldAa = null;
  if (aa) {
    const wa = ctx.obj({});
    fieldAa = ctx.obj({});
    for (const [k, v] of aa.entries()) (WIDGET_TRIGGERS.includes(k.decodeText()) ? wa : fieldAa).set(k, v);
    if (wa.keys().length) kid.set(N('AA'), wa);
  }
  kid.set(N('Parent'), refOfKey(f.id));
  const kr = ctx.register(kid);
  for (const k of WIDGET_KEYS) d.delete(N(k));
  if (aa) { if (fieldAa.keys().length) d.set(N('AA'), fieldAa); else d.delete(N('AA')); }
  d.set(N('Kids'), ctx.obj([kr]));
  const w = f.widgets[0];
  if (w?.page !== null && w) {
    const pd = ctx.lookup(pageRefs(pdf)[w.page]);
    const arr = arrAt(ctx, pd, 'Annots');
    if (arr) setList(ctx, pd, 'Annots', arr.asArray().map(o => (o instanceof PDFRef && keyOf(o) === f.id ? kr : o)));
  }
  return kr;
}

/** Duplicate a field onto other pages (a widget at the same place, the same field). Returns how many widgets were added. */
export function duplicateField(pdf, name, pages) {
  const ctx = pdf.context;
  const f = read(pdf).find(x => x.name === name) ?? noField(name);
  const model = f.widgets[0] ?? invalid(`${name} has no widget`);
  const refs = pageRefs(pdf);
  for (const p of pages) if (!(p >= 0 && p < refs.length)) invalid(`page ${p + 1} does not exist`);
  const have = new Set(f.widgets.map(w => w.page));
  const targets = [...new Set(pages)].filter(p => !have.has(p));
  if (!targets.length) return 0;
  const modelRef = model.id === f.id ? splitMerged(pdf, f) : refOfKey(model.id);
  const template = ctx.lookup(modelRef);
  const added = [];
  for (const p of targets) {
    const w = ctx.obj({});
    for (const [k, v] of template.entries()) w.set(k, v);
    w.set(N('P'), refs[p]); w.set(N('Parent'), refOfKey(f.id)); w.delete(N('StructParent'));
    const wr = ctx.register(w);
    addToPage(pdf, refs[p], wr);
    added.push(wr);
  }
  const fd = fieldDict(ctx, f);
  setList(ctx, fd, 'Kids', [...listOf(ctx, fd, 'Kids'), ...added]);
  redrawField(pdf, name);
  return added.length;
}

// ── properties ──────────────────────────────────────────────────────────────────────────────

/** look.rs `patch_da`: rewrite only the last Tf and fill colour of a /DA string. */
export function patchDa(da, size, patch) {
  if (!patch.font && size === undefined && !patch.text) return da;
  const toks = da.split(/\s+/).filter(Boolean);
  const numeric = s => Number.isFinite(Number(s));
  if (patch.font || size !== undefined) {
    const old = parseDa(da);
    const font = patch.font ? FIELD_FONTS.find(([l]) => l === patch.font)?.[1] ?? patch.font : old.font;
    const sz = af.jsNumber(Math.min(300, Math.max(0, size ?? old.size)));
    let at = -1;
    toks.forEach((t, i) => { if (t === 'Tf' && i >= 2) at = i; });
    if (at >= 0) { toks[at - 2] = `/${font}`; toks[at - 1] = sz; } else toks.push(`/${font}`, sz, 'Tf');
  }
  if (patch.text) {
    const c = patch.text.map(v => String(Math.round(v * 1000) / 1000));
    let at = null;
    toks.forEach((t, i) => {
      const k = {g: 1, rg: 3, k: 4}[t];
      if (k && i - k >= 0 && toks.slice(i - k, i).every(numeric)) at = [i - k, i];
    });
    if (at) toks.splice(at[0], at[1] - at[0] + 1, ...c, 'rg'); else toks.push(...c, 'rg');
  }
  return toks.join(' ');
}

function patchWidgetLook(ctx, wd, patch) {
  const touchesMk = patch.border !== undefined || patch.fill !== undefined;
  const touchesBs = patch.width !== undefined || patch.style !== undefined;
  if (touchesMk) {
    let mk = dictAt(ctx, wd, 'MK');
    if (!mk) { mk = ctx.obj({}); wd.set(N('MK'), mk); }
    for (const [key, change] of [['BC', patch.border], ['BG', patch.fill]]) {
      if (change === undefined) continue;
      if (change === null) mk.delete(N(key)); else mk.set(N(key), rgbObj(ctx, change));
    }
  }
  if (touchesBs) {
    let bs = dictAt(ctx, wd, 'BS');
    if (!bs) { bs = ctx.obj({}); wd.set(N('BS'), bs); }
    if (patch.width !== undefined) bs.set(N('W'), num(patch.width));
    if (patch.style !== undefined) {
      const code = BORDER_STYLES.find(([l]) => l === patch.style)?.[1] ?? patch.style;
      bs.set(N('S'), nameObj(code));
      if (code === 'D' && !bs.has(N('D'))) bs.set(N('D'), ctx.obj([3]));
    }
  }
}

function validatePatch(p) {
  for (const c of [p.border, p.fill, p.text]) if (c && !(c.length === 3 && c.every(v => Number.isFinite(v) && v >= 0 && v <= 1))) invalid('appearance colours must be RGB values between 0 and 1');
  if (p.width !== undefined && !(Number.isFinite(p.width) && p.width >= 0 && p.width <= 12)) invalid('border width must be between 0 and 12 points');
}

function setActionsOf(pdf, f, actions) {
  const ctx = pdf.context;
  const w = f.widgets[0];
  if (!w) return;
  const wd = widgetDict(ctx, w);
  const KEYS = Object.fromEntries([['mouse_down', 'D'], ['mouse_enter', 'E'], ['mouse_exit', 'X'], ['on_focus', 'Fo'], ['on_blur', 'Bl']]);
  let aa = dictAt(ctx, wd, 'AA');
  aa = aa ? copyDict(ctx, aa) : ctx.obj({});
  // An action of another type is kept as it is (actions.rs FieldAction::Other).
  const keep = {mouse_up: wd.get(N('A')), ...Object.fromEntries(Object.entries(KEYS).map(([t, k]) => [t, aa.get(N(k))]))};
  for (const k of Object.values(KEYS)) aa.delete(N(k));
  aa.delete(N('U'));
  wd.delete(N('A'));
  for (const [trigger, action] of actions) {
    const obj = action.kind === 'other' ? keep[trigger] : actionObject(ctx, pdf, action);
    if (!obj) continue;
    if (trigger === 'mouse_up') wd.set(N('A'), obj); else if (KEYS[trigger]) aa.set(N(KEYS[trigger]), obj);
  }
  if (aa.keys().length) wd.set(N('AA'), aa); else wd.delete(N('AA'));
}
function copyDict(ctx, d) { const o = ctx.obj({}); for (const [k, v] of d.entries()) o.set(k, v); return o; }

/** An action dictionary for an Actions-tab action {kind, ...}. */
function actionObject(ctx, pdf, a) {
  switch (a.kind) {
    case 'javascript': return ctx.obj({S: 'JavaScript', JS: textObj(a.script ?? '')});
    case 'uri': return ctx.obj({S: 'URI', URI: PDFString.of(String(a.uri ?? '').replace(/[()\\]/g, ''))});
    case 'reset': { const d = ctx.obj({S: 'ResetForm'}); if (a.fields?.length) d.set(N('Fields'), ctx.obj(a.fields.map(textObj))); return d; }
    case 'named': return ctx.obj({S: 'Named', N: a.name});
    case 'goto': { const p = pageRefs(pdf)[a.page]; if (!p) invalid(`page ${a.page + 1} does not exist`); return ctx.obj({S: 'GoTo', D: [p, 'Fit']}); }
    case 'showhide': return ctx.obj({S: 'Hide', T: a.fields.map(textObj), H: a.hide !== false});
    case 'submit': return ctx.obj({S: 'SubmitForm', F: textObj(a.url ?? ''), Flags: 4});
    default: return null;
  }
}

/** Change a field's properties (every tab of Field Properties) and redraw it. Returns the field's (new) name. */
export function setProps(pdf, name, props) {
  const ctx = pdf.context;
  if (props.fontSize !== undefined && !(Number.isFinite(props.fontSize) && props.fontSize >= 0)) invalid('font size must be a finite, non-negative number');
  // Refused here, before anything is written, rather than stored as a different formula (printcraft 8f16855).
  if (props.calculate?.kind === 'notation' && !af.notationStorable(props.calculate.expr)) invalid(af.NOTATION_NOT_STORABLE);
  if (props.appearance) { if (props.look) invalid('give an appearance patch or a complete look, not both'); validatePatch(props.appearance); }
  const all = read(pdf);
  const f = all.find(x => x.name === name) ?? noField(name);
  const exportOptions = props.exportValue ? buttonExportOptions(f, props.exportValue[0], props.exportValue[1]) : null;
  if (props.exportValue && props.options) invalid('give exportValue or options, not both');
  if (props.caption) {
    if (f.kind !== 'pushbutton') invalid('only push buttons have a caption');
    if (!f.widgets[props.caption[0]]) invalid(`${name} has no widget ${props.caption[0] + 1}`);
  }
  let rotatedRect = null;
  if (props.rotation) {
    const [wi, rot] = props.rotation;
    if (![0, 90, 180, 270].includes(rot)) invalid('rotation must be 0, 90, 180 or 270 degrees');
    const w = f.widgets[wi] ?? invalid(`${name} has no widget ${wi + 1}`);
    if ((w.rotation % 180 === 0) !== (rot % 180 === 0) && !props.rect) {
      const [x0, y0, x1, y1] = w.rect;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, nw = y1 - y0, nh = x1 - x0;
      const r = [cx - nw / 2, cy - nh / 2, cx + nw / 2, cy + nh / 2];
      if (r[2] - r[0] < MIN_FIELD_SIDE || r[3] - r[1] < MIN_FIELD_SIDE) invalid('the field is too small');
      rotatedRect = r;
    }
  }
  const lockOnly = Object.keys(props).filter(k => props[k] !== undefined && k !== 'locked').length === 0;
  if (f.widgets.some(w => w.locked) && props.locked !== false && !lockOnly) invalid(`${name} is locked: unlock it first`);
  if (props.locked !== undefined) {
    for (const w of f.widgets) { const wd = widgetDict(ctx, w); const fl = intAt(ctx, wd, 'F') ?? 0; wd.set(N('F'), num(props.locked ? fl | 128 : fl & ~128)); }
    if (lockOnly) return {name};
  }
  if (props.actions) setActionsOf(pdf, f, props.actions);
  // A new name: rename the field's own part, or move it under the parents a full name gives it.
  let newName = name;
  if (props.name !== undefined && props.name.trim() && props.name.trim() !== f.name) newName = renameField(pdf, all, f, props.name.trim());
  const fd = fieldDict(ctx, f);
  const oldDa = parseDa(f.da);
  const sizeSet = props.fontSize !== undefined;
  let newDa = f.da;
  if (props.look) newDa = patchDa(f.da, props.look.size ?? props.fontSize ?? oldDa.size, {font: props.look.font, text: props.look.text});
  else newDa = patchDa(f.da, props.fontSize, props.appearance ?? {});
  if (props.look || props.appearance?.font) ensureForm(pdf);
  let ff = f.flags;
  const setFlag = (flag, on) => { if (on !== undefined) ff = on ? ff | flag : ff & ~flag; };
  setFlag(FLAG.READ_ONLY, props.readOnly);
  setFlag(FLAG.REQUIRED, props.required);
  if (f.kind === 'text') setFlag(FLAG.MULTILINE, props.multiline);
  for (const [flag, on] of props.flags ?? []) setFlag(flag, on);
  if (f.kind === 'text' && ff & FLAG.COMB) {
    const limit = props.maxLen !== undefined ? props.maxLen : f.maxLen;
    if (!limit) invalid('a comb of characters needs a character limit');
    ff &= ~(FLAG.MULTILINE | FLAG.PASSWORD | FLAG.FILE_SELECT);
  }
  if (props.quadding !== undefined && ![0, 1, 2].includes(props.quadding)) invalid('alignment is 0 (left), 1 (centre) or 2 (right)');
  if (props.options && !props.options.length && (f.kind === 'combo' || f.kind === 'list')) invalid('a list needs at least one option');
  if (props.checkStyle && !(f.kind === 'checkbox' || f.kind === 'radio')) invalid('only check boxes and radio buttons have a check style');
  const parentDefault = ancestorSets(ctx, refOfKey(f.id), 'DV');
  fd.set(N('Ff'), num(ff));
  if (props.tooltip !== undefined) { if (props.tooltip === '') fd.delete(N('TU')); else fd.set(N('TU'), textObj(props.tooltip)); }
  if (props.maxLen !== undefined) { if (props.maxLen === null || props.maxLen === 0) fd.delete(N('MaxLen')); else fd.set(N('MaxLen'), num(props.maxLen)); }
  let newItems = null;
  if (props.options) newItems = props.options.map(o => (Array.isArray(o) ? [String(o[0]), String(o[1])] : [String(o), String(o)]));
  else if (ff & FLAG.SORT && (f.kind === 'combo' || f.kind === 'list')) newItems = f.options;
  if (newItems && ff & FLAG.SORT && (f.kind === 'combo' || f.kind === 'list')) newItems = [...newItems].sort((a, b) => a[1].toLowerCase().localeCompare(b[1].toLowerCase()));
  if (newItems && (f.kind === 'combo' || f.kind === 'list')) {
    fd.set(N('Opt'), ctx.obj(newItems.map(([e, d]) => (e === d ? textObj(d) : ctx.obj([textObj(e), textObj(d)])))));
    const exports = newItems.map(x => x[0]);
    const idx = [...new Set(f.value.map(v => exports.indexOf(v)).filter(i => i >= 0))].sort((a, b) => a - b);
    if (idx.length) fd.set(N('I'), ctx.obj(idx)); else fd.delete(N('I'));
    f.options = newItems;
  }
  if (exportOptions) fd.set(N('Opt'), ctx.obj(exportOptions.map(v => textObj(v))));
  if (props.quadding !== undefined) fd.set(N('Q'), num(props.quadding));
  if (props.defaultValue !== undefined) {
    const v = props.defaultValue;
    if (v !== null) fd.set(N('DV'), f.kind === 'checkbox' || f.kind === 'radio' ? nameObj(v) : textObj(v));
    else if (parentDefault) fd.set(N('DV'), f.kind === 'checkbox' || f.kind === 'radio' ? nameObj('Off') : textObj(''));
    else fd.delete(N('DV'));
  }
  if (sizeSet || props.look || props.appearance?.font || props.appearance?.text) fd.set(N('DA'), textObj(newDa));
  const patch = props.appearance ?? {};
  if (props.appearance || (sizeSet && !props.look)) {
    for (const w of f.widgets) {
      const wd = widgetDict(ctx, w);
      patchWidgetLook(ctx, wd, patch);
      if (w.id !== f.id && (sizeSet || patch.font || patch.text) && wd.has(N('DA'))) wd.set(N('DA'), textObj(patchDa(textAt(ctx, wd, 'DA') ?? f.da, props.fontSize, patch)));
    }
  }
  if (props.look) {
    const l = props.look;
    for (const w of f.widgets) {
      const wd = widgetDict(ctx, w);
      patchWidgetLook(ctx, wd, {border: l.border ?? null, fill: l.fill ?? null, width: Math.min(12, Math.max(0, l.width ?? 1)), style: l.style ?? 'Solid'});
      if (w.id !== f.id && wd.has(N('DA'))) wd.set(N('DA'), textObj(newDa));
    }
  }
  if (props.checkStyle) for (const w of f.widgets) { const wd = widgetDict(ctx, w); let mk = dictAt(ctx, wd, 'MK'); if (!mk) { mk = ctx.obj({}); wd.set(N('MK'), mk); } mk.set(N('CA'), textObj(codeOfStyle(props.checkStyle))); }
  if (props.rect) {
    const [wi, r0] = props.rect;
    const w = f.widgets[wi] ?? invalid(`${name} has no widget ${wi + 1}`);
    const r = [Math.min(r0[0], r0[2]), Math.min(r0[1], r0[3]), Math.max(r0[0], r0[2]), Math.max(r0[1], r0[3])];
    if (!r.every(Number.isFinite) || r[2] - r[0] < MIN_FIELD_SIDE || r[3] - r[1] < MIN_FIELD_SIDE) invalid('the field is too small');
    widgetDict(ctx, w).set(N('Rect'), rectObj(ctx, r));
  }
  if (props.format || props.validate || props.calculate) {
    if (!(f.kind === 'text' || f.kind === 'combo')) invalid('only text fields and drop-down lists have format, validate and calculate scripts');
    const aaRaw = dictAt(ctx, fd, 'AA');
    const aa = aaRaw ? copyDict(ctx, aaRaw) : ctx.obj({});
    const act = js => ctx.obj({S: 'JavaScript', JS: textObj(js)});
    if (props.format) {
      aa.delete(N('F')); aa.delete(N('K'));
      const js = af.formatJs(props.format);
      if (js) { if (js[0]) aa.set(N('F'), act(js[0])); aa.set(N('K'), act(js[1])); }
    }
    if (props.validate) { aa.delete(N('V')); const js = af.validateJs(props.validate); if (js) aa.set(N('V'), act(js)); }
    if (props.calculate) {
      aa.delete(N('C'));
      const js = af.calculateJs(props.calculate);
      if (js) aa.set(N('C'), act(js));
      keepListed(pdf, refOfKey(f.id), props.calculate.kind !== 'none');
    }
    if (aa.keys().length) fd.set(N('AA'), aa); else fd.delete(N('AA'));
  }
  if (props.rotation) {
    const [wi, rot] = props.rotation;
    const wd = widgetDict(ctx, f.widgets[wi]);
    if (rotatedRect) wd.set(N('Rect'), rectObj(ctx, rotatedRect));
    let mk = dictAt(ctx, wd, 'MK');
    if (!mk) { mk = ctx.obj({}); wd.set(N('MK'), mk); }
    if (rot === 0) mk.delete(N('R')); else mk.set(N('R'), num(rot));
    if (!mk.keys().length) wd.delete(N('MK'));
  }
  if (props.caption) { const wd = widgetDict(ctx, f.widgets[props.caption[0]]); let mk = dictAt(ctx, wd, 'MK'); if (!mk) { mk = ctx.obj({}); wd.set(N('MK'), mk); } mk.set(N('CA'), textObj(props.caption[1])); }
  const onlyCaption = props.caption && Object.keys(props).filter(k => props[k] !== undefined && k !== 'caption').length === 0 ? props.caption[0] : null;
  const undrawn = redrawField(pdf, newName, onlyCaption);
  if (props.calculate) recalculate(pdf);
  return {name: newName, undrawn};
}

/** A new name: the field's own part, or a full name that moves it under the parents it names. */
function renameField(pdf, all, f, requested) {
  const ctx = pdf.context;
  let n = requested;
  const [parentsOfOld, ownOld] = splitLast(f.name);
  const [parentsOfNew] = splitLast(n);
  if (parentsOfNew !== null && parentsOfNew === parentsOfOld) n = n.slice(parentsOfNew.length + 1);
  const full = parentsOfOld !== null && !n.includes('.') ? `${parentsOfOld}.${n}` : n;
  if (n.includes('.')) {
    const parts = nameParts(n);
    const why = all.filter(x => x.id !== f.id).map(x => clash(n, x.name)).find(Boolean);
    if (why) invalid(why);
    const afd = ensureForm(pdf);
    const ref = refOfKey(f.id);
    // The attributes the field inherits stay with it when it moves.
    const fd = ctx.lookup(ref);
    let p = fd.get(N('Parent'));
    const seen = new Set();
    while (p instanceof PDFRef && !seen.has(keyOf(p))) {
      seen.add(keyOf(p));
      const pd = ctx.lookup(p);
      for (const k of ['FT', 'Ff', 'V', 'DV', 'DA', 'Q', 'MaxLen']) if (!fd.has(N(k)) && pd.has(N(k))) fd.set(N(k), pd.get(N(k)));
      p = pd.get(N('Parent'));
    }
    detach(pdf, ref);
    attach(pdf, afd, ref, parts);
    renameInCalculations(pdf, all, f.name, n);
    return n;
  }
  if (!n.trim()) invalid('field names can\'t be empty');
  const why = all.filter(x => x.id !== f.id).map(x => clash(full, x.name)).find(Boolean);
  if (why) invalid(why);
  const afd = ensureForm(pdf);
  const parent = ctx.lookup(refOfKey(f.id)).get(N('Parent'));
  const parentDict = parent instanceof PDFRef ? ctx.lookup(parent) : null;
  const other = childNamed(pdf, parentDict, n);
  if (other && keyOf(other) !== f.id) invalid(`a field named "${full}" already exists`);
  void afd; void ownOld;
  ctx.lookup(refOfKey(f.id)).set(N('T'), textObj(n));
  if (all.filter(x => x.name === f.name).length === 1) renameInCalculations(pdf, all, f.name, full);
  return full;
}
const splitLast = name => { const i = name.lastIndexOf('.'); return i < 0 ? [null, name] : [name.slice(0, i), name.slice(i + 1)]; };

/** Name field `oldName` `newName` in each field's Calculate script that reads it. */
function renameInCalculations(pdf, all, oldName, newName) {
  const ctx = pdf.context;
  for (const f of all) {
    const owners = [fieldDict(ctx, f), ...(f.widgets.length === 1 ? [widgetDict(ctx, f.widgets[0])] : [])];
    for (const owner of owners) {
      const aa = dictAt(ctx, owner, 'AA');
      const c = aa ? dictAt(ctx, aa, 'C') : null;
      if (!c) continue;
      const js = textOf(get(ctx, c, 'JS'));
      if (js === null) continue;
      const out = af.renameInCalculation(js, oldName, newName);
      if (out === null) continue;
      c.set(N('JS'), textObj(out));
      break;
    }
  }
}

// ── tab order ───────────────────────────────────────────────────────────────────────────────

/** Set the tab order of pages (0-based): row, column, structure or annotations (unspecified). */
export function setTabOrder(pdf, pages, order) {
  const ctx = pdf.context;
  const refs = pageRefs(pdf);
  for (const p of pages) {
    const r = refs[p] ?? invalid(`page ${p + 1} does not exist`);
    const pd = ctx.lookup(r);
    const code = {row: 'R', column: 'C', structure: 'S'}[order];
    if (code) pd.set(N('Tabs'), nameObj(code)); else pd.delete(N('Tabs'));
  }
}
export const tabOrders = pdf => pageRefs(pdf).map(r => tabOrderOf(pdf.context, r));

/** Order tabs manually: move field `name` one place earlier or later in its page's tab order. */
export function moveInTabOrder(pdf, name, earlier) {
  const ctx = pdf.context;
  const all = read(pdf);
  const f = all.find(x => x.name === name) ?? noField(name);
  const pages = f.widgets.map(w => w.page).filter(p => p !== null);
  if (!pages.length) invalid(`${name} is not on a page`);
  const page = Math.min(...pages);
  const order = all.map(g => [Math.min(...g.widgets.filter(w => w.page === page).map(w => w.tab), Infinity), g.name]).filter(([t]) => t !== Infinity).sort((a, b) => a[0] - b[0]);
  const names = order.map(o => o[1]);
  const i = names.indexOf(name);
  const j = earlier ? i - 1 : i + 1;
  if (j < 0 || j >= names.length) return false;
  [names[i], names[j]] = [names[j], names[i]];
  const widgets = names.flatMap(n => (all.find(g => g.name === n)?.widgets ?? []).filter(w => w.page === page).map(w => w.id));
  const pd = ctx.lookup(pageRefs(pdf)[page]);
  const list = arrAt(ctx, pd, 'Annots')?.asArray() ?? invalid('the page has no annotations');
  const set = new Set(all.flatMap(g => g.widgets.filter(w => w.page === page).map(w => w.id)));
  let k = 0;
  setList(ctx, pd, 'Annots', list.map(o => (o instanceof PDFRef && set.has(keyOf(o)) ? refOfKey(widgets[k++] ?? keyOf(o)) : o)));
  pd.delete(N('Tabs'));
  return true;
}

// ── arrange (Align, Distribute, Match size) ─────────────────────────────────────────────────

export const ARRANGE_OPS = Object.freeze(['align_left', 'align_right', 'align_top', 'align_bottom', 'center_h', 'center_v', 'distribute_h', 'distribute_v', 'same_width', 'same_height', 'same_size']);

/**
 * prepare.rs `arrange`: the new rectangles that arrange `others` against `anchor` (user space; the anchor stays put).
 * Each item is {key, rect}. Returns [{key, rect}] for the widgets that move.
 */
export function arrange(anchor, others, op) {
  const a = anchor.rect;
  const items = others.map(o => ({key: o.key, rect: o.rect}));
  if (!items.length) return [];
  const aw = a[2] - a[0], ah = a[3] - a[1];
  const moved = [];
  if (op === 'distribute_h' || op === 'distribute_v') {
    items.push({key: anchor.key, rect: a});
    if (items.length < 3) return [];
    const horiz = op === 'distribute_h';
    items.sort((x, y) => (horiz ? x.rect[0] - y.rect[0] : y.rect[3] - x.rect[3]));
    const size = r => (horiz ? r[2] - r[0] : r[3] - r[1]);
    const first = items[0].rect, last = items[items.length - 1].rect;
    const span = horiz ? last[2] - first[0] : first[3] - last[1];
    const gap = (span - items.reduce((s, i) => s + size(i.rect), 0)) / (items.length - 1);
    let at = horiz ? first[0] : first[3];
    for (const {key, rect: r} of items) {
      const s = size(r);
      moved.push({key, rect: horiz ? [at, r[1], at + s, r[3]] : [r[0], at - s, r[2], at]});
      at = horiz ? at + s + gap : at - s - gap;
    }
  } else {
    for (const {key, rect: r} of items) {
      const w = r[2] - r[0], h = r[3] - r[1];
      let nr;
      switch (op) {
        case 'align_left': nr = [a[0], r[1], a[0] + w, r[3]]; break;
        case 'align_right': nr = [a[2] - w, r[1], a[2], r[3]]; break;
        case 'align_top': nr = [r[0], a[3] - h, r[2], a[3]]; break;
        case 'align_bottom': nr = [r[0], a[1], r[2], a[1] + h]; break;
        case 'center_h': { const cx = (a[0] + a[2]) / 2; nr = [cx - w / 2, r[1], cx + w / 2, r[3]]; break; }
        case 'center_v': { const cy = (a[1] + a[3]) / 2; nr = [r[0], cy - h / 2, r[2], cy + h / 2]; break; }
        case 'same_width': nr = [r[0], r[1], r[0] + aw, r[3]]; break;
        case 'same_height': nr = [r[0], r[3] - ah, r[2], r[3]]; break;
        default: nr = [r[0], r[3] - ah, r[0] + aw, r[3]];
      }
      moved.push({key, rect: nr});
    }
  }
  const byKey = new Map([...others, anchor].map(o => [o.key, o.rect]));
  return moved.filter(m => byKey.get(m.key).some((v, i) => Math.abs(v - m.rect[i]) > 1e-6));
}

// ── flatten ─────────────────────────────────────────────────────────────────────────────────

/** Flatten form fields: each visible widget's appearance is drawn into its page and the form is removed. Returns how many widgets were drawn. */
export function flattenFields(pdf) {
  const ctx = pdf.context;
  const all = read(pdf);
  const pages = pageRefs(pdf);
  let drawn = 0;
  const byPage = new Map();
  for (const f of all) for (const w of f.widgets) if (w.page !== null && !w.hidden && f.kind !== 'signature') (byPage.get(w.page) ?? byPage.set(w.page, []).get(w.page)).push([f, w]);
  for (const [pi, list] of byPage) {
    const pd = ctx.lookup(pages[pi]);
    let ops = '';
    const xobjects = {};
    list.forEach(([f, w], i) => {
      const wd = widgetDict(ctx, w);
      const apN = get(ctx, dictAt(ctx, wd, 'AP'), 'N');
      let stream = apN, ref = wd.get(N('AP')) ? dictAt(ctx, wd, 'AP').get(N('N')) : null;
      if (apN instanceof PDFDict && !(apN instanceof PDFStream)) {
        const state = nameAt(ctx, wd, 'AS');
        ref = state ? apN.get(N(state)) : null;
        stream = ref ? res(ctx, ref) : null;
      }
      if (!(stream instanceof PDFStream || stream instanceof PDFRawStream) || !(ref instanceof PDFRef)) return;
      const bbox = numsAt(ctx, stream.dict, 'BBox') ?? [0, 0, 1, 1];
      const m = numsAt(ctx, stream.dict, 'Matrix') ?? [1, 0, 0, 1, 0, 0];
      const pt = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
      const cs = [pt(bbox[0], bbox[1]), pt(bbox[2], bbox[1]), pt(bbox[0], bbox[3]), pt(bbox[2], bbox[3])];
      const tx0 = Math.min(...cs.map(c => c[0])), tx1 = Math.max(...cs.map(c => c[0])), ty0 = Math.min(...cs.map(c => c[1])), ty1 = Math.max(...cs.map(c => c[1]));
      const [rx0, ry0, rx1, ry1] = w.rect;
      const sx = tx1 > tx0 ? (rx1 - rx0) / (tx1 - tx0) : 1, sy = ty1 > ty0 ? (ry1 - ry0) / (ty1 - ty0) : 1;
      const A = [sx, 0, 0, sy, rx0 - tx0 * sx, ry0 - ty0 * sy].map(v => Math.round(v * 10000) / 10000);
      const name = `Fl${i}`;
      xobjects[name] = ref;
      ops += `q ${A.join(' ')} cm /${name} Do Q\n`;
      drawn++;
    });
    if (!ops) continue;
    let resources = dictAt(ctx, pd, 'Resources');
    if (!resources) { resources = ctx.obj({}); pd.set(N('Resources'), resources); }
    let xo = dictAt(ctx, resources, 'XObject');
    if (!xo) { xo = ctx.obj({}); resources.set(N('XObject'), xo); }
    for (const [k, v] of Object.entries(xobjects)) xo.set(N(k), v);
    const bytes = new TextEncoder().encode(`q\n${ops}Q\n`);
    const sref = ctx.register(ctx.flateStream(bytes, {}));
    const cur = get(ctx, pd, 'Contents');
    const contents = cur instanceof PDFArray ? cur.asArray() : pd.get(N('Contents')) ? [pd.get(N('Contents'))] : [];
    pd.set(N('Contents'), ctx.obj([...contents, sref]));
  }
  // Every widget leaves its page; the form goes.
  const keys = new Set(all.flatMap(f => f.widgets.filter(w => w.page !== null && f.kind !== 'signature').map(w => w.id)));
  dropFromPages(pdf, keys);
  const afd = acroform(pdf);
  if (afd) {
    const keep = all.filter(f => f.kind === 'signature').map(f => refOfKey(f.id));
    afd.set(N('Fields'), ctx.obj(keep));
    afd.delete(N('CO'));
  }
  return drawn;
}

export {FLAG, FIELD_FONTS, BORDER_STYLES, checkStyleOf};
