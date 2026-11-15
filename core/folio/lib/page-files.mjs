// Files other than the open document, for Organize (Insert from File, Replace Pages, Extract,
// Split) and Export: the system Open/Save dialogs and reading/writing bytes.
//
// printcraft crates/ui-egui/src/workflows/files.rs (pick_files, use_paths, write_files_then:
// plain file names only, atomic writes) at 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see
// assets/third-party-licenses/artcraft-reference.txt). The host side is the FileService of
// core/kernel/host.d.mts plus `readFile`/`writeFile`/typed pickers asked of the integrator in
// design note U-folio-edit-organize--integrator--file-bytes-and-ocr-host; everything here
// feature-detects them. Programmatic calls (bridge) never open dialogs: they pass `path` or the
// bytes as `base64`. No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {base64} from './page-source.mjs';

export const MAX_READ = 30_000_000;

/** A person at the window (ribbon, shortcut, dialog): the system dialogs may open. */
export const interactive = ctx => ctx.origin === 'ui' || ctx.origin === 'shortcut' || ctx.origin === 'dialog';
const files = ctx => ctx.host?.files ?? null;

/** Whether the host can read a file the person picks (the UI path of Insert from File / Replace). */
export const canReadFiles = ctx => typeof files(ctx)?.readFile === 'function' && typeof files(ctx)?.pickOpen === 'function';
/** Whether the host can write bytes to a path the person picks (Extract, Split, Export). */
export const canWriteFiles = ctx => typeof files(ctx)?.writeFile === 'function' && (typeof files(ctx)?.pickDataSave === 'function' || typeof files(ctx)?.pickSave === 'function');

// Programmatic calls (bridge, tests) pass bytes and get bytes back, so only the person's path (the
// ribbon, shortcuts, dialogs; a state asked without an origin is the ribbon's) needs the host.
const programmatic = ctx => !!ctx.origin && !interactive(ctx);
/** ControlState for a command whose UI path reads another file. */
export function readState(ctx) {
  if (!programmatic(ctx) && ctx.host?.kind === 'renderer' && !canReadFiles(ctx)) return {enabled: false, reason: "this build can't read other files yet"};
  return {enabled: true};
}
/** ControlState for a command whose UI path writes a file. */
export function writeState(ctx) {
  if (!programmatic(ctx) && ctx.host?.kind === 'renderer' && !canWriteFiles(ctx)) return {enabled: false, reason: "this build can't write other files yet"};
  return {enabled: true};
}

const decode = b64 => {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4) throw new CommandError('invalid_params', 'base64 is not valid base64', {path: '/base64'});
  const s = globalThis.atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};
export const baseName = p => String(p ?? '').split(/[\\/]/).pop() ?? '';
export const stem = p => baseName(p).replace(/\.[^.]*$/, '');

/**
 * The bytes of another file: `p.base64` (bridge), `p.path` read by the host, or — interactively —
 * a file the person picks in the system Open dialog. Null when the dialog is cancelled.
 * @returns {Promise<{name: string, bytes: Uint8Array, path: string|null}|null>}
 */
export async function readOther(ctx, p, {title = 'Open', filters = [{name: 'Adobe PDF Files', extensions: ['pdf']}]} = {}) {
  if (typeof p.base64 === 'string') {
    const bytes = decode(p.base64);
    if (bytes.length > MAX_READ) throw new CommandError('too_large', 'Files over 30 MB cannot be read', {path: '/base64'});
    return {name: p.name ?? 'Untitled.pdf', bytes, path: null};
  }
  const f = files(ctx);
  let path = p.path ?? null;
  if (!path) {
    if (!interactive(ctx)) throw new CommandError('invalid_params', 'path or base64 is required: programmatic calls never open the Open dialog', {path: '/path'});
    if (typeof f?.pickOpen !== 'function') throw new CommandError('unavailable', 'The Open dialog is not available here');
    path = await f.pickOpen({kind: ctx.app, doc: ctx.docId, title, filters});
    if (Array.isArray(path)) path = path[0];
    if (!path) return null;
  }
  if (typeof f?.readFile !== 'function') throw new CommandError('unavailable', "this build can't read other files yet");
  const r = await f.readFile(path, {maxBytes: MAX_READ});
  return {name: r?.name ?? baseName(path), bytes: decode(r.base64), path};
}

/**
 * Write `bytes` to `p.path` or, interactively, to a path chosen in the system Save dialog.
 * Without a path or a host writer (bridge, tests) the bytes come back as base64.
 * @returns {Promise<{path: string|null, base64?: string, canceled?: boolean}>}
 */
export async function writeOther(ctx, p, bytes, {title = 'Save As', name = 'Untitled.pdf', filters = [{name: 'Adobe PDF Files', extensions: ['pdf']}]} = {}) {
  const f = files(ctx);
  let path = p.path ?? null;
  if (!path && interactive(ctx)) {
    if (typeof f?.pickDataSave !== 'function' && typeof f?.pickSave !== 'function') throw new CommandError('unavailable', 'The Save dialog is not available here');
    // The Save dialog with this file's own types (a host that has one); else the document Save dialog.
    const ask = typeof f?.pickDataSave === 'function' ? f.pickDataSave : f?.pickSave;
    const picked = await ask.call(f, {kind: ctx.app, doc: ctx.docId, mode: 'copy', title, name, filters, format: filters[0]?.extensions?.[0]});
    if (!picked?.path) return {path: null, canceled: true};
    path = picked.path;
    if (!/\.[A-Za-z0-9]+$/.test(baseName(path))) path += `.${filters[0].extensions[0]}`;
  }
  if (!path) return {path: null, base64: base64(bytes)};
  if (typeof f?.writeFile !== 'function') throw new CommandError('unavailable', "this build can't write other files yet");
  const r = await f.writeFile(ctx.docId, {path, base64: base64(bytes)});
  return {path: r?.path ?? path};
}

/**
 * workflows/files.rs `is_plain_file_name`: a name with no folder part, no reserved characters,
 * not empty, not only dots.
 */
export function isPlainFileName(name) {
  const s = String(name ?? '');
  if (!s.trim() || /^\.+$/.test(s) || s.length > 255) return false;
  return !/[\\/:*?"<>|\u0000-\u001f]/.test(s);
}

/** files.rs `file_stem_from_user`: a typed name without its .pdf and surrounding spaces. */
export const fileStemFromUser = s => String(s ?? '').trim().replace(/\.pdf$/i, '').trim();
