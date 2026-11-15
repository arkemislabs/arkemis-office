// Headers and footers: which one a page shows (first page, even page, default; linked to the
// previous section), laid out with that page's fields; sections on their odd/even side; bookmarks'
// pages for PAGEREF; mirrored margins on even pages.
//
// Translated from wordcraft crates/layout/src/headers.rs (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c). Not translated: STYLEREF in headers (`styleref.rs`),
// floating tables pinned to the page from a header (`with_pin`).
import {layoutBox} from './boxes.mjs';
import {pageBorderRules} from './page.mjs';
import {translate} from './placed.mjs';
import {textWidthOf} from './floats.mjs';
import {fieldName} from './fields.mjs';

/** Whether a section start needs a blank filler page, and the number the section restarts at (section_side). */
export function sectionSide(start, restart, last, pages, evenOdd, mirror) {
  if (start === 'oddPage' || start === 'evenPage') {
    const wantOdd = start === 'oddPage';
    const continuingOdd = (last + 1) % 2 === 1;
    const filler = pages > 0 && continuingOdd !== wantOdd && (restart === null || evenOdd || mirror);
    const r = restart === null ? null : (restart % 2 === 1) === wantOdd ? restart : restart + 1;
    return [filler, r];
  }
  if (start === 'nextPage') {
    const filler = evenOdd && pages > 0 && restart !== null && (restart % 2 === 1) !== ((pages + 1) % 2 === 1);
    return [filler, restart];
  }
  return [false, restart];
}

/** Headers/footers each section shows, linked to the previous section's where it has none (HfLinks/Linked). */
export class HfLinks {
  constructor(sections) {
    this.sections = sections;
    this.heads = linked(sections, s => s.headers);
    this.feet = linked(sections, s => s.footers);
  }
}
function linked(sections, get) {
  let prev = {default: null, first: null, even: null};
  return sections.map(([, s]) => {
    const o = get(s) ?? {};
    prev = {default: o.default ?? prev.default, first: o.first ?? prev.first, even: o.even ?? prev.even};
    return prev;
  });
}

/** Whether any header, footer or text box has a PAGEREF (headers_footers_refer_to_pages). */
export function headersFootersReferToPages(doc) {
  for (const part of Object.values(doc.parts)) {
    if (!['header', 'footer', 'textBox'].includes(part?.kind)) continue;
    let found = false;
    const walk = bl => { for (const b of bl ?? []) { if (b.kind === 'table') { for (const r of b.rows) for (const c of r.cells) walk(c.blocks); } else if ((b.objects ?? []).some(o => o.type === 'field' && fieldName(o.instr ?? '') === 'PAGEREF')) found = true; } };
    walk(part.blocks);
    if (found) return true;
  }
  return false;
}

/** Bookmark name -> [page number, format] of the page it starts on (bookmark_pages). */
export function bookmarkPages(doc, pages, sections) {
  const wanted = new Map();
  const seen = new Set();
  doc.body.forEach((b, i) => {
    if (b.kind !== 'para' || !(b.objects ?? []).some(o => o.type === 'bookmarkStart')) return;
    let k = 0;
    for (let off = 0; off < b.text.length; off++) {
      if (b.text[off] !== '￼') continue;
      const o = b.objects[k++];
      if (o?.type === 'bookmarkStart' && !seen.has(o.name)) { seen.add(o.name); if (!wanted.has(i)) wanted.set(i, []); wanted.get(i).push([o.name, off]); }
    }
  });
  const out = new Map();
  for (const page of pages) {
    if (!wanted.size) break;
    const fmt = sections[page.section]?.[1]?.pageNumFormat ?? 'decimal';
    for (const it of page.items) {
      if (it.kind !== 'lines' || it.story !== 'body' || it.path.length !== 1) continue;
      const marks = wanted.get(it.path[0]);
      if (!marks) continue;
      for (let m = marks.length - 1; m >= 0; m--) {
        const li = it.para.lineOf(marks[m][1]);
        if (li >= it.l0 && li < it.l1) { out.set(marks[m][0], [page.number, fmt]); marks.splice(m, 1); }
      }
      if (!marks.length) wanted.delete(it.path[0]);
    }
  }
  return out;
}

/** Lay out each page's header and footer (headers_footers). */
export function headersFooters(ctx, hf, pages, sections, totals) {
  const total = pages.length;
  const evenOdd = !!ctx.doc.settings.evenOddHeaders;
  const firstOfSection = new Set();
  const seen = new Set();
  pages.forEach((p, i) => { if (!seen.has(p.section)) { seen.add(p.section); firstOfSection.add(i); } });
  pages.forEach((page, i) => {
    const sect = sections[page.section]?.[1];
    if (!sect) return;
    const first = sect.titlePage && firstOfSection.has(i);
    const even = evenOdd && page.number % 2 === 0;
    const pick = set => (first ? set.first : even ? set.even ?? set.default : set.default);
    const hid = pick(hf.heads[page.section]), fid = pick(hf.feet[page.section]);
    page.hfSlot = first ? 'first' : even ? 'even' : 'default';
    Object.assign(ctx.fields, {page: page.number, pageFormat: sect.pageNumFormat ?? 'decimal', pages: total, sectionPages: totals.section(page.section),
      section: page.section + 1});
    const w = textWidthOf(sect);
    const x = sect.marginLeft + sect.gutter;
    if (hid !== null && hid !== undefined && ctx.doc.part(hid)) {
      const frame = {sect, origin: [x, sect.header], number: page.number, mirror: ctx.mirror};
      const b = layoutBox(ctx, {story: hid, blocks: ctx.doc.part(hid).blocks ?? [], prefix: [], width: w, cell: undefined, depth: 0, frame});
      page.header = b.items.map(it => translate(it, x, sect.header));
      page.headerStory = hid;
    }
    if (fid !== null && fid !== undefined && ctx.doc.part(fid)) {
      const blocks = ctx.doc.part(fid).blocks ?? [];
      const h = layoutBox(ctx, {story: fid, blocks, prefix: [], width: w, cell: undefined, depth: 0, frame: null}).height;
      const top = sect.pageH - sect.footer - h;
      const frame = {sect, origin: [x, top], number: page.number, mirror: ctx.mirror};
      const b = layoutBox(ctx, {story: fid, blocks, prefix: [], width: w, cell: undefined, depth: 0, frame});
      page.footer = b.items.map(it => translate(it, x, top));
      page.footerStory = fid;
    }
  });
}

/** Even pages of mirrored margins move over by the margins' difference (mirror_even_pages). */
export function mirrorEvenPages(pages, sections) {
  for (const page of pages) {
    if (page.number % 2 !== 0) continue;
    const s = sections[page.section]?.[1];
    if (!s) continue;
    const dx = s.marginRight - s.marginLeft - s.gutter;
    if (Math.abs(dx) < 0.001 || !Number.isFinite(dx)) continue;
    const borders = pageBorderRules(s).length;
    page.items.slice(borders).concat(page.header, page.footer).forEach(it => translate(it, dx, 0));
    page.body = {...page.body, x: page.body.x + dx};
  }
}
