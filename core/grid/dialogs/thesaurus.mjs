// Thesaurus dialog model (Review > Thesaurus, Shift+F7; command review.thesaurus): the word looked up, its meanings with their synonyms,
// and Replace, which puts the synonym in the active cell. Over gridcraft's `thesaurus` (cmd/spelling.rs) at
// 146161b4b450a56e5e59a083ba0478582d1e602b; the synonyms come from the built-in word list instead of dictionary stems. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// Values: word (the word looked up), senses ([{word, synonyms}]), picked (the synonym chosen).

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {baseDoc} from '../lib/data-common.mjs';
import {cellAt} from '../model/store.mjs';
import {wordsOf} from '../../common/lib/spelling.mjs';
import {lookup} from '../../prism/lib/thesaurus.mjs';

export default defineDialog({
  id: 'dialog.thesaurus',
  title: 'Thesaurus',
  command: 'review.thesaurus',
  init(ctx) {
    const content = baseDoc(ctx);
    const sel = gridSel(ctx);
    const cell = cellAt(content.sheets[sel.sheet], sel.active.row, sel.active.col);
    const text = typeof cell?.v === 'string' && cell.f === undefined ? cell.v : '';
    const word = wordsOf(text)[0]?.text ?? '';
    return {word, senses: word ? lookup(word) : [], picked: ''};
  },
  validate: v => (String(v.picked ?? '').trim() ? [] : [{field: 'picked', message: 'Pick a synonym to replace the cell text with.'}]),
  toCommand: v => ({command: 'review.thesaurus', params: {to: String(v.picked)}}),
});
