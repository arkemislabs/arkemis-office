// Developer › Code › Macros: Word's Macros dialog: the macros kept (Quill's are lists of editing commands, kept in
// the person's settings), Run (OK) and Delete. Record Macro makes them; macros are never read from or kept in a file.
//
// Translated from wordcraft crates/engine/src/cmd/tools/actions.rs (`macros`) and the Macros list of the app's
// dialogs at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. Drawn by src/apps/quill/dialogs/macros.tsx.

import {defineDialog} from '../../kernel/dialog.mjs';
import {macrosOf} from '../commands/tools.mjs';

const listed = v => (v.macros ?? []).some(([n]) => n === String(v.name ?? '').trim());

export default defineDialog({
  id: 'dialog.macros',
  title: 'Macros',
  command: 'tools.macros',
  init(ctx) {
    const macros = Object.entries(macrosOf(ctx)).map(([n, steps]) => [n, steps.length]).sort((a, b) => a[0].localeCompare(b[0]));
    const name = macros[0]?.[0] ?? '';
    return {macros, name, list: name || null};
  },
  derive(v, changed) {
    if (changed.includes('list') && v.list) return {name: v.list};
    return {};
  },
  buttons: {
    delete: (_ctx, v) => (listed(v) ? {command: 'tools.macros', params: {delete: String(v.name).trim()}} : null),
  },
  validate: v => (listed(v) ? [] : [{field: 'name', message: 'Choose a macro to run.'}]),
  toCommand: v => ({command: 'tools.macros', params: {run: String(v.name).trim()}}),
});
