// Protect Using Password (submit: protect.password): Requires user to enter a password for Viewing or
// Editing, the password twice with its strength, and under Advanced Options the compatibility level,
// what to encrypt, and (for Editing) printing, changes and copying.
//
// Translated from printcraft crates/ui-egui/src/dialogs/protect.rs (ProtectDraft: problem, edit;
// strength; body) and crates/engine/src/protection.rs (Protection) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {COMPATIBILITY, PRINTING, CHANGES, strength, algorithmOf, protectionProblem} from '../lib/protect.mjs';

const ALL = 'All document contents';
const NO_META = 'All document contents except metadata';
const rc4 = v => algorithmOf(v.compatibility).startsWith('Rc4');

/** The strength meter (protect.rs strength): its bar and word. Nothing typed yet, an empty bar. */
const SCORES = {Weak: 0.25, Medium: 0.6, Strong: 1};
const meter = password => ({score: password ? SCORES[strength(password)] : 0, label: password ? strength(password) : ''});

export default defineDialog({
  id: 'dialog.protect',
  title: 'Protect Using Password',
  command: 'protect.password',
  init() {
    return {for: 'Viewing', password: '', confirm: '', advanced: false, compatibility: COMPATIBILITY[0], encrypt: ALL, printing: PRINTING[2], changes: CHANGES[0], copy: false, 'screen-reader': true, 'strength-meter': meter('')};
  },
  derive(v, changed) {
    // Unencrypted metadata needs crypt filters (Acrobat 6.0 and later): the RC4 levels always encrypt it.
    return {'strength-meter': meter(v.password), ...(changed.includes('compatibility') && rc4(v) && v.encrypt !== ALL ? {encrypt: ALL} : {})};
  },
  validate(v) {
    const out = [];
    const problem = !v.password ? 'Type a password.' : v.password !== v.confirm ? "The passwords don't match." : null;
    if (problem) { out.push({field: v.password ? 'confirm' : 'password', message: problem}); return out; }
    const viewing = v.for !== 'Editing';
    const text = protectionProblem({openPassword: viewing ? v.password : null, permissionsPassword: viewing ? null : v.password, algorithm: algorithmOf(v.compatibility)});
    if (text) out.push({field: 'password', message: text});
    return out;
  },
  toCommand(v) {
    const viewing = v.for !== 'Editing';
    return {command: 'protect.password', params: {
      ...(viewing ? {openPassword: v.password} : {permissionsPassword: v.password}),
      compatibility: v.compatibility, encrypt: rc4(v) ? ALL : v.encrypt === NO_META ? NO_META : ALL,
      ...(viewing ? {} : {printing: v.printing, changes: v.changes, copy: !!v.copy, screenReader: !!v['screen-reader']})}};
  },
});
