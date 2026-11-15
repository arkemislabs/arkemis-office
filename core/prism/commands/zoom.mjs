// Insert > Zoom: Summary Zoom, Section Zoom and Slide Zoom.
// Translated from deckcraft crates/engine/src/cmd/zoom.rs (`zoom`, `grid`, `indices`) at 4ce2944. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// A zoom is a picture of the target slide that jumps to it in the slide show. With Return to Zoom (on for summary and section
// zooms, as in PowerPoint) the show comes back to the zoom slide after the target slide, or the target section's last slide
// (the link's `zoomReturn`, which core/prism/lib/show-state.mjs follows). In .pptx a zoom is saved as the linked picture.
// The picture is the slide drawn by the host (`ctx.host.renderSlides`, the slide view drawn to a PNG); a host without one
// (tests, headless) gets a plain page with the slide's title, in SVG.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {UPSTREAM_COMMIT, bad, hasSlide, addMedia, pictureFill, newId, selectIds, base64Decode} from '../lib/shape-common.mjs';
import {shape as newShape, slideTitle} from '../model/presentation.mjs';
import {currentSlideId} from '../model/doc.mjs';
import {selectSlideList} from '../lib/text-session.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/zoom.rs']};
const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** `n` tiles of `aspect` (w / h) in a centred grid inside `area` ({x, y, w, h}). */
export function grid(n, area, aspect) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, Math.ceil(n / cols));
  const gap = 12;
  const cw = (area.w - gap * (cols - 1)) / cols, ch = (area.h - gap * (rows - 1)) / rows;
  let [w, h] = cw / ch > aspect ? [ch * aspect, ch] : [cw, cw / aspect];
  // A single slide zoom is a quarter of the slide wide, as PowerPoint inserts it.
  if (n === 1) [w, h] = [Math.min(w, area.w / 2), Math.min(h, area.w / 2 / aspect)];
  const used = Math.min(cols, n);
  const totalW = used * w + gap * (used - 1), totalH = rows * h + gap * (rows - 1);
  const x0 = area.x + (area.w - totalW) / 2, y0 = area.y + (area.h - totalH) / 2;
  return Array.from({length: n}, (_, k) => ({x: x0 + (k % cols) * (w + gap), y: y0 + Math.floor(k / cols) * (h + gap), w, h}));
}

function indices(p, key, n, what) {
  const out = [];
  for (const x of Array.isArray(p[key]) ? p[key] : []) {
    if (!Number.isInteger(x) || x < 0 || x >= n) throw bad('insert.zoom', `there is no ${what} ${JSON.stringify(x)} (indices count from 0)`);
    if (!out.includes(x)) out.push(x);
  }
  return out;
}

/** The zoom tiles: [{slide id, index, last: id of the slide the show returns after}]. */
export function targetsOf(doc, kind, p) {
  const slides = doc.slides, n = slides.length, sections = doc.sections ?? [];
  const indexOf = id => slides.findIndex(x => x.id === id);
  if (kind === 'slide') return indices(p, 'slides', n, 'slide').map(i => ({slide: slides[i].id, index: i, last: slides[i].id}));
  if (kind === 'section') {
    return indices(p, 'sections', sections.length, 'section').flatMap(k => {
      const sec = sections[k];
      const first = sec.slides?.[0], last = sec.slides?.at(-1);
      return first && last && indexOf(first) >= 0 ? [{slide: first, index: indexOf(first), last}] : [];
    });
  }
  let starts = indices(p, 'slides', n, 'slide');
  // Default: the first slide of every section.
  if (!starts.length) starts = sections.flatMap(sec => (sec.slides?.[0] && indexOf(sec.slides[0]) >= 0 ? [indexOf(sec.slides[0])] : []));
  starts.sort((a, b) => a - b);
  return starts.map((i, k) => {
    const end = Math.max(i, k + 1 < starts.length ? starts[k + 1] - 1 : n - 1);
    return {slide: slides[i].id, index: i, last: slides[end].id};
  });
}

/** A plain page with the slide's title, as SVG, for a host that cannot draw the slide. */
function placeholder(doc, index) {
  const size = doc.slideSize ?? {width: 960, height: 540};
  const title = (slideTitle(doc.slides[index]) || '').split('\n')[0].trim() || `Slide ${index + 1}`;
  const w = 480, h = Math.round(480 * size.height / Math.max(size.width, 1));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#ffffff" stroke="#c8c8c8"/>`
    + `<text x="${w / 2}" y="${h / 2}" font-family="Calibri, sans-serif" font-size="${Math.max(14, Math.round(h / 9))}" fill="#333333" text-anchor="middle" dominant-baseline="central">${esc(title)}</text></svg>`;
  return {ct: 'image/svg+xml', bytes: new TextEncoder().encode(svg)};
}

async function pictures(ctx, targets) {
  const draw = ctx.host?.renderSlides;
  if (typeof draw === 'function') {
    try {
      const got = await draw(ctx.doc, targets.map(t => t.index), 480);
      if (Array.isArray(got) && got.length === targets.length) {
        return got.map((u, i) => {
          const m = /^data:([^;,]*);base64,(.*)$/.exec(String(u ?? ''));
          const bytes = m ? base64Decode(m[2]) : null;
          return bytes ? {ct: m[1] || 'image/png', bytes} : placeholder(ctx.doc, targets[i].index);
        });
      }
    } catch { /* drawn by the placeholder below */ }
  }
  return targets.map(t => placeholder(ctx.doc, t.index));
}

async function zoom(ctx, p) {
  const cmd = 'insert.zoom';
  const kind = p.kind ?? 'slide';
  if (!['slide', 'section', 'summary'].includes(kind)) throw bad(cmd, `unknown zoom kind \`${kind}\` (slide, section or summary)`);
  const doc = ctx.doc;
  const targets = targetsOf(doc, kind, p);
  if (!targets.length) throw bad(cmd, 'choose the slides (or sections) to zoom to');
  const back = typeof p.returnToZoom === 'boolean' ? p.returnToZoom : kind !== 'slide';
  const size = doc.slideSize ?? {width: 960, height: 540};
  const summary = kind === 'summary';
  const aspect = size.width / Math.max(size.height, 1);
  const area = summary ? {x: size.width * 0.06, y: size.height * 0.26, w: size.width * 0.88, h: size.height * 0.66}
    : targets.length === 1 ? {x: size.width * 0.5, y: size.height * 0.5, w: size.width * 0.45, h: size.height * 0.45}
      : {x: size.width * 0.08, y: size.height * 0.12, w: size.width * 0.84, h: size.height * 0.8};
  const boxes = grid(targets.length, area, aspect);
  const pics = await pictures(ctx, targets);
  const label = {summary: 'Summary', section: 'Section', slide: 'Slide'}[kind];
  const shapes = targets.map((t, k) => {
    const title = (slideTitle(doc.slides[t.index]) || '').split('\n')[0].trim();
    const tip = title || `Slide ${t.index + 1}`;
    const media = addMedia(ctx, cmd, `zoom-${t.index + 1}.${pics[k].ct === 'image/svg+xml' ? 'svg' : 'png'}`, pics[k].ct, pics[k].bytes);
    return newShape({id: newId(ctx, cmd), name: `${label} Zoom ${t.index + 1}`, descr: tip, xfrm: boxes[k], kind: {type: 'picture', fill: pictureFill(media, [0, 0, 0, 0])},
      click: {action: {kind: 'slide', slide: t.slide}, tooltip: tip, highlightClick: false, ...(back ? {zoomReturn: t.last} : {})}});
  });
  const ids = shapes.map(x => x.id);
  if (summary) {
    // A new Title Only slide before the first part, as PowerPoint makes it.
    const first = Math.min(...targets.map(t => t.index));
    const made = await ctx.run('slide.new', {layout: 'titleOnly', at: first, title: 'Summary'});
    const sl = ctx.doc.slides.find(x => x.id === made.id);
    ctx.change.splice(['slides', ctx.doc.slides.indexOf(sl), 'shapes'], sl.shapes.length, 0, ...shapes);
    selectSlideList(ctx, [made.id], made.id);
    selectIds(ctx, made.id, ids);
    return {kind, ids, returnToZoom: back, slide: made.index};
  }
  const cur = currentSlideId(ctx.doc, ctx.selection);
  const at = ctx.doc.slides.findIndex(x => x.id === cur);
  if (at < 0) throw bad(cmd, 'no slide');
  ctx.change.splice(['slides', at, 'shapes'], ctx.doc.slides[at].shapes.length, 0, ...shapes);
  selectIds(ctx, cur, ids);
  return {kind, ids, returnToZoom: back, slide: at};
}

export default defineCommands({
  family: 'zoom',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {id: 'insert.zoom', label: 'Zoom', risk: 'edit', state: hasSlide, dialog: 'dialog.insertZoom',
      description: '{kind?: slide|section|summary (default slide); slides?: [index] (slide and summary zooms); sections?: [index] (section zoom); returnToZoom?: bool (default: on for section and summary, off for slide)}',
      params: s.object({kind: s.optional(s.string({max: 16})), slides: s.optional(s.array(s.any(), {max: 10000})), sections: s.optional(s.array(s.any(), {max: 10000})),
        returnToZoom: s.optional(s.boolean())}),
      run: zoom},
  ],
});
