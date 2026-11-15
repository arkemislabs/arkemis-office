// Footnotes and endnotes: numbering, note boxes on the page that references them, splitting a
// long note across pages, endnotes at a section's or the document's end.
//
// Translated from wordcraft crates/layout/src/notes.rs (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c). The document's own separators
// (`footnoteSeparators`) are laid out from their part blocks when present.
import {CL} from './para/model.mjs';
import {leftOutObjects} from './floats.mjs';
import {layoutBox} from './boxes.mjs';
import {itemBottom, rect, vSpan} from './placed.mjs';
import {NOTE_SEP_W} from './para/paragraph.mjs';

/** Height of the default separator's band (NOTE_SEP). */
export const NOTE_SEP = 12;
export {NOTE_SEP_W};
/** The story of decoration items (line numbers) that belong to no story (DECOR_STORY). */
export const DECOR_STORY = 0xffffffff;
/** At most this many pages of note continuation (MAX_NOTE_PAGES). */
export const MAX_NOTE_PAGES = 10_000;
export const MAX_NOTE_PASSES = 3;
const SINGLE = w => ({style: 'single', width: w, color: null, space: 0});

/** Numbers of the notes, by part id (note_info): Map id -> {n, fmt, section, order}. */
export function noteInfo(doc, hideDeleted, pages) {
  const sections = doc.sections();
  const opts = sections.map(([, s]) => [doc.noteOptions(s, false), doc.noteOptions(s, true)]);
  const m = new Map();
  const last = [null, null];
  const order = [0, 0];
  let si = 0;
  const walk = (blocks, block, top) => {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const bi = top ? i : block;
      if (b.kind === 'table') { for (const r of b.rows) for (const c of r.cells) walk(c.blocks, bi, false); continue; }
      if (!b.objects?.length) continue;
      const gone = leftOutObjects(doc, b, null, true, hideDeleted);
      b.objects.forEach((o, k) => {
        if (gone(k)) return;
        if (o.type === 'shape' && o.story !== undefined && o.story !== null && doc.part(o.story)) walk(doc.part(o.story).blocks ?? [], bi, false);
        if (o.type !== 'noteRef') return;
        while (si + 1 < sections.length && bi > sections[si][0]) si++;
        const ki = o.kind === 'endnote' ? 1 : 0;
        const op = opts[si][ki];
        const page = ki === 0 ? pages.get(o.id) ?? null : null;
        let n;
        const prev = last[ki];
        if (!prev) n = op.numStart;
        else {
          const again = op.numRestart === 'eachSect' ? prev[1] !== si : op.numRestart === 'eachPage' ? page !== null && page !== prev[2] : false;
          n = again ? op.numStart : prev[0] + 1;
        }
        last[ki] = [n, si, page];
        order[ki]++;
        m.set(o.id, {n, fmt: op.numFmt, section: si, order: order[ki]});
      });
    }
  };
  walk(doc.body, 0, true);
  return m;
}

/** The page each footnote is placed on first (footnote_pages). */
export function footnotePages(doc, pages) {
  const m = new Map();
  pages.forEach((p, pi) => {
    for (const it of p.items) {
      if (it.story === 'body' || it.story === DECOR_STORY || (it.kind !== 'lines' && it.kind !== 'cell')) continue;
      if (doc.part(it.story)?.kind === 'footnote' && !m.has(it.story)) m.set(it.story, pi);
    }
  });
  return m;
}

/** The document's separators, laid out (NoteSeps): {sep, cont, notice} each [items, h] or null. */
export function noteSeps(ctx, seps, width) {
  const box = blocks => {
    if (!blocks?.length) return null;
    const b = layoutBox(ctx, {story: DECOR_STORY, blocks, prefix: [], width, cell: undefined, depth: 0, frame: null});
    return [b.items, b.height];
  };
  return {sep: box(seps?.separator), cont: box(seps?.continuationSeparator), notice: box(seps?.continuationNotice)};
}
export const sepH = (seps, cont) => { const s = cont ? seps.cont : seps.sep; return s ? s[1] : NOTE_SEP; };
export const noticeH = seps => (seps.notice ? seps.notice[1] : 0);

/** A footnote laid out for a page: {id, items, h, cont}. */
export function noteBox(id, items, h, cont = false) { return {id, items, h, cont}; }

function splittable(n, it) { return it.kind === 'lines' && it.story === n.id && it.path.length === 1; }

/** Heights a note can be cut at, between its lines (NoteBox::cuts). */
export function noteCuts(n) {
  const blocked = n.items.filter(it => !splittable(n, it) && it.kind !== 'fill' && it.kind !== 'rule').map(vSpan);
  let lastTop = -Infinity;
  const cuts = [];
  for (const it of n.items) {
    if (!splittable(n, it)) continue;
    const first = it.para.lines[it.l0];
    if (!first) continue;
    for (let k = it.l0; k < it.l1; k++) {
      const l = it.para.lines[k];
      lastTop = Math.max(lastTop, it.y + l.top - first.top);
      cuts.push(it.y + l.top - first.top + l.height);
    }
  }
  const ok = cuts.filter(b => b > 0.01 && b <= lastTop + 0.01 && !blocked.some(([t, e]) => t < b - 0.01 && e > b + 0.01)).sort((a, b) => a - b);
  const out = [];
  for (const c of ok) if (!out.length || Math.abs(out[out.length - 1] - c) >= 0.01) out.push(c);
  return out;
}
export const firstPiece = n => Math.min(noteCuts(n)[0] ?? n.h, n.h);

/** Split a note at `cut` (NoteBox::split): [head, tail]. */
export function splitNote(n, cut) {
  const head = [], tail = [];
  for (const it of n.items) {
    const [top, bottom] = vSpan(it);
    if (bottom <= cut + 0.01) { head.push(it); continue; }
    if (top >= cut - 0.01) { tail.push({...it}); continue; }
    if (it.kind === 'lines') {
      const ft = it.para.lines[it.l0].top;
      let k = it.l0;
      while (k < it.l1 && !(it.y + it.para.lines[k].top - ft + it.para.lines[k].height > cut + 0.01)) k++;
      const ky = it.para.lines[k] ? it.y + it.para.lines[k].top - ft : it.y;
      if (k > it.l0) head.push({...it, l1: k});
      if (k < it.l1) tail.push({...it, l0: k, y: ky});
    } else if (it.kind === 'fill') {
      head.push({...it, rect: rect(it.rect.x, it.rect.y, it.rect.w, cut - it.rect.y)});
      tail.push({...it, rect: rect(it.rect.x, cut, it.rect.w, it.rect.y + it.rect.h - cut)});
    } else if (it.kind === 'rule') {
      head.push({...it, y0: Math.min(it.y0, cut), y1: Math.min(it.y1, cut)});
      tail.push({...it, y0: Math.max(it.y0, cut), y1: Math.max(it.y1, cut)});
    } else head.push(it);
  }
  let start = Infinity;
  for (const it of tail) if (it.kind === 'lines') start = Math.min(start, vSpan(it)[0]);
  start = start === Infinity ? cut : Math.max(start, cut);
  for (const it of tail) {
    shiftIt(it, 0, -start);
    if (it.kind === 'fill' && it.rect.y < 0) it.rect = {...it.rect, h: Math.max(it.rect.h + it.rect.y, 0), y: 0};
  }
  return [noteBox(n.id, head, cut, n.cont), noteBox(n.id, tail, Math.max(n.h - start, 0), true)];
}
function shiftIt(it, dx, dy) {
  if (it.kind === 'lines') { it.x += dx; it.y += dy; } else if (it.kind === 'rule') { it.x0 += dx; it.x1 += dx; it.y0 += dy; it.y1 += dy; } else if (it.rect) it.rect = {...it.rect, x: it.rect.x + dx, y: it.rect.y + dy};
}

/** A note's box laid out `width` wide. */
export function layNote(ctx, id, width) {
  const part = ctx.doc.part(id);
  const b = layoutBox(ctx, {story: id, blocks: part?.blocks ?? [], prefix: [], width, cell: undefined, depth: 0, frame: null});
  return noteBox(id, b.items, b.height);
}

/** Endnotes placed after the text (place_endnotes). */
export function placeEndnotes(ctx, pb, ids, block) {
  if (!ids.length || pb.web) return;
  const width = pb.colW();
  const sep = ctx.doc.content.endnoteSeparators?.separator;
  if (sep?.length) {
    const b = layoutBox(ctx, {story: DECOR_STORY, blocks: sep, prefix: [], width, cell: undefined, depth: 0, frame: null});
    const x = pb.colX(), y = pb.y;
    for (const it of b.items) { shiftIt(it, x, y); pb.page().items.push(it); }
    pb.y += b.height;
  } else {
    pb.y += 12;
    const x = pb.colX(), ry = pb.y;
    pb.page().items.push({kind: 'rule', x0: x, y0: ry, x1: x + NOTE_SEP_W, y1: ry, border: SINGLE(0.5)});
    pb.y += 8;
  }
  let added = 0;
  for (const id of ids) {
    if (!ctx.doc.part(id)) continue;
    let note = layNote(ctx, id, pb.colW());
    for (;;) {
      const room = pb.bottom - pb.y;
      let cut = null;
      if (!(note.h <= room + 0.01 || added >= MAX_NOTE_PAGES)) {
        const cuts = noteCuts(note);
        let c = null;
        for (let i = cuts.length - 1; i >= 0; i--) if (cuts[i] <= room + 0.01) { c = cuts[i]; break; }
        if (c === null && pb.atTop() && cuts.length) c = cuts[0];
        if (c === null && !pb.atTop()) { pb.advance(block, pb.top); added++; continue; }
        cut = c;
      }
      let head = note, rest = null;
      if (cut !== null) [head, rest] = splitNote(note, cut);
      const x = pb.colX(), y = pb.y;
      for (const it of head.items) { const c = {...it}; shiftIt(c, x, y); pb.page().items.push(c); }
      pb.y += head.h;
      if (!rest) break;
      note = rest;
      pb.advance(block, pb.top);
      added++;
    }
  }
}

/** The note references of a paragraph by cluster index (para_notes). */
export function paraNotes(doc, p, pl) {
  const notes = pl.notes.slice();
  if ((p.objects ?? []).some(o => o.type === 'shape' && o.story !== undefined && o.story !== null)) {
    pl.clusters.forEach((c, ci) => {
      if (c.kind !== CL.OBJECT || c.obj < 0) return;
      const o = p.objects[c.obj];
      if (o?.type === 'shape' && o.story !== null && o.story !== undefined && !o.float?.hidden) {
        for (const n of notesInBox(doc, o.story)) notes.push([ci, n]);
      }
    });
  }
  return notes;
}
function notesInBox(doc, id) {
  const out = [];
  const walk = blocks => { for (const b of blocks ?? []) { if (b.kind === 'table') { for (const r of b.rows) for (const c of r.cells) walk(c.blocks); } else for (const o of b.objects ?? []) if (o.type === 'noteRef') out.push(o.id); } };
  walk(doc.part(id)?.blocks);
  return out;
}

/** Footnotes referenced in a table's rows placed on this page (table_notes). */
export function tableNotes(ctx, pb, items) {
  if (pb.web) return;
  const ids = [];
  for (const it of items) {
    if (it.kind !== 'lines' || it.story !== 'body') continue;
    const a = it.para.lines[it.l0], b = it.para.lines[it.l1 - 1];
    if (!a || !b) continue;
    for (const [ci, id] of it.para.notes) if (ci >= a.c0 && ci < b.c1 && !ids.includes(id) && !pb.notes.some(n => n.id === id)) ids.push(id);
  }
  const before = pb.notesH();
  for (const id of ids) {
    if (ctx.doc.part(id)?.kind !== 'footnote') continue;
    pb.notes.push(layNote(ctx, id, pb.textWidth()));
  }
  pb.bottom -= pb.notesH() - before;
}
export {itemBottom};
