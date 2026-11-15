// Equation › Tools › Equation Options (the group's launcher): how equation text is typed, Unicode math in the linear format or LaTeX. OK runs
// equation.inputFormat. Word's own box (Equation Options, with Math AutoCorrect) lists replacement rules; here the choice is the syntax, which is
// what the equation editor offers (not checked against upstream: wordcraft has no such box).

import {defineDialog} from '../../kernel/dialog.mjs';
import {INPUT_PREF} from '../commands/equation.mjs';

export default defineDialog({
  id: 'dialog.equationOptions',
  title: 'Equation Options',
  command: 'equation.inputFormat',
  init: ctx => ({format: ctx.prefs?.[INPUT_PREF] === 'latex' ? 'latex' : 'unicode'}),
  validate: v => (['unicode', 'latex'].includes(v.format) ? [] : [{field: 'format', message: 'Choose how equations are typed.'}]),
  toCommand: v => ({command: 'equation.inputFormat', params: {format: v.format}}),
});
