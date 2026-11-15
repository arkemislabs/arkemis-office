// Accessibility Checker Options (submit: a11y.check): Report Options (Create accessibility report), Page Range (All pages in document, Pages from..to),
// Checking Options (Category and its rules with Select All and Clear All).
// Translated from printcraft crates/ui-egui/src/workflows/a11y_ui.rs `options_body` at 8f16855 (MIT, see assets/third-party-licenses/artcraft-reference.txt). The
// options are kept for the session, like Acrobat's; "Show this dialog when the Checker starts" is not offered (the dialog always shows).

import {defineDialog} from '../../kernel/dialog.mjs';
import {RULES, CATEGORIES, defaultRules} from '../lib/a11y.mjs';

export const CATEGORY_VALUES = Object.fromEntries(CATEGORIES.map(c => [c, c.toLowerCase().replace(/ /g, '-')]));
const field = id => `r-${id}`;
let draft = null;

const countOn = v => RULES.filter(r => v[field(r.id)] === true).length;
const label = v => `Checking Options (${countOn(v)} of 32 in all categories)`;

export default defineDialog({
  id: 'dialog.accessibility-options',
  title: 'Accessibility Checker Options',
  command: 'a11y.check',
  init(ctx) {
    const n = Math.max(1, (ctx.doc?.pages ?? []).length);
    const on = new Set(draft?.rules ?? defaultRules());
    const v = {report: draft?.report ?? false, pages: 'All', from: 1, to: n, category: draft?.category ?? CATEGORY_VALUES.Document, selectAll: 0, clearAll: 0, __count: n};
    for (const r of RULES) v[field(r.id)] = on.has(r.id);
    return {...v, checking: label(v)};
  },
  validate(v) {
    const out = [];
    const n = Number(v.__count) || 1;
    if (v.pages === 'Range') {
      const from = Number(v.from), to = Number(v.to);
      if (!Number.isInteger(from) || from < 1 || from > n) out.push({field: 'from', message: `Type a page from 1 to ${n}`});
      else if (!Number.isInteger(to) || to < from || to > n) out.push({field: 'to', message: `Type a page from ${from} to ${n}`});
    }
    if (!countOn(v)) out.push({field: 'category', message: 'Choose at least one rule to check'});
    return out;
  },
  derive(v, changed) {
    const out = {};
    const cat = Object.entries(CATEGORY_VALUES).find(([, id]) => id === v.category)?.[0];
    if (changed.includes('selectAll') || changed.includes('clearAll')) {
      for (const r of RULES.filter(x => x.category === cat)) out[field(r.id)] = changed.includes('selectAll');
    }
    out.checking = label({...v, ...out});
    return out;
  },
  toCommand(v) {
    const rules = RULES.filter(r => v[field(r.id)] === true).map(r => r.id);
    draft = {rules, report: v.report === true, category: v.category};
    const n = Number(v.__count) || 1;
    const params = {rules, report: v.report === true};
    if (v.pages === 'Range') {
      const from = Math.min(Math.max(1, Number(v.from) || 1), n), to = Math.min(Math.max(from, Number(v.to) || n), n);
      params.pages = Array.from({length: to - from + 1}, (_, i) => from - 1 + i);
    }
    return {command: 'a11y.check', params};
  },
});
