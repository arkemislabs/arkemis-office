// Dialog models (docs/architecture.md sections 6.1 step 3 and 9.1): discover core/common/dialogs and
// core/<app>/dialogs, validate each model against defineDialog's contract and its file name, and
// write core/generated/<app>.dialogs.mjs.
import path from 'node:path';
import {walk, rel, GENERATED_HEADER, lit} from './util.mjs';
import {validateDialog, dialogStem} from '../../core/kernel/dialog.mjs';
import {isModuleFile, importModule, relImport} from './registry.mjs';

/** Dialog models in one dialogs/ folder: [{file, rel, id, command, module}]. */
export async function loadDialogModules(root, dir, report) {
  const out = [];
  for (const file of walk(dir, isModuleFile)) {
    const r = rel(root, file);
    if (rel(dir, file).includes('/')) { report.error(r, 'dialog models live directly in dialogs/'); continue; }
    const ns = await importModule(file, report, root);
    if (!ns) continue;
    const d = ns.default;
    const errors = validateDialog(d, {where: r});
    for (const e of errors) report.error(r, e.slice(r.length + 2));
    if (!d || errors.length) continue;
    const stem = path.basename(file, '.mjs');
    if (dialogStem(d.id) !== stem) report.error(r, `dialog id "${d.id}" belongs in ${dialogStem(d.id)}.mjs`);
    out.push({file, rel: r, id: d.id, command: d.command ?? null, module: d});
  }
  return out;
}

export function dialogsIndex(root, dialogs) {
  const list = [...dialogs.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const lines = [GENERATED_HEADER];
  list.forEach((d, i) => lines.push(`import d${i} from ${lit(relImport('core/generated', root, d.rel))};`));
  lines.push('export const dialogs = {');
  list.forEach((d, i) => lines.push(`  ${lit(d.id)}: d${i},`));
  lines.push('};');
  lines.push(`export const sources = ${JSON.stringify(Object.fromEntries(list.map(d => [d.id, d.rel])))};`, '');
  return lines.join('\n');
}
