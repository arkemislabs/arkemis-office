// Shared setup for the Home tab family tests (U:slate format, paragraph, tags): a notebook whose
// first page holds one note container with the given paragraphs, and selection helpers.

import {buildNotebook, notebookSession, NOW} from './foundation-helpers.mjs';

/**
 * A notebook with one page whose note container holds `paras`: strings, or
 * {text, style, indent, marks: [{type, attrs?, from?, to?}], tags, list: 'bullet'|'ordered'}.
 * Consecutive list paragraphs of the same kind form one list. Block ids are b1, b2, ...
 */
export function notebookWithText(paras = ['Hello world'], opts = {}) {
  const content = buildNotebook(opts.notebook);
  const sid = content.tree.find(id => content.sections[id]);
  const pid = content.sections[sid].pages[0].id;
  let n = 0;
  const para = p => {
    const x = typeof p === 'string' ? {text: p} : p;
    const id = `b${++n}`;
    const text = x.text ?? '';
    const content = [];
    if (text) {
      if (x.marks?.length) {
        // One mark set over the whole text unless a range is given (from/to split into runs).
        const cuts = new Set([0, text.length]);
        for (const m of x.marks) { cuts.add(m.from ?? 0); cuts.add(m.to ?? text.length); }
        const pts = [...cuts].sort((a, b) => a - b);
        for (let i = 0; i < pts.length - 1; i++) {
          const marks = x.marks.filter(m => (m.from ?? 0) <= pts[i] && (m.to ?? text.length) >= pts[i + 1]).map(m => ({type: m.type, ...(m.attrs ? {attrs: m.attrs} : {})}));
          content.push({type: 'text', text: text.slice(pts[i], pts[i + 1]), ...(marks.length ? {marks} : {})});
        }
      } else content.push({type: 'text', text});
    }
    return {type: 'paragraph', attrs: {id, style: x.style ?? 'normal', align: x.align ?? null, indent: x.indent ?? 0, dir: null, tags: x.tags ?? [], spacing: null, audio: null}, ...(content.length ? {content} : {})};
  };
  const blocks = [];
  for (const p of paras) {
    const kind = typeof p === 'object' && p.list;
    const node = para(p);
    if (!kind) { blocks.push(node); continue; }
    const type = kind === 'ordered' ? 'orderedList' : 'bulletList';
    const last = blocks[blocks.length - 1];
    const item = {type: 'listItem', attrs: {id: `li${n}`}, content: [node]};
    if (last?.type === type) last.content.push(item);
    else blocks.push({type, attrs: type === 'orderedList' ? {id: `l${n}`, start: 1, format: p.format ?? 'decimal-period'} : {id: `l${n}`, symbol: p.symbol ?? 'disc'}, content: [item]});
  }
  content.pages[pid] = {...content.pages[pid], body: {type: 'doc', content: [{type: 'container', attrs: {id: 'c1', x: 48, y: 96, width: null}, content: blocks}]}};
  return {content, pageId: pid, sectionId: sid};
}

/** A selection from `/pg:<id>/b:<block>/t:<from>` to `.../t:<to>` (to defaults to from: a caret). */
export const textSel = (pageId, block, from, to = from, focusBlock = block) => ({
  ranges: [{anchor: `/pg:${pageId}/b:${block}/t:${from}`, focus: `/pg:${pageId}/b:${focusBlock}/t:${to}`}], primary: 0});

export async function textSession(paras, {selection, ...opts} = {}) {
  const built = notebookWithText(paras, opts);
  const t = await notebookSession(built.content, {selection: typeof selection === 'function' ? selection(built.pageId) : selection, prefs: opts.prefs, ...(opts.host ? {host: opts.host} : {})});
  t.pageId = built.pageId;
  t.sectionId = built.sectionId;
  t.select = sel => t.session.setSelection(t.docId, sel, {origin: 'test'});
  /** The page body's container blocks as JSON. */
  Object.defineProperty(t, 'blocks', {get: () => t.content.pages[built.pageId].body.content[0].content});
  return t;
}

export {NOW};
