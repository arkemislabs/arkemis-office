// Password Options (Password Protection > Password Options...; submit: review.passwordOptions):
// lock a protected section after it has not been worked in for a time, and/or as soon as the
// person navigates away from it. Slate has no ArtCraft upstream.
import {defineDialog} from '../../kernel/dialog.mjs';
import {labelOf, lockOptions, minutesOf} from '../lib/autolock.mjs';

export default defineDialog({
  id: 'dialog.password-options',
  title: 'Password Options',
  command: 'review.passwordOptions',
  init(ctx) {
    const o = lockOptions(ctx.prefs);
    return {lockAfter: o.lockAfter, lockAfterTime: labelOf(o.minutes), lockOnNavigate: o.onNavigate};
  },
  validate: v => (minutesOf(v.lockAfterTime) ? [] : [{field: 'lockAfterTime', message: 'Choose how long.'}]),
  toCommand: v => ({command: 'review.passwordOptions', params: {lockAfter: v.lockAfter === true, minutes: minutesOf(v.lockAfterTime), onNavigate: v.lockOnNavigate === true}}),
});
