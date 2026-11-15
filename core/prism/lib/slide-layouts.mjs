// Slide layouts for slide.new (U:prism/slide) over Prism's schema-1 content (960 × 540 pt slides,
// text elements). Placeholder positions translated from deckcraft crates/model/src/defaults.rs
// (Title Slide, Title and Content, Section Header, Two Content, Comparison, Title Only, Blank,
// Content with Caption, Picture with Caption) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Schema 1 has no masters or layout parts: a new slide records its layout kind in `slide.layout`
// and carries its placeholders as empty text elements marked `placeholder: <type>`.
// No DOM, no Node built-ins.

const TITLE = [60, 29, 840, 105];
const ink = '#202331', muted = '#5c6274';

/** deckcraft LayoutType names (slide.new `layout` accepts the kind or the layout's name). */
export const LAYOUTS = Object.freeze({
  title: {name: 'Title Slide', shapes: [
    {placeholder: 'ctrTitle', box: [120, 88, 720, 188], fontSize: 60, align: 'center'},
    {placeholder: 'subTitle', box: [120, 284, 720, 130], fontSize: 24, align: 'center', color: muted},
  ]},
  titleAndContent: {name: 'Title and Content', shapes: [
    {placeholder: 'title', box: TITLE, fontSize: 44},
    {placeholder: 'body', box: [60, 144, 840, 343], fontSize: 28},
  ]},
  sectionHeader: {name: 'Section Header', shapes: [
    {placeholder: 'title', box: [65, 135, 830, 225], fontSize: 60},
    {placeholder: 'body', box: [65, 362, 830, 118], fontSize: 24, color: muted},
  ]},
  twoContent: {name: 'Two Content', shapes: [
    {placeholder: 'title', box: TITLE, fontSize: 44},
    {placeholder: 'body', box: [60, 144, 412, 343], fontSize: 28},
    {placeholder: 'body', box: [488, 144, 412, 343], fontSize: 28},
  ]},
  comparison: {name: 'Comparison', shapes: [
    {placeholder: 'title', box: TITLE, fontSize: 44},
    {placeholder: 'body', box: [60, 133, 412, 62], fontSize: 24, bold: true},
    {placeholder: 'body', box: [60, 198, 412, 289], fontSize: 24},
    {placeholder: 'body', box: [488, 133, 412, 62], fontSize: 24, bold: true},
    {placeholder: 'body', box: [488, 198, 412, 289], fontSize: 24},
  ]},
  titleOnly: {name: 'Title Only', shapes: [{placeholder: 'title', box: TITLE, fontSize: 44}]},
  blank: {name: 'Blank', shapes: []},
  contentWithCaption: {name: 'Content with Caption', shapes: [
    {placeholder: 'title', box: [60, 36, 322, 126], fontSize: 32},
    {placeholder: 'body', box: [412, 78, 488, 384], fontSize: 28},
    {placeholder: 'body', box: [60, 162, 322, 300], fontSize: 16},
  ]},
  pictureWithCaption: {name: 'Picture with Caption', shapes: [
    {placeholder: 'title', box: [60, 36, 322, 126], fontSize: 32},
    {placeholder: 'pic', box: [412, 78, 488, 384], fontSize: 28},
    {placeholder: 'body', box: [60, 162, 322, 300], fontSize: 16},
  ]},
});

/** Resolve a layout given by kind (`titleAndContent`) or name (`Title and Content`), case-insensitively. */
export function findLayout(input) {
  if (typeof input !== 'string') return null;
  const want = input.trim().toLowerCase().replace(/[\s_-]+/g, '');
  for (const [kind, l] of Object.entries(LAYOUTS)) {
    if (kind.toLowerCase() === want || l.name.toLowerCase().replace(/[\s_-]+/g, '') === want) return kind;
  }
  return null;
}

/** The layout a schema-1 slide uses: its recorded kind, else title for the first slide, else titleAndContent. */
export const layoutOf = (slide, index) => slide?.layout && LAYOUTS[slide.layout] ? slide.layout : index === 0 ? 'title' : 'titleAndContent';

/**
 * A new slide on `layout` (deckcraft `defaults::new_slide`). `title` and `body` fill the title
 * and main body placeholders. `uid` mints element and slide ids.
 */
export function newSlide(layout, {uid, background = '#ffffff', title, body} = {}) {
  const elements = LAYOUTS[layout].shapes.map(sh => {
    const [x, y, w, h] = sh.box;
    const e = {id: uid(), type: 'text', placeholder: sh.placeholder, x, y, w, h, text: '', fontSize: sh.fontSize, color: sh.color ?? ink};
    if (sh.bold) e.bold = true;
    if (sh.align) e.align = sh.align;
    return e;
  });
  const titleEl = elements.find(e => e.placeholder === 'title' || e.placeholder === 'ctrTitle');
  if (title !== undefined && titleEl) titleEl.text = title;
  // deckcraft `body_placeholder`: the first body-like placeholder that is not the title.
  const bodyEl = elements.find(e => ['body', 'subTitle'].includes(e.placeholder) && e.w > 100 && e.h > 70);
  if (body !== undefined && bodyEl) bodyEl.text = body;
  return {id: uid(), layout, background, elements, notes: ''};
}
