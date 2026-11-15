// Insert › Text › Quick Parts › Building Blocks Organizer…: Word's Building Blocks Organizer: a table of the building blocks kept
// (the person's and the document's) with the columns Name, Gallery, Category and Template that sorts by a column heading, a
// preview of the selected block with its name and description under it, and the buttons Edit Properties…, Delete and Insert.
//
// Over wordcraft's quick_parts (tools/actions.rs); the Organizer's box is Word's. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Drawn by src/apps/quill/dialogs/buildingBlocks.tsx.

import {defineDialog} from '../../kernel/dialog.mjs';
import {blockRows, AUTO_TEXT_GALLERY} from '../commands/blocks.mjs';

export const COLUMNS = Object.freeze([['name', 'Name'], ['gallery', 'Gallery'], ['category', 'Category'], ['template', 'Template']]);

/** Every building block as a row {name, gallery, category, description, where, template, text}, in the order of `sort` (a column key). */
export function allBlocks(ctx, sort = 'name', desc = false) {
  return orderRows(blockRows(ctx), sort, desc);
}
const pick = v => (v.blocks ?? []).find(r => r.name === String(v.name ?? '').trim()) ?? null;
const commandOf = row => (row.gallery === AUTO_TEXT_GALLERY ? 'insert.autoText' : 'insert.quickParts');

export default defineDialog({
  id: 'dialog.buildingBlocks',
  title: 'Building Blocks Organizer',
  command: 'insert.quickParts',
  init(ctx) {
    const blocks = allBlocks(ctx);
    return {blocks, name: blocks[0]?.name ?? '', list: blocks[0]?.name ?? null, sort: 'name', desc: false};
  },
  derive(v, changed) {
    if (changed.includes('list') && v.list) return {name: v.list};
    return {};
  },
  buttons: {
    delete: (_ctx, v) => { const r = pick(v); return r ? {command: commandOf(r), params: {delete: r.name, ...(r.where === 'Document' ? {in: 'document'} : {})}} : null; },
  },
  validate: v => (pick(v) ? [] : [{field: 'name', message: 'Choose a building block.'}]),
  toCommand(v) { const r = pick(v); return {command: commandOf(r), params: {insert: r.name}}; },
});

/** The rows in the order of the column `sort` (descending with `desc`). */
export function orderRows(rows, sort, desc) {
  const key = COLUMNS.some(([k]) => k === sort) ? sort : 'name';
  const out = [...(rows ?? [])].sort((a, b) => String(a[key]).localeCompare(String(b[key])) || a.name.localeCompare(b.name));
  return desc ? out.reverse() : out;
}
