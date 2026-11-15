// Home › Styles › Styles pane › Manage Styles (Edit page).
// Translated from wordcraft crates/ui-egui/src/dialogs/styles.rs `manage_styles` (sort order, the
// list from cmd/para/lists.rs `manage_list`, the description, Show in the Styles gallery and Hide
// from style lists → `styles.setVisibility`, Modify…, New Style…, Delete → `styles.delete`) at
// aadb077e072b7de05f724e359d8db82e151f125c. Word applies the visibility changes on OK, as one undo
// step; Modify… and New Style… open their dialogs on top. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {manageList} from '../lib/para-lists.mjs';
import {caretStyle, describeStyle} from '../lib/format-dialogs.mjs';

/** Every listed style's name, type and visibility, in both orders (the view lists `_order[sortOrder]`). */
export function manageInfo(sheet) {
  const rec = manageList(sheet, false);
  const alpha = manageList(sheet, true);
  const info = {};
  for (const x of rec) info[x.id] = {name: x.name, type: x.type, builtIn: x.builtIn, gallery: x.inGallery, hidden: x.hidden, description: describeStyle(sheet, x.id)};
  return {info, order: {recommended: rec.map(x => x.id), alphabetical: alpha.map(x => x.id)}};
}

const look = (v, id) => ({...(v._info?.[id] ?? {}), ...(v._changes?.[id] ?? {})});

export default defineDialog({
  id: 'dialog.manageStyles',
  title: 'Manage Styles',
  init(ctx) {
    const {info, order} = manageInfo(ctx.doc.styles);
    const cur = caretStyle(ctx);
    const style = info[cur] ? cur : order.recommended[0] ?? null;
    const x = info[style] ?? {};
    return {sortOrder: 'recommended', style, showInGallery: !!x.gallery, hide: !!x.hidden, _info: info, _order: order, _changes: {}};
  },
  derive(v, changed) {
    if (changed.includes('style')) {
      const x = look(v, v.style);
      return {showInGallery: !!x.gallery, hide: !!x.hidden};
    }
    if (changed.includes('showInGallery') || changed.includes('hide')) {
      if (!v.style) return {};
      const was = v._info?.[v.style] ?? {};
      const next = {...(v._changes?.[v.style] ?? {})};
      if (changed.includes('showInGallery')) next.gallery = !!v.showInGallery;
      if (changed.includes('hide')) next.hidden = !!v.hide;
      for (const k of ['gallery', 'hidden']) if (next[k] === was[k]) delete next[k];
      const all = {...(v._changes ?? {})};
      if (Object.keys(next).length) all[v.style] = next; else delete all[v.style];
      return {_changes: all};
    }
    return {};
  },
  validate() { return []; },
  preview(ctx, v) {
    return {kind: 'description', text: v.style ? (v._info?.[v.style]?.description ?? describeStyle(ctx.doc.styles, v.style)) : ''};
  },
  buttons: {
    deleteButton(ctx, v) {
      if (!v.style) return null;
      return {command: 'styles.delete', params: {style: v.style}};
    },
  },
  toCommand(v) {
    const batch = Object.entries(v._changes ?? {}).map(([style, c]) => ({command: 'styles.setVisibility', params: {style, ...c}}));
    return batch.length ? {batch} : null;
  },
});
