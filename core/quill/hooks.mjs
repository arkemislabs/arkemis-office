// What Quill checks around every command that edits the document (the kernel's foundation
// hooks, core/kernel/session.mjs): Restrict Editing refuses commands the protection forbids, a
// document protected for tracked changes is tracked, edits outside the editable regions are
// rolled back, and formatting changed while Track Changes is on becomes a tracked formatting
// change. Translated from wordcraft crates/engine/src/session/run.rs (`Session::run`: the
// `check_before` guard, `outside_unchanged` after the command, `fmt_revisions::record`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {CommandError} from '../kernel/errors.mjs';
import {isQuill2} from './model/content.mjs';
import {Document} from './model/document.mjs';
import {author as authorOf, isoSeconds} from './lib/caret-session.mjs';
import {checkBefore, outsideUnchanged} from './lib/review-protect.mjs';
import {records, recordFormatting} from './lib/review-fmt.mjs';
import {outlineOf} from './lib/outline-view.mjs';
import {recordStep} from './commands/tools.mjs';

/** Whether changes are tracked for this person: the document's setting, or Track Changes › Just Mine. */
export const tracking = ctx => !!ctx?.doc?.settings?.trackChanges || !!ctx?.view?.trackMine;

export function before(ctx, cmd, params) {
  if (!isQuill2(ctx.doc)) return null;
  const d = new Document(ctx.doc);
  const author = authorOf(ctx.prefs);
  const guard = checkBefore(d, author, cmd.id, params);
  if (d.c.settings?.protection === 'trackedChanges' && !d.c.settings.trackChanges) {
    ctx.model.edit(ctx, x => { x.updateField('settings', s => { s.trackChanges = true; }); });
  }
  return {guard, before: ctx.doc, author};
}

export function after(ctx, cmd, params, st) {
  if (!st || !isQuill2(ctx.doc) || ctx.doc === st.before) return;
  if (st.guard && !outsideUnchanged(new Document(st.before), new Document(ctx.doc), st.author)) {
    throw new CommandError('disabled', `${cmd.id}: only the editable regions of this protected document can change`);
  }
  const trackFormatting = ctx.prefs?.markup?.trackFormatting ?? true;
  if (tracking(ctx) && trackFormatting && records(cmd.id)) {
    const date = isoSeconds(ctx.host?.now?.() ?? Date.now());
    ctx.model.edit(ctx, d => recordFormatting(d, st.before, {author: st.author, date}));
  }
  // Outline view (U:quill/view): collapsed headings are found again where the edit moved them
  // (outline.rs after_command → remap_collapsed_headings).
  if (ctx.view?.outline?.collapsed?.length) ctx.setView({outline: outlineOf(ctx.view, new Document(ctx.doc))});
}

/** After any command that ran: Record Macro keeps the ones that change the document or move the caret (tools.mjs). */
export function observe(ctx, cmd, params) {
  if (ctx.view?.recording) recordStep(ctx, cmd, params);
}
