// Layout › Page Setup › Hyphenation › Manual…: the next word that could end a line, with every place a hyphen may go (the suggested one chosen):
// Yes puts an optional hyphen there and goes on to the next word, No skips the word, and when none is left it says so.
//
// Over wordcraft crates/ui-egui/src/dialogs/dialogs_layout/text.rs `manual_ui` and engine page.rs `manual_hyphenation`; accepting is caret.set to
// the word's place plus the chosen point and text.optionalHyphen, as upstream does. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Drawn by src/apps/quill/dialogs/manualHyphenation.tsx.

import {defineDialog} from '../../kernel/dialog.mjs';
import {nextManualHyphen} from '../commands/word-core.mjs';

const at = (pos, off) => ({story: pos.story, path: [...pos.path], off});
/** The UTF-16 offset of char `index` of `word`. */
const offsetOf = (word, index) => [...word].slice(0, Math.max(0, index)).join('').length;

export default defineDialog({
  id: 'dialog.manualHyphenation',
  title: 'Manual Hyphenation',
  command: 'layout.manualHyphenation',
  init(ctx) {
    let hit = null;
    try { hit = nextManualHyphen(ctx); } catch { hit = null; }
    return hit ? {word: hit.word, pos: hit.pos, points: hit.points, choice: hit.suggest, done: false} : {word: '', pos: null, points: [], choice: 0, done: true};
  },
  validate: () => [],
  buttons: {
    yes: (_ctx, v) => (v.done || !v.pos ? null : {batch: [
      {command: 'caret.set', params: {pos: at(v.pos, v.pos.off + offsetOf(v.word, v.choice))}},
      {command: 'text.optionalHyphen', params: {}}]}),
    no: (_ctx, v) => (v.done || !v.pos ? null : {command: 'caret.set', params: {pos: at(v.pos, v.pos.off + v.word.length)}}),
  },
  toCommand: v => ({command: 'layout.manualHyphenation', params: v.pos ? {from: at(v.pos, v.pos.off)} : {}}),
});
