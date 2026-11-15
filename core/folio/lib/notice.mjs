// What the notice bar over the pages says (printcraft crates/ui-egui/src/canvas/bars.rs `notices`, at 8f16855; MIT, see
// assets/third-party-licenses/artcraft-reference.txt).
//
// The bar shows one message, the first that applies: a form's stopped scripts, security (a form still says what it is, the
// security sentence follows it), what the document is as a form, a repaired file, then the file's own warnings. Only the
// messages this window can tell are here: it never runs a document's scripts (so there is no "scripts turned off" notice
// and no JavaScript Console button), has no XFA layout, and does not repair files, so those three are not offered.
// Dismiss closes the bar for the document; "Don't show again" (security only) hides the secured notice in every document.
// No DOM, no Node built-ins.

import * as P from './protect.mjs';

export const SECURED = 'This document is secured. Some changes are restricted by its security settings.';
const fieldsText = n => `This document contains ${n} interactive form fields.`;

/**
 * The notice for a document, or null when there is none.
 * @returns {{kind: 'secured'|'form', icon: string, text: string, fields: boolean, security: boolean, unlock: boolean, dontShow: boolean}|null}
 */
export function noticeOf(doc, view, prefs) {
  if (!Array.isArray(doc?.pages) || !doc.pages.length) return null;
  if (view?.noticeDismissed) return null;
  const sec = doc.security ?? null;
  const secured = !!(doc.permissions || (sec && !sec.pending)); // protection chosen but not yet saved is not a secured document
  const hiddenSecured = prefs?.hideSecuredNotice === true;
  const shown = (Array.isArray(doc.fields) ? doc.fields : []).filter(f => f.kind !== 'pushbutton');
  const form = shown.length ? fieldsText(shown.length) : null;
  if (secured && !hiddenSecured) {
    return {kind: 'secured', icon: form ? 'text-cursor-input' : 'lock', text: form ? `${form} ${SECURED}` : SECURED, fields: !!form, security: true,
      unlock: P.canUnlock(sec), dontShow: true};
  }
  if (form) return {kind: 'form', icon: 'text-cursor-input', text: form, fields: true, security: false, unlock: false, dontShow: false};
  return null;
}
