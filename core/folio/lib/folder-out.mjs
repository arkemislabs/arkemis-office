// Writing a set of files for a command that makes several (exported images, separate PDFs).
//
// From the window the person is asked for a folder in the system folder dialog (host files.pickFolder) and each file goes in through
// files.writeInFolder, which writes only inside that folder and only under a plain name (electron/folder-files.cjs); a taken name is numbered.
// A program (the bridge, tests) writes nothing: the files come back as base64 for it to keep. No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {interactive} from './page-files.mjs';
import {base64} from './page-source.mjs';

export const hasFolderWriter = ctx => typeof ctx.host?.files?.pickFolder === 'function' && typeof ctx.host?.files?.writeInFolder === 'function';

/** Control state for a command whose window path writes into a folder. */
export function folderState(ctx) {
  if (ctx.origin && (ctx.origin === 'ui' || ctx.origin === 'shortcut' || ctx.origin === 'dialog') && ctx.host?.kind === 'renderer' && !hasFolderWriter(ctx)) return {enabled: false, reason: "this build can't write into a folder yet"};
  return {enabled: true};
}

/** A file name safe to write under: no separators, reserved characters or leading dots. */
export const plainName = name => String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '') || 'file';

/**
 * @param {{name: string, bytes: Uint8Array}[]} files
 * @returns {Promise<{written: string[], folder?: string, files?: {name: string, base64: string}[], canceled?: boolean}>}
 */
export async function writeSet(ctx, files, {title = 'Choose a folder'} = {}) {
  const f = ctx.host?.files;
  if (interactive(ctx) && hasFolderWriter(ctx)) {
    const folder = await f.pickFolder({kind: ctx.app, title});
    if (!folder) return {written: [], canceled: true};
    const written = [];
    for (const file of files) written.push((await f.writeInFolder(ctx.docId, {folder: folder.folder, name: plainName(file.name), base64: base64(file.bytes)})).name);
    return {written, folder: folder.name};
  }
  if (interactive(ctx)) throw new CommandError('unavailable', 'The folder dialog is not available here');
  return {written: files.map(x => plainName(x.name)), files: files.map(x => ({name: plainName(x.name), base64: base64(x.bytes)}))};
}
