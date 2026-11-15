// Dialog text templates. A spec's titles, labels and hints come from the upstream product and keep its
// placeholders: "Unlock {name}", "{Create|Change} {signature|initials}", "Move or copy \"<section>\" into ...",
// "New Tag / Modify Tag". The dialog's model supplies what they stand for (its values, or the arguments the
// opener passed), so the person never sees a raw token:
//
//   {name}          the value `name` (or `__name`) when it is a string or a number
//   <name>          the same, in the angle-bracket form
//   {A|B}           one of the words: the one whose own name is a true value (`initials: true` picks "initials"),
//                   else the second when the dialog is editing something that exists (`editing`, `update`,
//                   `modify`, `__replace`, `mode: 'modify'`), else the first
//   "New A / Modify B"  a title with two halves picks the second half in the same editing case
//
// A token with no value is dropped with the connecting word before it, never shown. Pure: no DOM, no React.

import type {SpecField} from '../../generated/spec-types';

type Source = Record<string, unknown>;

const NAMED = /\{([^{}|]+)\}|<([A-Za-z][A-Za-z ]*)>/g;
const ALTERNATION = /\{([^{}]+\|[^{}]+)\}/g;
const ANY_TOKEN = /\{[^{}]+\}|<[A-Za-z][A-Za-z ]*>/;

export const hasTokens = (text: string): boolean => ANY_TOKEN.test(text);

const camel = (s: string) => s.trim().replace(/[-_ ]+([a-z0-9])/gi, (_, c: string) => c.toUpperCase()).replace(/^[A-Z]/, c => c.toLowerCase());
const scalar = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);

/** Whether the dialog is changing something that already exists (the second word of a "Create / Change" pair). */
export function isEditing(src: Source): boolean {
  return src.editing === true || src.update === true || src.modify === true || src.existing === true || src.replace === true || src.__replace === true
    || src.__editing === true || src.mode === 'modify' || src.mode === 'edit' || src.mode === 'update';
}

function lookup(src: Source, name: string): string | null {
  const n = name.trim();
  for (const k of [n, `__${n}`, camel(n), `__${camel(n)}`]) { const v = scalar(src[k]); if (v !== null) return v; }
  return null;
}

function pickWord(words: string[], src: Source): string {
  for (const w of words) { const k = camel(w); if (src[k] === true || src[`__${k}`] === true) return w; }
  return isEditing(src) && words.length > 1 ? words[1] : words[0];
}

/** Fill a template from the values; `complete` is false when some token had nothing to stand for. */
export function fillTemplate(text: string, src: Source): {text: string; complete: boolean} {
  let complete = true;
  let out = String(text ?? '').replace(ALTERNATION, (_, body: string) => pickWord(body.split('|').map(s => s.trim()), src));
  out = out.replace(NAMED, (m, a?: string, b?: string) => {
    const v = lookup(src, a ?? b ?? '');
    if (v === null) { complete = false; return m; }
    return v;
  });
  return {text: out, complete};
}

/** A template with the tokens that had no value removed, and the word that joined each ("pages of {name}" -> "pages"). */
export function stripTokens(text: string): string {
  return String(text ?? '')
    .replace(/\s*\b(?:of|for|from|on|in|at|per|to|by)\s+(?:\{[^{}]+\}|<[A-Za-z][A-Za-z ]*>)/gi, '')
    .replace(/\s*(?:\{[^{}]+\}|<[A-Za-z][A-Za-z ]*>)/g, '')
    .replace(/\(\s*[,;]?\s*\)/g, '').replace(/\(\s*,\s*/g, '(').replace(/,\s*\)/g, ')').replace(/\s{2,}/g, ' ').replace(/\s+([:.,;?!])/g, '$1').trim();
}

/** The template's text for display: filled when it can be, else with the tokens it cannot fill taken out. */
export function resolveText(text: string | undefined | null, src: Source): string {
  const raw = String(text ?? '');
  if (!raw || !(raw.includes('{') || raw.includes('<'))) return raw;
  const f = fillTemplate(raw, src);
  return f.complete ? f.text : stripTokens(f.text);
}

/** The source a dialog's templates read: what the opener passed, then the dialog's own values. */
export const templateSource = (d: {values: Source; args?: Source | null}): Source => ({...(d.args ?? {}), ...d.values});

/**
 * A dialog's title. The model's `titleFor(values)` wins (and a model that sets `__title`), then the spec's
 * title filled from the values, then the model's own title when the spec's cannot be filled, then the spec's
 * title with its tokens taken out. A "A / B" title picks a half the same way.
 */
export function dialogTitle(d: {spec: {title: string}; values: Source; args?: Source | null}, model?: {title?: string; titleFor?: (v: Source) => string} | null): string {
  const src = templateSource(d);
  if (typeof d.values.__title === 'string' && d.values.__title) return d.values.__title;
  if (typeof model?.titleFor === 'function') { try { const t = model.titleFor(d.values); if (typeof t === 'string' && t) return t; } catch { /* fall through to the spec's title */ } }
  let spec = String(d.spec.title ?? '');
  const halves = spec.split(/\s+\/\s+/);
  if (halves.length === 2 && model?.title && !hasTokens(model.title)) return model.title;
  if (halves.length === 2) spec = isEditing(src) ? halves[1] : halves[0];
  const f = fillTemplate(spec, src);
  if (f.complete) return f.text;
  if (model?.title && !hasTokens(model.title)) return model.title;
  return stripTokens(f.text);
}

const SKIP_KEYS = new Set(['id', 'kind', 'options', 'dialog', 'command', 'param', 'visibleWhen', 'input', 'accept', 'default']);

/** A field with its label, hint and note filled from the dialog's values. */
export function resolveField(f: SpecField, src: Source): SpecField {
  let changed = false;
  const out: SpecField = {...f};
  for (const k of ['label', 'hint', 'note'] as const) {
    const v = f[k];
    if (typeof v !== 'string' || SKIP_KEYS.has(k) || !(v.includes('{') || v.includes('<'))) continue;
    const next = resolveText(v, src);
    if (next !== v) { (out as Record<string, unknown>)[k] = next; changed = true; }
  }
  return changed ? out : f;
}

/** A button's label: the spec's, else the word its role stands for, else its id. Never blank. */
export function buttonLabel(b: {id: string; label?: string | null; role?: string}): string {
  const l = String(b.label ?? '').trim();
  if (l) return l;
  const byRole: Record<string, string> = {ok: 'OK', cancel: 'Cancel', apply: 'Apply', help: 'Help'};
  return byRole[b.role ?? ''] ?? (b.id ? b.id.replace(/[-_.]+/g, ' ').replace(/^./, c => c.toUpperCase()) : 'OK');
}
