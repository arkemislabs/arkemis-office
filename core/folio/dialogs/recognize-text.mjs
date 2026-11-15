// Recognize Text (submit: ocr.recognize): Pages All / Current page / From–to, Document language,
// Output (Searchable Image (Exact)), Downsample to, Also recognize pages that already have text.
// Translated from printcraft crates/ui-egui/src/workflows/ocr_ui.rs:99 (`body`, the draft kept
// between openings: 300 dpi, English) at 3109bb2359759e24ef490e1cdbdba00722b20972.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {LANGUAGES} from '../lib/ocr-layer.mjs';

let draft = null;

export default defineDialog({
  id: 'dialog.recognize-text',
  title: 'Recognize Text',
  command: 'ocr.recognize',
  init(ctx) {
    const list = ctx.doc?.pages ?? [];
    const current = Math.max(0, list.findIndex(p => p.id === ctx.doc?.activePageId));
    return {pages: draft?.pages ?? 'All pages', from: 1, to: Math.max(1, list.length), language: 'English', output: 'Searchable Image (Exact)',
      downsample: draft?.downsample ?? '300 dpi', force: draft?.force ?? false, __count: list.length, __current: current};
  },
  validate(v) {
    if (v.pages !== 'From') return [];
    const n = Number(v.__count) || 1, a = Number(v.from), b = Number(v.to);
    if (!(Number.isInteger(a) && a >= 1 && a <= n)) return [{field: 'from', message: `Type a page number from 1 to ${n}`}];
    if (!(Number.isInteger(b) && b >= a && b <= n)) return [{field: 'to', message: `Type a page number from ${a} to ${n}`}];
    return [];
  },
  toCommand(v) {
    draft = {pages: v.pages, downsample: v.downsample, force: v.force};
    const n = Number(v.__count) || 1;
    const pages = v.pages === 'Current page' ? [Number(v.__current) || 0]
      : v.pages === 'From' ? Array.from({length: Number(v.to) - Number(v.from) + 1}, (_, k) => Number(v.from) - 1 + k) : null;
    const dpi = Number(String(v.downsample ?? '300').replace(/\D+/g, '')) || 300;
    return {command: 'ocr.recognize', params: {...(pages && pages.length && pages.length <= n ? {pages} : {}),
      language: (LANGUAGES.find(l => l[1] === v.language) ?? LANGUAGES[0])[0], dpi, force: !!v.force}};
  },
});
