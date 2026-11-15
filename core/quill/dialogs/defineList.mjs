// Home › Paragraph › Multilevel List › Define New Multilevel List… (submit: list.define, one undo step).
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_lists.rs (`STYLES`, `LevelForm`
// read/params, `ListForm` read/params/sample, `define_list`: a new number style puts the level's
// number in the text, Include level number from appends it, `preview`) at
// aadb077e072b7de05f724e359d8db82e151f125c, in Word's expanded arrangement. Positions are inches.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The nine levels live in `_levels` (each a LevelForm); the visible fields are the level being
// edited (`level`), copied in when the level changes and written back as they change.

import {defineDialog} from '../../kernel/dialog.mjs';
import {peek, focusOf} from '../lib/format-target.mjs';
import {LEVELS, caretList, levelsOf, levelJson, defaultLevel} from '../lib/para-lists.mjs';
import {formatNumber} from '../model/numfmt.mjs';
import {toIn, fromIn, isNum} from '../lib/format-dialogs.mjs';

const LEVEL_FIELDS = ['text', 'format', 'start', 'restart', 'restartAfter', 'linkStyle', 'align', 'alignedAt', 'indentAt', 'follow', 'tabOn', 'tabAt', 'font', 'bold', 'italic', 'legal'];

/** `LevelForm::read`: level `i` from its list.define JSON. */
export function levelForm(i, v) {
  const ra = v?.restartAfter;
  return {
    text: v?.text ?? '', format: v?.format ?? 'decimal', start: Math.min(32_767, Number.isInteger(v?.start) ? v.start : 1),
    restart: ra !== 0, restartAfter: Number.isInteger(ra) && ra > 0 ? Math.min(8, ra) : Math.max(1, i),
    linkStyle: v?.style ?? '', align: v?.align ?? 'left',
    alignedAt: toIn(isNum(v?.alignedAt) ? v.alignedAt : 0), indentAt: toIn(isNum(v?.indentAt) ? v.indentAt : 0),
    follow: v?.follow ?? 'tab', tabOn: isNum(v?.tabAt), tabAt: toIn(isNum(v?.tabAt) ? v.tabAt : isNum(v?.indentAt) ? v.indentAt : 0),
    font: v?.font ?? '', bold: !!v?.bold, italic: !!v?.italic, legal: !!v?.legal,
  };
}

/** `LevelForm::params`: the level as list.define takes it. */
export function levelParams(l, i) {
  return {
    format: l.format, text: l.text, start: l.start,
    restartAfter: !l.restart ? 0 : i > 0 && l.restartAfter < i ? l.restartAfter : null,
    style: l.linkStyle ? l.linkStyle : null, align: l.align,
    alignedAt: fromIn(l.alignedAt), indentAt: fromIn(l.indentAt), follow: l.follow,
    tabAt: l.tabOn && l.follow === 'tab' ? fromIn(l.tabAt) : null,
    font: typeof l.font === 'string' && l.font.trim() ? l.font.trim() : null, bold: l.bold, italic: l.italic, legal: l.legal,
  };
}

/** `ListForm::sample`: the number level `k` shows with every level at its start value. */
export function sample(levels, k) {
  const l = levels[k];
  if (!l) return '';
  if (l.format === 'none') return '';
  if (l.format === 'bullet') return l.text;
  let out = '';
  const chars = [...l.text];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const dgt = chars[i + 1];
    if (c === '%' && dgt !== undefined && /[0-9]/.test(dgt)) {
      i++;
      const j = Math.min(LEVELS - 1, Math.max(0, Number(dgt) - 1));
      const lv = levels[j];
      const fmt = l.legal && j !== k ? 'decimal' : lv?.format ?? 'decimal';
      out += formatNumber(fmt, Math.max(1, lv?.start ?? 1));
    } else out += c;
  }
  return out;
}

/** `ListForm::read`: the caret's list, or a new 1. a. i. list. */
export function readList(ctx) {
  const d = peek(ctx);
  const num = caretList(d, focusOf(ctx, d));
  const levels = (num !== null ? levelsOf(d.numbering, num) : null) ?? Array.from({length: LEVELS}, (_, i) => defaultLevel(i));
  return Array.from({length: LEVELS}, (_, i) => levelForm(i, levels[i] ? levelJson(levels[i]) : null));
}

const fieldsOf = l => Object.fromEntries(LEVEL_FIELDS.map(k => [k, l[k]]));

export default defineDialog({
  id: 'dialog.defineList',
  title: 'Define New Multilevel List',
  command: 'list.define',
  init(ctx) {
    const levels = readList(ctx);
    return {level: 0, includeLevel: '', ...fieldsOf(levels[0]), _levels: levels};
  },
  derive(v, changed) {
    const levels = (v._levels ?? []).map(l => ({...l}));
    const i = Math.max(0, Math.min(LEVELS - 1, Number(v.level) || 0));
    if (changed.includes('level')) return {...fieldsOf(levels[i]), includeLevel: ''};
    const cur = {...levels[i]};
    for (const k of LEVEL_FIELDS) if (changed.includes(k)) cur[k] = v[k];
    const out = {};
    if (changed.includes('format')) {
      // A new style puts this level's number in the text if it had none (a bullet its character).
      const was = levels[i].format;
      if (v.format === 'bullet') cur.text = '•';
      else if (was === 'bullet' || !String(cur.text).includes('%')) cur.text = `%${i + 1}.`;
      out.text = cur.text;
    }
    if (changed.includes('includeLevel') && v.includeLevel !== '' && v.includeLevel !== null) {
      const k = Number(v.includeLevel);
      if (Number.isInteger(k) && k >= 1 && k <= i) { cur.text = `${cur.text}%${k}`; out.text = cur.text; }
      out.includeLevel = '';
    }
    if (changed.includes('start')) cur.start = Math.max(0, Math.min(32_767, Math.round(Number(v.start) || 0)));
    levels[i] = cur;
    return {...out, _levels: levels};
  },
  validate(v) {
    const out = [];
    const levels = v._levels ?? [];
    levels.forEach((l, i) => {
      for (const k of ['alignedAt', 'indentAt', 'tabAt']) if (!isNum(l[k]) || l[k] < -10 || l[k] > 22) out.push({field: k, message: `Level ${i + 1}: the measurement must be between -10" and 22".`});
      if (String(l.text).length > 64) out.push({field: 'text', message: `Level ${i + 1}: the number format is too long.`});
    });
    return out;
  },
  preview(ctx, v) {
    const levels = v._levels ?? [];
    return {kind: 'list', current: Number(v.level) || 0, rows: levels.map((l, i) => ({label: sample(levels, i), align: l.align, alignedAt: fromIn(l.alignedAt), indentAt: fromIn(l.indentAt), follow: l.follow}))};
  },
  toCommand(v) {
    return {command: 'list.define', params: {levels: (v._levels ?? []).map((l, i) => levelParams(l, i))}};
  },
});
