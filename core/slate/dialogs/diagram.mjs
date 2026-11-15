// Diagram (double-click a diagram on the page, or Insert > Files > Diagram then its outline; submit: diagram.edit).
// The kind of diagram and its outline, one line per box. U:slate/rest.
import {defineDialog} from '../../kernel/dialog.mjs';
import {DIAGRAM_KINDS, parseOutline} from '../lib/diagram.mjs';
import {blockIndex} from '../model/page.mjs';
import {pageDoc} from '../model/canvas.mjs';

const selected = ctx => {
  const m = /^\/pg:([^/]+)\/media:([^/]+)$/.exec(ctx.selection?.ranges?.[ctx.selection.primary ?? 0]?.focus ?? '');
  if (!m) return null;
  const page = decodeURIComponent(m[1]), id = decodeURIComponent(m[2]);
  try {
    const hit = blockIndex(pageDoc(ctx, page)).get(id);
    return hit?.node.type.name === 'diagram' ? {page, id, node: hit.node} : null;
  } catch { return null; }
};

export default defineDialog({
  id: 'dialog.diagram',
  title: 'Diagram',
  command: 'diagram.edit',
  init(ctx) {
    const d = selected(ctx);
    return {page: d?.page ?? null, id: d?.id ?? null, kind: d?.node.attrs.kind ?? 'flowchart', text: d?.node.attrs.text ?? ''};
  },
  validate(v) {
    const out = [];
    if (!v.id) out.push({field: 'text', message: 'Select a diagram on the page first.'});
    if (!DIAGRAM_KINDS.includes(v.kind)) out.push({field: 'kind', message: 'Choose a kind of diagram.'});
    if (!parseOutline(v.text).length) out.push({field: 'text', message: 'Type at least one line: each line is a box.'});
    return out;
  },
  toCommand: v => ({command: 'diagram.edit', params: {id: v.id, page: v.page ?? undefined, kind: v.kind, text: v.text}}),
});
