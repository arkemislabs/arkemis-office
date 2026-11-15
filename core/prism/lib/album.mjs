// Photo Album: the page layout, the plan of slides, and the album marker kept on its slides.
// Translated from deckcraft crates/engine/src/cmd/insert/album.rs (`album_layout`, `album_frame`, `album_plan`,
// `place_album`, `place_pictures`, `fit_in`, `album_marker`, `parse_album_mark`, `infer_album`) at 4ce2944.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// The marker is a slide tag named `arkemis-album` (name and value pairs survive a .pptx save as the slide's custom data);
// an album saved by deckcraft carries it as `deckcraft-album:…` in the slide's extension list, which this reader does not
// see, so such an album is found by its slides' name "Photo Album" instead (as deckcraft does for markerless albums).

export const MAX_ITEMS = 48;
export const MAX_BYTES = 32 * 1024 * 1024;
export const MAX_TOTAL = 64 * 1024 * 1024;
export const MAX_TEXT = 400;
export const TAG = 'arkemis-album';

export const LAYOUTS = Object.freeze({
  fit: {cols: 1, rows: 1, per: 1, title: false, fit: true},
  1: {cols: 1, rows: 1, per: 1, title: false, fit: false},
  '1title': {cols: 1, rows: 1, per: 1, title: true, fit: false},
  2: {cols: 2, rows: 1, per: 2, title: false, fit: false},
  '2title': {cols: 2, rows: 1, per: 2, title: true, fit: false},
  4: {cols: 2, rows: 2, per: 4, title: false, fit: false},
  '4title': {cols: 2, rows: 2, per: 4, title: true, fit: false},
});
export const FRAMES = Object.freeze(['none', 'rect', 'rounded', 'simple']);
export const LAYOUT_KEYS = Object.freeze(Object.keys(LAYOUTS));

const norm = s => String(s ?? '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();

/** `{layout key, layout}` from a name (`one`, `2 title`, `fit`…); null when unknown. */
export function layoutOf(name) {
  const k = norm(name);
  const alias = {one: '1', two: '2', four: '4', onetitle: '1title', twotitle: '2title', fourtitle: '4title'};
  const key = alias[k] ?? k;
  return LAYOUTS[key] ? {key, layout: LAYOUTS[key]} : null;
}

export function frameOf(name) {
  const k = norm(name);
  if (k === 'none') return 'none';
  if (k === 'rect' || k === 'rectangle') return 'rect';
  if (['rounded', 'round', 'roundedrect', 'roundedrectangle'].includes(k)) return 'rounded';
  if (['simple', 'simpleframe', 'simplewhite', 'white'].includes(k)) return 'simple';
  return null;
}

/** The outline each frame gives a picture (`apply_frame`). */
export const FRAME_LINE = Object.freeze({
  rect: {color: '#1A1A1A', width: 1.5},
  rounded: {color: '#1A1A1A', width: 2.25, join: 'round'},
  simple: {color: '#FFFFFF', width: 6},
});

/** Slides of the album: pictures batched `per` to a slide, a text item on a slide of its own (`album_plan`). */
export function plan(items, per) {
  const n = Math.max(1, per);
  const out = [];
  let batch = [];
  for (const it of items) {
    if (it.kind === 'text') {
      if (batch.length) { out.push({pictures: batch}); batch = []; }
      out.push({text: it.text});
    } else {
      batch.push(it);
      if (batch.length >= n) { out.push({pictures: batch}); batch = []; }
    }
  }
  if (batch.length) out.push({pictures: batch});
  return out;
}

/** `fit_in`: the largest `(w, h)` of aspect `px_w / px_h` inside a box. */
export function fitIn(boxW, boxH, pxW, pxH) {
  const aspect = pxH > 0 ? pxW / pxH : 4 / 3;
  const bw = Math.max(1, boxW), bh = Math.max(1, boxH);
  if (!Number.isFinite(aspect) || aspect <= 0) return [bw, bh];
  return aspect >= bw / bh ? [bw, Math.max(1, bw / aspect)] : [Math.max(1, bh * aspect), bh];
}

/** `place_album` + `place_pictures`: the title box and, per picture, its rectangle and caption rectangle. */
export function place(width, height, layout, pics, captions) {
  const margin = layout.fit ? 18 : 36;
  const titleBand = layout.title ? 48 : 0;
  const gap = 12, capH = 22, capGap = 4;
  const left = margin, top = margin + titleBand;
  const gridW = Math.max(1, width - margin - left), gridH = Math.max(1, height - margin - top);
  const cols = Math.max(1, layout.cols), rows = Math.max(1, layout.rows);
  const cellW = Math.max(1, (gridW - gap * (cols - 1)) / cols), cellH = Math.max(1, (gridH - gap * (rows - 1)) / rows);
  const picH = captions ? Math.max(1, cellH - capH - capGap) : cellH;
  const placed = [];
  pics.forEach((pic, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    if (row >= rows) return;
    const cx = left + col * (cellW + gap), cy = top + row * (cellH + gap);
    const [dw, dh] = fitIn(cellW, picH, pic.pxW, pic.pxH);
    const x = cx + (cellW - dw) / 2, y = cy + (picH - dh) / 2;
    placed.push({pic: [x, y, dw, dh], caption: captions ? [x, y + dh + 4, Math.max(36, dw), 22] : null});
  });
  return {title: layout.title ? [margin, 8, Math.max(1, width - 2 * margin), 32] : null, placed};
}

/** The text of a picture's file name without its extension (a caption). */
export function fileStem(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() || '';
  const i = base.lastIndexOf('.');
  const stem = i > 0 && i < base.length - 1 ? base.slice(0, i) : base;
  return stem || 'Picture';
}

/** The marker value: `id=7;layout=2;frame=none;captions=0;gray=0;theme=Office`. */
export function marker(id, o) {
  return `id=${id};layout=${o.layoutKey};frame=${o.frame};captions=${o.captions ? 1 : 0};gray=${o.grayscale ? 1 : 0};theme=${o.theme ?? ''}`;
}

/** The marker of a slide, or null. */
export function markOf(slide) {
  const raw = (slide?.tags ?? []).find(t => t?.[0] === TAG)?.[1];
  if (typeof raw !== 'string') return null;
  const out = {id: 0, layout: '', frame: '', captions: false, gray: false, theme: ''};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i), v = part.slice(i + 1);
    if (k === 'id') out.id = Number.parseInt(v, 10) || 0;
    else if (k === 'layout') out.layout = v;
    else if (k === 'frame') out.frame = v;
    else if (k === 'captions') out.captions = v === '1';
    else if (k === 'gray') out.gray = v === '1';
    else if (k === 'theme') out.theme = v;
  }
  return out.id ? out : null;
}

/** The slides of the album under the slide at `index` or with album id `id`: [{index, id}] and the album id (0: a run named "Photo Album"). */
export function albumOf(slides, index, id = 0) {
  if (id) {
    const hits = slides.map((s, i) => ({s, i})).filter(({s}) => markOf(s)?.id === id);
    return hits.length ? {id, slides: hits.map(({s, i}) => ({index: i, id: s.id}))} : null;
  }
  const cur = slides[index];
  if (!cur) return null;
  const m = markOf(cur);
  if (m) return albumOf(slides, index, m.id);
  if (cur.name !== 'Photo Album') return null;
  let a = index, b = index;
  while (a > 0 && slides[a - 1].name === 'Photo Album') a -= 1;
  while (slides[b + 1]?.name === 'Photo Album') b += 1;
  return {id: 0, slides: slides.slice(a, b + 1).map((s, k) => ({index: a + k, id: s.id}))};
}
