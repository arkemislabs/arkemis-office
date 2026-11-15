// Home › Paragraph › Paragraph dialog (the group launcher, Line Spacing Options…; submit: para.set,
// one undo step).
// Translated from wordcraft crates/ui-egui/src/dialogs/paragraph.rs (`paragraph_dialog`,
// `para_fields`, `apply_paragraph`: the fields that differ from what every selected paragraph had,
// blank fields left alone, alignment and indents as seen on the page, a new direction keeping them
// where the dialog shows them) and dispatch.rs `paragraph_dialog` at
// aadb077e072b7de05f724e359d8db82e151f125c, with Word's fields (Special/By first-line indent, Line
// spacing rule and At, Outline level). MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {parasAt, toIn, fromIn, r2, isNum, lineFields, lineSpacingOf} from '../lib/format-dialogs.mjs';

/** The upstream keys the dialog edits, each with the dialog fields behind it. */
export const PARA_KEYS = Object.freeze({
  bidi: ['direction'], align: ['alignment'], left: ['left'], right: ['right'], indentFirst: ['special', 'by'],
  spaceBefore: ['before'], spaceAfter: ['after'], lineSpacing: ['lineRule', 'lineAt', 'lineAtPt'], outlineLevel: ['outlineLevel'],
  mirrorIndents: ['mirrorIndents'], contextualSpacing: ['contextualSpacing'],
  keepNext: ['keepNext'], keepLines: ['keepLines'], pageBreakBefore: ['pageBreakBefore'], widowControl: ['widowControl'],
  suppressLineNumbers: ['suppressLineNumbers'], suppressHyphens: ['suppressHyphens'],
  kinsoku: ['kinsoku'], wordWrap: ['wordWrap'], overflowPunct: ['overflowPunct'], topLinePunct: ['topLinePunct'],
  autoSpaceDE: ['autoSpaceDE'], autoSpaceDN: ['autoSpaceDN'],
});
const ON_PAGE = ['align', 'left', 'right'];
const FLAGS = ['mirrorIndents', 'contextualSpacing', 'keepNext', 'keepLines', 'pageBreakBefore', 'widowControl', 'suppressLineNumbers', 'suppressHyphens',
  'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN'];

/** Alignment as seen on the page (`Align::visual`): a right-to-left paragraph's start is the right edge. */
export const visualAlign = (align, bidi) => (bidi && align === 'left' ? 'right' : bidi && align === 'right' ? 'left' : align === 'both' ? 'justify' : align);

/** One resolved paragraph as the dialog's fields (`paragraph_dialog`). */
export function paraFieldsOf(rp) {
  const bidi = !!rp.bidi;
  const [vl, vr] = bidi ? [rp.indentRight ?? 0, rp.indentLeft ?? 0] : [rp.indentLeft ?? 0, rp.indentRight ?? 0];
  const first = rp.indentFirst ?? 0;
  const ol = rp.outlineLevel;
  return {
    direction: bidi ? 'rtl' : 'ltr', alignment: visualAlign(rp.align ?? 'left', bidi),
    outlineLevel: ol === null || ol === undefined || ol >= 9 ? 'body' : String(ol + 1),
    left: toIn(vl), right: toIn(vr),
    special: first > 0 ? 'firstLine' : first < 0 ? 'hanging' : 'none', by: first ? toIn(Math.abs(first)) : null,
    before: r2(rp.spaceBefore ?? 0), after: r2(rp.spaceAfter ?? 0),
    ...lineFields(rp.lineSpacing),
    ...Object.fromEntries(FLAGS.map(k => [k, !!rp[k]])),
  };
}

/** The values the dialog opens with: the paragraphs' shared fields, blank (null) where they differ (#1346). */
export function paragraphValues(ctx) {
  const list = parasAt(ctx);
  const each = list.map(paraFieldsOf);
  const first = each[0] ?? paraFieldsOf({});
  const out = {...first};
  for (const fields of Object.values(PARA_KEYS)) {
    const differ = each.some(e => fields.some(f => JSON.stringify(e[f]) !== JSON.stringify(first[f])));
    if (differ) for (const f of fields) out[f] = null;
  }
  return out;
}

const changed = (v, key) => PARA_KEYS[key].some(f => JSON.stringify(v[f]) !== JSON.stringify(v._basis?.[f]));
const blank = (v, key) => PARA_KEYS[key].every(f => v[f] === null || v[f] === undefined) || (key === 'indentFirst' && !v.special) || (key === 'lineSpacing' && !v.lineRule);

/** A key's value as para.set takes it (`para_fields`), or undefined when its fields are blank. */
export function keyValue(v, key) {
  if (blank(v, key)) return undefined;
  switch (key) {
    case 'bidi': return v.direction === 'rtl';
    case 'align': return v.alignment;
    case 'left': return isNum(v.left) ? fromIn(v.left) : undefined;
    case 'right': return isNum(v.right) ? fromIn(v.right) : undefined;
    case 'indentFirst': {
      if (v.special === 'none') return 0;
      const by = isNum(v.by) ? fromIn(v.by) : 0;
      return v.special === 'hanging' ? -by : by;
    }
    case 'spaceBefore': return isNum(v.before) ? v.before : undefined;
    case 'spaceAfter': return isNum(v.after) ? v.after : undefined;
    case 'lineSpacing': return lineSpacingOf(v) ?? undefined;
    case 'outlineLevel': return v.outlineLevel === 'body' ? 9 : Number(v.outlineLevel) - 1;
    default: return typeof v[key] === 'boolean' ? v[key] : undefined;
  }
}

/** `apply_paragraph`: only what changed (blank fields stay as each paragraph has them), as one para.set. */
export function paragraphParams(v) {
  const turned = changed(v, 'bidi') && !blank(v, 'bidi');
  const props = {}, onPage = {};
  for (const key of Object.keys(PARA_KEYS)) {
    const onPg = ON_PAGE.includes(key);
    if (!changed(v, key) && !(turned && onPg)) continue;
    const x = keyValue(v, key);
    if (x === undefined) continue;
    if (onPg) onPage[key] = x;
    else props[key] = x;
  }
  if (!Object.keys(props).length && !Object.keys(onPage).length) return null;
  return {props, onPage};
}

export default defineDialog({
  id: 'dialog.paragraph',
  title: 'Paragraph',
  command: 'para.set',
  init(ctx) {
    const v = paragraphValues(ctx);
    return {...v, _basis: {...v}};
  },
  derive(v, changedFields) {
    const out = {};
    if (changedFields.includes('special')) {
      if (v.special === 'none') out.by = null;
      else if (!isNum(v.by) || v.by === 0) out.by = 0.5;
    }
    if (changedFields.includes('lineRule')) {
      const preset = {single: 1, onePointFive: 1.5, double: 2}[v.lineRule];
      if (preset) { out.lineAt = preset; out.lineAtPt = null; }
      if (v.lineRule === 'multiple' && !isNum(v.lineAt)) { out.lineAt = 3; out.lineAtPt = null; }
      if ((v.lineRule === 'atLeast' || v.lineRule === 'exactly') && !isNum(v.lineAtPt)) { out.lineAtPt = 12; out.lineAt = null; }
    }
    // Word: typing a multiple in At picks Multiple (or the matching preset).
    if (changedFields.includes('lineAt') && isNum(v.lineAt) && v.lineRule !== 'multiple') out.lineRule = 'multiple';
    return out;
  },
  validate(v) {
    const out = [];
    for (const k of ['left', 'right']) if (v[k] !== null && v[k] !== undefined && (!isNum(v[k]) || Math.abs(v[k]) > 22)) out.push({field: k, message: 'The measurement must be between -22" and 22".'});
    if (v.special && v.special !== 'none' && (!isNum(v.by) || v.by < 0 || v.by > 22)) out.push({field: 'by', message: 'The measurement must be between 0" and 22".'});
    for (const k of ['before', 'after']) if (v[k] !== null && v[k] !== undefined && (!isNum(v[k]) || v[k] < 0 || v[k] > 1584)) out.push({field: k, message: 'The number must be between 0 and 1584.'});
    if (v.lineRule === 'multiple' && (!isNum(v.lineAt) || v.lineAt < 0.06 || v.lineAt > 132)) out.push({field: 'lineAt', message: 'The number must be between 0.06 and 132.'});
    if ((v.lineRule === 'atLeast' || v.lineRule === 'exactly') && (!isNum(v.lineAtPt) || v.lineAtPt < (v.lineRule === 'exactly' ? 0.7 : 0) || v.lineAtPt > 1584)) {
      out.push({field: 'lineAtPt', message: 'The number must be between 0 pt and 1584 pt.'});
    }
    return out;
  },
  preview(ctx, v) {
    // Word's preview page: grey previous and following paragraphs around the sample paragraph,
    // indented, spaced and aligned as the fields say (points).
    const first = keyValue(v, 'indentFirst') ?? 0;
    const ls = lineSpacingOf(v);
    return {
      kind: 'paragraph',
      align: v.alignment ?? 'left', rtl: v.direction === 'rtl',
      left: isNum(v.left) ? fromIn(v.left) : 0, right: isNum(v.right) ? fromIn(v.right) : 0, first,
      before: isNum(v.before) ? v.before : 0, after: isNum(v.after) ? v.after : 0,
      line: ls ? (ls.rule === 'multiple' ? ls.value : Math.max(0.5, ls.value / 12)) : 1,
    };
  },
  toCommand(v) {
    const params = paragraphParams(v);
    return params ? {command: 'para.set', params} : null;
  },
});
