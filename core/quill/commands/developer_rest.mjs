// Developer › Controls › Legacy Tools (U:quill/rest): the legacy form fields of Word 97-2003 forms: Text Form Field, Check Box Form Field and
// Drop-Down Form Field, and Reset Form Fields.
//
// Not checked against upstream (wordcraft reads legacy form fields from a file, crates/doc legacy_form.rs, but has no command that makes one);
// each follows Word. A legacy form field is a field (FORMTEXT, FORMCHECKBOX, FORMDROPDOWN) holding its w:ffData; the page draws a check box as
// ☐ or ☒ and a drop-down as its chosen entry, and the file keeps the field and its ffData as Word writes them. Toggle Legacy Check Box and Choose
// Legacy Drop-Down Entry change the field at the caret (Word does it by clicking in a protected form; there is no click here, the commands are the
// edit). Reset Form Fields takes every legacy field back to its default: a text field blank, a check box as its default, a drop-down its first entry.
// Not here (hidden): ActiveX controls (Windows code Quill never runs), Insert Frame and Form Field Shading.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import * as T from '../lib/table-session.mjs';
import * as P from '../model/para.mjs';
import {BODY} from '../model/document.mjs';
import {legacyFormXml, parseLegacyForm} from '../model/legacy-form.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/doc/src/legacy_form.rs']};
const failed = m => new CommandError('failed', m);
const FORM_FIELD = /^\s*FORM(TEXT|CHECKBOX|DROPDOWN)\b/i;
const BLANK = ' '.repeat(5);
const INSTR = {text: ' FORMTEXT ', checkBox: ' FORMCHECKBOX ', dropDown: ' FORMDROPDOWN '};
const NAMES = {text: 'Text', checkBox: 'Check', dropDown: 'Dropdown'};

/** Every legacy form field of the body: [{path, off, o}]. */
function legacyFields(d) {
  const out = [];
  for (const path of d.paraPaths(BODY)) {
    const p = d.para(BODY, path);
    for (const [off, o] of P.objectsWithOffsets(p)) if (o?.type === 'field' && FORM_FIELD.test(o.instr ?? '') && o.form) out.push({path, off, o});
  }
  return out;
}

function insertLegacy(ctx, p) {
  const S = T.open(ctx);
  const kind = p.kind;
  const taken = new Set(legacyFields(S.d).map(f => parseLegacyForm(f.o.form)?.name));
  let n = 1;
  while (taken.has(`${NAMES[kind]}${n}`)) n++;
  const name = p.name ?? `${NAMES[kind]}${n}`;
  const entries = kind === 'dropDown' ? (p.entries?.length ? p.entries.map(String) : ['Option 1', 'Option 2', 'Option 3']) : [];
  const form = legacyFormXml(kind, {name, entries, checked: !!p.checked, maxLen: p.maxLength ?? null});
  const field = {type: 'field', instr: INSTR[kind], result: kind === 'text' ? BLANK : '', form};
  const props = T.typingProps(S);
  const at = T.deleteSelection(S);
  const end = S.d.insertObject(at, field, props);
  T.setCaret(S, end);
  return T.finish(S, {name, kind});
}

/** The legacy form field the selection holds or touches: just before the caret, or the one the selection covers. */
function fieldAtCaret(S) {
  const [a, b] = T.ordered(S.sel);
  const all = legacyFields(S.d).filter(f => f.path.length === a.path.length && f.path.every((v, i) => v === a.path[i]));
  const hit = all.find(f => (a.off === b.off ? f.off === a.off - 1 || f.off === a.off : f.off >= a.off && f.off < b.off));
  if (!hit) throw failed('there is no legacy form field at the selection');
  return hit;
}

function setForm(S, hit, form, result) {
  const p = S.d.paraMut(BODY, hit.path);
  P.setObjectAt(p, hit.off, {...hit.o, form, ...(result !== undefined ? {result} : {})});
}

function toggleCheck(ctx, p) {
  const S = T.open(ctx);
  const hit = fieldAtCaret(S);
  const f = parseLegacyForm(hit.o.form);
  if (f?.type !== 'checkBox') throw failed('that field is not a check box');
  const on = typeof p.value === 'boolean' ? p.value : !f.checked;
  const form = hit.o.form.replace(/<w:checked\b[^>]*\/>/g, '').replace('</w:checkBox>', `${on ? '<w:checked/>' : ''}</w:checkBox>`);
  setForm(S, hit, form);
  return T.finish(S, {checked: on});
}

function chooseEntry(ctx, p) {
  const S = T.open(ctx);
  const hit = fieldAtCaret(S);
  const f = parseLegacyForm(hit.o.form);
  if (f?.type !== 'dropDown') throw failed('that field is not a drop-down');
  const i = Number.isInteger(p.index) ? p.index : f.entries.indexOf(p.value);
  if (i < 0 || i >= f.entries.length) throw new CommandError('invalid_params', 'no such entry');
  const form = hit.o.form.replace(/<w:result\b[^>]*\/>/g, '').replace(/(<w:ddList[^>]*>)/, `$1${i > 0 ? `<w:result w:val="${i}"/>` : ''}`);
  setForm(S, hit, form);
  return T.finish(S, {selected: i, entry: f.entries[i]});
}

function resetForm(ctx) {
  const S = T.open(ctx);
  const fields = legacyFields(S.d);
  if (!fields.length) throw failed('the document has no legacy form fields');
  for (const hit of fields.reverse()) {
    const f = parseLegacyForm(hit.o.form);
    if (!f) continue;
    if (f.type === 'checkBox') {
      const dflt = /<w:default\s+w:val="(1|true|on)"/i.test(hit.o.form);
      setForm(S, hit, hit.o.form.replace(/<w:checked\b[^>]*\/>/g, '').replace('</w:checkBox>', `${dflt ? '<w:checked/>' : ''}</w:checkBox>`));
    } else if (f.type === 'dropDown') setForm(S, hit, hit.o.form.replace(/<w:result\b[^>]*\/>/g, ''));
    else setForm(S, hit, hit.o.form, BLANK);
  }
  return T.finish(S, {reset: fields.length});
}

const inField = ctx => {
  const st = T.ready(ctx);
  if (!st.enabled) return st;
  try { fieldAtCaret(T.open(ctx)); return {enabled: true}; } catch { return {enabled: false, reason: 'there is no legacy form field at the selection'}; }
};

export default defineCommands({
  family: 'developer_rest',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'developer.legacyField', label: 'Legacy Form Field', risk: 'edit', state: T.ready,
      description: 'Legacy Tools (Developer › Controls): a legacy form field at the caret: `kind` text (Text Form Field, with `maxLength`), checkBox (Check Box Form Field, `checked`) or dropDown (Drop-Down Form Field, `entries`); `name` is its bookmark name (Text1, Check1, Dropdown1 by default). Not checked against upstream.',
      params: s.object({kind: s.enum(['text', 'checkBox', 'dropDown']), name: s.optional(s.string({min: 1, max: 40})), entries: s.optional(s.array(s.string({max: 255}), {max: 25})), checked: s.optional(s.boolean()), maxLength: s.optional(s.integer({min: 1, max: 255}))}),
      run: insertLegacy},
    {id: 'developer.legacyCheck', label: 'Toggle Legacy Check Box', risk: 'edit', state: inField,
      description: 'Toggle Legacy Check Box: the legacy check box at the caret is checked or cleared (`value` sets it). Not checked against upstream.',
      params: s.object({value: s.optional(s.boolean())}), run: toggleCheck},
    {id: 'developer.legacyChoose', label: 'Choose Legacy Drop-Down Entry', risk: 'edit', state: inField,
      description: 'Choose Legacy Drop-Down Entry: the legacy drop-down at the caret shows the entry `index` (0-based) or `value`. Not checked against upstream.',
      params: s.object({index: s.optional(s.integer({min: 0, max: 63})), value: s.optional(s.string({max: 255}))}), run: chooseEntry},
    {id: 'developer.resetFormFields', label: 'Reset Form Fields', risk: 'edit', state: T.ready,
      description: 'Reset Form Fields (Developer › Controls › Legacy Tools): every legacy form field back to its default: text fields blank, check boxes as their default, drop-downs on their first entry. Not checked against upstream.',
      params: s.object({}), run: resetForm},
  ],
});
