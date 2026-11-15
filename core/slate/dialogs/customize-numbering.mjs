// Customize Numbering (Home › Basic Text › Numbering › Customize Numbering...; submit:
// list.customizeNumbering). OneNote's List task pane: Sequence, Text before, Text after, Start
// at, Continue / Restart numbering, List alignment, Alignment distance and At least, with a
// preview of the first three numbers. Slate has no ArtCraft upstream.
import {defineDialog} from '../../kernel/dialog.mjs';
import {SEQUENCES} from '../commands/paragraph.mjs';

const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
const ONES = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen',
  'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const ORD = ['Zeroth', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth', 'Thirteenth',
  'Fourteenth', 'Fifteenth', 'Sixteenth', 'Seventeenth', 'Eighteenth', 'Nineteenth'];
function roman(n) {
  let out = '';
  for (const [v, r] of ROMAN) while (n >= v) { out += r; n -= v; }
  return out;
}
function alpha(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(97 + ((n - 1) % 26)) + s;
  return s;
}
const suffix = n => (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');

/** One number in a sequence, as OneNote lists show it. */
export function numberText(sequence, n) {
  switch (SEQUENCES[sequence] ?? 'decimal') {
    case 'upper-roman': return roman(n).toUpperCase();
    case 'lower-roman': return roman(n);
    case 'upper-alpha': return alpha(n).toUpperCase();
    case 'lower-alpha': return alpha(n);
    case 'ordinal-text': return ORD[n] ?? `${n}${suffix(n)}`;
    case 'ordinal': return `${n}${suffix(n)}`;
    case 'cardinal-text': return ONES[n] ?? String(n);
    default: return String(n);
  }
}

export default defineDialog({
  id: 'dialog.customize-numbering',
  title: 'Customize Numbering',
  command: 'list.customizeNumbering',
  init: () => ({sequence: '1, 2, 3', textBefore: '', textAfter: '.', startAt: 1, restart: 'Continue numbering', listAlignment: 'Left', alignmentDistance: 0, textDistance: 0.25}),
  validate(v) {
    const out = [];
    if (!(Number.isInteger(Number(v.startAt)) && Number(v.startAt) >= 1 && Number(v.startAt) <= 32767)) out.push({field: 'startAt', message: 'Start at is a whole number from 1 to 32767.'});
    if (!SEQUENCES[v.sequence]) out.push({field: 'sequence', message: 'Choose a sequence.'});
    return out;
  },
  preview: (ctx, v) => ({lines: [0, 1, 2].map(i => `${v.textBefore ?? ''}${numberText(v.sequence, Number(v.startAt || 1) + i)}${v.textAfter ?? ''}`)}),
  toCommand(v) {
    const params = {sequence: v.sequence, startAt: Number(v.startAt), restart: v.restart === 'Restart numbering', textAfter: v.textAfter ?? ''};
    if (v.textBefore) params.textBefore = v.textBefore;
    if (v.listAlignment && v.listAlignment !== 'Left') params.listAlignment = String(v.listAlignment).toLowerCase();
    if (Number(v.alignmentDistance)) params.alignmentDistance = Number(v.alignmentDistance);
    if (Number(v.textDistance) && Number(v.textDistance) !== 0.25) params.textDistance = Number(v.textDistance);
    return {command: 'list.customizeNumbering', params};
  },
});
