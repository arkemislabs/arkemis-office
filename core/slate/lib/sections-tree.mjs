// The notebook tree as OneNote's pickers list it (Move or Copy Pages, Move or Copy Section,
// Merge Section): the notebook, then its section groups and sections in tab order, indented
// (U:slate/sections; other units may import, not edit). No DOM, no Node built-ins.

import {treeEntries} from '../model/notebook.mjs';

/** [{value, label, kind: 'notebook'|'group'|'section', depth, color}] in tab order. */
export function notebookTree(content) {
  const out = [{value: content.notebook.id, label: content.notebook.name, kind: 'notebook', depth: 0, color: content.notebook.color ?? null}];
  for (const e of treeEntries(content)) {
    const rec = e.kind === 'section' ? content.sections[e.id] : content.groups[e.id];
    out.push({value: e.id, label: rec.name, kind: e.kind, depth: e.depth + 1, color: e.kind === 'section' ? rec.color ?? null : null});
  }
  return out;
}

/** The tree filtered by a search text (OneNote keeps the matching items and their parents). */
export function filterTree(tree, search) {
  const q = String(search ?? '').trim().toLowerCase();
  if (!q) return tree;
  const keep = new Set();
  tree.forEach((item, i) => {
    if (!item.label.toLowerCase().includes(q)) return;
    keep.add(i);
    for (let j = i - 1, d = item.depth; j >= 0 && d > 0; j--) if (tree[j].depth < d) { keep.add(j); d = tree[j].depth; }
  });
  return tree.filter((_, i) => keep.has(i));
}
