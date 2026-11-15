// The working copy of Field Properties and what OK changes: the draft a field is opened as and the
// `props` of form.field.properties that turn the original into the edited draft (only what changed).
//
// Translated from printcraft crates/ui-egui/src/tools/prepare/draft.rs (FieldDraft, FieldTab, tabs by
// kind, ACTION_KINDS, ActionDraft::action), prepare/properties.rs (the Options tab per kind, Comb
// forcing a limit, Locked greying the tabs) and tools/bulk_fields.rs (shared properties: only the
// properties changed apply) at 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {FLAG} from './form-read.mjs';
import {CHECK_STYLES} from './form-appearance.mjs';

export const ACTION_KINDS = Object.freeze(['Run a JavaScript', 'Open a web link', 'Reset a form', 'Execute a menu item', 'Go to a page view', 'Show a field', 'Hide a field', 'Submit a form']);
export const ACTION_TRIGGERS = Object.freeze([['mouse_up', 'Mouse Up'], ['mouse_down', 'Mouse Down'], ['mouse_enter', 'Mouse Enter'], ['mouse_exit', 'Mouse Exit'], ['on_focus', 'On Focus'], ['on_blur', 'On Blur']]);
export const THICKNESS = Object.freeze([['Thin', 1], ['Medium', 2], ['Thick', 3]]);
export const BORDER_STYLES = Object.freeze(['Solid', 'Dashed', 'Beveled', 'Inset', 'Underline']);
export const STYLE_CODES = Object.freeze({S: 'Solid', D: 'Dashed', B: 'Beveled', I: 'Inset', U: 'Underline'});
export const FONTS = Object.freeze(['Helvetica', 'Times Roman', 'Courier']);
export const FONT_OF_RESOURCE = Object.freeze({Helv: 'Helvetica', TiRo: 'Times Roman', Cour: 'Courier'});
export const SEPARATORS = Object.freeze(['1,234.56', '1234.56', '1.234,56', '1234,56', "1'234.56"]);
export const NEGATIVES = Object.freeze(['-1,234.01', '1,234.01 (red)', '(1,234.01)', '(1,234.01) (red)']);
export const SPECIALS = Object.freeze(['Zip Code', 'Zip Code + 4', 'Phone Number', 'Social Security Number', 'Arbitrary Mask']);
export const CURRENCIES = Object.freeze(['', '$', '€', '£', '¥', 'CHF ']);
export const CHECK_STYLE_NAMES = Object.freeze(CHECK_STYLES.map(([n]) => n));
export const KIND_TITLES = Object.freeze({text: 'Text Field', checkbox: 'Check Box', radio: 'Radio Button', pushbutton: 'Button', combo: 'Drop-down', list: 'List Box', signature: 'Digital Signature'});

/** FieldDraft::tabs: General, Appearance and Position always; Options for most; Format/Validate/Calculate for text and drop-down; Actions always. */
export function tabsFor(kind) {
  const tabs = ['General', 'Appearance', 'Position'];
  if (kind !== 'signature') tabs.push('Options');
  if (kind === 'text' || kind === 'combo') tabs.push('Format', 'Validate', 'Calculate');
  tabs.push('Actions');
  return tabs;
}

const hex = c => (Array.isArray(c) ? `#${c.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}` : null);
export const rgbOfHex = h => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h ?? '')); return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255) : null; };

/** The draft a field is opened as. `others`: the other fields' names (the Calculate tab's choices). */
export function draftOf(f, widget = 0, others = []) {
  const w = f.widgets[widget] ?? f.widgets[0];
  const look = w?.look ?? {border: [0, 0, 0], fill: null, width: 1, style: 'S', text: [0, 0, 0], font: 'Helv', size: 0};
  const maxLen = f.maxLen ?? 0;
  const draft = {
    field: f.name, widget, kind: f.kind, __title: `${KIND_TITLES[f.kind] ?? 'Field'} Properties`, tabs: tabsFor(f.kind), others,
    name: f.name, tooltip: f.tooltip ?? '', caption: w?.caption ?? '', flags: f.flags >>> 0, locked: f.widgets.some(x => x.locked),
    limit: maxLen > 0, maxLen: maxLen > 0 ? maxLen : (f.flags & FLAG.COMB ? 10 : 0), options: f.options.map(o => o[1]), optionValues: f.options.map(o => o[0]),
    quadding: f.quadding ?? 0, defaultValue: f.kind === 'checkbox' || f.kind === 'radio' ? (f.defaultValue[0] && f.defaultValue[0] === w?.onState ? w.onState : '') : f.defaultValue[0] ?? '',
    onState: w?.onState ?? '', fontSize: look.size ?? 0, position: w ? [w.rect[0], w.rect[1], w.rect[2] - w.rect[0], w.rect[3] - w.rect[1]].map(v => Math.round(v * 100) / 100) : [0, 0, 0, 0],
    rotation: w?.rotation ?? 0,
    look: {border: look.border, fill: look.fill, width: look.width ?? 1, style: STYLE_CODES[look.style] ?? 'Solid', text: look.text ?? [0, 0, 0], font: FONT_OF_RESOURCE[look.font] ?? 'Helvetica'},
    checkStyle: f.checkStyle ?? 'Check', format: f.actions.format, validate: f.actions.validate, calculate: f.actions.calculate,
    actions: (f.triggers ?? []).map(([t, a]) => [t, a]), newOption: '', unsupported: f.actions.unsupported ?? [],
  };
  return draft;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** ActionDraft::action: the action a trigger/kind/text entry makes, or {error}. */
export function actionOf(kind, text) {
  const t = String(text ?? '').trim();
  const names = () => t.split(',').map(x => x.trim()).filter(Boolean);
  switch (kind) {
    case 0: return {action: {kind: 'javascript', script: String(text ?? '')}};
    case 1: return t ? {action: {kind: 'uri', uri: t}} : {error: 'Enter a URL'};
    case 2: return {action: {kind: 'reset', fields: names()}};
    case 3: return {action: {kind: 'named', name: t || 'Print'}};
    case 4: { const n = Number(t); return Number.isInteger(n) && n >= 1 ? {action: {kind: 'goto', page: n - 1}} : {error: 'Enter a page number'}; }
    case 5: return t ? {action: {kind: 'showhide', fields: names(), hide: false}} : {error: 'Enter the field names'};
    case 6: return t ? {action: {kind: 'showhide', fields: names(), hide: true}} : {error: 'Enter the field names'};
    default: return t ? {action: {kind: 'submit', url: t}} : {error: 'Enter a URL'};
  }
}

/** How the Actions tab lists an action (FieldAction::describe). */
export function describeAction(a) {
  switch (a.kind) {
    case 'javascript': return 'Run a JavaScript';
    case 'uri': return `Open a web link: ${a.uri}`;
    case 'reset': return a.fields?.length ? `Reset a form: ${a.fields.join(', ')}` : 'Reset a form';
    case 'named': return `Execute a menu item: ${a.name}`;
    case 'goto': return `Go to a page view: page ${a.page + 1}`;
    case 'showhide': return `${a.hide ? 'Hide' : 'Show'} a field: ${a.fields.join(', ')}`;
    case 'submit': return `Submit a form: ${a.url}`;
    default: return a.name ?? 'Action';
  }
}

/** The kind index and text an action is edited as (Actions ▸ Edit). */
export function editableAction(a) {
  switch (a.kind) {
    case 'javascript': return [0, a.script];
    case 'uri': return [1, a.uri];
    case 'reset': return [2, a.fields.join(', ')];
    case 'named': return [3, a.name];
    case 'goto': return [4, String(a.page + 1)];
    case 'showhide': return [a.hide ? 6 : 5, a.fields.join(', ')];
    case 'submit': return [7, a.url];
    default: return [0, ''];
  }
}

/** Problems that keep OK from applying: [{field, message}]. */
export function problemsOf(d, original) {
  const out = [];
  if (!String(d.name).trim()) out.push({field: 'name', message: "Field names can't be empty"});
  if (d.kind === 'text' && d.flags & FLAG.COMB && !(d.maxLen > 0)) out.push({field: 'comb', message: 'A comb of characters needs a character limit'});
  if ((d.kind === 'combo' || d.kind === 'list') && !d.options.length && original) out.push({field: 'items', message: 'A list needs at least one option'});
  if (d.position[2] < 4 || d.position[3] < 4) out.push({field: 'width', message: 'The field is too small'});
  if (d.validate?.kind === 'range' && d.validate.min !== null && d.validate.max !== null && d.validate.min > d.validate.max) out.push({field: 'from', message: 'From must not be more than To'});
  return out;
}

/** The `props` of form.field.properties that turn `o` (the original draft) into `d`; {} when nothing changed. */
export function propsOf(d, o) {
  const p = {};
  const locked = o.locked && d.locked;
  if (locked) return {};
  if (d.name.trim() !== o.name) p.name = d.name.trim();
  if (d.tooltip !== o.tooltip) p.tooltip = d.tooltip;
  const flags = [];
  for (let bit = 0; bit < 31; bit++) { const m = 1 << bit; if ((d.flags & m) !== (o.flags & m)) flags.push([m, (d.flags & m) !== 0]); }
  if (flags.length) p.flags = flags;
  const limitChanged = d.limit !== o.limit || (d.limit && d.maxLen !== o.maxLen) || ((d.flags & FLAG.COMB) !== (o.flags & FLAG.COMB));
  if ((d.kind === 'text') && limitChanged) p.maxLen = d.limit || d.flags & FLAG.COMB ? Math.max(1, Math.round(d.maxLen)) : null;
  if (d.quadding !== o.quadding) p.quadding = d.quadding;
  if (d.defaultValue !== o.defaultValue) p.defaultValue = d.defaultValue === '' ? null : d.defaultValue;
  if ((d.kind === 'combo' || d.kind === 'list') && !same(d.options, o.options)) p.options = d.options;
  if (d.kind === 'pushbutton' && d.caption !== o.caption) p.caption = [d.widget, d.caption];
  if (d.fontSize !== o.fontSize) p.fontSize = d.fontSize;
  const a = {};
  const lk = d.look, ol = o.look;
  if (!same(lk.border, ol.border)) a.border = lk.border;
  if (!same(lk.fill, ol.fill)) a.fill = lk.fill;
  if (lk.width !== ol.width) a.width = lk.width;
  if (lk.style !== ol.style) a.style = lk.style;
  if (!same(lk.text, ol.text)) a.text = lk.text;
  if (lk.font !== ol.font) a.font = lk.font;
  if (Object.keys(a).length) p.appearance = a;
  if (!same(d.position, o.position)) { const [x, y, w, h] = d.position; p.userRect = [d.widget, [x, y, x + w, y + h]]; }
  if (d.rotation !== o.rotation) p.rotation = [d.widget, d.rotation];
  if (d.checkStyle !== o.checkStyle) p.checkStyle = d.checkStyle;
  if (!same(d.format, o.format)) p.format = d.format;
  if (!same(d.validate, o.validate)) p.validate = d.validate;
  if (!same(d.calculate, o.calculate)) p.calculate = d.calculate;
  if (!same(d.actions, o.actions)) p.actions = d.actions.map(([t, act]) => [t, act]);
  if (d.locked !== o.locked) p.locked = d.locked;
  return p;
}

// ── shared properties (bulk_fields.rs) ──────────────────────────────────────────────────────

const triState = (fields, test) => { const yes = fields.filter(test).length; return yes === 0 ? 'No' : yes === fields.length ? 'Yes' : 'Mixed'; };
const commonOf = (list, eq = same) => (list.length && list.every(x => eq(x, list[0])) ? list[0] : undefined);

/** The values Shared Field Properties opens with (a property the fields do not agree on is Mixed / empty). */
export function bulkInit(fields) {
  const first = fields.map(f => f.widgets[0]?.look);
  return {
    names: fields.map(f => f.name), count: `${fields.length} fields selected`,
    tooltip: commonOf(fields.map(f => f.tooltip ?? '')) ?? '',
    'read-only': triState(fields, f => f.flags & FLAG.READ_ONLY), required: triState(fields, f => f.flags & FLAG.REQUIRED), locked: triState(fields, f => f.widgets.some(w => w.locked)),
    'font-size': commonOf(first.map(l => l?.size ?? 0)) ?? null,
    'text-color': hex(commonOf(first.map(l => l?.text ?? [0, 0, 0]))) ?? null,
    border: hex(commonOf(first.map(l => l?.border ?? null))) ?? null, fill: hex(commonOf(first.map(l => l?.fill ?? null))) ?? null,
    limit: commonOf(fields.map(f => f.maxLen ?? 0)) ?? null, comb: commonOf(fields.map(f => (f.flags & FLAG.COMB) !== 0)) ?? null,
  };
}

/** Only what the person changed applies: the shared `props` for form.field.properties (names). */
export function bulkProps(v, original) {
  const p = {};
  if (v.tooltip !== original.tooltip) p.tooltip = v.tooltip;
  if (v['read-only'] !== original['read-only'] && v['read-only'] !== 'Mixed') p.readOnly = v['read-only'] === 'Yes';
  if (v.required !== original.required && v.required !== 'Mixed') p.required = v.required === 'Yes';
  if (v.locked !== original.locked && v.locked !== 'Mixed') p.locked = v.locked === 'Yes';
  if (v['font-size'] !== original['font-size'] && v['font-size'] !== null) p.fontSize = Math.max(0, Number(v['font-size']) || 0);
  const a = {};
  if (v['text-color'] !== original['text-color'] && rgbOfHex(v['text-color'])) a.text = rgbOfHex(v['text-color']);
  if (v.border !== original.border) a.border = rgbOfHex(v.border);
  if (v.fill !== original.fill) a.fill = rgbOfHex(v.fill);
  if (Object.keys(a).length) p.appearance = a;
  if (v.limit !== original.limit && v.limit !== null) p.maxLen = Number(v.limit) > 0 ? Math.round(Number(v.limit)) : null;
  if (v.comb !== original.comb && v.comb !== null) p.flags = [[FLAG.COMB, !!v.comb]];
  return p;
}

export {hex};
