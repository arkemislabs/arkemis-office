// AutoCorrect dialog model (Tools › AutoCorrect Options…): the AutoCorrect tab (Correct TWo
// INitial CApitals, Capitalize first letter of sentences, Capitalize names of days, Correct
// accidental use of cAPS LOCK key, Replace text as you type; Replace / With and Add; the
// replacement list with Delete per row) and AutoFormat As You Type (fractions, ordinals with
// superscript, automatic bulleted and numbered lists, smart quotes). OK runs text.autocorrect.
// Translated from deckcraft crates/ui-egui/src/dialogs/body.rs (AutoCorrect, 1290-1330) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Office options deckcraft has no engine for (table cell capitals, Exceptions…, hyphens, smileys,
// hyperlinks, AutoFit, Actions, Math AutoCorrect) are not shown (docs/spec/patches/prism/text.json).

import {defineDialog} from '../../kernel/dialog.mjs';
import {acPrefs, AUTOCORRECT} from '../lib/text-autocorrect.mjs';

const eqi = (a, b) => a.toLowerCase() === b.toLowerCase();
/** The replacement list as the options command reports it: your entries, then the built-in ones left. */
export function entriesOf(pr) {
  return [...pr.acEntries.map(e => [...e]),
    ...AUTOCORRECT.filter(([k]) => !pr.acRemoved.some(r => eqi(r, k)) && !pr.acEntries.some(([e]) => eqi(e, k))).map(e => [...e])];
}

const FLAGS = {twoInitials: 'acTwoInitials', sentenceCaps: 'acSentenceCaps', days: 'acDays', capsLock: 'acCapsLock', replaceText: 'autocorrect',
  fractions: 'acFractions', ordinals: 'acOrdinals', lists: 'acLists', smartQuotes: 'smartQuotes'};

export default defineDialog({
  id: 'dialog.autocorrect',
  title: 'AutoCorrect',
  command: 'text.autocorrect',
  init(ctx) {
    const pr = acPrefs(ctx.prefs);
    const v = {from: '', to: '', entries: entriesOf(pr)};
    for (const [k, slot] of Object.entries(FLAGS)) v[k] = !!pr[slot];
    return v;
  },
  validate: () => [],
  buttons: {
    add(_ctx, v) {
      const from = String(v.from ?? '').trim(), to = String(v.to ?? '');
      if (!from) return null;
      v.from = '';
      v.to = '';
      return {command: 'text.autocorrect', params: {add: [from, to]}};
    },
  },
  toCommand: v => ({command: 'text.autocorrect', params: {on: !!v.replaceText, twoInitials: !!v.twoInitials, sentenceCaps: !!v.sentenceCaps,
    days: !!v.days, capsLock: !!v.capsLock, fractions: !!v.fractions, ordinals: !!v.ordinals, lists: !!v.lists, smartQuotes: !!v.smartQuotes}}),
});
