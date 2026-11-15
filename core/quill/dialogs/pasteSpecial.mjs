// Home › Clipboard › Paste ▾ › Paste Special… (submit: edit.pasteSpecial {as}).
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dispatch.rs (`paste_special_dialog`: "Paste
// as:" radio list of the formats the clipboard holds, best first, "The clipboard is empty." when
// there are none, a Result line describing the chosen format, OK pastes it) and dialogs.rs
// (`Dialog::PasteSpecial { formats, choice, payload, note }`), with crates/engine/src/cmd/paste.rs
// (`source`, `available`) for which formats are offered, at ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: `formats` (the ids offered, recomputed when the payload changes), `as` (the choice),
// `ownText` (our own copy's text, so a system clipboard that differs means someone else copied
// since), and the payload the window read from the system clipboard (`text`, `html`, `rtf`,
// `picture`). Word's Source / Paste link / Display as icon belong to OLE objects, which neither
// upstream nor Quill has, so they are not part of this dialog.

import {defineDialog} from '../../kernel/dialog.mjs';
import {FORMATS, ownClip, readersKnown, importers} from '../lib/paste-content.mjs';

void importers().catch(() => null);

const PAYLOAD = ['text', 'html', 'rtf', 'picture'];
const looksLikeRtf = t => t.trimStart().startsWith('{\\rtf');
const looksLikeHtml = t => { const s = t.trimStart(); return s.startsWith('<') && (s.includes('</') || s.includes('/>')); };
const str = v => (typeof v === 'string' ? v : null);

/** The Result line for a format (paste_special_dialog's hints). */
export const HINTS = Object.freeze({
  formatted: 'Keeps the fonts and formatting of the copied text.',
  rtf: "Reads the clipboard's rich text and keeps its formatting.",
  html: "Reads the clipboard's web content and keeps its formatting.",
  picture: "Pastes the clipboard's picture.",
  text: 'Drops all formatting and pastes plain text.',
});

/** The formats the payload can be pasted as, best first (paste.rs `available`). */
export function formatsFor(v, readers = readersKnown()) {
  const text = str(v.text) !== null ? v.text.replace(/\r\n/g, '\n') : null;
  const own = str(v.ownText);
  const clip = text ?? own;
  const ok = {
    formatted: own !== null && (text === null || own === text),
    rtf: !!readers.rtf && !!(str(v.rtf) || (clip && looksLikeRtf(clip))),
    html: !!readers.html && !!(str(v.html) || (clip && looksLikeHtml(clip))),
    picture: !!str(v.picture),
    text: !!clip,
  };
  return FORMATS.map(([id]) => id).filter(id => ok[id]);
}

export default defineDialog({
  id: 'dialog.pasteSpecial',
  title: 'Paste Special',
  command: 'edit.pasteSpecial',
  init(ctx) {
    const own = ownClip(ctx);
    const v = {ownText: own ? own.text : null};
    v.formats = formatsFor(v);
    v.as = v.formats[0] ?? null;
    return v;
  },
  derive(v, changed) {
    if (!changed.some(k => PAYLOAD.includes(k) || k === 'ownText')) return {};
    const formats = formatsFor(v);
    return {formats, as: formats.includes(v.as) ? v.as : formats[0] ?? null};
  },
  validate(v) {
    const formats = Array.isArray(v.formats) ? v.formats : formatsFor(v);
    if (!formats.length) return [{field: 'as', message: 'The clipboard is empty.'}];
    if (!formats.includes(v.as)) return [{field: 'as', message: 'Choose how to paste the clipboard.'}];
    return [];
  },
  preview(_ctx, v) {
    const label = FORMATS.find(([id]) => id === v.as)?.[1] ?? null;
    return {format: v.as ?? null, label, hint: v.as ? HINTS[v.as] ?? HINTS.text : null, formats: (v.formats ?? []).map(id => ({id, label: FORMATS.find(([f]) => f === id)?.[1] ?? id}))};
  },
  toCommand(v) {
    const params = {as: v.as};
    for (const k of PAYLOAD) if (str(v[k])) params[k] = v[k];
    return {command: 'edit.pasteSpecial', params};
  },
});
