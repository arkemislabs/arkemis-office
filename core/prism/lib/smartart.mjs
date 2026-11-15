// SmartArt: a diagram's outline (the Text Pane) and the shapes generated from it.
// Translated from deckcraft crates/engine/src/cmd/smartart.rs (`LAYOUTS`, `STYLES`, `COLORS`, `category`, `MAX_LEVEL`), smartart/nodes.rs
// (`groups`, `normalize`, `add`, `remove`, `promote_node`, `demote_node`, `nodes_from_lines`), smartart/layout.rs (every `arm_*`),
// smartart/diagrams.rs (`hierarchy`, `org_chart`) and smartart/paint.rs (`accent`, `shade`, `paint`, `text_shape`, `deco`, `line_shape`,
// `picture_shape`, `fit_words`) at 4ce2944. MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// A SmartArt graphic is a group whose `diagram` ({kind, nodes: [{text, level, picture?, assistant?, title?}], colors, style}) holds its layout
// and its nodes. Every edit changes the nodes and regenerates the group's children inside the group's own rectangle, so the diagram keeps
// its size and place. Not translated: reading text typed straight into a diagram shape back into the nodes, and the 3-D scene of the
// Brick Scene style (its bevel is kept, its camera is not drawn).

import {shape as newShape, presetGeom} from '../model/presentation.mjs';
import {colorScheme, fillSolid, fillNone} from '../model/style.mjs';
import {shapeGeometry} from '../model/render.mjs';
import {svgPath} from '../model/geom/kurbo.mjs';
import {xfrmAffine} from '../model/geom/index.mjs';

export const MAX_LEVEL = 8;
export const MAX_NODES = 100;
const MAX_SHAPES = 40;

/** DeckCraft's layouts with the names PowerPoint's gallery gives them: [id, name]. */
const NAMES = [
  ['list', 'Vertical Bullet List'], ['blockList', 'Basic Block List'], ['hBulletList', 'Horizontal Bullet List'], ['process', 'Basic Process'],
  ['chevron', 'Basic Chevron Process'], ['verticalProcess', 'Vertical Process'], ['stepUp', 'Step Up Process'], ['cycle', 'Basic Cycle'],
  ['blockCycle', 'Block Cycle'], ['radial', 'Basic Radial'], ['hierarchy', 'Hierarchy'], ['pyramid', 'Basic Pyramid'],
  ['invertedPyramid', 'Inverted Pyramid'], ['matrix', 'Basic Matrix'], ['titledMatrix', 'Titled Matrix'], ['pictureList', 'Vertical Picture List'],
  ['pictureCaption', 'Picture Caption List'], ['pictureProcess', 'Picture Accent Process'], ['pictureHList', 'Horizontal Picture List'],
  ['timeline', 'Basic Timeline'], ['venn', 'Basic Venn'], ['target', 'Basic Target'], ['textCycle', 'Text Cycle'], ['continuousCycle', 'Continuous Cycle'],
  ['horizontalHierarchy', 'Horizontal Hierarchy'], ['gridMatrix', 'Grid Matrix'], ['gear', 'Gear'], ['funnel', 'Funnel'],
  ['segmentedCycle', 'Segmented Cycle'], ['multidirectionalCycle', 'Multidirectional Cycle'], ['orgChart', 'Organization Chart'],
  ['halfCircleOrgChart', 'Half Circle Organization Chart'], ['cycleMatrix', 'Cycle Matrix'], ['segmentedPyramid', 'Segmented Pyramid'],
  ['pie', 'Basic Pie'], ['nameTitleOrgChart', 'Name and Title Organization Chart'], ['verticalBoxList', 'Vertical Box List'],
  ['trapezoidList', 'Trapezoid List'], ['tableList', 'Table List'], ['accentProcess', 'Accent Process'],
  ['continuousBlockProcess', 'Continuous Block Process'], ['bendingProcess', 'Basic Bending Process'], ['linearVenn', 'Linear Venn'],
  ['stackedVenn', 'Stacked Venn'], ['nestedTarget', 'Nested Target'],
];
const CATEGORY = {
  picture: ['pictureList', 'pictureCaption', 'pictureProcess', 'pictureHList'],
  Process: ['process', 'chevron', 'verticalProcess', 'stepUp', 'timeline', 'gear', 'funnel', 'accentProcess', 'continuousBlockProcess', 'bendingProcess'],
  Cycle: ['cycle', 'blockCycle', 'textCycle', 'continuousCycle', 'segmentedCycle', 'multidirectionalCycle', 'pie'],
  Hierarchy: ['hierarchy', 'horizontalHierarchy', 'orgChart', 'halfCircleOrgChart', 'nameTitleOrgChart'],
  Relationship: ['radial', 'venn', 'target', 'linearVenn', 'stackedVenn', 'nestedTarget'],
  Matrix: ['matrix', 'titledMatrix', 'gridMatrix', 'cycleMatrix'],
  Pyramid: ['pyramid', 'invertedPyramid', 'segmentedPyramid'],
};
/** The gallery category of a layout (`category`). */
export function categoryOf(id) {
  if (CATEGORY.picture.includes(id)) return 'Picture';
  return Object.entries(CATEGORY).find(([k, v]) => k !== 'picture' && v.includes(id))?.[0] ?? 'List';
}
export const LAYOUTS = Object.freeze(NAMES.map(([id, name]) => [id, name, categoryOf(id)]));
export const LAYOUT_IDS = Object.freeze(LAYOUTS.map(l => l[0]));
export const CATEGORIES = Object.freeze(['All', 'List', 'Process', 'Cycle', 'Hierarchy', 'Relationship', 'Matrix', 'Pyramid', 'Picture']);
export const layoutName = id => LAYOUTS.find(l => l[0] === id)?.[1] ?? 'SmartArt';
const PICTURE_LAYOUTS = CATEGORY.picture;

/** SmartArt Styles: [id, name]. */
export const STYLES = Object.freeze([
  ['flat', 'Simple Fill'], ['subtle', 'Subtle Effect'], ['intense', 'Intense Effect'], ['outline', 'White Outline'], ['polished', 'Polished'],
  ['inset', 'Inset'], ['cartoon', 'Cartoon'], ['powder', 'Powder'], ['brick', 'Brick Scene'],
]);
export const STYLE_IDS = Object.freeze(STYLES.map(s => s[0]));

/** Change Colors: [id, name]. */
export const COLORS = Object.freeze([
  ['colorful', 'Colorful'], ['range23', 'Colorful Range - Accent Colors 2 to 3'], ['range34', 'Colorful Range - Accent Colors 3 to 4'],
  ['range45', 'Colorful Range - Accent Colors 4 to 5'], ['range56', 'Colorful Range - Accent Colors 5 to 6'],
  ...[1, 2, 3, 4, 5, 6].map(n => [`accent${n}`, `Accent ${n}`]), ...[1, 2, 3, 4, 5, 6].map(n => [`accent${n}Grad`, `Gradient Range - Accent ${n}`]),
]);
const ACCENTS = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];

// ---------------------------------------------------------------------------------------------
// The outline

const blank = (text = '', level = 0) => ({text, level});
/** `normalize`: the first node is level 0, none sits more than one level below the node before it, levels 0..MAX_LEVEL. Extra fields are kept. */
export function normalize(nodes) {
  let prev = -1;
  return nodes.map((n, i) => {
    const level = Math.max(0, Math.min(MAX_LEVEL, Math.min(Number.isFinite(n.level) ? Math.trunc(n.level) : 0, i === 0 ? 0 : prev + 1)));
    prev = level;
    return {...n, text: String(n.text ?? ''), level};
  });
}

/** `nodes_from_lines`: one node per line, each leading tab one level deeper. */
export function nodesFromLines(lines) {
  return normalize(lines.map(l => {
    const m = /^\t*/.exec(String(l))[0].length;
    return blank(String(l).slice(m).trim(), m);
  }));
}

/** Top-level groups: each level-0 node with the nodes under it (`groups`), as index lists. */
export function groups(nodes) {
  const out = [];
  nodes.forEach((n, i) => { if (n.level === 0 || !out.length) out.push([i]); else out.at(-1).push(i); });
  return out;
}

const subtreeEnd = (nodes, i) => { let j = i + 1; while (j < nodes.length && nodes[j].level > nodes[i].level) j += 1; return j; };

/** `add`: a node `position` (after | before | below | above | assistant) the node at `index`; returns {nodes, index}. */
export function addNode(nodes, index, position, text = '') {
  const list = nodes.map(n => ({...n}));
  if (!list.length) return {nodes: [blank(text)], index: 0};
  const i = Math.max(0, Math.min(list.length - 1, index ?? list.length - 1));
  const lv = list[i].level;
  let at, level;
  switch (position) {
    case 'before': at = i; level = lv; break;
    case 'above': at = i; level = Math.max(0, lv - 1); break;
    case 'below': case 'assistant': at = i + 1; level = Math.min(MAX_LEVEL, lv + 1); break;
    default: at = subtreeEnd(list, i); level = lv;
  }
  list.splice(at, 0, {...blank(text, level), ...(position === 'assistant' ? {assistant: true} : {})});
  return {nodes: normalize(list), index: at};
}

/** `remove`: the node goes and its sub-points move up one level. */
export function removeNode(nodes, index) {
  const list = nodes.map(n => ({...n}));
  if (index < 0 || index >= list.length) return null;
  const end = subtreeEnd(list, index);
  for (let k = index + 1; k < end; k++) list[k].level = Math.max(0, list[k].level - 1);
  list.splice(index, 1);
  return normalize(list);
}

/** `promote_node`: the node and its sub-points one level up; null at level 0. */
export function promote(nodes, index) {
  if (index < 0 || index >= nodes.length || nodes[index].level === 0) return null;
  const list = nodes.map(n => ({...n}));
  for (let k = index; k < subtreeEnd(list, index); k++) list[k].level -= 1;
  return normalize(list);
}

/** `demote_node`: the node and its sub-points one level down, under the node before it; null when it cannot. */
export function demote(nodes, index) {
  if (index <= 0 || index >= nodes.length || nodes[index].level > nodes[index - 1].level || nodes[index].level >= MAX_LEVEL) return null;
  const list = nodes.map(n => ({...n}));
  for (let k = index; k < subtreeEnd(list, index); k++) list[k].level += 1;
  return normalize(list);
}

export const defaultNodes = () => [blank('Text'), blank('Text'), blank('Text')];

// ---------------------------------------------------------------------------------------------
// Colours, styles and text (smartart/paint.rs)

/** The accent shape `i` is drawn in under Change Colors: `colorful` cycles the accents, `rangeAB` alternates two, `accentN` keeps one. */
export function accentSlot(colors, i) {
  const range = /^range(\d)/.exec(colors ?? '');
  if (range && +range[1] >= 1 && +range[1] <= 6) return ACCENTS[(+range[1] - 1 + (i % 2)) % 6];
  const one = /^accent(\d)/.exec(colors ?? '');
  if (one && +one[1] >= 1 && +one[1] <= 6) return ACCENTS[+one[1] - 1];
  return ACCENTS[i % 6];
}
/** Gradient Range: each shape a step darker than the one before (the steps cycle). */
const shadeOf = (colors, i) => (String(colors ?? '').endsWith('Grad') ? [{op: 'lumMod', val: 100000 - (i % 4) * 15000}] : []);
/** The colour reference of shape `i` under Change Colors (an accent, with the Gradient Range step when the colours are one). */
export const colorRef = (colors, i) => ref(accentSlot(colors, i), shadeOf(colors, i));
const ref = (slot, mods = []) => ({base: {kind: 'scheme', slot}, mods});
const ln = (color, width) => ({fill: fillSolid(color), width, dash: null, cap: null, join: null, compound: null, head: null, tail: null});
const noLine = () => ({fill: fillNone(), width: null, dash: null, cap: null, join: null, compound: null, head: null, tail: null});
const shadow = (blur, dist) => ({color: {base: {kind: 'rgb', rgb: {r: 0, g: 0, b: 0, a: 255}}, mods: [{op: 'alpha', val: 40000}]}, blur, dist, dir: 90, inner: false,
  sx: 1, sy: 1, kx: 0, ky: 0, align: 'tl', rotateWithShape: false});
const threeD = (bevel, w, h, camera) => `<a:scene3d><a:camera prst="${camera}"/><a:lightRig rig="threePt" dir="t"/></a:scene3d><a:sp3d prstMaterial="matte"><a:bevelT w="${Math.round(w * 12700)}" h="${Math.round(h * 12700)}" prst="${bevel}"/></a:sp3d>`;
export const is3d = style => ['polished', 'inset', 'cartoon', 'powder', 'brick'].includes(style);

/** Fill, outline, text colour and effects for the diagram's style; `light` shapes are a pale tint of the accent with dark text. */
function paint(d, sh, i, light) {
  const slot = accentSlot(d.colors, i);
  const base = ref(slot, shadeOf(d.colors, i));
  const tint = pct => ref(slot, [{op: 'lumMod', val: 100000 - pct * 1000}, {op: 'lumOff', val: pct * 1000}]);
  const style = d.style ?? 'flat';
  const dark = light || style === 'outline' || style === 'powder';
  if (light) { sh.fill = fillSolid(tint(80)); sh.line = ln(tint(60), 1); } else {
    switch (style) {
      case 'outline': sh.fill = fillSolid(ref('lt1')); sh.line = ln(base, 2.25); break;
      case 'subtle': sh.fill = fillSolid(base); sh.line = ln(ref('lt1'), 1.5); sh.effects = {outerShadow: shadow(4, 3)}; break;
      case 'polished': case 'inset': case 'cartoon': case 'powder': case 'brick': {
        const [bevel, bw, line, fill] = {polished: ['circle', 12, ln(ref('lt1'), 0.75), base], inset: ['relaxedInset', 10, null, base],
          cartoon: ['softRound', 8, ln(ref('tx1'), 2), base], powder: ['convex', 14, null, tint(40)], brick: ['slope', 6, ln(ref('lt1'), 1), base]}[style];
        sh.fill = fillSolid(fill);
        sh.line = line ?? noLine();
        sh.effects = {outerShadow: style === 'inset' ? null : shadow(6, 4), bevel, raw3d: threeD(bevel, bw, bw * 0.6, style === 'brick' ? 'isometricOffAxis2Top' : 'orthographicFront')};
        break;
      }
      case 'intense':
        sh.fill = {kind: 'gradient', stops: [{pos: 0, color: tint(30)}, {pos: 1, color: ref(slot, [...shadeOf(d.colors, i), {op: 'lumMod', val: 75000}])}],
          shape: {kind: 'linear', angle: 90, scaled: false}, rotateWithShape: true, tile: [0, 0, 0, 0]};
        sh.line = ln(ref('lt1'), 1);
        sh.effects = {outerShadow: shadow(8, 5)};
        break;
      default: sh.fill = fillSolid(base); sh.line = ln(ref('lt1'), 1.5);
    }
  }
  if (sh.text) {
    const c = ref(dark ? 'tx1' : 'lt1');
    for (const p of sh.text.paragraphs) for (const r of p.runs) r.props = {...r.props, fill: fillSolid(c)};
  }
}

/** The text of a shape: the first line the title (centred, larger), the rest bullets; with `title` false every line is a bullet. */
function textBodyOf(nodes, idx, title) {
  const lines = idx.map(k => nodes[k]).filter(Boolean);
  const top = lines.length ? (title ? lines[0].level : Math.max(0, lines[0].level - 1)) : 0;
  const paragraphs = lines.map((n, k) => {
    const head = title && k === 0;
    const level = head ? 0 : Math.min(MAX_LEVEL, Math.max(0, n.level - top - 1));
    const size = head ? 20 : 14;
    return {level, props: head ? {align: 'center', bullet: {kind: 'none'}} : {align: 'left', bullet: {kind: 'char', char: '•'}, marginLeft: 12 * (level + 1), indent: -10},
      runs: [{text: n.text, props: {size}}], endProps: {size}};
  });
  if (!paragraphs.length) paragraphs.push({level: 0, props: {align: 'center'}, runs: [{text: '', props: {size: 20}}], endProps: {size: 20}});
  return {body: {autofit: {kind: 'shrink', fontScale: 1, lineReduction: 0}, ...(title ? {anchor: 'middle'} : {anchor: 'top'})}, paragraphs};
}

/** Shrink the text so no word is wider than its line (fit_words): all paragraphs together; height is left to the autofit. */
function fitWords(sh) {
  const w = sh.xfrm?.w;
  if (!w || !sh.text) return;
  const textW = ['ellipse', 'gear6', 'gear9'].includes(sh.geom?.name) ? w * 0.71 : w;
  const b = sh.text.body;
  const avail = textW - (b.insetL ?? 7.2) - (b.insetR ?? 7.2);
  let scale = 1;
  for (const p of sh.text.paragraphs) {
    const line = avail - Math.max(0, p.props?.marginLeft ?? 0);
    for (const r of p.runs) {
      const word = Math.max(0, ...String(r.text).split(/\s+/).filter(Boolean).map(t => [...t].length));
      const need = word * (r.props.size ?? 18) * 0.6;
      if (need > 0) scale = Math.min(scale, Math.max(0, line) / need);
    }
  }
  scale = Math.max(scale, 0.25);
  if (scale >= 0.999) return;
  const shrink = v => (typeof v === 'number' ? Math.floor(v * scale * 2) / 2 : v);
  for (const p of sh.text.paragraphs) {
    for (const r of p.runs) r.props = {...r.props, size: shrink(r.props.size)};
    p.endProps = {...p.endProps, size: shrink(p.endProps?.size)};
    if (p.props?.marginLeft !== undefined) p.props = {...p.props, marginLeft: shrink(p.props.marginLeft)};
    if (typeof p.props?.indent === 'number') p.props = {...p.props, indent: p.props.indent * scale};
  }
}

// ---------------------------------------------------------------------------------------------
// The layouts (smartart/layout.rs, diagrams.rs): items are drafts {shape fields, nodes: [indexes]} that `build` turns into shapes

const X = (x, y, w, h, rot = 0, flipH = false) => ({x, y, w, h, rot, flipH});
const rad = deg => (deg * Math.PI) / 180;

class L {
  constructor(d, area) {
    this.d = d; this.area = area; this.gs = groups(d.nodes); this.n = Math.max(1, this.gs.length); this.nf = this.n; this.out = [];
  }
  /** A titled text shape for top-level group `i` (its nodes `g`), painted in accent `i`. */
  titled(preset, x, i, g, o = {}) { this.out.push({preset, x, nodes: g, title: true, accent: i, ...o}); }
  /** A text shape of the given nodes. */
  text(preset, x, g, i, o = {}) { this.out.push({preset, x, nodes: g, accent: i, ...o}); }
  deco(preset, x, i, o = {}) { this.out.push({preset, x, nodes: [], deco: true, accent: i, light: true, ...o}); }
  arrow(x, rot, i, light = true) { this.deco('rightArrow', {...x, rot, flipH: false}, i, {light}); }
  line(a, b) { this.out.push({preset: 'line', x: X(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 0, (b[0] < a[0]) !== (b[1] < a[1])), nodes: [], connector: true, accent: 0}); }
  picture(preset, x, i, node) { this.out.push({preset, x, nodes: [], picture: node, accent: i, light: true}); }
}
const clearBox = {plain: true};

const ARMS = {
  list(l) { // Vertical / Horizontal Bullet List: a coloured title bar, sub-points in a pale box below.
    const {area, gs, nf} = l;
    const vertical = l.d.kind === 'list';
    gs.forEach((g, i) => {
      const cell = vertical ? X(area.x, area.y + i * area.h / nf, area.w, area.h / nf * 0.92) : X(area.x + i * area.w / nf + area.w / nf * 0.03, area.y, area.w / nf * 0.94, area.h);
      const barH = Math.min(cell.h, vertical ? Math.max(18, Math.min(area.h / nf * 0.92, area.h * 0.12)) : area.h * 0.22);
      l.titled('roundRect', X(cell.x, cell.y, cell.w, barH), i, g.slice(0, 1));
      if (g.length > 1) {
        const pad = cell.w * 0.03;
        l.text('rect', X(cell.x + pad, cell.y + barH, cell.w - 2 * pad, Math.max(1, cell.h - barH)), g.slice(1), i, {light: true});
      }
    });
  },
  blockList(l) {
    const {area, gs, n, nf} = l;
    const cols = Math.max(1, Math.min(n, Math.ceil(Math.sqrt(nf * area.w / Math.max(area.h, 1) / 1.6))));
    const rows = Math.ceil(n / cols);
    const [w, h] = [area.w / cols, area.h / rows];
    const [bw, bh] = [w * 0.9, Math.min(h * 0.85, w * 0.9 * 0.6)];
    gs.forEach((g, i) => {
      const [c, r] = [i % cols, Math.floor(i / cols)];
      const inRow = r + 1 === rows ? n - r * cols : cols;
      const x0 = area.x + (area.w - inRow * w) / 2;
      l.titled('rect', X(x0 + c * w + (w - bw) / 2, area.y + r * h + (h - bh) / 2, bw, bh), i, g);
    });
  },
  process(l) {
    const {area, gs, n, nf} = l;
    const chevron = l.d.kind === 'chevron';
    const gap = chevron ? -area.w * 0.02 : area.w * 0.06;
    const w = Math.max(1, (area.w - gap * (nf - 1)) / nf);
    const h = Math.min(area.h * 0.5, w * (chevron ? 0.45 : 0.65));
    const y = area.y + (area.h - h) / 2;
    gs.forEach((g, i) => {
      const x = area.x + i * (w + gap);
      l.titled(chevron ? 'chevron' : 'roundRect', X(x, y, w, h), i, g);
      if (!chevron && i + 1 < n) { const aw = gap * 0.7; l.arrow(X(x + w + gap * 0.15, y + h / 2 - aw * 0.45, aw, aw * 0.9), 0, i); }
    });
  },
  verticalProcess(l) {
    const {area, gs, n, nf} = l;
    const gap = area.h * 0.06;
    const h = Math.max(1, (area.h - gap * (nf - 1)) / nf);
    const w = area.w * 0.6;
    const x = area.x + (area.w - w) / 2;
    gs.forEach((g, i) => {
      const y = area.y + i * (h + gap);
      l.titled('roundRect', X(x, y, w, h), i, g);
      if (i + 1 < n) { const s = gap * 0.8; l.arrow(X(area.x + area.w / 2 - s / 2, y + h + gap * 0.1, s, s), 90, i); }
    });
  },
  stepUp(l) {
    const {area, gs, nf} = l;
    const w = area.w / nf;
    const h = area.h / (nf + 1) * 1.6;
    gs.forEach((g, i) => l.titled('rect', X(area.x + i * w + w * 0.04, area.y + area.h - h - i * (area.h - h) / Math.max(nf - 1, 1), w * 0.92, h), i, g));
  },
  cycle(l) {
    const {area, gs, n, nf} = l;
    const block = l.d.kind === 'blockCycle';
    const r = Math.min(area.h, area.w) * 0.36;
    const [cx, cy] = [area.x + area.w / 2, area.y + area.h / 2];
    const dd = Math.min(r * (block ? 0.75 : 0.8), 2 * Math.PI * r / nf * 0.62);
    gs.forEach((g, i) => {
      const a = rad(i / nf * 360 - 90);
      const [w, h] = block ? [dd * 1.3, dd * 0.75] : [dd, dd];
      l.titled(block ? 'roundRect' : 'ellipse', X(cx + r * Math.cos(a) - w / 2, cy + r * Math.sin(a) - h / 2, w, h), i, g);
      if (n > 1) {
        const m = rad((i + 0.5) / nf * 360 - 90);
        const s = Math.max(8, dd * 0.42);
        // Solid accent arrows (a pale tint all but vanishes on white), a little larger than before.
        l.arrow(X(cx + r * Math.cos(m) - s / 2, cy + r * Math.sin(m) - s * 0.4, s, s * 0.8), (i + 0.5) / nf * 360, i, false);
      }
    });
  },
  radial(l) {
    const {area, gs} = l;
    const [centre, ...rest] = gs;
    if (!centre) return;
    const m = Math.max(1, rest.length);
    const r = Math.min(area.h, area.w) * 0.36;
    const [cx, cy] = [area.x + area.w / 2, area.y + area.h / 2];
    const dc = r * 0.75;
    const dd = Math.min(r * 0.75, 2 * Math.PI * r / m * 0.7);
    rest.forEach((_, k) => {
      const a = rad(k / m * 360 - 90);
      l.line([cx + dc / 2 * Math.cos(a), cy + dc / 2 * Math.sin(a)], [cx + (r - dd / 2) * Math.cos(a), cy + (r - dd / 2) * Math.sin(a)]);
    });
    l.titled('ellipse', X(cx - dc / 2, cy - dc / 2, dc, dc), 0, centre);
    rest.forEach((g, k) => { const a = rad(k / m * 360 - 90); l.titled('ellipse', X(cx + r * Math.cos(a) - dd / 2, cy + r * Math.sin(a) - dd / 2, dd, dd), k + 1, g); });
  },
  pyramid(l) {
    const {area, gs, nf} = l;
    const inverted = l.d.kind === 'invertedPyramid';
    const h = area.h / nf;
    // Sub-points do not fit inside a narrow tier: the pyramid moves left and each tier's sub-points are listed beside it.
    const kids = gs.some(g => g.length > 1);
    const pw = Math.min(area.h, kids ? area.w * 0.5 : area.w) * (kids ? 1 : 1.15);
    const px = kids ? area.x + area.w * 0.02 : area.x + (area.w - pw) / 2;
    gs.forEach((g, i) => {
      const [a, b] = [i / nf, (i + 1) / nf];
      const [t, bt] = inverted ? [1 - a, 1 - b] : [a, b];
      const [wt, wb] = [pw * t, pw * bt];
      const w = Math.max(wt, wb, 1);
      const bh = h * 0.96;
      const [it, ib] = [(w - wt) / 2, (w - wb) / 2];
      const tip = Math.min(wt, wb) < 1e-6;
      const inset = tip ? w * 0.22 : (it + ib) / 2 + Math.abs(it - ib) / 4 + 4;
      if (kids && g.length > 1) l.text('rect', X(px + pw + area.w * 0.03, area.y + i * h, Math.max(1, area.x + area.w - (px + pw + area.w * 0.03)), bh), g.slice(1), i, {plain: true, light: true, align: 'left', anchor: 'middle'});
      l.titled('rect', X(px + (pw - w) / 2, area.y + i * h, w, bh), i, kids ? g.slice(0, 1) : g, {
        custom: `M ${it.toFixed(2)} 0 L ${(w - it).toFixed(2)} 0 L ${(w - ib).toFixed(2)} ${bh.toFixed(2)} L ${ib.toFixed(2)} ${bh.toFixed(2)} Z`, inset: {l: inset, r: inset},
        ...(tip ? {anchor: inverted ? 'top' : 'bottom'} : {}),
      });
    });
  },
  matrix(l) {
    const {area, gs} = l;
    const titled = l.d.kind === 'titledMatrix';
    const s = Math.min(area.h, area.w);
    const [x0, y0] = [area.x + (area.w - s) / 2, area.y + (area.h - s) / 2];
    const [quads, title] = titled ? [gs.slice(1), gs[0]] : [gs, null];
    quads.slice(0, 4).forEach((g, i) => l.titled('roundRect', X(x0 + (i % 2) * s / 2 + 3, y0 + Math.floor(i / 2) * s / 2 + 3, s / 2 - 6, s / 2 - 6), i + (titled ? 1 : 0), g));
    if (title) { const c = s * 0.42; l.titled('roundRect', X(x0 + (s - c) / 2, y0 + (s - c * 0.6) / 2, c, c * 0.6), 0, title, {light: true}); }
  },
  pictureList(l) {
    const {area, gs, nf} = l;
    const h = area.h / nf;
    const bh = h * 0.88;
    gs.forEach((g, i) => {
      const y = area.y + i * h;
      const s = Math.min(bh, area.w * 0.3);
      l.picture('rect', X(area.x, y, s, bh), i, g[0]);
      l.titled('roundRect', X(area.x + s + bh * 0.08, y, Math.max(1, area.w - s - bh * 0.08), bh), i, g);
    });
  },
  pictureCaption(l) {
    const {area, gs, n, nf} = l;
    const process = l.d.kind === 'pictureProcess';
    const cols = process ? n : Math.max(1, Math.min(n, Math.ceil(Math.sqrt(nf * area.w / Math.max(area.h, 1) / 1.2))));
    const rows = Math.ceil(n / cols);
    const gap = process ? area.w * 0.05 : 0;
    const w = (area.w - gap * (cols - 1)) / cols;
    const h = area.h / rows;
    const bw = process ? w : w * 0.9;
    const ch = Math.min(h * 0.9, bw * 1.1);
    gs.forEach((g, i) => {
      const [c, r] = [i % cols, Math.floor(i / cols)];
      const inRow = r + 1 === rows ? n - r * cols : cols;
      const x0 = area.x + (area.w - inRow * w - gap * (inRow - 1)) / 2;
      const x = x0 + c * (w + gap) + (w - bw) / 2;
      const y = area.y + r * h + (h - ch) / 2;
      const ph = ch * 0.62;
      l.picture(process ? 'ellipse' : 'rect', X(x + (bw - Math.min(ph, bw)) / 2, y, Math.min(ph, bw), ph), i, g[0]);
      l.titled(process ? 'roundRect' : 'rect', X(x, y + ph + ch * 0.03, bw, ch * 0.35), i, g);
      if (process && i + 1 < n) { const a = Math.min(gap * 0.7, ch * 0.2); l.arrow(X(x + bw + (gap - a) / 2, y + ph / 2 - a / 2, a, a), 0, i); }
    });
  },
  textCycle(l) {
    const {area, gs, n, nf} = l;
    const textOnly = l.d.kind === 'textCycle';
    const r = Math.min(area.h, area.w) * 0.36;
    const [cx, cy] = [area.x + area.w / 2, area.y + area.h / 2];
    const dd = Math.min(r * 0.8, 2 * Math.PI * r / nf * 0.62);
    if (!textOnly) { const ring = r * 2 + dd * 0.3; l.deco('donut', X(cx - ring / 2, cy - ring / 2, ring, ring), 0, {adj: [7000]}); }
    gs.forEach((g, i) => {
      const a = rad(i / nf * 360 - 90);
      const [w, h] = [dd * 1.35, dd * 0.7];
      l.titled('roundRect', X(cx + r * Math.cos(a) - w / 2, cy + r * Math.sin(a) - h / 2, w, h), i, g, textOnly ? {plain: true, textTint: 75000} : {});
      if (textOnly && n > 1) { const m = rad((i + 0.5) / nf * 360 - 90); const s = Math.max(6, dd * 0.3); l.arrow(X(cx + r * Math.cos(m) - s / 2, cy + r * Math.sin(m) - s * 0.4, s, s * 0.8), (i + 0.5) / nf * 360, i); }
    });
  },
  segmentedCycle(l) {
    const {area, gs, nf} = l;
    const ring = l.d.kind === 'segmentedCycle';
    const s = Math.min(area.h, area.w);
    const [cx, cy] = [area.x + area.w / 2, area.y + area.h / 2];
    const gap = ring ? 2 : 0;
    gs.forEach((g, i) => {
      const a0 = i / nf * 360 - 90 + gap / 2, a1 = (i + 1) / nf * 360 - 90 - gap / 2;
      const ang = a => Math.round((((a % 360) + 360) % 360) * 60000);
      l.deco(ring ? 'blockArc' : 'pie', X(cx - s / 2, cy - s / 2, s, s), i, {light: false, adj: ring ? [ang(a0), ang(a1), 25000] : [ang(a0), ang(a1)]});
      const m = rad((a0 + a1) / 2);
      const rr = ring ? s * 0.4375 : s * 0.3;
      const tw = Math.min(s * (ring ? 0.22 : 0.3), Math.PI * 2 * rr / nf * 0.9);
      const th = s * 0.16;
      l.titled('rect', X(cx + rr * Math.cos(m) - tw / 2, cy + rr * Math.sin(m) - th / 2, tw, th), i, g, clearBox);
    });
  },
  multidirectionalCycle(l) {
    const {area, gs, n, nf} = l;
    const r = Math.min(area.h, area.w) * 0.36;
    const [cx, cy] = [area.x + area.w / 2, area.y + area.h / 2];
    const dd = Math.min(r * 0.75, 2 * Math.PI * r / nf * 0.55);
    gs.forEach((g, i) => {
      const a = rad(i / nf * 360 - 90);
      l.titled('roundRect', X(cx + r * Math.cos(a) - dd * 0.65, cy + r * Math.sin(a) - dd * 0.4, dd * 1.3, dd * 0.8), i, g);
      if (n > 1) { const m = rad((i + 0.5) / nf * 360 - 90); const s = Math.max(8, dd * 0.5); l.deco('leftRightArrow', X(cx + r * Math.cos(m) - s / 2, cy + r * Math.sin(m) - s * 0.2, s, s * 0.4, (i + 0.5) / nf * 360), i); }
    });
  },
  cycleMatrix(l) {
    const {area, gs} = l;
    const s = Math.min(area.h, area.w);
    const [cx, cy] = [area.x + area.w / 2, area.y + area.h / 2];
    const c = s * 0.56;
    gs.slice(0, 4).forEach((g, i) => {
      const [sx, sy] = [[-1, 1, 1, -1][i], [-1, -1, 1, 1][i]];
      const b = s * 0.4;
      if (g.length > 1) {
        l.text('roundRect', X(cx + (sx < 0 ? -s / 2 : s / 2 - b), cy + (sy < 0 ? -s / 2 : s / 2 - b), b, b), g.slice(1), i, {light: true, anchor: sy < 0 ? 'top' : 'bottom', inset: {l: sx > 0 ? b * 0.35 : 6, r: sx < 0 ? b * 0.35 : 6}});
      }
    });
    gs.slice(0, 4).forEach((g, i) => {
      const [sx, sy] = [[-1, 1, 1, -1][i], [-1, -1, 1, 1][i]];
      const a0 = [180, 270, 0, 90][i] + 1.5;
      l.deco('pie', X(cx - c / 2, cy - c / 2, c, c), i, {light: false, adj: [Math.round(a0 * 60000), Math.round((a0 + 87) * 60000)]});
      const q = c * 0.3;
      l.titled('rect', X(cx + sx * c * 0.2 - q / 2, cy + sy * c * 0.2 - q / 2, q, q), i, g.slice(0, 1), clearBox);
    });
  },
  segmentedPyramid(l) {
    const {area, gs, nf} = l;
    const rows = Math.max(1, Math.ceil(Math.sqrt(nf)));
    const s = Math.min(area.h, area.w / 1.15);
    const pw = s * 1.15;
    const [x0, y0] = [area.x + (area.w - pw) / 2, area.y + (area.h - s) / 2];
    const [tw, th] = [pw / rows, s / rows];
    let k = 0;
    for (let r = 0; r < rows; r++) {
      const left = x0 + pw / 2 - (r + 1) * tw / 2;
      for (let c = 0; c < 2 * r + 1; c++) {
        const g = gs[k];
        if (!g) return;
        const up = c % 2 === 1;
        l.titled('rect', X(left + c * tw / 2, y0 + r * th, tw, th), k, g, {
          custom: up ? `M 0 0 L ${tw.toFixed(2)} 0 L ${(tw / 2).toFixed(2)} ${th.toFixed(2)} Z` : `M ${(tw / 2).toFixed(2)} 0 L ${tw.toFixed(2)} ${th.toFixed(2)} L 0 ${th.toFixed(2)} Z`,
          inset: {l: tw * 0.22, r: tw * 0.22, ...(up ? {b: th * 0.35} : {t: th * 0.35})}, anchor: up ? 'top' : 'bottom',
        });
        k += 1;
      }
    }
  },
  verticalBoxList(l) {
    const {area, gs, nf} = l;
    const h = area.h / nf;
    gs.forEach((g, i) => {
      const y = area.y + i * h;
      const tabH = Math.min(h * 0.3, 40);
      l.text('rect', X(area.x, y + tabH / 2, area.w, h * 0.9 - tabH / 2), g.slice(1), i, {light: true, inset: {t: tabH * 0.6}});
      l.titled('roundRect', X(area.x + area.w * 0.05, y, area.w * 0.6, tabH), i, g.slice(0, 1));
    });
  },
  trapezoidList(l) {
    const {area, gs} = l;
    const table = l.d.kind === 'tableList';
    const [head, cols] = table && gs.length ? [gs[0], gs.slice(1)] : [null, gs];
    const top = head ? area.h * 0.28 : 0;
    if (head) l.titled('rect', X(area.x, area.y, area.w, top * 0.9), 0, head);
    const m = Math.max(1, cols.length);
    const w = area.w / m;
    cols.forEach((g, k) => {
      const i = k + (table ? 1 : 0);
      const x = X(area.x + k * w + w * 0.02, area.y + top, w * 0.96, area.h - top);
      l.titled(table ? 'rect' : 'trapezoid', x, i, g, {anchor: 'top', ...(table ? {light: true} : {inset: {l: x.w * 0.2, r: x.w * 0.2, t: x.h * 0.08}})});
    });
  },
  accentProcess(l) {
    const {area, gs, n, nf} = l;
    const gap = area.w * 0.05;
    const w = (area.w - gap * (nf - 1)) / nf;
    gs.forEach((g, i) => {
      const x = area.x + i * (w + gap);
      const th = area.h * 0.22;
      if (g.length > 1) l.text('rect', X(x + w * 0.12, area.y + th * 0.7, w * 0.88, area.h - th * 0.7), g.slice(1), i, {light: true, inset: {t: th * 0.45}});
      l.titled('roundRect', X(x, area.y, w * 0.85, th), i, g.slice(0, 1));
      if (i + 1 < n) { const a = gap * 0.8; l.arrow(X(x + w + (gap - a) / 2 - w * 0.07, area.y + th / 2 - a / 2, a, a), 0, i); }
    });
  },
  continuousBlockProcess(l) {
    const {area, gs, nf} = l;
    l.deco('rightArrow', X(area.x, area.y + area.h * 0.15, area.w, area.h * 0.7), 0);
    const w = area.w * 0.85 / nf;
    const h = area.h * 0.32;
    gs.forEach((g, i) => l.titled('roundRect', X(area.x + area.w * 0.02 + i * w + w * 0.05, area.y + (area.h - h) / 2, w * 0.9, h), i, g));
  },
  bendingProcess(l) {
    const {area, gs, n, nf} = l;
    const cols = Math.max(1, Math.min(n, Math.ceil(Math.sqrt(nf * area.w / Math.max(area.h, 1) / 1.5))));
    const rows = Math.ceil(n / cols);
    const [cw, rh] = [area.w / cols, area.h / rows];
    const [bw, bh] = [cw * 0.72, Math.min(rh * 0.75, cw * 0.72 * 0.6)];
    gs.forEach((g, i) => {
      const [c, r] = [i % cols, Math.floor(i / cols)];
      const x = area.x + c * cw;
      const y = area.y + r * rh + (rh - bh) / 2;
      l.titled('rect', X(x, y, bw, bh), i, g);
      if (i + 1 < n) {
        const a = (cw - bw) * 0.7;
        if (c + 1 < cols) l.arrow(X(x + bw + (cw - bw - a) / 2, y + bh / 2 - a / 2, a, a), 0, i);
        else { const b = Math.max(6, Math.min(rh - bh, a * 1.5)); l.arrow(X(x + bw / 2 - b / 2, y + bh + (rh - bh - b) / 2, b, b), 90, i); }
      }
    });
  },
  linearVenn(l) {
    const {area, gs, n, nf} = l;
    if (l.d.kind === 'linearVenn') {
      const dc = Math.min(area.w / (nf * 0.75 + 0.25), area.h);
      const step = dc * 0.75;
      const x0 = area.x + (area.w - (step * (nf - 1) + dc)) / 2;
      gs.forEach((g, i) => l.titled('ellipse', X(x0 + i * step, area.y + (area.h - dc) / 2, dc, dc), i, g, {alpha: 55000}));
      return;
    }
    const s = Math.min(area.h, area.w);
    const [cx, bottom] = [area.x + area.w / 2, area.y + (area.h + s) / 2];
    gs.forEach((_, i) => { const dc = s * (1 - i / nf); l.deco('ellipse', X(cx - dc / 2, bottom - dc, dc, dc), i, {light: false}); });
    const band = s / nf;
    gs.forEach((g, i) => {
      const dc = s * (1 - i / nf);
      const top = bottom - dc;
      const h = i + 1 < n ? band : dc;
      const w = dc * (i + 1 < n ? 0.6 : 0.7);
      l.titled('rect', X(cx - w / 2, top + (i + 1 < n ? band * 0.05 : 0), w, h * 0.9), i, g, clearBox);
    });
  },
  nestedTarget(l) {
    const {area, gs, n, nf} = l;
    const bandX = area.w / 2 / nf * 0.6;
    const bandY = area.h / nf * 0.9 / 2;
    gs.forEach((_, i) => { const [dx, dy] = [bandX * i, bandY * i]; l.deco('roundRect', X(area.x + dx, area.y + dy, area.w - 2 * dx, area.h - 2 * dy), i, {light: false}); });
    gs.forEach((g, i) => {
      const [dx, dy] = [bandX * i, bandY * i];
      const h = i + 1 < n ? bandY : area.h - 2 * dy;
      l.titled('rect', X(area.x + dx + bandX * 0.3, area.y + dy, Math.max(1, area.w - 2 * dx - bandX * 0.6), h), i, g, clearBox);
    });
  },
  gridMatrix(l) {
    const {area, gs} = l;
    const s = Math.min(area.h, area.w);
    const [x0, y0] = [area.x + (area.w - s) / 2, area.y + (area.h - s) / 2];
    const t = s * 0.06;
    l.deco('leftRightArrow', X(x0, y0 + (s - t) / 2, s, t), 0);
    l.deco('upDownArrow', X(x0 + (s - t) / 2, y0, t, s), 0);
    const q = s / 2 - t * 1.2;
    gs.slice(0, 4).forEach((g, i) => {
      const [c, r] = [i % 2, Math.floor(i / 2)];
      l.titled('rect', X(x0 + c * (s / 2 + t * 0.7) + t * 0.5 * (1 - c), y0 + r * (s / 2 + t * 0.7) + t * 0.5 * (1 - r), q, q), i, g);
    });
  },
  gear(l) {
    const {area, gs} = l;
    const s = Math.min(area.h, area.w * 0.62);
    const [x0, y0] = [area.x + (area.w - s / 0.62) / 2, area.y + (area.h - s) / 2];
    const spots = [[0, 0.18, 0.66, 'gear9'], [0.5, 0, 0.48, 'gear6'], [0.56, 0.48, 0.42, 'gear6']];
    gs.slice(0, 3).forEach((g, i) => { const [fx, fy, fs, preset] = spots[i]; const z = s * fs; l.titled(preset, X(x0 + fx * s * 1.3, y0 + fy * s, z, z), i, g); });
  },
  funnel(l) {
    const {area, gs} = l;
    const s = Math.min(area.h, area.w);
    const [cx, y0] = [area.x + area.w / 2, area.y];
    const fw = s * 0.8, fh = s * 0.62;
    l.deco('funnel', X(cx - fw / 2, y0, fw, fh), 0);
    const last = gs.length > 1 ? gs.at(-1) : null;
    const inside = last ? gs.slice(0, -1) : gs;
    const k = Math.min(inside.length, 3);
    const dc = fw * 0.27;
    const spots = [[0, 0.04], [-0.2, 0.3], [0.2, 0.3]];
    inside.slice(0, 3).forEach((g, i) => { const [dx, dy] = k === 1 ? [0, 0.15] : spots[i]; l.titled('ellipse', X(cx + dx * fw - dc / 2, y0 + dy * fh + fh * 0.05, dc, dc), i, g); });
    if (last) {
      const a = s * 0.12;
      l.deco('downArrow', X(cx - a / 2, y0 + fh, a, a * 1.2), k);
      l.titled('roundRect', X(cx - fw * 0.35, y0 + fh + a * 1.3, fw * 0.7, Math.max(10, s - fh - a * 1.3)), k, last);
    }
  },
  pictureHList(l) {
    const {area, gs, nf} = l;
    const w = area.w / nf;
    gs.forEach((g, i) => {
      const x = area.x + i * w + w * 0.04;
      const bw = w * 0.92, ph = area.h * 0.55;
      l.picture('rect', X(x, area.y, bw, ph), i, g[0]);
      l.titled('rect', X(x, area.y + ph, bw, area.h - ph), i, g, {anchor: 'top', plain: true});
    });
  },
  timeline(l) {
    const {area, gs, nf} = l;
    const mid = area.y + area.h / 2;
    const bar = Math.max(6, area.h * 0.08);
    l.deco('rightArrow', X(area.x, mid - bar, area.w, bar * 2), 0);
    const w = area.w * 0.92 / nf;
    gs.forEach((g, i) => {
      const cx = area.x + w * (i + 0.5);
      const dot = bar * 1.4;
      l.deco('ellipse', X(cx - dot / 2, mid - dot / 2, dot, dot), i, {light: false});
      const th = area.h / 2 - bar * 1.6;
      const y = i % 2 === 0 ? area.y : mid + bar * 1.6;
      l.titled('rect', X(cx - w * 0.48, y, w * 0.96, Math.max(1, th)), i, g, {plain: true, light: true, anchor: i % 2 === 0 ? 'bottom' : 'top'});
    });
  },
  venn(l) {
    const {area, gs, n, nf} = l;
    const s = Math.min(area.h, area.w);
    const [cx, cy] = [area.x + area.w / 2, area.y + area.h / 2];
    const dc = n === 1 ? s : s * 0.62;
    const r = n === 1 ? 0 : (s - dc) / 2;
    gs.forEach((g, i) => {
      const a = rad(i / nf * 360 + (n === 2 ? 180 : -90));
      const p = dc * 0.36;
      const [dx, dy] = [Math.cos(a) * p, Math.sin(a) * p];
      l.titled('ellipse', X(cx + r * Math.cos(a) - dc / 2, cy + r * Math.sin(a) - dc / 2, dc, dc), i, g, {alpha: 50000,
        inset: {l: Math.max(2, 7.2 + dx), r: Math.max(2, 7.2 - dx), t: Math.max(2, 3.6 + dy), b: Math.max(2, 3.6 - dy)}});
    });
  },
  target(l) {
    const {area, gs, nf} = l;
    const s = Math.min(area.h, area.w * 0.5);
    const [cx, cy] = [area.x + s / 2, area.y + area.h / 2];
    const band = s / 2 / nf;
    gs.forEach((_, i) => { const dc = s - 2 * band * i; l.deco('ellipse', X(cx - dc / 2, cy - dc / 2, dc, dc), i, {light: false}); });
    const tx = area.x + s + area.w * 0.06;
    const rh = area.h / nf;
    gs.forEach((g, i) => {
      const ty = area.y + rh * (i + 0.5);
      const ry = cy - s / 2 + band * (i + 0.5);
      l.line([cx, Math.min(ry, ty)], [tx, ty]);
      l.titled('rect', X(tx, ty - rh * 0.45, Math.max(1, area.x + area.w - tx), rh * 0.9), i, g, {plain: true, light: true, align: 'left'});
    });
  },
  hierarchy(l) { hierarchy(l, l.d.kind === 'horizontalHierarchy'); },
  orgChart(l) { orgChart(l); },
};
for (const [alias, arm] of [['hBulletList', 'list'], ['chevron', 'process'], ['blockCycle', 'cycle'], ['invertedPyramid', 'pyramid'], ['titledMatrix', 'matrix'],
  ['pictureProcess', 'pictureCaption'], ['continuousCycle', 'textCycle'], ['pie', 'segmentedCycle'], ['tableList', 'trapezoidList'], ['stackedVenn', 'linearVenn'],
  ['horizontalHierarchy', 'hierarchy'], ['halfCircleOrgChart', 'orgChart'], ['nameTitleOrgChart', 'orgChart']]) ARMS[alias] = ARMS[arm];

/** The tree of the outline: the parent of each node by level. */
function parents(nodes) {
  const parent = nodes.map(() => null);
  const stack = [];
  nodes.forEach((n, i) => {
    while (stack.length && nodes[stack.at(-1)].level >= n.level) stack.pop();
    parent[i] = stack.length ? stack.at(-1) : null;
    stack.push(i);
  });
  return parent;
}

/** `hierarchy`: one box per node, rows by level, each subtree as wide as its leaves (turned a quarter when horizontal). */
function hierarchy(l, horizontal) {
  const {area} = l;
  const nodes = l.d.nodes.slice(0, MAX_SHAPES);
  if (!nodes.length) return;
  const parent = parents(nodes);
  const kids = i => nodes.map((_, k) => k).filter(k => parent[k] === i);
  const leaves = nodes.map(() => 0);
  for (let i = nodes.length - 1; i >= 0; i--) { const k = kids(i); leaves[i] = k.length ? k.reduce((a, c) => a + leaves[c], 0) : 1; }
  const depth = nodes.map((_, i) => { let d = 0, p = parent[i]; while (p !== null) { d += 1; p = parent[p]; } return d; });
  const rows = Math.max(...depth) + 1;
  const total = Math.max(1, kids(null).reduce((a, r) => a + leaves[r], 0));
  const [span, across] = horizontal ? [area.h, area.w] : [area.w, area.h];
  const cellW = span / total, rowH = across / rows;
  const [bw, bh] = horizontal ? [cellW * 0.8, rowH * 0.7] : [cellW * 0.85, rowH * 0.6];
  const left = nodes.map(() => 0);
  let nextRoot = 0;
  nodes.forEach((_, i) => {
    let start;
    if (parent[i] === null) { start = nextRoot; nextRoot += leaves[i]; } else {
      start = left[parent[i]];
      for (const s of kids(parent[i])) { if (s === i) break; start += leaves[s]; }
    }
    left[i] = start;
  });
  const boxes = nodes.map((_, i) => {
    const c = (left[i] + leaves[i] / 2) * cellW;
    const r = depth[i] * rowH + (rowH - bh) / 2;
    return horizontal ? X(area.x + r, area.y + c - bw / 2, bh, bw) : X(area.x + c - bw / 2, area.y + r, bw, bh);
  });
  nodes.forEach((_, i) => l.titled('roundRect', boxes[i], depth[i], [i]));
  nodes.forEach((_, i) => {
    if (parent[i] === null) return;
    const [a, b] = [boxes[parent[i]], boxes[i]];
    l.line(...(horizontal ? [[a.x + a.w, a.y + a.h / 2], [b.x, b.y + b.h / 2]] : [[a.x + a.w / 2, a.y + a.h], [b.x + b.w / 2, b.y]]));
  });
}

/** `org_chart`: `hierarchy` with elbow connectors and assistants beside their parent on a row of their own; half circles or name and title boxes. */
function orgChart(l) {
  const {area, d} = l;
  if (BRANCHES.includes(d.hang)) { orgHanging(l); return; }
  const nodes = d.nodes.slice(0, MAX_SHAPES);
  if (!nodes.length) return;
  const parent = parents(nodes);
  const asst = i => !!nodes[i].assistant && parent[i] !== null;
  const kids = i => nodes.map((_, k) => k).filter(k => parent[k] === i && !asst(k));
  const leaves = nodes.map(() => 0);
  for (let i = nodes.length - 1; i >= 0; i--) { const k = kids(i); leaves[i] = k.length ? k.reduce((a, c) => a + leaves[c], 0) : 1; }
  const slot = nodes.map(() => 0);
  nodes.forEach((_, i) => { slot[i] = parent[i] === null ? 0 : asst(i) ? slot[parent[i]] + 1 : slot[parent[i]] + 2; });
  const used = [...new Set(slot)].sort((a, b) => a - b);
  const row = i => used.indexOf(slot[i]);
  const rows = Math.max(1, used.length);
  const total = Math.max(1, kids(null).reduce((a, r) => a + leaves[r], 0));
  const cellW = area.w / total, rowH = area.h / rows;
  const [bw, bh] = [Math.min(cellW * 0.85, area.w * 0.3), rowH * 0.62];
  const left = nodes.map(() => 0);
  let nextRoot = 0;
  nodes.forEach((_, i) => {
    if (asst(i)) return;
    let start;
    if (parent[i] === null) { start = nextRoot; nextRoot += leaves[i]; } else {
      start = left[parent[i]];
      for (const s of kids(parent[i])) { if (s === i) break; start += leaves[s]; }
    }
    left[i] = start;
  });
  const boxes = nodes.map((_, i) => {
    const y = area.y + row(i) * rowH + (rowH - bh) / 2;
    const p = parent[i];
    if (p !== null && asst(i)) {
      const k = nodes.slice(0, i).filter((_, j) => parent[j] === p && asst(j)).length;
      const pc = area.x + (left[p] + leaves[p] / 2) * cellW;
      const off = bw * 0.15 + Math.floor(k / 2) * bw * 1.1;
      const x = k % 2 === 0 ? pc + off : pc - off - bw;
      return X(Math.min(Math.max(x, area.x), area.x + area.w - bw), y, bw, bh);
    }
    return X(area.x + (left[i] + leaves[i] / 2) * cellW - bw / 2, y, bw, bh);
  });
  nodes.forEach((_, i) => {
    const p = parent[i];
    if (p === null) return;
    const [a, b] = [boxes[p], boxes[i]];
    const pc = a.x + a.w / 2;
    if (asst(i)) {
      const my = b.y + b.h / 2;
      l.line([pc, a.y + a.h], [pc, my]);
      l.line([pc, my], [b.x > pc ? b.x : b.x + b.w, my]);
    } else {
      const mid = b.y - (rowH - bh) / 2;
      const cc = b.x + b.w / 2;
      l.line([pc, a.y + a.h], [pc, mid]);
      l.line([Math.min(pc, cc), mid], [Math.max(pc, cc), mid]);
      l.line([cc, mid], [cc, b.y]);
    }
  });
  orgBoxes(l, nodes, boxes, nodes.map((_, i) => Math.floor(slot[i] / 2)));
}

/** The boxes of an organization chart (half circles, or name and title boxes) once placed; `depthOf` gives each node's accent. */
function orgBoxes(l, nodes, boxes, depthOf, size) {
  const halfCircle = l.d.kind === 'halfCircleOrgChart', nameTitle = l.d.kind === 'nameTitleOrgChart';
  nodes.forEach((n, i) => {
    const depth = depthOf[i];
    if (halfCircle) {
      const x = boxes[i];
      [[140, 310], [320, 130]].forEach(([a0, a1], k) => l.deco('blockArc', x, depth, {light: false, adj: [a0 * 60000, a1 * 60000, 4000], plain: false, noLine: true, ...(k === 1 ? {tintFill: 40} : {})}));
      l.titled('rect', x, depth, [i], {plain: true, light: true, ...(size ? {size} : {})});
    } else {
      const x = nameTitle && String(n.title ?? '').trim() ? {...boxes[i], h: boxes[i].h * 0.85} : boxes[i];
      l.titled('rect', x, depth, [i], size ? {size} : {});
      // The title strip appears once a title is typed; an empty one is no stray tab under the name.
      if (nameTitle && String(n.title ?? '').trim()) l.out.push({preset: 'rect', x: X(x.x + x.w * 0.12, x.y + x.h * 0.72, x.w * 0.8, x.h * 0.42), nodes: [], titleText: n.title ?? '', title: true, accent: depth, light: true, white: true, ...(size ? {size: Math.max(6, size * 0.6)} : {})});
    }
  });
}

/** The branch layouts of the Layout drop-down for organization charts (SmartArt Design > Create Graphic): standard (none), Both, Left Hanging, Right Hanging. */
export const BRANCHES = Object.freeze(['both', 'left', 'right']);
export const ORG_KINDS = Object.freeze(['orgChart', 'halfCircleOrgChart', 'nameTitleOrgChart']);

/** The hanging branch layouts (not in deckcraft; placed as PowerPoint draws them): each node's children are stacked in a column under it, joined by a vertical line, a step in from the node. */
function orgHanging(l) {
  const {area, d} = l;
  const nodes = d.nodes.slice(0, MAX_SHAPES);
  if (!nodes.length) return;
  const parent = parents(nodes);
  const kids = i => nodes.map((_, k) => k).filter(k => parent[k] === i);
  const depth = nodes.map((_, i) => { let n = 0, p = parent[i]; while (p !== null) { n += 1; p = parent[p]; } return n; });
  const maxDepth = Math.max(...depth);
  const roots = kids(null);
  const both = d.hang === 'both';
  const row = nodes.map(() => 0);
  const side = nodes.map(() => (d.hang === 'right' ? -1 : 1));
  let next = 0;
  const walk = i => { row[i] = next++; for (const c of kids(i)) walk(c); };
  const rootKids = roots.length === 1 ? kids(roots[0]) : [];
  if (both && rootKids.length > 1) {
    row[roots[0]] = 0;
    const half = Math.ceil(rootKids.length / 2);
    const rows = [0, 0];
    const count = i => 1 + kids(i).reduce((a, c) => a + count(c), 0);
    const mark = (i, sd) => { side[i] = sd; for (const c of kids(i)) mark(c, sd); };
    rootKids.forEach((c, k) => {
      const col = k < half ? 0 : 1;
      mark(c, col === 0 ? -1 : 1);
      next = 1 + rows[col];
      walk(c);
      rows[col] += count(c);
    });
    next = 1 + Math.max(rows[0], rows[1]);
  } else roots.forEach(walk);
  const rows = Math.max(1, next);
  const rowH = area.h / rows;
  const bh = Math.min(rowH * 0.72, area.h * 0.3);
  const levels = Math.max(1, maxDepth);
  const indent = Math.min(area.w * 0.07, (area.w * 0.4) / levels);
  const bw = Math.max(area.w * 0.18, Math.min(area.w * 0.55, both ? area.w / 2 - indent * (levels + 0.6) : area.w - indent * levels));
  const cx = area.x + area.w / 2;
  const boxes = nodes.map(() => null);
  const place = i => {
    const y = area.y + row[i] * rowH + (rowH - bh) / 2;
    const p = parent[i];
    let x;
    if (p === null) x = both ? cx - bw / 2 : d.hang === 'right' ? area.x + area.w - bw : area.x;
    else {
      const pb = boxes[p];
      if (both && parent[p] === null && rootKids.length > 1) x = side[i] < 0 ? cx - indent * 0.6 - bw : cx + indent * 0.6;
      else x = side[i] < 0 ? pb.x + pb.w - indent - bw : pb.x + indent;
    }
    boxes[i] = X(Math.min(Math.max(x, area.x), area.x + area.w - bw), y, bw, bh);
  };
  nodes.map((_, i) => i).sort((a, b) => depth[a] - depth[b] || a - b).forEach(place);
  nodes.forEach((_, p) => {
    const ks = kids(p);
    if (!ks.length) return;
    const pb = boxes[p];
    const split = both && parent[p] === null && rootKids.length > 1;
    const tx = split ? cx : side[ks[0]] < 0 ? pb.x + pb.w - indent / 2 : pb.x + indent / 2;
    const midOf = k => boxes[k].y + boxes[k].h / 2;
    l.line([tx, pb.y + pb.h], [tx, Math.max(...ks.map(midOf))]);
    for (const k of ks) l.line([tx, midOf(k)], [side[k] < 0 ? boxes[k].x + boxes[k].w : boxes[k].x, midOf(k)]);
  });
  // The boxes are flat: the text is set to fit their height.
  orgBoxes(l, nodes, boxes, depth, Math.max(7, Math.min(20, Math.floor(bh * 0.4))));
}

/** The draft items of a diagram laid out in `area`. */
function layoutItems(d, area) {
  const l = new L(d, area);
  ARMS[d.kind]?.(l);
  return l.out;
}

// ---------------------------------------------------------------------------------------------
// Shapes

/** Turn a draft item into a shape (no id yet): geometry, text, fill, line and effects. */
function shapeOf(d, it, k, nodes) {
  const sh = newShape({name: it.deco ? 'SmartArt arrow' : it.connector ? 'SmartArt connector' : it.picture !== undefined ? 'SmartArt picture' : 'SmartArt shape',
    xfrm: {x: it.x.x, y: it.x.y, w: it.x.w, h: it.x.h, rot: it.x.rot ?? 0, flipH: !!it.x.flipH, flipV: false},
    geom: it.custom ? {kind: 'custom', paths: [{w: it.x.w, h: it.x.h, d: it.custom, fill: 'norm', stroke: true}]} : presetGeom(it.preset, it.adj),
    descr: it.nodes.map(i => nodes[i]?.text).filter(Boolean).join('; ')});
  if (it.connector) {
    sh.fill = fillNone();
    sh.line = ln(ref('accent1', [{op: 'lumMod', val: 60000}]), 1.25);
    return sh;
  }
  if (!it.deco && it.picture === undefined) {
    sh.text = it.titleText !== undefined ? textBodyOf([{text: it.titleText, level: 0}], [0], true) : textBodyOf(nodes, it.nodes, !!it.title);
    if (it.anchor) sh.text.body.anchor = it.anchor;
    if (it.inset) sh.text.body = {...sh.text.body, ...(it.inset.l !== undefined ? {insetL: it.inset.l} : {}), ...(it.inset.r !== undefined ? {insetR: it.inset.r} : {}),
      ...(it.inset.t !== undefined ? {insetT: it.inset.t} : {}), ...(it.inset.b !== undefined ? {insetB: it.inset.b} : {})};
    if (it.align) for (const p of sh.text.paragraphs) p.props = {...p.props, align: it.align};
    if (it.titleText !== undefined) for (const p of sh.text.paragraphs) { p.runs[0].props.size = 11; p.endProps = {size: 11}; }
  }
  paint(d, sh, it.accent, !!it.light);
  if (it.picture !== undefined) {
    const media = nodes[it.picture]?.picture;
    if (media) { sh.fill = {kind: 'picture', media, crop: [0, 0, 0, 0], mode: {kind: 'stretch', fillRect: [0, 0, 0, 0]}, alpha: null}; sh.line = ln(ref('lt1'), 1.5); }
  }
  const slot = accentSlot(d.colors, it.accent);
  if (it.plain) { sh.fill = fillNone(); sh.line = noLine(); sh.effects = null; }
  if (it.noLine) { sh.line = noLine(); sh.effects = null; }
  if (it.white) sh.fill = fillSolid(ref('lt1'));
  if (it.tintFill) sh.fill = fillSolid(ref(slot, [{op: 'lumMod', val: 100000 - it.tintFill * 1000 * 1.5}, {op: 'lumOff', val: it.tintFill * 1000}]));
  if (it.alpha && sh.fill?.kind === 'solid') sh.fill = fillSolid({...sh.fill.color, mods: [...(sh.fill.color.mods ?? []), {op: 'alpha', val: it.alpha}]});
  if (it.textTint && sh.text) for (const p of sh.text.paragraphs) for (const r of p.runs) r.props = {...r.props, fill: fillSolid(ref(slot, [{op: 'lumMod', val: it.textTint}]))};
  if (sh.text && it.size) {
    for (const p of sh.text.paragraphs) { for (const r of p.runs) r.props = {...r.props, size: it.size}; p.endProps = {...p.endProps, size: it.size}; }
  }
  if (sh.text) fitWords(sh);
  void k;
  return sh;
}

/** The area the generated shapes fill. */
export const areaOf = x => ({x: x.x, y: x.y, w: Math.max(1, x.w), h: Math.max(1, x.h)});

/** The children of a diagram group: real shapes (ids from `nextId()`), painted with the diagram's style and colours. */
export function build(d, area, nextId) {
  let items = layoutItems(d, area).slice(0, 80);
  // Right to Left mirrors the whole graphic across the middle of its area (not in deckcraft; as PowerPoint reverses a graphic).
  if (d.rtl) items = items.map(it => ({...it, x: {...it.x, x: 2 * area.x + area.w - it.x.x - it.x.w, flipH: !it.x.flipH, rot: (((360 - (it.x.rot ?? 0)) % 360) + 360) % 360}}));
  return items.map((it, k) => ({...shapeOf(d, it, k, d.nodes), id: nextId()}));
}

const paragraphText = p => (p.runs ?? []).map(r => r.text ?? '').join('');
/** The outline with the text typed into the diagram's shapes read back (`sync_text`): a shape whose paragraphs still match its nodes gives its text back to them. An imported graphic, or one whose shapes were added or removed, is left as it is. */
export function syncText(d, children) {
  if (d.imported || !Array.isArray(children)) return d.nodes;
  const map = layoutItems(d, {x: 0, y: 0, w: 100, h: 100}).slice(0, 80).map(it => it.nodes);
  if (map.length !== children.length) return d.nodes;
  const nodes = d.nodes.map(n => ({...n}));
  children.forEach((sh, k) => {
    const idx = map[k];
    const paras = sh?.text?.paragraphs;
    if (!paras || !idx.length || paras.length !== idx.length) return;
    paras.forEach((p, j) => { if (nodes[idx[j]]) nodes[idx[j]].text = paragraphText(p); });
  });
  return nodes;
}

/** Move Up / Move Down (not in deckcraft; as PowerPoint): the node and its sub-points swap places with the sibling before or after it, at the same level. Null when there is none. */
export function moveNode(nodes, index, dir) {
  if (index < 0 || index >= nodes.length) return null;
  const lv = nodes[index].level;
  const end = subtreeEnd(nodes, index);
  const block = nodes.slice(index, end);
  if (dir === 'up') {
    let j = index - 1;
    while (j >= 0 && nodes[j].level > lv) j -= 1;
    if (j < 0 || nodes[j].level < lv) return null;
    return {nodes: [...nodes.slice(0, j), ...block, ...nodes.slice(j, index), ...nodes.slice(end)].map(n => ({...n})), index: j};
  }
  if (end >= nodes.length || nodes[end].level !== lv) return null;
  const next = subtreeEnd(nodes, end);
  return {nodes: [...nodes.slice(0, index), ...nodes.slice(end, next), ...block, ...nodes.slice(next)].map(n => ({...n})), index: index + (next - end)};
}

/** A layout's gallery picture: the sample graphic's shapes as drawn paths [{x, m, paths: [{d}], fill, pale, line, alpha}] in a 160 x 100 box (shapes without a fill are left out). */
export function thumb(kind, nodes = sampleNodes(kind), colors = 'colorful', style = 'flat') {
  const d = {kind, nodes, colors, style};
  return layoutItems(d, {x: 0, y: 0, w: 160, h: 100}).filter(it => !it.plain).map(it => {
    const {w, h} = it.x;
    let paths = [];
    try { paths = shapeGeometry({geom: it.custom ? {kind: 'custom', paths: [{w, h, d: it.custom, fill: 'norm', stroke: true}]} : presetGeom(it.preset, it.adj)}, w, h).paths.map(p => ({d: svgPath(p.path)})); } catch { paths = []; }
    return {x: it.x, m: xfrmAffine({x: it.x.x, y: it.x.y, w, h, rot: it.x.rot ?? 0, flipH: !!it.x.flipH, flipV: false}), paths,
      fill: it.connector ? null : accentSlot(colors, it.accent), pale: !!it.light && !it.connector, line: !!it.connector, alpha: it.alpha ?? null, style};
  });
}

export {fillNone, PICTURE_LAYOUTS};
export const sampleNodes = kind => {
  const levels = categoryOf(kind) === 'Hierarchy' ? [0, 1, 2, 2, 1] : categoryOf(kind) === 'Matrix' ? [0, 0, 0, 0, 0]
    : categoryOf(kind) === 'List' && kind !== 'blockList' && kind !== 'tableList' ? [0, 1, 0, 1, 0, 1] : [0, 0, 0, 0];
  return levels.map(level => blank('', level));
};
