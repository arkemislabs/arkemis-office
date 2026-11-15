// Finding the object a Format tab command acts on and changing it in one undoable step: the selected chart, picture or
// shape (or `kind` and `id`), and the objects picked together (Ctrl+click, a group), `view.objectPick`.
// In the shape of gridcraft's object commands (insert/objects.mjs `targetObject`); not in gridcraft otherwise.
// No DOM, no Node built-ins.

import {hasDoc, gridSel, requireSchema2} from './edit-targets.mjs';
import {bad, baseDoc, failed} from './data-common.mjs';
import {findObject, listName, selectedObject, OBJECT_KINDS} from './objects.mjs';

export const PROTECTED = 'The cell or chart you are trying to change is on a protected sheet. To make a change, unprotect the sheet.';
export const protectedSheet = sheet => !!sheet?.protection?.enabled && !sheet.protection.objects;
export const KINDS = ['chart', 'image', 'shape'];
const label = k => (k === 'image' ? 'a picture' : `a ${k}`);

/** The object `kind`/`id` name, else the selected one, among `kinds`: {content, si, sheet, kind, list, index, object}. */
export function pick(ctx, p, cmd, kinds = KINDS) {
  const content = baseDoc(ctx);
  const picked = selectedObject(content, ctx.selection);
  const si = picked ? picked.si : gridSel(ctx).sheet;
  requireSchema2(ctx, si);
  const sheet = content.sheets[si];
  const kind = p.kind ?? picked?.kind;
  const id = Number.isInteger(p.id) ? p.id : picked && picked.kind === kind ? picked.id : undefined;
  if (!OBJECT_KINDS[kind] || !kinds.includes(kind) || kind === 'slicer') throw bad(cmd, `select ${kinds.map(label).join(' or ')} first`);
  if (!Number.isInteger(id)) throw bad(cmd, 'missing `id`');
  const hit = findObject(sheet, kind, id);
  if (!hit) throw bad(cmd, 'no such object');
  if (kind === 'shape' && hit.object.kind === 'ink') throw bad(cmd, 'ink has no fill or outline to change (turn it into a shape first)');
  if (protectedSheet(sheet)) throw failed(PROTECTED);
  return {content, si, sheet, kind, list: listName(kind), ...hit};
}

/** Replace the object with a changed copy. */
export const put = (ctx, t, next) => ctx.change.set(['sheets', t.si, t.list, t.index], next);

/** The selected object (any of `kinds`) with its sheet index, or null. */
export function selectedOf(ctx, kinds = KINDS) {
  const picked = selectedObject(ctx.doc, ctx.selection);
  if (!picked || !kinds.includes(picked.kind)) return null;
  const hit = findObject(ctx.doc.sheets[picked.si], picked.kind, picked.id);
  return hit ? {...picked, object: hit.object} : null;
}

/** The state of a command that needs a selected object of `kinds` (`what`: "a picture"). */
export const needs = (kinds, what) => ctx => {
  const st = hasDoc(ctx);
  if (!st.enabled) return st;
  return selectedOf(ctx, kinds) ? {enabled: true} : {enabled: false, reason: `select ${what} first`};
};

/**
 * The objects a command acts on together: the picked ones (Ctrl+click, a group) when two or more, else `ids`/`kind`, else the one
 * selected object. [{kind, id}...] on the active sheet.
 */
export function pickedObjects(ctx, p = {}) {
  const content = baseDoc(ctx);
  const si = gridSel(ctx).sheet;
  const sheet = content.sheets[si];
  const out = [];
  const add = (kind, id) => { if (OBJECT_KINDS[kind] && kind !== 'slicer' && findObject(sheet, kind, id) && !out.some(o => o.kind === kind && o.id === id)) out.push({kind, id}); };
  if (Array.isArray(p.ids) && p.ids.length) for (const x of p.ids) { if (typeof x === 'number') add(p.kind ?? 'shape', x); else if (x && typeof x === 'object') add(x.kind, x.id); }
  else {
    for (const o of ctx.view?.objectPick ?? []) add(o.kind, o.id);
    const sel = selectedObject(content, ctx.selection);
    if (sel && sel.si === si) add(sel.kind, sel.id);
  }
  return {si, sheet, objects: out};
}
