// Paste Special (Home › Clipboard › Paste ▾ › Paste Special…): paste the clipboard in a chosen
// format (Formatted Text, Rich Text Format, HTML Format, Picture, Unformatted Text).
//
// Translated from wordcraft crates/engine/src/cmd/paste.rs (`specs`, `paste_special`, `source`,
// `available`, `formats_json`) at ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c. The
// shared paste machinery (what a paste brings in, adopt, insert) is core/quill/lib/paste-content.mjs.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Without `as` the command lists the formats the clipboard can be pasted as and asks the front end
// for the Paste Special dialog (upstream push_ui_request {open: 'pasteSpecial', formats, payload}).
// A paste the person makes (origin ui / shortcut / dialog) without a payload reads the system
// clipboard through the host, as Paste does.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {open, finish, ready, pushUi, UPSTREAM_COMMIT} from '../lib/caret-session.mjs';
import {pasteText} from '../lib/text-edit.mjs';
import {MAX_PASTE_BYTES, MAX_PICTURE_BYTES, FORMATS, available, formatsJson, sourceOf, importers, ownClip, insertFragment, adopt, importHtml} from '../lib/paste-content.mjs';
import {noteEdit} from './text.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/paste.rs']};

export {FORMATS};

const userOrigin = ctx => ctx.origin === 'ui' || ctx.origin === 'shortcut' || ctx.origin === 'dialog';

/** The system clipboard's payload for a paste the person makes (the shell passes it upstream). */
async function withSystemClipboard(ctx, p) {
  if (!userOrigin(ctx) || ['text', 'html', 'rtf', 'picture'].some(k => p[k] !== undefined)) return p;
  if (typeof ctx.host?.clipboardRead !== 'function') return p;
  try {
    const got = await ctx.host.clipboardRead();
    const out = {...p};
    for (const k of ['text', 'html', 'rtf', 'picture']) if (typeof got?.[k] === 'string' && got[k]) out[k] = got[k];
    return out;
  } catch { return p; }
}

/** The format names agents and the dialog may use (paste_special's match). */
export function normalFormat(fmt) {
  const f = String(fmt).toLowerCase();
  if (f === 'formatted' || f === 'keep' || f === 'wordcraft') return 'formatted';
  if (f === 'rtf') return 'rtf';
  if (f === 'html') return 'html';
  if (f === 'picture' || f === 'png' || f === 'image') return 'picture';
  if (f === 'text' || f === 'unformatted' || f === 'plain') return 'text';
  throw new CommandError('invalid_params', `unknown format \`${fmt}\` (formatted, rtf, html, picture or text)`, {path: '/as'});
}

async function pasteSpecial(ctx, p0) {
  for (const k of ['text', 'html', 'rtf']) {
    if (typeof p0[k] === 'string' && p0[k].length > MAX_PASTE_BYTES) throw new CommandError('invalid_params', `\`${k}\` is larger than ${MAX_PASTE_BYTES >> 20} MB`, {path: `/${k}`});
  }
  if (typeof p0.picture === 'string' && p0.picture.length > MAX_PICTURE_BYTES) {
    throw new CommandError('invalid_params', `\`picture\` is larger than ${MAX_PICTURE_BYTES >> 20} MB`, {path: '/picture'});
  }
  const p = await withSystemClipboard(ctx, p0);
  const imp = await importers();
  const ids = available(ctx, p, imp);
  if (p.as === undefined) {
    // No format chosen: list them and ask the front end for the dialog.
    const S = open(ctx);
    const req = {open: 'pasteSpecial', formats: ids};
    for (const k of ['text', 'html', 'rtf', 'picture']) if (typeof p[k] === 'string') req[k] = p[k];
    pushUi(S, req);
    finish(ctx, S);
    return {formats: formatsJson(ids), ui: S.ui};
  }
  const fmt = normalFormat(p.as);
  const src = sourceOf(ctx, p, fmt, imp);
  if (src === null) {
    throw new CommandError('failed', ids.length ? `the clipboard has no ${fmt} content (available: ${ids.join(', ')})` : 'the clipboard is empty');
  }
  if (fmt === 'picture') {
    const r = await ctx.run('insert.picture', {data: src});
    return {...(r && typeof r === 'object' ? r : {}), pastedAs: fmt};
  }
  let content = null;
  if (fmt === 'html') content = await importHtml(imp, src);
  else if (fmt === 'rtf') {
    try { content = await imp.rtf(src); } catch (e) { throw new CommandError('failed', `bad RTF: ${e?.message ?? e}`); }
  }
  const S = open(ctx);
  if (fmt === 'text') {
    S.view.pendingMove = null;
    pasteText(S, src.replace(/\r\n/g, '\r').replace(/\n/g, '\r'));
  } else if (fmt === 'formatted') {
    const own = ownClip(ctx);
    if (!own) throw new CommandError('failed', 'the clipboard is empty');
    insertFragment(S, own.fragment);
  } else {
    insertFragment(S, adopt(S, content));
  }
  S.view.burstSel = null;
  noteEdit(ctx, S);
  const res = finish(ctx, S, {edit: true, result: {pastedAs: fmt}});
  ctx.setUndoLabel('Paste Special');
  return res;
}

export default defineCommands({
  family: 'paste',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'edit.pasteSpecial', label: 'Paste Special', shortcut: 'Mod+Alt+V', risk: 'edit', dialog: 'dialog.pasteSpecial',
      description: 'Paste the clipboard as Formatted Text, Rich Text Format, HTML Format, a Picture or Unformatted Text; without `as`, the formats it can be pasted as (and the Paste Special dialog).',
      params: s.object({
        as: s.optional(s.string({max: 32, description: 'formatted | rtf | html | picture | text'})),
        text: s.optional(s.string({max: 16 << 20})), html: s.optional(s.string({max: 16 << 20})), rtf: s.optional(s.string({max: 16 << 20})),
        picture: s.optional(s.string({max: 96 << 20, description: 'base64 image'})),
      }),
      state: ctx => ready(ctx),
      run: (ctx, p) => pasteSpecial(ctx, p),
    },
  ],
});
