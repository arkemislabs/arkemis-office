// SmartArt graphics WordCraft makes and edits (Insert › SmartArt): a layout, an outline of items
// (text and level) and a colour variant. A graphic object with `graphic.smartArt` set keeps this
// model next to the items it is drawn with.
// Translated from wordcraft crates/doc/src/smart_art.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// SmartArtSpec `{layout, items: [{text, level}], colors}`. Every value from outside goes through
// sanitizedSmartArt(). No DOM, no Node built-ins.

export const MAX_ITEMS = 100;
export const MAX_TEXT = 255;
export const MAX_LEVEL = 7;

const LAYOUTS = [
  ['basicList', 'Basic List', 'List', 'Shows items of equal weight as blocks in rows.'],
  ['process', 'Basic Process', 'Process', 'Shows steps in order, left to right, with arrows between them.'],
  ['cycle', 'Basic Cycle', 'Cycle', 'Shows steps that repeat, around a circle.'],
  ['hierarchy', 'Hierarchy', 'Hierarchy', 'Shows a tree: each item below the item it belongs to.'],
  ['pyramid', 'Basic Pyramid', 'Pyramid', 'Shows parts that build on each other, largest at the bottom.'],
  ['radial', 'Basic Radial', 'Relationship', 'Shows items around a central idea: the first item is the centre.'],
  ['matrix', 'Basic Matrix', 'Matrix', 'Shows parts of a whole as quadrants.'],
  ['venn', 'Basic Venn', 'Relationship', 'Shows overlapping ideas as overlapping circles.'],
];
export const SMART_ART_LAYOUTS = Object.freeze(LAYOUTS.map(l => l[0]));
const L = Object.fromEntries(LAYOUTS.map(([id, label, category, description]) => [id, {label, category, description}]));
export const smartArtLayoutLabel = id => L[id]?.label ?? L.basicList.label;
export const smartArtLayoutCategory = id => L[id]?.category ?? L.basicList.category;
export const smartArtLayoutDescription = id => L[id]?.description ?? L.basicList.description;

const norm = id => [...String(id ?? '')].filter(c => !/\s/u.test(c) && c !== '-' && c !== '_').join('').toLowerCase();
/** The layout an id names (case, hyphens, underscores and spaces ignored; `list` is the basic list). */
export function smartArtLayoutFromId(id) {
  const n = norm(id);
  if (n === 'list') return 'basicList';
  return SMART_ART_LAYOUTS.find(l => l.toLowerCase() === n || L[l].label.replace(/ /g, '').toLowerCase() === n) ?? null;
}

export const SMART_ART_COLORS = Object.freeze(['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'colorful']);
export const smartArtColorsLabel = c => (c === 'colorful' ? 'Colorful' : `Accent ${String(c).slice(6)}`);
export function smartArtColorsFromId(id) {
  const n = norm(id);
  return SMART_ART_COLORS.find(c => c === n || smartArtColorsLabel(c).replace(/ /g, '').toLowerCase() === n) ?? null;
}
/** The theme accent (1–6) of shape `i`. */
export const smartArtAccent = (colors, i) => (colors === 'colorful' ? (i % 6) + 1 : Number(String(colors).slice(6)) || 1);

const item = (text, level) => ({text, level});

/** A new graphic of `layout` with WordCraft's sample items. */
export function sampleSmartArt(layout = 'basicList') {
  let items;
  switch (layout) {
    case 'hierarchy': items = [item('Lead', 0), item('Design', 1), item('Sketches', 2), item('Build', 1), item('Code', 2), item('Tests', 2)]; break;
    case 'radial': items = [item('Goal', 0), ...['Plan', 'Build', 'Test', 'Ship'].map(t => item(t, 1))]; break;
    case 'process': case 'cycle': items = ['Plan', 'Build', 'Test', 'Ship'].map(t => item(t, 0)); break;
    case 'pyramid': case 'venn': items = ['People', 'Process', 'Tools'].map(t => item(t, 0)); break;
    case 'matrix': items = ['Strengths', 'Weaknesses', 'Chances', 'Risks'].map(t => item(t, 0)); break;
    default: items = ['Ideas', 'Notes', 'Drafts', 'Edits', 'Final'].map(t => item(t, 0));
  }
  return {layout, items, colors: 'accent1'};
}

/** `s` as item text: control characters as spaces, ends trimmed, at most MAX_TEXT characters. */
export function cleanSmartArtText(s) {
  const trimmed = String(s ?? '').replace(/^[\s\p{Cc}]+/u, '');
  return [...trimmed].slice(0, MAX_TEXT).map(c => (/\p{Cc}/u.test(c) ? ' ' : c)).join('').trimEnd();
}

/** At most MAX_ITEMS items, clean text, levels that follow on (first at 0, each at most one below the one before). */
export function sanitizedSmartArt(s0) {
  const layout = SMART_ART_LAYOUTS.includes(s0?.layout) ? s0.layout : 'basicList';
  const colors = SMART_ART_COLORS.includes(s0?.colors) ? s0.colors : 'accent1';
  let prev = null;
  const items = (s0?.items ?? []).slice(0, MAX_ITEMS).map(it => {
    const most = Math.min(prev === null ? 0 : Math.min(prev + 1, 255), MAX_LEVEL);
    const lvl = Math.max(0, Math.min(255, Math.trunc(Number(it?.level) || 0)));
    const level = Math.min(lvl, most);
    prev = level;
    return {text: cleanSmartArtText(it?.text), level};
  });
  return {layout, items, colors};
}

/** The index of the item each item belongs to (the nearest before it one level up); null at the top. */
export function smartArtParents(s) {
  const out = [];
  let last = [];
  s.items.forEach((it, i) => {
    const l = it.level;
    last = last.slice(0, l);
    out.push(l === 0 ? null : last[last.length - 1] ?? null);
    last.push(i);
  });
  return out;
}

/** The items under item `i` (directly or deeper): [start, end). */
export function smartArtDescendants(s, i) {
  const it = s.items[i];
  if (!it) return [0, 0];
  const start = i + 1;
  let end = s.items.length;
  for (let k = start; k < s.items.length; k++) if (s.items[k].level <= it.level) { end = k; break; }
  return [start, end];
}
