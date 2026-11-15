// Paragraph Spacing (Home › Basic Text › Paragraph Alignment › Paragraph Spacing Options...;
// submit: paragraph.spacing). OneNote's dialog: Before, After and Line Spacing At Least, in
// points, read from the first selected paragraph. Slate has no ArtCraft upstream.
import {defineDialog} from '../../kernel/dialog.mjs';
import {schema} from '../schema.mjs';
import {textRange, textblocksIn} from '../lib/format-text.mjs';

const FIELDS = ['spaceBefore', 'spaceAfter', 'lineSpacingAtLeast'];

export default defineDialog({
  id: 'dialog.paragraph-spacing',
  title: 'Paragraph Spacing',
  command: 'paragraph.spacing',
  init(ctx) {
    const r = textRange(ctx);
    const para = r && textblocksIn(r.doc, r.from, r.to).find(b => b.node.type === schema.nodes.paragraph);
    return {spaceBefore: 0, spaceAfter: 0, lineSpacingAtLeast: 0, ...(para?.node.attrs.spacing ?? {})};
  },
  validate: v => FIELDS.filter(k => !(Number.isFinite(Number(v[k])) && Number(v[k]) >= 0 && Number(v[k]) <= 999))
    .map(field => ({field, message: 'Enter a number of points from 0 to 999.'})),
  toCommand: v => ({command: 'paragraph.spacing', params: Object.fromEntries(FIELDS.map(k => [k, Number(v[k])]))}),
});
