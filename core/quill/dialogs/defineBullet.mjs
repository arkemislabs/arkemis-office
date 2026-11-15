// Home › Paragraph › Bullets › Define New Bullet… (submit: para.defineBullet).
// Word's Define New Bullet (office source) over wordcraft crates/engine/src/cmd/tools/specs.rs:316
// `para.defineBullet {char}` at aadb077e072b7de05f724e359d8db82e151f125c: a bullet character from
// the list or typed; the preview shows the bulleted list. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

/** The bullet the dialog applies: the typed character when there is one, else the picked one. */
export const bulletOf = v => (typeof v.custom === 'string' && [...v.custom.trim()].length ? [...v.custom.trim()][0] : v.char);

export default defineDialog({
  id: 'dialog.defineBullet',
  title: 'Define New Bullet',
  command: 'para.defineBullet',
  init() { return {char: '•', custom: ''}; },
  validate(v) {
    const c = bulletOf(v);
    if (typeof c !== 'string' || [...c].length !== 1) return [{field: 'custom', message: 'Choose or type one bullet character.'}];
    if (typeof v.custom === 'string' && [...v.custom.trim()].length > 1) return [{field: 'custom', message: 'Type one character.'}];
    return [];
  },
  preview(ctx, v) { return {kind: 'bullets', bullet: bulletOf(v) ?? '•'}; },
  toCommand(v) { return {command: 'para.defineBullet', params: {char: bulletOf(v)}}; },
});
