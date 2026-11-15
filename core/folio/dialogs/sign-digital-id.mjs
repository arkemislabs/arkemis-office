// Sign with a Digital ID: Choose ID ▸ Configure (a new self-signed ID, or one from a .pfx/.p12
// file) ▸ Sign as (appearance, graphic, reason, location, permitted actions when certifying, the
// ID's password) ▸ Sign.
//
// Translated from printcraft crates/ui-egui/src/tools/sign_ui.rs (SignStep, SignDraft::new: Choose
// when IDs exist, else Configure; NewIdDraft defaults; KEY_ALGORITHMS; SignGraphic) and
// crates/ui-egui/src/tools/sign_ui/dialog.rs (the three steps, Back / Continue / Sign / Cancel) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Creating or importing an ID happens on Continue (sign.id.create / sign.id.import) in the dialog's
// own view (src/apps/folio/dialogs/sign-digital-id.tsx); Sign runs sign.digital, sign.certify or
// sign.certify_invisible with the area the person dragged. "Lock document after signing" (Acrobat
// only) stays hidden.

import {defineDialog} from '../../kernel/dialog.mjs';

const GRAPHICS = ['name', 'fillsign', 'image', 'none'];

/** Back and Continue are in the dialog's footer; the dialog's body (src/apps/folio/dialogs/sign-digital-id.tsx) does what they ask: it listens for this. */
export const STEP_EVENT = 'folio:sign-step';
function step(button) {
  const g = globalThis;
  if (typeof g.dispatchEvent === 'function' && typeof g.CustomEvent === 'function') g.dispatchEvent(new g.CustomEvent(STEP_EVENT, {detail: button}));
  return null;
}

export default defineDialog({
  id: 'dialog.sign-digital-id',
  title: 'Sign with a Digital ID',
  command: 'sign.digital',
  init(ctx, args = {}) {
    const ids = Array.isArray(ctx.prefs?.digitalIds) ? ctx.prefs.digitalIds : [];
    const certify = args?.certify ?? (ctx.view?.tool === 'sign.certify' ? 2 : null);
    return {
      step: ids.length ? 'choose' : 'configure',
      ids: ids.map((e, i) => ({index: i, name: e.name, issuer: e.issuer, email: e.email, expires: e.expires, fingerprint: e.fingerprint})),
      selected: ids.findIndex(e => !e.unusable),
      page: args?.page ?? null, rect: args?.rect ?? null, field: args?.field ?? null, certify, invisible: !!args?.invisible,
      kind: 'create', name: String(ctx.prefs?.identity?.name ?? ''), ou: '', org: '', email: '', country: '', alg: 'rsa2048', password: '', confirm: '',
      file: '', 'file-password': '',
      graphic: ctx.prefs?.signGraphic ?? 'name', image: null,
      show: ['name', 'date'], reason: '', location: '', permitted: certify ?? 2, 'id-password': '',
    };
  },
  buttons: {Back: () => step('back'), Continue: () => step('continue')},
  validate(v) {
    if (v.step !== 'sign') return [{field: 'ids', message: 'Choose a digital ID and Continue.'}];
    if (v.selected == null || v.selected < 0) return [{field: 'ids', message: 'Choose a digital ID.'}];
    if (!v['id-password']) return [{field: 'id-password', message: "Enter the digital ID's password."}];
    if (!GRAPHICS.includes(v.graphic)) return [{field: 'graphic', message: 'Choose what the signature shows.'}];
    if (v.graphic === 'image' && !v.image) return [{field: 'image', message: 'Choose an image for the signature.'}];
    return [];
  },
  toCommand(v) {
    const show = new Set(v.show ?? []);
    const params = {
      digitalId: v.ids[v.selected]?.fingerprint ?? v.selected, password: v['id-password'],
      ...(v.reason ? {reason: v.reason} : {}), ...(v.location ? {location: v.location} : {}),
      appearance: {name: show.has('name'), date: show.has('date'), reason: show.has('reason'), location: show.has('location'), distinguishedName: show.has('dn'), labels: show.has('labels')},
      graphic: v.graphic, ...(v.graphic === 'image' && v.image ? {imageBase64: v.image} : {}),
      ...(v.page != null ? {page: v.page} : {}), ...(v.rect ? {rect: v.rect} : {}), ...(v.field ? {field: v.field} : {}),
    };
    if (v.certify && v.invisible) return {command: 'sign.certify_invisible', params: {...params, permitted: Number(v.permitted) || 2}};
    if (v.certify) return {command: 'sign.certify', params: {...params, permitted: Number(v.permitted) || 2}};
    return {command: 'sign.digital', params};
  },
});
