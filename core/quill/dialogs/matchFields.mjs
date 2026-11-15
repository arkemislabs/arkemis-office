// Mailings › Write & Insert Fields › Match Fields: the recipient-list field that fills each part of an
// address block and greeting line, or "(not matched)". Close closes.
//
// Translated from wordcraft crates/ui-egui/src/dialogs/mailings.rs (`ADDRESS_PARTS`) and
// dispatch.rs (`match_fields_dialog`) at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. The matching is read-only, as upstream's.

import {defineDialog} from '../../kernel/dialog.mjs';
import {mergeOf, addressMap} from '../lib/mailings-merge.mjs';

/** The address parts Match Fields lists, with their keys in the address map: [label, key]. */
export const ADDRESS_PARTS = Object.freeze([['Courtesy Title', 'title'], ['First Name', 'firstName'], ['Last Name', 'lastName'], ['Company', 'company'],
  ['Address', 'address'], ['City', 'city'], ['State', 'state'], ['Postal Code', 'postal'], ['Country', 'country']]);

export default defineDialog({
  id: 'dialog.matchFields',
  title: 'Match Fields',
  command: 'mailings.matchFields',
  init(ctx) {
    const m = mergeOf(ctx);
    return {fields: m.headers, address: addressMap(m.headers)};
  },
  validate: () => [],
  toCommand: () => null,
});
