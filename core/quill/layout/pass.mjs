// One layout pass: sections onto pages (starts, continuous breaks, columns and their balancing),
// blocks placed in order, endnotes, footnotes carried past the last page, headers and footers,
// page totals; plus the views (Print, Web, Draft, Read).
//
// Translated from wordcraft crates/layout/src/pass.rs (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c). Outline view places body paragraphs through
// outline.mjs (`place_block` with an `OutlinePass`). Not translated: vertical (turned)
// sections (`vertical.rs`), comment balloons for Print Markup (`balloons.rs`), floats above their
// anchors (`EarlyFloats` re-wrap passes).
import {Ctx, hidesDeleted} from './ctx.mjs';
import {PageBuilder, bodyTopFor, footTopFor} from './page.mjs';
import {placePara, cloneCounters} from './flow.mjs';
import {placeTable} from './table-flow.mjs';
import {layoutBox} from './boxes.mjs';
import {layoutTable} from './table.mjs';
import {HfLinks, bookmarkPages, headersFooters, headersFootersReferToPages, mirrorEvenPages, sectionSide} from './headers.mjs';
import {noteInfo, noteSeps, placeEndnotes} from './notes.mjs';
import {Totals, envKey} from './cache.mjs';
import {NO_GRID} from './para/lines.mjs';
import {itemBottom} from './placed.mjs';
import {gridLinePitch, gridCharPitch} from '../model/section.mjs';
import {outlinePass, placeOutlinePara} from './outline.mjs';

Ctx.prototype.layoutBox = function (input) { return layoutBox(this, input); };
Ctx.prototype.layoutTable = function (story, t, path, width, depth) { return layoutTable(this, story, t, path, width, depth); };

const modeOf = view => { const web = view === 'web' || view === 'draft' || view === 'outline'; return {web, reflow: web || view === 'read'}; };

/** The section's document grid (Grid::of). */
function gridOf(doc, s) {
  const line = gridLinePitch(s);
  if (line === null) return NO_GRID;
  const size = doc.resolveChar('Normal', {}).size;
  const fontSize = Number.isFinite(size) ? Math.max(1, Math.min(1584, size)) : 10.5;
  return {line, chars: gridCharPitch(s, fontSize), fontSize, snapAll: s.docGrid?.type === 'snapToChars'};
}

/** The blocks whose paragraph mark takes no room (section_marks): [stacked, quiet]. */
function sectionMarks(doc, opts, sections) {
  const stacked = new Set(), quiet = new Set();
  for (let i = 0; i + 1 < sections.length; i++) {
    if (sections[i + 1][1].start !== 'continuous') continue;
    const end = sections[i][0];
    const b = doc.body[end];
    if (!(b?.kind === 'para' && b.text.length === 0)) continue;
    const prev = doc.body[end - 1];
    if (prev?.kind === 'para' && prev.section && prev.text.length === 0) quiet.add(end); else stacked.add(end);
  }
  if (!opts.showHidden) doc.body.forEach((b, i) => { if (b.kind === 'para' && b.mark?.hidden === true && !b.text.replace(/￼/g, '').length) quiet.add(i); });
  return [stacked, quiet];
}

/** The page the continuous views lay out on (reflow_sect). */
function reflowSect(first, opts) {
  const s = {...first};
  s.pageW = Number.isFinite(opts.webWidth) ? Math.max(144, Math.min(20_000, opts.webWidth)) : 300;
  if (opts.view === 'read') {
    s.pageH = Number.isFinite(opts.readHeight) ? Math.max(144, Math.min(20_000, opts.readHeight)) : 500;
    s.marginBottom = 18;
    s.pageBorders = null;
    s.lineNumbers = null;
  }
  Object.assign(s, {marginLeft: 18, marginRight: 18, marginTop: 18, gutter: 0, columns: {count: 1, space: 36, separator: false, widths: []}, valign: 'top'});
  return s;
}

/** Where a section's pages start and end (section_tops). */
function sectionTops(ctx, hf, si, sect, fixed) {
  const heads = hf.heads[si], feet = hf.feet[si];
  const body = fixed ? sect.marginTop : bodyTopFor(ctx, sect, heads.default);
  const first = fixed || !sect.titlePage ? body : bodyTopFor(ctx, sect, heads.first);
  const foot = fixed ? Infinity : footTopFor(ctx, sect, feet.default);
  const firstFoot = fixed || !sect.titlePage ? foot : footTopFor(ctx, sect, feet.first);
  return {body, first, foot, firstFoot};
}

/**
 * One layout pass (layout_pass). Returns {again: Totals} when page totals in the body turned out
 * different, else {done: DocLayout}.
 */
export function layoutPass(doc, cache, opts, shaper, notePages, totals, mayRepeat) {
  const env = envKey(doc, opts, shaper);
  if (env !== cache.env) { cache.clear(); cache.env = env; }
  const ctx = new Ctx(doc, cache, opts, shaper);
  const notes = noteInfo(doc, hidesDeleted(opts, 'body'), notePages);
  ctx.notesHash = [...notes].sort((a, b) => a[0] - b[0]).map(([id, n]) => `${id}:${n.n}:${n.fmt}`).join(',');
  Object.assign(ctx.fields, {page: 1, pages: totals.pages, sectionPages: totals.section(0), section: 1, notes, title: doc.content.core?.title ?? '',
    author: doc.content.core?.creator ?? '', filename: opts.filename ?? '', filepath: opts.filepath ?? ''});
  const sections = doc.sections();
  const hf = new HfLinks(sections);
  const mode = modeOf(opts.view ?? 'print');
  ctx.mirror = !!doc.settings.mirrorMargins && !mode.reflow;
  [ctx.stackedMarks, ctx.quietMarks] = sectionMarks(doc, opts, sections);
  ctx.outline = opts.view === 'outline' ? outlinePass(doc, opts.outline ?? {}) : null;
  const firstSect = sections[0][1];
  const webSect = mode.reflow ? reflowSect(firstSect, opts) : null;
  const sectRef = webSect ?? firstSect;
  const pb = new PageBuilder(sectRef, mode.web);
  const endnotes = [...notes].filter(([id]) => doc.part(id)?.kind === 'endnote').map(([id, n]) => [n.order, id, n.section]).sort((a, b) => a[0] - b[0]).map(([, id, s]) => [id, s]);
  let block = 0;
  sections.forEach(([end, sect0], si) => {
    const sect = mode.reflow ? sectRef : sect0;
    const tops = sectionTops(ctx, hf, si, sect, mode.reflow);
    const start = si === 0 ? 'nextPage' : sect0.start;
    // begin_section_state
    pb.sect = sect;
    pb.sectIdx = si;
    pb.sectBeneath = doc.noteOptions(sect0, false).pos === 'beneathText';
    if (!mode.web && doc.content.footnoteSeparators && Object.keys(doc.content.footnoteSeparators).length) pb.seps = noteSeps(ctx, doc.content.footnoteSeparators, sect.pageW - sect.marginLeft - sect.marginRight - sect.gutter);
    ctx.fields.section = si + 1;
    ctx.fields.sectionPages = totals.section(si);
    ctx.grid = mode.reflow ? NO_GRID : gridOf(doc, sect);
    if (sect.lineNumbers?.restart === 'section') pb.lineNo = 0;
    if (mode.web && si > 0) { /* one long page */ } else if (!pb.pages.length || start !== 'continuous') {
      if (!mode.web) pb.takeBackBreakPage();
      const s = doc.settings;
      const [filler, restart] = sectionSide(start, sect0.pageNumStart ?? null, pb.number, pb.pages.length, !!s.evenOddHeaders, !!s.mirrorMargins);
      if (filler && !mode.web && si > 0) {
        const prev = sections[si - 1][1];
        pb.sect = prev; pb.sectIdx = si - 1;
        const top = bodyTopFor(ctx, prev, hf.heads[si - 1].default);
        pb.footTop = footTopFor(ctx, prev, hf.feet[si - 1].default);
        pb.newPage(block, top);
        pb.sect = sect; pb.sectIdx = si;
      }
      if (restart !== null) pb.restartAt = restart;
      pb.footTop = tops.firstFoot;
      pb.newPage(block, tops.first);
    } else {
      pb.cols = columnsOf(sect);
      pb.col = 0;
      pb.top = pb.textBottom();
      pb.y = pb.top;
      pb.maxY = pb.top;
    }
    pb.footTop = tops.foot;
    const last = Math.min(end, doc.body.length - 1);
    const next = sections[si + 1]?.[1]?.start ?? null;
    const balance = !mode.web && pb.cols.length > 1 && (pb.sect.valign ?? 'top') === 'top' && next === 'continuous';
    pb.colBreakPage = null;
    pb.nextStartsPage = !mode.web && next !== null && next !== 'continuous';
    block = placeSectionBlocks(ctx, pb, block, last, balance, tops.body);
    // Endnotes at the end of a section that keeps them there.
    if (doc.noteOptions(sect0, true).pos === 'sectEnd' && pb.pages.length) {
      const here = [];
      while (endnotes.length && endnotes[0][1] <= si) here.push(endnotes.shift()[0]);
      placeEndnotes(ctx, pb, here, Math.max(block - 1, 0));
    }
  });
  if (!pb.pages.length) pb.newPage(0, sectRef.marginTop);
  placeEndnotes(ctx, pb, endnotes.map(([id]) => id), block);
  // finish_pages
  pb.applyValign();
  pb.flushNotes();
  const lastBlock = Math.max(doc.body.length - 1, 0);
  for (let i = 0; i < 10_000 && pb.carry.length; i++) { pb.newPage(lastBlock, pb.top); pb.flushNotes(); }
  pb.carry = [];
  const pages = pb.pages;
  if (mode.web && pages[0]) {
    let bottom = 0;
    for (const it of pages[0].items) if (it.kind === 'lines') bottom = Math.max(bottom, itemBottom(it.y, it.para, it.l0, it.l1) ?? 0);
    pages[0].h = bottom + 36;
  }
  ctx.grid = NO_GRID;
  if (!mode.reflow) {
    const found = Totals.of(pages, sections);
    if (ctx.usesTotals && mayRepeat && !found.equals(totals)) return {again: found};
    ctx.trackTotals = false;
    if (headersFootersReferToPages(doc)) ctx.fields.bookmarkPages = bookmarkPages(doc, pages, sections);
    headersFooters(ctx, hf, pages, sections, found);
    if (doc.settings.mirrorMargins) mirrorEvenPages(pages, sections);
  }
  return {done: {pages, sections}, usesTotals: ctx.usesTotals};
}

function columnsOf(s) {
  const n = Math.max(1, Math.min(45, s.columns?.count ?? 1));
  // Same as the model's columnBoxes; inlined to keep PageBuilder the only caller of the page geometry.
  const tw = Math.max(s.pageW - s.marginLeft - s.marginRight - s.gutter, 18);
  const widths = s.columns?.widths ?? [];
  let boxes;
  if (widths.length && widths.length === n) {
    let x = 0;
    boxes = widths.map(([w, sp]) => { const b = [x, Math.max(w, 18)]; x += w + sp; return b; });
  } else {
    const space = Math.max(0, s.columns?.space ?? 36);
    const w = Math.max((tw - space * (n - 1)) / n, 18);
    boxes = Array.from({length: n}, (_, i) => [i * (w + space), w]);
  }
  return s.rtl ? boxes.map(([x, w]) => [tw - x - w, w]) : boxes;
}

function placeBlock(ctx, pb, block, bodyTop) {
  const b = ctx.doc.body[block];
  if (!b) return;
  const o = ctx.outline;
  if (o && b.kind === 'para') placeOutlinePara(ctx, pb, b, block, o);
  else if (o && o.hidden[block]) { /* a table under a collapsed heading */ }
  else if (b.kind === 'para') placePara(ctx, pb, b, block, bodyTop); else placeTable(ctx, pb, b, block, bodyTop);
}

/** Place blocks first..last, balancing the last page's columns if asked (place_section_blocks). */
function placeSectionBlocks(ctx, pb, block, last, balance, bodyTop) {
  let from = balance ? [block, snapTake(pb, ctx)] : null;
  while (block <= last && ctx.doc.body[block]) {
    const before = balance ? [pb.pages.length, snapTake(pb, ctx)] : null;
    pb.markBlock();
    placeBlock(ctx, pb, block, bodyTop);
    if (before && pb.pages.length !== before[0]) from = [block, before[1]];
    block++;
  }
  if (from) balanceColumns(ctx, pb, from[0], block, from[1], bodyTop);
  return block;
}

/** Pagination state before a block, to lay blocks out again from there (Snap). */
function snapTake(pb, ctx) {
  const pg = pb.pages[pb.pages.length - 1];
  return {pb: pb.clone(), pages: pb.pages.length, items: pg ? pg.items.length : 0, behind: pb.behind[pb.behind.length - 1] ?? 0,
    counters: cloneCounters(ctx.counters), eqCount: ctx.eqCount, page: ctx.fields.page};
}
function snapRestore(s, pb, ctx) {
  const pages = pb.pages, behind = pb.behind;
  pages.length = Math.min(pages.length, s.pages);
  behind.length = Math.min(behind.length, s.pages);
  const pg = pages[pages.length - 1];
  if (pg) {
    const k = Math.min(Math.max((behind[behind.length - 1] ?? 0) - s.behind, 0), pg.items.length);
    pg.items.splice(0, k);
    pg.items.length = Math.min(pg.items.length, s.items);
  }
  if (behind.length) behind[behind.length - 1] = s.behind;
  Object.assign(pb, s.pb.clone());
  pb.pages = pages;
  pb.behind = behind;
  ctx.counters = cloneCounters(s.counters);
  ctx.eqCount = s.eqCount;
  ctx.fields.page = s.page;
}

const BALANCE_MAX_PAGES = 16;
const BALANCE_PASSES = 12;

/** Balance the columns of a section's last page before a continuous break (balance_columns). */
function balanceColumns(ctx, pb, first, end, snap, bodyTop) {
  const page = pb.pages.length - 1;
  const ncols = Math.max(pb.cols.length, 1);
  const top = pb.top;
  const full = pb.uncappedBottom() - top;
  const used = Math.min(pb.contentBottom, pb.uncappedBottom()) - top;
  if (pb.colBreakPage === page || snap.pages === 0 || page + 1 - snap.pages > BALANCE_MAX_PAGES || used <= 1 || full <= 1 || pb.cols.length < 2) return;
  const pass = h => {
    snapRestore(snap, pb, ctx);
    pb.balance = [page, h];
    pb.capColumns();
    for (let b = first; b < end; b++) {
      if (!ctx.doc.body[b]) break;
      placeBlock(ctx, pb, b, bodyTop);
      if (pb.pages.length > page + 1) break;
    }
    pb.balance = null;
    pb.capColumns();
    return pb.pages.length === page + 1 && pb.contentBottom <= top + h + 0.5;
  };
  let lo = Math.max(used / ncols - 1, 0), hi = full, last = null;
  if (used < full - 0.5) { const ok = pass(used); if (ok) hi = used; last = [used, ok]; }
  for (let i = 0; i < BALANCE_PASSES && hi - lo > 1; i++) {
    const mid = (lo + hi) / 2;
    const ok = pass(mid);
    if (ok) hi = mid; else lo = mid;
    last = [mid, ok];
  }
  if (!(last && last[0] === hi && last[1])) { if (!pass(hi) && hi < full) pass(full); }
}
