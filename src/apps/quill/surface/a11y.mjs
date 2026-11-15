// The accessible mirror of the page view: the canvas draws pages as pictures, so the document under
// it is described as a tree a screen reader can read (paragraphs, headings with their level, list
// items grouped into lists with their markers, tables as table/row/cell, pictures by their alt text,
// links around their text, one text run per laid-out line). Only the pages on screen and one page
// either side are described, and the tree is capped, so a long document costs no more than a short one.
//
// Translated from wordcraft crates/ui-egui/src/a11y.rs (`page_window`, `build`, `Builder::container`,
// `para_node`, `paragraph`, MAX_NODES, MAX_RUN, MAX_DEPTH) at ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c. Upstream emits an AccessKit tree; here the same tree
// is plain data the page view renders as visually hidden DOM with ARIA roles.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

/** Most nodes described at once (a dense page has a few hundred). */
export const MAX_NODES = 6000;
/** A text run holds at most this many characters. */
export const MAX_RUN = 255;
/** Deepest table nesting described. */
export const MAX_DEPTH = 16;

const OBJ = '\uFFFC';
const BREAKS = /[\n\u000C\u000E]/g;

/** The pages to describe: those meeting the view band, and one either side (page_window). */
export function pageWindow(rects, top, height) {
  const first = rects.findIndex(r => r.y + r.h >= top && r.y <= top + height);
  if (first < 0) return null;
  let last = first;
  while (last + 1 < rects.length && rects[last + 1].y <= top + height) last++;
  return [Math.max(first - 1, 0), Math.min(last + 2, rects.length)];
}

/** Symbol-font bullets are private-use characters: say them as bullets. */
const markerText = s => [...s].map(c => (c >= '' && c <= '' ? '•' : c)).join('');

/**
 * Build the tree for pages [from, to) of `lay` (a DocLayout) over `doc` (a model Document).
 * Returns {nodes: Map<id, node>, top: id[], count}; a node is
 * {id, role: 'paragraph'|'heading'|'listitem'|'list'|'listmarker'|'table'|'row'|'cell'|'run'|'link'|'img',
 *  level?, text?, href?, alt?, rowIndex?, colIndex?, rows?, cols?, children: id[], path?, line?}.
 */
export function build(doc, lay, pages) {
  const nodes = new Map();
  const top = [];
  const lists = new Map();
  const full = () => nodes.size >= MAX_NODES;
  const add = (id, parent, node) => {
    if (nodes.has(id) || full()) return false;
    if (parent) { const pn = nodes.get(parent); if (!pn) return false; pn.children.push(id); } else top.push(id);
    nodes.set(id, {id, children: [], ...node});
    return true;
  };
  const key = p => p.join('.');
  const container = path => {
    if (path.length <= 1) return null;
    const n = path.length;
    if (n < 4 || n > MAX_DEPTH * 3 + 1) return undefined;
    const tpath = path.slice(0, n - 3), rpath = path.slice(0, n - 2), cpath = path.slice(0, n - 1);
    const row = path[n - 3], col = path[n - 2];
    const tid = `t${key(tpath)}`, rid = `r${key(rpath)}`, cid = `c${key(cpath)}`;
    if (!nodes.has(tid)) {
      const parent = container(tpath);
      if (parent === undefined) return undefined;
      const t = doc.table('body', tpath);
      add(tid, parent, {role: 'table', rows: t?.rows.length ?? 0, cols: t?.grid?.length ?? 0});
    }
    if (!nodes.has(rid)) add(rid, tid, {role: 'row', rowIndex: row});
    if (!nodes.has(cid)) add(cid, rid, {role: 'cell', rowIndex: row, colIndex: col});
    return nodes.has(cid) ? cid : undefined;
  };
  const paraNode = (path, pl) => {
    const id = `p${key(path)}`;
    if (nodes.has(id)) return id;
    const parent0 = container(path);
    if (parent0 === undefined) return null;
    const block = path[path.length - 1];
    const heading = pl.rp?.outlineLevel ?? null;
    const list = pl.rp?.numbering && pl.rp.numbering.num !== 0 && pl.label ? pl.rp.numbering : null;
    let parent = parent0;
    if (list && heading === null) {
      const ck = parent0 ?? 'doc';
      const cur = lists.get(ck);
      let lid;
      if (cur && cur.last + 1 === block && nodes.has(cur.id)) lid = cur.id;
      else { lid = `l${ck}:${block}`; if (!add(lid, parent0, {role: 'list'})) return null; }
      lists.set(ck, {id: lid, last: block});
      parent = lid;
    }
    const node = heading !== null && heading < 9 ? {role: 'heading', level: heading + 1}
      : list ? {role: 'listitem', level: list.level + 1} : {role: 'paragraph'};
    if (!add(id, parent, {...node, path})) return null;
    const label = pl.label?.runs?.map(r => r.shown).join('') ?? pl.label?.text ?? '';
    if (label.trim()) add(`${id}m`, id, {role: 'listmarker', text: markerText(label)});
    return id;
  };
  for (let pi = pages[0]; pi < pages[1] && !full(); pi++) {
    const page = lay.pages[pi];
    if (!page) continue;
    for (const it of page.items) {
      if (full()) break;
      if (it.kind !== 'lines' || it.story !== 'body') continue;
      const id = paraNode(it.path, it.para);
      if (!id) continue;
      const para = doc.para('body', it.path);
      if (!para) continue;
      const objects = new Map((para.objects ?? []).map((o, k) => [k, o]));
      const objIndex = new Map();
      let k = 0;
      for (let i = 0; i < para.text.length; i++) if (para.text[i] === OBJ) objIndex.set(i, k++);
      for (let li = it.l0; li < it.l1 && !full(); li++) {
        const ln = it.para.lines[li];
        if (!ln) continue;
        const text = para.text.slice(ln.start, ln.stop);
        // Split the line at links and pictures; long runs in pieces of MAX_RUN.
        let buf = '', link = null, start = ln.start;
        const flush = () => {
          if (!buf) return;
          const t = buf.replace(BREAKS, ' ');
          for (let o = 0; o < t.length; o += MAX_RUN) {
            const piece = t.slice(o, o + MAX_RUN);
            if (link) {
              const lid = `a${key(it.path)}:${start}`;
              if (!nodes.has(lid)) add(lid, id, {role: 'link', href: link});
              add(`${lid}:${o}`, lid, {role: 'run', text: piece, line: li});
            } else add(`s${key(it.path)}:${start + o}`, id, {role: 'run', text: piece, line: li});
          }
          buf = '';
        };
        for (let i = 0; i < text.length; i++) {
          const off = ln.start + i;
          const ch = text[i];
          const props = runProps(para, off);
          const l = props?.link ?? null;
          if (ch === OBJ) {
            flush();
            start = off + 1;
            const o = objects.get(objIndex.get(off));
            if (o && (o.type === 'image' || o.type === 'graphic')) add(`i${key(it.path)}:${off}`, id, {role: 'img', alt: o.alt ?? ''});
            continue;
          }
          if (l !== link) { flush(); link = l; start = off; }
          buf += ch;
        }
        flush();
      }
    }
  }
  return {nodes, top, count: nodes.size};
}

function runProps(p, off) {
  let at = 0;
  for (const r of p.runs ?? []) { if (off < at + r.len) return r.props ?? null; at += r.len; }
  return null;
}
