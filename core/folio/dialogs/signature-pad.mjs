// Create / Change signature or initials (the signature pad): Type, Draw or Image.
//
// Translated from printcraft crates/ui-egui/src/tools/fill_sign.rs (signature_pad, SigDraft::new
// (initials from the author's name), from_saved, ready, saved, undo_stroke, pad_buttons) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Not translated: the Scan tab (a photo of a signature on paper cleaned into an image:
// signature_scan.rs); its fields stay hidden (src/apps/folio/dialogs/signature-pad.tsx draws the
// Type, Draw and Image tabs).

import {defineDialog} from '../../kernel/dialog.mjs';
import {initialsOf, savedSig} from '../lib/sign-fill.mjs';
import {MAX_SIGNATURE_CHARS, scriptMissing} from '../lib/sign-script.mjs';

/** The values with the draft of the kind being made filled in where the person changed nothing. */
export function resolved(v) {
  const d = v.drafts?.[v.initials ? 'initials' : 'signature'] ?? {};
  return {...v, what: v.initials ? 'initials' : 'signature', mode: v.mode ?? d.mode ?? 'type', typed: v.typed ?? d.typed ?? '',
    strokes: v.strokes ?? d.strokes ?? [], image: v.image ?? d.image ?? null};
}

/** "Create signature", "Change initials": Change when a saved one is being edited. */
export const titleOf = v => `${v.drafts?.[v.initials ? 'initials' : 'signature']?.editing ? 'Change' : 'Create'} ${v.initials ? 'initials' : 'signature'}`;

const nameOf = ctx => String(ctx.prefs?.identity?.name ?? ctx.prefs?.author ?? '');

export default defineDialog({
  id: 'dialog.signature-pad',
  title: 'Create signature',
  titleFor: titleOf,
  command: 'sign.fill.signature.change',
  // The shell merges the opener's {initials: true} over these values (ShellController.openDialog),
  // so both drafts are prepared: SigDraft::new / from_saved for the signature and for initials.
  init(ctx, args) {
    const draft = initials => {
      const saved = savedSig(ctx.prefs?.fillSign?.[initials ? 'initials' : 'signature']);
      return {editing: !!saved, mode: saved?.drawn ? 'draw' : saved?.image ? 'image' : 'type',
        typed: saved?.typed ?? (initials ? initialsOf(nameOf(ctx)) : nameOf(ctx).trim()),
        strokes: saved?.drawn ?? [], image: saved?.image ?? null};
    };
    const initials = args?.initials === true;
    return {__title: `${draft(initials).editing ? 'Change' : 'Create'} ${initials ? 'initials' : 'signature'}`, what: initials ? 'initials' : 'signature', initials: false, mode: null, typed: null, strokes: null, image: null, drafts: {signature: draft(false), initials: draft(true)}};
  },
  validate(raw) {
    const v = resolved(raw);
    if (v.mode === 'draw') return (v.strokes ?? []).some(s => s.length > 1) ? [] : [{field: 'pad', message: `Draw your ${v.what} below.`}];
    if (v.mode === 'image') return v.image ? [] : [{field: 'browse', message: 'Choose a PNG or JPEG image.'}];
    const t = String(v.typed ?? '').trim();
    if (!t) return [{field: 'typed', message: `Type your ${v.what}.`}];
    if (Array.from(t).length > MAX_SIGNATURE_CHARS) return [{field: 'typed', message: `At most ${MAX_SIGNATURE_CHARS} characters.`}];
    const missing = scriptMissing(t);
    if (missing) return [{field: 'typed', message: `The signature font can't draw "${missing}". Draw your ${v.what} or use an image instead.`}];
    return [];
  },
  toCommand(raw) {
    const v = resolved(raw);
    const command = v.initials ? 'sign.fill.initials.change' : 'sign.fill.signature.change';
    if (v.mode === 'draw') return {command, params: {drawn: v.strokes.filter(s => s.length)}};
    if (v.mode === 'image') return {command, params: {image: v.image}};
    return {command, params: {typed: String(v.typed).trim()}};
  },
});
