// Character, paragraph, table, row and cell properties, colours and borders.
// Translated from wordcraft crates/doc/src/props.rs, props/char_props.rs, props/para_props.rs,
// props/table_props.rs and props/color.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Properties are plain JSON objects shaped as upstream serializes them (camelCase keys, an
// absent key is `None` = inherit). Enums are their serialized names ('single', 'dotDash', ...).
// An `Rgb` is `[r, g, b]`; a `TextColor` is `'Auto'` or `{Rgb: [r, g, b]}`; `LineSpacing` is
// `{rule: 'multiple'|'atLeast'|'exactly', value}`. Functions never mutate their inputs.
// No DOM, no Node built-ins.

// --- equality -------------------------------------------------------------------------------

/** Structural equality of JSON values (absent and undefined keys are equal). */
export function same(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
    return true;
  }
  let n = 0;
  for (const k in a) {
    if (a[k] === undefined) continue;
    n++;
    if (!same(a[k], b[k])) return false;
  }
  for (const k in b) if (b[k] !== undefined) n--;
  return n === 0;
}

const isEmptyObj = o => {
  if (!o) return true;
  for (const k in o) if (o[k] !== undefined) return false;
  return true;
};

// --- colour (props/color.rs) ----------------------------------------------------------------

export const BLACK = Object.freeze([0, 0, 0]);
export const WHITE = Object.freeze([255, 255, 255]);

/** `RRGGBB` (no `#`). */
export const rgbHex = c => c.map(x => x.toString(16).toUpperCase().padStart(2, '0')).join('');

/** Parse `RRGGBB` or `#RRGGBB`; null otherwise. */
export function parseRgb(s) {
  if (typeof s !== 'string') return null;
  let t = s.trim();
  if (t.startsWith('#')) t = t.slice(1);
  if (t.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(t)) return null;
  return [parseInt(t.slice(0, 2), 16), parseInt(t.slice(2, 4), 16), parseInt(t.slice(4, 6), 16)];
}

/** Read an Rgb the way upstream deserializes one: `[r, g, b]`, `RRGGBB` or `#RRGGBB`. */
export function readRgb(v) {
  if (typeof v === 'string') return parseRgb(v);
  if (Array.isArray(v) && v.length === 3 && v.every(x => Number.isInteger(x) && x >= 0 && x <= 255)) return [v[0], v[1], v[2]];
  return null;
}
export const isRgb = v => Array.isArray(v) && v.length === 3 && v.every(x => Number.isInteger(x) && x >= 0 && x <= 255);

/** `auto`/`automatic` (any case) or a colour parseRgb reads. */
export function parseTextColor(s) {
  if (typeof s !== 'string') return null;
  if (/^(auto|automatic)$/i.test(s)) return 'Auto';
  const c = parseRgb(s);
  return c ? {Rgb: c} : null;
}
/** Read a TextColor as upstream deserializes it: `"Auto"`, `{"Rgb": [...]}`, or a parseTextColor string. */
export function readTextColor(v) {
  if (v === 'Auto') return 'Auto';
  if (typeof v === 'string') return parseTextColor(v);
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && 'Rgb' in v) {
    const c = readRgb(v.Rgb);
    return c ? {Rgb: c} : null;
  }
  return null;
}
export const isTextColor = v => v === 'Auto' || (v && typeof v === 'object' && isRgb(v.Rgb) && Object.keys(v).length === 1);

function toHsl([R, G, B]) {
  const r = R / 255, g = G / 255, b = B / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}
export function rgbFromHsl(h, s, l) {
  const byte = v => Math.max(0, Math.min(255, Math.round(v * 255)));
  if (s === 0) return [byte(l), byte(l), byte(l)];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = t => {
    t = ((t % 1) + 1) % 1;
    const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return byte(v);
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}
const clamp01 = x => Math.max(0, Math.min(1, x));
const mix = (c, to, v) => c.map(x => Math.max(0, Math.min(255, Math.round(x * v + to * (1 - v)))));
export function rgbWithLum(c, f) { const [h, s, l] = toHsl(c); return rgbFromHsl(h, s, clamp01(f(l))); }
/** The colour with the DrawingML modifier `name` (lumMod, lumOff, tint, shade, satMod) at `v`. */
export function rgbModified(c, name, v) {
  switch (name) {
    case 'lumMod': return rgbWithLum(c, l => l * v);
    case 'lumOff': return rgbWithLum(c, l => l + v);
    case 'tint': return mix(c, 255, v);
    case 'shade': return mix(c, 0, v);
    case 'satMod': { const [h, s, l] = toHsl(c); return rgbFromHsl(h, clamp01(s * v), l); }
    default: return [...c];
  }
}
export const rgbLuma = c => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

// --- char_props.rs --------------------------------------------------------------------------

export const UNDERLINES = Object.freeze(['none', 'single', 'words', 'double', 'thick', 'dotted', 'dash', 'dotDash', 'dotDotDash', 'wave', 'doubleWave']);
const UNDERLINE_OOXML = {none: 'none', single: 'single', words: 'words', double: 'double', thick: 'thick', dotted: 'dotted', dash: 'dash',
  dotDash: 'dotDash', dotDotDash: 'dotDotDash', wave: 'wave', doubleWave: 'wavyDouble'};
export const underlineOoxml = u => UNDERLINE_OOXML[u] ?? 'none';
export function underlineFromOoxml(s) {
  for (const u of UNDERLINES) if (UNDERLINE_OOXML[u] === s) return u;
  return {thickDash: 'dash', dashLong: 'dash', dashedHeavy: 'dash', dashLongHeavy: 'dash', dottedHeavy: 'dotted', wavyHeavy: 'wave',
    dashDotHeavy: 'dotDash', dashDotDotHeavy: 'dotDotDash'}[s] ?? 'single';
}

export const VERT_ALIGNS = Object.freeze(['baseline', 'superscript', 'subscript']);

export const HIGHLIGHTS = Object.freeze(['none', 'yellow', 'brightGreen', 'turquoise', 'pink', 'blue', 'red', 'darkBlue', 'teal', 'green',
  'violet', 'darkRed', 'darkYellow', 'gray50', 'gray25', 'black', 'white']);
const HL = {
  none: [null, 'none', 'No Color'], yellow: [[255, 255, 0], 'yellow', 'Yellow'], brightGreen: [[0, 255, 0], 'green', 'Bright Green'],
  turquoise: [[0, 255, 255], 'cyan', 'Turquoise'], pink: [[255, 0, 255], 'magenta', 'Pink'], blue: [[0, 0, 255], 'blue', 'Blue'],
  red: [[255, 0, 0], 'red', 'Red'], darkBlue: [[0, 0, 128], 'darkBlue', 'Dark Blue'], teal: [[0, 128, 128], 'darkCyan', 'Teal'],
  green: [[0, 128, 0], 'darkGreen', 'Green'], violet: [[128, 0, 128], 'darkMagenta', 'Violet'], darkRed: [[128, 0, 0], 'darkRed', 'Dark Red'],
  darkYellow: [[128, 128, 0], 'darkYellow', 'Dark Yellow'], gray50: [[128, 128, 128], 'darkGray', 'Gray-50%'],
  gray25: [[192, 192, 192], 'lightGray', 'Gray-25%'], black: [[0, 0, 0], 'black', 'Black'], white: [[255, 255, 255], 'white', 'White'],
};
export const highlightRgb = h => (HL[h]?.[0] ? [...HL[h][0]] : null);
export const highlightOoxml = h => HL[h]?.[1] ?? 'none';
export const highlightName = h => HL[h]?.[2] ?? 'No Color';
export const highlightFromOoxml = s => HIGHLIGHTS.find(h => HL[h][1] === s) ?? 'none';

/** The text size, in points, of a run whose size no style or default sets. */
export const DEFAULT_FONT_SIZE = 11;

const LIG_KEYS = ['standard', 'contextual', 'historical', 'discretional'];
/** Every combination of the four ligature flags. */
export function allLigatures() {
  const out = [];
  for (let b = 0; b < 16; b++) out.push({standard: !!(b & 1), contextual: !!(b & 2), historical: !!(b & 4), discretional: !!(b & 8)});
  return out;
}
/** The `w14:ligatures/@w14:val` name. */
export function ligaturesOoxml(l) {
  const on = LIG_KEYS.filter(k => l?.[k]);
  if (!on.length) return 'none';
  if (on.length === 4) return 'all';
  return on.map((n, i) => (i > 0 ? n[0].toUpperCase() + n.slice(1) : n)).join('');
}
export const ligaturesFromOoxml = s => allLigatures().find(l => ligaturesOoxml(l) === s) ?? null;

export const COMBINE_BRACKETS = Object.freeze(['none', 'round', 'square', 'angle', 'curly']);

const CHAR_TEXT_STYLE = ['style', 'font', 'symFont', 'size', 'bold', 'italic', 'underline', 'underlineColor', 'strike', 'doubleStrike', 'color',
  'highlight', 'shading', 'border', 'vertAlign', 'caps', 'smallCaps', 'hidden', 'spacing', 'scale', 'position', 'kern', 'outline', 'shadow',
  'emboss', 'engrave', 'lang', 'noProof', 'rtl'];
const CHAR_SCRIPT_STYLE = ['cs', 'fontCs', 'fontEa', 'sizeCs', 'boldCs', 'italicCs', 'langBidi', 'langEa', 'eastAsianLayout'];
const CHAR_MARKS_MINUS = ['link', 'linkTip', 'ins', 'del', 'ligatures'];
const CHAR_MARKS_OVERLAY = ['link', 'linkTip', 'ins', 'del', 'fmtChange', 'ligatures'];
/** Every CharProps key (serialized names). */
export const CHAR_KEYS = Object.freeze([...CHAR_TEXT_STYLE, 'ligatures', 'textEffects', ...CHAR_SCRIPT_STYLE, 'link', 'linkTip', 'ins', 'del', 'fmtChange']);

/** Overlay each listed key that `patch` sets onto a copy of `base`. */
function overlayKeys(out, patch, keys) {
  for (const k of keys) if (patch[k] !== undefined) out[k] = patch[k];
}

/** Apply every set field of `patch` on top of `base` (CharProps::overlaid). */
export function charOverlaid(base, patch) {
  const out = {...(base || {})};
  if (!patch) return out;
  overlayKeys(out, patch, CHAR_TEXT_STYLE);
  overlayKeys(out, patch, CHAR_SCRIPT_STYLE);
  overlayKeys(out, patch, CHAR_MARKS_OVERLAY);
  if (patch.textEffects !== undefined) {
    const te = {...(out.textEffects || {})};
    for (const k of ['fill', 'outline', 'shadow', 'glow', 'reflection']) if (patch.textEffects[k] !== undefined) te[k] = patch.textEffects[k];
    out.textEffects = te;
  }
  return out;
}

/** The fields of `self` that differ from `base` (CharProps::minus). */
export function charMinus(self, base) {
  const out = {...(self || {})};
  for (const k of [...CHAR_TEXT_STYLE, ...CHAR_SCRIPT_STYLE, ...CHAR_MARKS_MINUS]) if (same(out[k], base?.[k])) delete out[k];
  return out;
}

/** The same formatting outside a hyperlink (CharProps::unlinked). */
export function charUnlinked(c) {
  const out = {...(c || {})};
  if (out.link !== undefined) {
    delete out.link; delete out.linkTip;
    if (out.style === 'Hyperlink') delete out.style;
  }
  return out;
}

export const charIsEmpty = c => isEmptyObj(c);

/** The font a character of this run is shown in: the symbol's own font, else the run's font. */
export function shownFont(c) {
  if (typeof c?.symFont === 'string' && c.symFont.trim()) return c.symFont;
  return c?.font ?? null;
}

/** The same formatting without the symbol's own font. */
export function charWithoutSymbol(c) { const out = {...(c || {})}; delete out.symFont; return out; }

/** Clear direct formatting, keeping links, revisions and a symbol's font (CharProps::cleared). */
export function charCleared(c) {
  const out = {};
  for (const k of ['link', 'linkTip', 'ins', 'del', 'fmtChange', 'symFont']) if (c?.[k] !== undefined) out[k] = c[k];
  return out;
}

/** Just the formatting: without the link, revision marks and tracked change (CharProps::formatting). */
export function charFormatting(c) {
  const out = {...(c || {})};
  delete out.link; delete out.linkTip; delete out.ins; delete out.del; delete out.fmtChange;
  return out;
}

// --- para_props.rs --------------------------------------------------------------------------

export const ALIGNS = Object.freeze(['left', 'center', 'right', 'justify', 'distribute']);
/** Alignment as seen on the page in a right-to-left paragraph (Left and Right swap). */
export const alignVisual = (a, rtl) => (rtl && a === 'left' ? 'right' : rtl && a === 'right' ? 'left' : a);

export const singleSpacing = () => ({rule: 'multiple', value: 1});
export const TAB_ALIGNS = Object.freeze(['left', 'center', 'right', 'decimal', 'bar', 'clear']);
export const TAB_LEADERS = Object.freeze(['none', 'dot', 'hyphen', 'underscore', 'middleDot']);
export const tabLeaderChar = l => ({dot: '.', hyphen: '-', underscore: '_', middleDot: '·'})[l] ?? null;
/** Two tab positions closer than this (points) are the same stop. */
export const TAB_POS_EPS = 0.5;

export const BORDER_STYLES = Object.freeze(['none', 'single', 'double', 'dotted', 'dashed', 'thick', 'triple', 'dotDash', 'wave']);
export const borderStyleOoxml = s => (s === 'none' ? 'nil' : BORDER_STYLES.includes(s) ? s : 'nil');
export function borderStyleFromOoxml(s) {
  switch (s) {
    case 'nil': case 'none': return 'none';
    case 'double': return 'double';
    case 'dotted': return 'dotted';
    case 'dashed': case 'dashSmallGap': return 'dashed';
    case 'thick': return 'thick';
    case 'triple': return 'triple';
    case 'dotDash': case 'dotDotDash': return 'dotDash';
    case 'wave': case 'doubleWave': return 'wave';
    default: return 'single';
  }
}

/** One border line `{style, width, color, space}` (color: Rgb or null). */
export const border = (style = 'none', width = 0, color = null, space = 0) => ({style, width, color, space});
export const singleBorder = width => border('single', width, null, 0);
/** A border read with upstream's serde defaults (missing fields take their defaults). */
export const borderOf = b => ({style: b?.style ?? 'none', width: b?.width ?? 0, color: b?.color ?? null, space: b?.space ?? 0});
export const borderVisible = b => !!b && (b.style ?? 'none') !== 'none' && (b.width ?? 0) > 0;

export const BORDER_SIDES = Object.freeze(['top', 'left', 'bottom', 'right', 'between', 'inside_v']);
/** Borders on the four sides plus inner borders (`inside_v` keeps upstream's serialized name). */
export const bordersAll = b => ({top: b, left: b, bottom: b, right: b, between: b, inside_v: b});
export const bordersBox = b => ({top: b, left: b, bottom: b, right: b});
export const bordersAnyVisible = bs => !!bs && BORDER_SIDES.some(k => borderVisible(bs[k]));
/** Apply every set side of `patch` on top of `base` (Borders::overlay). */
export function bordersOverlaid(base, patch) {
  const out = {...(base || {})};
  if (patch) for (const k of BORDER_SIDES) if (patch[k] !== undefined && patch[k] !== null) out[k] = patch[k];
  return out;
}

const PARA_LAYOUT = ['style', 'align', 'indentLeft', 'indentRight', 'indentFirst', 'indentLeftChars', 'indentRightChars', 'indentFirstChars',
  'spaceBefore', 'spaceAfter', 'spaceBeforeAuto', 'spaceAfterAuto', 'lineSpacing', 'contextualSpacing', 'mirrorIndents', 'tabs', 'shading', 'borders'];
const PARA_PAGINATION = ['keepNext', 'keepLines', 'pageBreakBefore', 'widowControl', 'outlineLevel', 'numbering', 'suppressHyphens',
  'suppressLineNumbers', 'dropCap', 'dropCapMargin', 'dropCapDistance', 'dropCapFont', 'frame', 'snapToGrid'];
const PARA_SCRIPT = ['bidi', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN'];
/** Every ParaProps key (serialized names). */
export const PARA_KEYS = Object.freeze([...PARA_LAYOUT, ...PARA_PAGINATION, ...PARA_SCRIPT, 'numChange', 'fmtChange']);

/** ParaProps::overlaid. */
export function paraOverlaid(base, patch) {
  const out = {...(base || {})};
  if (!patch) return out;
  overlayKeys(out, patch, PARA_LAYOUT);
  overlayKeys(out, patch, PARA_PAGINATION);
  overlayKeys(out, patch, PARA_SCRIPT);
  return out;
}
export const paraIsEmpty = p => isEmptyObj(p);
/** Keep inherited indents in characters from winning over indents just set in points. */
export function paraCancelCharIndents(p, left, right, first) {
  const out = {...(p || {})};
  if (left) out.indentLeftChars = 0;
  if (right) out.indentRightChars = 0;
  if (first) out.indentFirstChars = 0;
  return out;
}
/** Just the formatting: without the tracked changes (ParaProps::formatting). */
export function paraFormatting(p) { const out = {...(p || {})}; delete out.numChange; delete out.fmtChange; return out; }

// --- table_props.rs -------------------------------------------------------------------------

export const VALIGNS = Object.freeze(['top', 'center', 'bottom']);
export const TEXT_DIRECTIONS = Object.freeze(['horizontal', 'down', 'up']);
export function textDirectionFromOoxml(v) {
  if (['tbRl', 'tbRlV', 'tbLrV', 'rl', 'rlV', 'lrV'].includes(v)) return 'down';
  if (v === 'btLr' || v === 'lr') return 'up';
  return 'horizontal';
}
export const textDirectionOoxml = d => ({horizontal: 'lrTb', down: 'tbRl', up: 'btLr'})[d] ?? 'lrTb';
/** Word's Text Direction button: horizontal → down → up → horizontal. */
export const textDirectionNext = d => ({horizontal: 'down', down: 'up', up: 'horizontal'})[d] ?? 'down';
export const textDirectionIsTurned = d => (d ?? 'horizontal') !== 'horizontal';

export const TEXT_VERTS = Object.freeze(['horz', 'vert', 'vert270', 'stacked']);
export function textVertFromOoxml(v) {
  if (['vert', 'eaVert', 'mongolianVert'].includes(v)) return 'vert';
  if (v === 'vert270') return 'vert270';
  if (v === 'wordArtVert' || v === 'wordArtVertRtl') return 'stacked';
  return 'horz';
}
export const textVertOoxml = v => ({horz: 'horz', vert: 'vert', vert270: 'vert270', stacked: 'wordArtVert'})[v] ?? 'horz';
export const textVertTurn = v => (v === 'vert' ? 'down' : v === 'vert270' ? 'up' : 'horizontal');
export const valignFromAnchor = v => (v === 'ctr' || v === 'dist' ? 'center' : v === 'b' ? 'bottom' : 'top');
export const anchorOoxml = a => (a === 'center' ? 'ctr' : a === 'bottom' ? 'b' : 't');

/** Word's default table style options ("look"). */
export const defaultTableLook = () => ({headerRow: true, totalRow: false, bandedRows: true, firstColumn: true, lastColumn: false, bandedColumns: false});
/** A table's look with upstream's defaults for missing flags. */
export function tableLook(props) {
  const d = defaultTableLook();
  const l = props?.look;
  if (!l) return d;
  for (const k of Object.keys(d)) if (typeof l[k] === 'boolean') d[k] = l[k];
  return d;
}

/** Distances from text of a floating table, finite and clamped (left, top, right, bottom). */
export const tableFloatDist = f => (f?.dist ?? [0, 0, 0, 0]).map(v => (Number.isFinite(v) ? Math.max(0, Math.min(1584, v)) : 0));

export const HEIGHT_RULES = Object.freeze(['auto', 'atLeast', 'exact']);
export const VMERGES = Object.freeze(['none', 'restart', 'continue']);

/** Resolve top, left, bottom and right cell margins against the table defaults (CellProps::resolved_margins). */
export function cellResolvedMargins(cp, defaults) {
  if (Array.isArray(cp?.margins)) return [...cp.margins];
  if (Array.isArray(cp?.partialMargins)) return defaults.map((d, i) => cp.partialMargins[i] ?? d);
  return [...defaults];
}
