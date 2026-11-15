// Bullets and Numbering (submit: format.bullets or format.numbering): the Bulleted page (nine
// characters or a custom one) and the Numbered page (seven schemes, Start at), Size (% of text) and
// Color on both; the None tile (first in the grid, as in PowerPoint) removes the list.
// Translated from deckcraft crates/ui-egui/src/dialogs/body.rs (`dlg_bullets`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// The page last edited decides which list OK applies (deckcraft keeps the open page as `tab`;
// it starts on the current paragraph's kind of list).

import {defineDialog} from '../../kernel/dialog.mjs';
import {currentPara} from '../lib/format-text.mjs';

const finite = v => typeof v === 'number' && Number.isFinite(v);
const CHARS = ['•', '○', '■', '□', '◆', '➢', '✓', '–', '★'];
const COLORS = ['tx1', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];

export function bulletsValues(ctx) {
  const pp = currentPara(ctx);
  const b = pp.bullet;
  const numbered = b?.kind === 'autoNum';
  const slot = pp.bulletColor?.base?.kind === 'scheme' ? pp.bulletColor.base.slot : null;
  return {none: false, kind: numbered ? 'numbered' : 'bulleted', char: b?.kind === 'char' && CHARS.includes(b.char) ? b.char : '•',
    custom: b?.kind === 'char' && !CHARS.includes(b.char) ? b.char : '', scheme: numbered ? b.scheme : 'arabicPeriod', start: numbered ? b.startAt ?? 1 : 1,
    size: finite(pp.bulletSize) ? Math.round(pp.bulletSize * 100) : 100, color: COLORS.includes(slot) ? slot : ''};
}

export function deriveBullets(_v, changed) {
  if (changed.includes('none')) return {};
  if (changed.some(k => k === 'char' || k === 'custom')) return {kind: 'bulleted', none: false};
  if (changed.some(k => k === 'scheme' || k === 'start')) return {kind: 'numbered', none: false};
  return {};
}

/** OK: `{on: true, size, color?, char}` or `{on: true, size, color?, scheme, start}`. */
export function bulletsCall(v) {
  if (v.none) return {command: v.kind === 'numbered' ? 'format.numbering' : 'format.bullets', params: {on: false}};
  const p = {on: true};
  if (finite(v.size)) p.size = Math.max(25, Math.min(400, v.size));
  if (v.color) p.color = v.color;
  if (v.kind === 'numbered') {
    p.scheme = v.scheme ?? 'arabicPeriod';
    p.start = Math.max(1, Math.min(32767, Math.trunc(finite(v.start) ? v.start : 1)));
    return {command: 'format.numbering', params: p};
  }
  const custom = [...String(v.custom ?? '')].find(c => c.trim());
  p.char = custom ?? v.char ?? '•';
  return {command: 'format.bullets', params: p};
}

export default defineDialog({
  id: 'dialog.bullets',
  title: 'Bullets and Numbering',
  command: 'format.bullets',
  init: ctx => bulletsValues(ctx),
  derive: deriveBullets,
  validate(v) {
    const out = [];
    if (!finite(v.size)) out.push({field: 'size', message: 'Size must be a number'});
    if (v.kind === 'numbered' && !finite(v.start)) out.push({field: 'start', message: 'Start at must be a number'});
    return out;
  },
  toCommand: bulletsCall,
});
