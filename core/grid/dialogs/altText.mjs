// Alt Text dialog model (submit: object.setAlt).
// Excel's Alt Text pane (the description box and Mark as decorative) for the selected chart, picture or shape; not in
// gridcraft (its pictures keep a description, `alt`, and nothing edits it afterwards). Not checked against upstream.
//
// Values: alt (the description), decorative.

import {defineDialog} from '../../kernel/dialog.mjs';
import {baseDoc} from '../lib/data-common.mjs';
import {findObject, selectedObject} from '../lib/objects.mjs';

export default defineDialog({
  id: 'dialog.altText',
  title: 'Alt Text',
  command: 'object.setAlt',
  init(ctx) {
    const content = baseDoc(ctx);
    const picked = selectedObject(content, ctx.selection);
    const hit = picked ? findObject(content.sheets[picked.si], picked.kind, picked.id) : null;
    return {alt: hit?.object.alt ?? '', decorative: hit?.object.decorative === true};
  },
  validate: () => [],
  toCommand: v => ({command: 'object.setAlt', params: v.decorative === true ? {decorative: true} : {alt: String(v.alt ?? '')}}),
});
