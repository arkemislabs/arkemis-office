// Paragraph formatting and lists (Home › Paragraph, Layout › Paragraph), over the schema-2 model.
// Translated from wordcraft crates/engine/src/cmd/para.rs (the `para.*` specs) and its modules
// crates/engine/src/cmd/para/format.rs (`cur`, `fmt`, `align`, `set_align`, `direction`, `tog`,
// `asian_typography`, `set_props`, `indent`, `outdent`, `ls`, `line_spacing`),
// crates/engine/src/cmd/para/lists.rs (`list`, `restart_numbering`, `list_buttons`),
// crates/engine/src/cmd/para/outline.rs (`move_paras`, `outline_step`, `sort`, `natural_key`,
// `natural_cmp`) and crates/engine/src/cmd/para/tabs_borders.rs (`tabs`, `border_sides`, `borders`)
// at aadb077e072b7de05f724e359d8db82e151f125c. The Styles commands are in para/styles.mjs.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Not translated here: Outline view's collapsed headings moving with their heading (outline.rs
// `move_shown`, `hidden_subheadings`: Outline view is the outline family's) and whole-cell or column
// selections (`selected_paths` over `column_segments`), which the kernel selection cannot express.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import * as P from '../model/para.mjs';
import {alignVisual, paraOverlaid, paraCancelCharIndents, parseRgb, borderStyleFromOoxml, border as mkBorder, borderVisible, bordersAnyVisible,
  TAB_POS_EPS, BORDER_STYLES, TAB_LEADERS, readRgb} from '../model/props.mjs';
import {resolvePara, resolveChar} from '../model/styles.mjs';
import {readBorder} from './format.mjs';
import {samePath, pathParent, pathLast, pathWithLast, cmpPath} from '../model/document.mjs';
import {sortKey, cmpSortKeys} from '../model/collate.mjs';
import {UPSTREAM_COMMIT, ready, need, ordered, selectedPaths, curPara, focusOf, focusPara, fmt, fmtParas, selResult, peek}
  from '../lib/format-target.mjs';
import {toggleList, listButtons, restartNumbering, ensureHeadingStyle, headingLevel} from '../lib/para-lists.mjs';
import {moveShown, hiddenSubheadings, levelsOf} from '../lib/outline-view.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/para.rs', 'crates/engine/src/cmd/para/format.rs',
  'crates/engine/src/cmd/para/lists.rs', 'crates/engine/src/cmd/para/outline.rs', 'crates/engine/src/cmd/para/tabs_borders.rs']};

const NONE = s.object({});
const VALUE = s.object({value: s.optional(s.boolean({description: 'true sets it, false clears it; omitted toggles'}))});
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** state() with the resolved paragraph at the caret. */
function withCur(ctx, f) {
  const st = ready(ctx);
  if (!st.enabled) return st;
  try { const d = peek(ctx); return {enabled: true, ...f(curPara(ctx, d), d)}; } catch { return {enabled: true}; }
}

// ---------------------------------------------------------------------------------------------
// Alignment and direction

/** The alignment buttons (`align`): as seen on the page; clicking the active one returns to the start edge. */
function alignButton(ctx, a) {
  need(ctx);
  const r = curPara(ctx, peek(ctx));
  const logical = alignVisual(a, r.bidi);
  const tgt = r.align === logical && logical !== 'left' ? null : a;
  return fmt(ctx, p => { const rtl = p.bidi ?? r.bidi; p.align = tgt === null ? 'left' : alignVisual(tgt, rtl); });
}

/** Set the alignment as seen on the page in every selected paragraph, in its own direction (`set_align`). */
function setAlign(ctx, a) {
  need(ctx);
  const rtl = curPara(ctx, peek(ctx)).bidi;
  return fmt(ctx, p => { p.align = alignVisual(a, p.bidi ?? rtl); });
}

const alignCmd = (id, label, a, shortcut) => ({
  id, label, shortcut, risk: 'edit',
  description: `${label} (Home › Paragraph): as seen on the page; clicking it again returns the paragraph to its start edge.`,
  params: NONE,
  state: ctx => withCur(ctx, r => ({checked: alignVisual(r.align, r.bidi) === a})),
  run: ctx => alignButton(ctx, a),
});

// ---------------------------------------------------------------------------------------------
// Indents

function indentStep(ctx, inc) {
  need(ctx);
  ctx.model.edit(ctx, d => {
    const [a] = ordered(ctx, d);
    const tab = Math.max(1, d.settings?.defaultTab ?? 36);
    for (const path of selectedPaths(ctx, d)) {
      const p = d.para(a.story, path);
      if (!p) continue;
      const num = p.props?.numbering && p.props.numbering.num !== 0 ? p.props.numbering : null;
      const left = resolvePara(d.styles, p.props ?? {}).indentLeft;
      const para = d.paraMut(a.story, path);
      let props = {...(para.props ?? {})};
      if (num) props.numbering = {num: num.num, level: inc ? Math.min(8, num.level + 1) : Math.max(0, num.level - 1)};
      else {
        props.indentLeft = inc ? (Math.floor(left / tab) + 1) * tab : Math.max(0, (Math.ceil(left / tab) - 1) * tab);
        props = paraCancelCharIndents(props, true, false, false);
      }
      para.props = props;
    }
  });
  return selResult(ctx);
}

// ---------------------------------------------------------------------------------------------
// Line spacing

const ls = (ctx, l) => fmt(ctx, p => { p.lineSpacing = l; });

function lineSpacing(ctx, p) {
  need(ctx);
  let l;
  if (typeof p.atLeast === 'number') l = {rule: 'atLeast', value: clamp(p.atLeast, 0, 1584)};
  else if (typeof p.exactly === 'number') l = {rule: 'exactly', value: clamp(p.exactly, 0.7, 1584)};
  else if (typeof p.value === 'number') l = {rule: 'multiple', value: clamp(p.value, 0.06, 132)};
  else throw new CommandError('invalid_params', '`value` (a multiple), `atLeast` or `exactly` (points) is required', {path: '/value'});
  return ls(ctx, l);
}

const lineSpacingState = (ctx, p) => withCur(ctx, r => {
  const l = r.lineSpacing;
  if (typeof p?.value === 'number') return {checked: l.rule === 'multiple' && Math.abs(l.value - p.value) < 0.001};
  return {value: l.rule === 'multiple' ? l.value : null};
});

// ---------------------------------------------------------------------------------------------
// Lists

function listCmd(ctx, p, kind) {
  need(ctx);
  let out;
  ctx.model.edit(ctx, d => {
    const [a] = ordered(ctx, d);
    const paths = selectedPaths(ctx, d);
    out = toggleList(d, a.story, paths, paths[0] ?? a.path, p.kind, p.off, kind);
  });
  return {...selResult(ctx), ...out};
}

const listState = which => (ctx, p) => {
  const st = ready(ctx);
  if (!st.enabled) return st;
  try {
    const d = peek(ctx);
    const r = curPara(ctx, d);
    const b = listButtons(d.numbering, r.numbering);
    return {enabled: true, checked: p?.off ? false : b[which]};
  } catch { return {enabled: true}; }
};

// ---------------------------------------------------------------------------------------------
// Moving, promoting, sorting (outline.rs)

function moveParas(ctx, up) {
  need(ctx);
  let sel;
  ctx.model.edit(ctx, d => {
    const [a, b] = ordered(ctx, d);
    // Outline view: what's collapsed moves with its heading, past whole shown paragraphs (U:quill/view, outline.rs move_shown).
    const shown = moveShown(d, ctx.view, a, b, up);
    if (shown) {
      const all = ctx.model.selection(ctx);
      const r = all[ctx.selection?.primary ?? 0] ?? all[0];
      const fwd = r && (r.anchor.path[0] ?? 0) <= (r.focus.path[0] ?? 0);
      sel = fwd ? {anchor: shown[0], focus: shown[1]} : {anchor: shown[1], focus: shown[0]};
      return;
    }
    if (a.story !== b.story || !samePath(pathParent(a.path), pathParent(b.path))) {
      throw new CommandError('failed', 'select paragraphs in one place (not across table cells) to move them');
    }
    const i0 = pathLast(a.path);
    let i1 = pathLast(b.path);
    if (i1 > i0 && b.off === 0) i1 -= 1;
    const bl = d.container(a.story, a.path);
    let lo, hi;
    if (up) {
      if (i0 === 0) throw new CommandError('failed', 'already at the top');
      lo = i0 - 1; hi = i1;
    } else {
      const n = i1 + 1;
      if (n >= bl.len()) throw new CommandError('failed', 'already at the bottom');
      lo = i0; hi = n;
    }
    const neighbour = up ? lo : hi;
    if (bl.get(neighbour)?.kind !== 'para') throw new CommandError('failed', 'a table is in the way');
    const slice = [];
    for (let i = lo; i <= hi; i++) slice.push(bl.get(i));
    if (slice.some(x => x.kind === 'para' && x.section)) throw new CommandError('failed', "paragraphs don't move across a section break");
    const rotated = up ? [...slice.slice(1), slice[0]] : [slice[slice.length - 1], ...slice.slice(0, -1)];
    const ml = d.containerMut(a.story, a.path);
    rotated.forEach((x, k) => ml.set(lo + k, x));
    const len = ml.len();
    const shift = pos => {
      const i = pathLast(pos.path);
      if (i >= i0 && i <= i1) return {...pos, path: pathWithLast(pos.path, up ? i - 1 : i + 1)};
      if (!up && i === i1 + 1) {
        // The end just past the range: the start of whatever follows it now.
        return i1 + 2 < len ? {...pos, path: pathWithLast(pos.path, i1 + 2), off: 0} : {...pos, path: pathWithLast(pos.path, i1 + 1), off: Number.MAX_SAFE_INTEGER};
      }
      return pos;
    };
    const all = ctx.model.selection(ctx);
    const r = all[ctx.selection?.primary ?? 0] ?? all[0];
    sel = {anchor: shift(d.clamp(r.anchor)), focus: shift(d.clamp(r.focus))};
    sel = {anchor: d.clamp(sel.anchor), focus: d.clamp(sel.focus)};
  });
  ctx.model.setSelection(ctx, [sel]);
  return selResult(ctx);
}

function outlineStep(ctx, promote) {
  need(ctx);
  ctx.model.edit(ctx, d => {
    const [a, b] = ordered(ctx, d);
    // Outline view: the headings hidden under a collapsed heading move a level with it (U:quill/view, outline.rs hidden_subheadings).
    const carried = hiddenSubheadings(ctx.view, levelsOf(d), [a, b], d);
    const paths = d.pathsBetween(a, b);
    // The heading before the selection, for promoted body text.
    let before = 1;
    for (const q of d.paraPaths(a.story)) {
      if (cmpPath(q, a.path) >= 0) break;
      const h = headingLevel(d.styles, d.para(a.story, q)?.props);
      if (h !== null) before = h;
    }
    let changed = false;
    for (const path of paths) {
      const p = d.para(a.story, path);
      if (!p) continue;
      const list = p.props?.numbering && p.props.numbering.num !== 0 ? p.props.numbering : null;
      if (list) {
        const level = promote ? Math.max(0, list.level - 1) : Math.min(8, list.level + 1);
        if (level !== list.level) {
          const m = d.paraMut(a.story, path);
          m.props = {...m.props, numbering: {num: list.num, level}};
          changed = true;
        }
        continue;
      }
      const h = headingLevel(d.styles, p.props);
      let tgt = null;
      if (h !== null) tgt = promote ? (h - 1 >= 1 ? h - 1 : null) : (h + 1 <= 9 ? h + 1 : null);
      else if (promote) tgt = before;
      if (tgt === null) continue;
      const id = ensureHeadingStyle(d, tgt);
      const m = d.paraMut(a.story, path);
      const props = {...(m.props ?? {}), style: id};
      delete props.outlineLevel;
      m.props = props;
      changed = true;
    }
    if (!changed) throw new CommandError('failed', promote ? 'nothing to promote' : 'nothing to demote');
    for (const [j, h] of carried) {
      const n = promote ? Math.max(h - 1, 1) : Math.min(h + 1, 9);
      if (n === h) continue;
      const id = ensureHeadingStyle(d, n);
      const m = d.paraMut('body', [j]);
      const props = {...(m.props ?? {}), style: id};
      delete props.outlineLevel;
      m.props = props;
    }
  });
  return selResult(ctx);
}

/** A paragraph's sort key: the number it starts with, then its text in its language's order (`natural_key`). */
const naturalKey = (text, lang) => {
  const m = /^[0-9]+/.exec(text.trim());
  return [m ? Number(m[0]) : null, sortKey(text, lang)];
};
/** Numbers first, in numeric order; the rest in collation order (`natural_cmp`). */
const naturalCmp = (x, y) => {
  let n = 0;
  if (x[0] !== null && y[0] !== null) n = x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0;
  else if (x[0] !== null) n = -1;
  else if (y[0] !== null) n = 1;
  return n || cmpSortKeys(x[1], y[1]);
};

/** The language of a paragraph's text (`para_lang`): its first run with text, else its mark, through styles and defaults. */
function paraLang(sheet, p) {
  const run = p.runs.find(r => r.len > 0)?.props ?? P.markOf(p);
  return resolveChar(sheet, p.props?.style ?? null, run).lang;
}

/** Word's Sort Text "Number": the first number anywhere in the paragraph (sign, separators, decimals); none sorts first. */
const numberKey = (text, lang) => {
  const m = /[-+−]?(?:\d{1,3}(?:[,  ]\d{3})+|\d+)(?:[.]\d+)?/.exec(text);
  const n = m ? Number(m[0].replace(/[,  ]/g, '').replace('−', '-')) : null;
  return [Number.isFinite(n) ? n : null, sortKey(text, lang)];
};
/** Word's Sort Text "Date": the paragraph read as a date; text that is no date sorts first. */
const dateKey = (text, lang) => {
  const t = Date.parse(text.trim());
  return [Number.isFinite(t) ? t : null, sortKey(text, lang)];
};
/** Number and date order: paragraphs without a value first (as Word puts them), then by value, then by text. */
const valueCmp = (x, y) => {
  let n = 0;
  if (x[0] === null && y[0] !== null) n = -1;
  else if (x[0] !== null && y[0] === null) n = 1;
  else if (x[0] !== null && y[0] !== null) n = x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0;
  return n || cmpSortKeys(x[1], y[1]);
};

function sortParas(ctx, p) {
  need(ctx);
  let sel;
  ctx.model.edit(ctx, d => {
    const [a, b] = ordered(ctx, d);
    if (a.story !== b.story || !samePath(pathParent(a.path), pathParent(b.path))) throw new CommandError('failed', 'select paragraphs in one place to sort');
    const i0 = pathLast(a.path), i1 = pathLast(b.path);
    const first = d.para(a.story, a.path);
    const lang = (first ? paraLang(d.styles, first) : null) ?? resolveChar(d.styles, null, {}).lang ?? ctx.prefs?.editingLanguage ?? null;
    const bl = d.container(a.story, a.path);
    const slice = [];
    for (let i = i0; i <= i1; i++) slice.push(bl.get(i));
    if (slice.some(x => x?.kind !== 'para')) throw new CommandError('failed', "sorting tables isn't supported here; use Table › Sort");
    // Word's Sort Text: "My list has a header row" keeps the first paragraph where it is.
    const head = p.header ? 1 : 0;
    const type = p.type ?? 'text';
    const keyOf = type === 'number' ? numberKey : type === 'date' ? dateKey : naturalKey;
    const cmp = type === 'text' ? naturalCmp : valueCmp;
    const keyed = slice.slice(head).map(x => [keyOf(P.plainText(x), lang), x]);
    // Array.prototype.sort is stable: equal keys keep their order, as Word's sort does.
    keyed.sort((x, y) => (p.descending ? -cmp(x[0], y[0]) : cmp(x[0], y[0])));
    const ml = d.containerMut(a.story, a.path);
    keyed.forEach(([, x], k) => ml.set(i0 + head + k, x));
    sel = {anchor: {...a, off: 0}, focus: d.clamp(b)};
  });
  ctx.model.setSelection(ctx, [sel]);
  return selResult(ctx);
}

// ---------------------------------------------------------------------------------------------
// Tabs and borders (tabs_borders.rs)

/** Most tab stops a paragraph keeps. */
export const MAX_TABS = 64;
const TAB_ALIGN_SET = ['left', 'center', 'right', 'decimal', 'bar'];

function readStops(v, k) {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) throw new CommandError('invalid_params', `\`${k}\`: a list of tab stops`, {path: `/${k}`});
  if (v.length > MAX_TABS) throw new CommandError('invalid_params', `at most ${MAX_TABS} tab stops`, {path: `/${k}`});
  return v.map((t, i) => {
    if (!t || typeof t !== 'object' || typeof t.pos !== 'number' || !Number.isFinite(t.pos) || Math.abs(t.pos) > 1584) {
      throw new CommandError('invalid_params', 'tab positions are points within ±1584', {path: `/${k}/${i}/pos`});
    }
    const align = t.align ?? 'left';
    const leader = t.leader ?? 'none';
    if (!TAB_ALIGN_SET.includes(align)) throw new CommandError('invalid_params', `align: ${TAB_ALIGN_SET.join('|')}`, {path: `/${k}/${i}/align`});
    if (!TAB_LEADERS.includes(leader)) throw new CommandError('invalid_params', `leader: ${TAB_LEADERS.join('|')}`, {path: `/${k}/${i}/leader`});
    return {pos: t.pos, align, leader};
  });
}

function tabs(ctx, p) {
  need(ctx);
  const replace = readStops(p.tabs, 'tabs');
  const set = readStops(p.set, 'set') ?? [];
  const clear = p.clear ?? [];
  if (clear.length > MAX_TABS || clear.some(x => !Number.isFinite(x))) throw new CommandError('invalid_params', `\`clear\` is at most ${MAX_TABS} positions in points`, {path: '/clear'});
  const clearAll = !!p.clearAll;
  ctx.model.edit(ctx, d => {
    if (typeof p.default === 'number') d.updateField('settings', st => ({...st, defaultTab: clamp(p.default, 1, 1584)}));
    if (!replace && !set.length && !clear.length && !clearAll) return;
    const sheet = d.styles;
    const near = (x, y) => Math.abs(x - y) < TAB_POS_EPS;
    const [a] = ordered(ctx, d);
    fmtParas(d, a.story, selectedPaths(ctx, d), pp => {
      // The stops the paragraph inherits from its style.
      const inherited = resolvePara(sheet, {...pp, tabs: undefined}).tabs;
      let list = replace ? replace.slice() : (pp.tabs ?? []).slice();
      const clearAt = pos => {
        list = list.filter(t => !near(t.pos, pos));
        if (inherited.some(t => near(t.pos, pos))) list.push({pos, align: 'clear', leader: 'none'});
      };
      if (clearAll) { list = []; for (const t of inherited) clearAt(t.pos); }
      for (const pos of clear) clearAt(pos);
      for (const t of set) { list = list.filter(x => !near(x.pos, t.pos)); list.push(t); }
      list.sort((x, y) => x.pos - y.pos);
      pp.tabs = list.slice(0, MAX_TABS);
    });
  });
  return selResult(ctx);
}

/** A `sides` object: exactly the sides it names, each {style, width, color} (`border_sides`). */
export function borderSides(v, spaceTb, spaceLr) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new CommandError('invalid_params', '`sides` is an object', {path: '/sides'});
  const side = (k, space) => {
    const x = v[k];
    if (!x || typeof x !== 'object') return undefined;
    const style = typeof x.style === 'string' ? borderStyleFromOoxml(x.style) : 'single';
    const width = clamp(typeof x.width === 'number' ? x.width : 0.5, 0.25, 6);
    return mkBorder(style, width, typeof x.color === 'string' ? parseRgb(x.color) : null, space);
  };
  const out = {};
  for (const [k, sp] of [['top', spaceTb], ['left', spaceLr], ['bottom', spaceTb], ['right', spaceLr], ['between', spaceTb]]) {
    const b = side(k, sp);
    if (b) out[k] = b;
  }
  return out;
}

export const BORDER_KINDS = Object.freeze(['bottom', 'top', 'left', 'right', 'none', 'all', 'outside', 'inside', 'insideH', 'insideV', 'horizontalLine']);

function borders(ctx, p) {
  need(ctx);
  if (p.sides !== undefined) {
    const b = borderSides(p.sides, 1, 4);
    // An explicit empty set keeps a style's borders off.
    return fmt(ctx, pp => { pp.borders = b; });
  }
  const kind = p.kind ?? 'bottom';
  if (kind === 'insideV') throw new CommandError('disabled', 'Inside Vertical Border applies to table cells, not paragraphs');
  const width = clamp(typeof p.width === 'number' ? p.width : 0.5, 0.25, 6);
  const color = typeof p.color === 'string' ? parseRgb(p.color) : null;
  const style = typeof p.style === 'string' ? borderStyleFromOoxml(p.style) : 'single';
  const b = mkBorder(style, width, color, kind === 'left' || kind === 'right' ? 4 : 1);
  if (kind === 'horizontalLine') {
    // A paragraph with a bottom border, like Word's Horizontal Line.
    return fmt(ctx, pp => { pp.borders = {bottom: {...b, width: 1.5}}; });
  }
  return fmt(ctx, pp => {
    let cur = {...(pp.borders ?? {})};
    const flip = k => { if (borderVisible(cur[k])) delete cur[k]; else cur[k] = b; };
    switch (kind) {
      case 'none': cur = {}; break;
      case 'all': cur = {top: b, left: b, bottom: b, right: b, between: b}; break;
      case 'outside': cur.top = b; cur.bottom = b; cur.left = b; cur.right = b; break;
      // Word: a paragraph's inside (horizontal) border is the border between paragraphs.
      case 'inside': case 'insideH': cur.between = b; break;
      case 'top': case 'bottom': case 'left': case 'right': flip(kind); break;
      default: break;
    }
    pp.borders = bordersAnyVisible(cur) ? cur : {};
  });
}

/** Which border kind the Borders split shows as on (the paragraph's own sides). */
function bordersState(ctx, p) {
  return withCur(ctx, r => {
    const bs = r.borders ?? {};
    const k = p?.kind;
    if (k === 'insideV') return {enabled: false, reason: 'Inside Vertical Border applies to table cells, not paragraphs'};
    const on = side => borderVisible(bs[side]);
    let checked = false;
    if (k === 'top' || k === 'bottom' || k === 'left' || k === 'right') checked = on(k);
    else if (k === 'inside' || k === 'insideH') checked = on('between');
    else if (k === 'outside') checked = ['top', 'bottom', 'left', 'right'].every(on);
    else if (k === 'all') checked = ['top', 'bottom', 'left', 'right', 'between'].every(on);
    else if (k === 'none') checked = !bordersAnyVisible(bs);
    return {checked};
  });
}

// ---------------------------------------------------------------------------------------------
// para.set, para.asianTypography, toggles

const ASIAN = ['kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN'];

function asianTypography(ctx, p) {
  need(ctx);
  const given = ASIAN.filter(k => typeof p[k] === 'boolean');
  const out = given.length ? fmt(ctx, pp => { for (const k of given) pp[k] = p[k]; }) : selResult(ctx);
  const r = curPara(ctx, peek(ctx));
  return {...out, asianTypography: Object.fromEntries(ASIAN.map(k => [k, r[k]]))};
}

/** A ParaProps object from the bridge or a dialog (upstream's serde shape). */
export function readParaProps(v) {
  if (v === null || v === undefined) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new CommandError('invalid_params', 'props must be an object of paragraph properties', {path: '/props'});
  const out = {};
  const bad = (k, why) => { throw new CommandError('invalid_params', `${k}: ${why}`, {path: `/props/${k}`}); };
  const num = (k, lo, hi) => { if (typeof v[k] !== 'number' || !Number.isFinite(v[k])) bad(k, 'a number'); out[k] = clamp(v[k], lo, hi); };
  for (const [k, x] of Object.entries(v)) {
    if (x === null || x === undefined) continue;
    switch (k) {
      case 'align': if (!['left', 'center', 'right', 'justify', 'distribute'].includes(x)) bad(k, 'left|center|right|justify|distribute'); out[k] = x; break;
      case 'indentLeft': case 'indentRight': case 'indentFirst': num(k, -1584, 1584); break;
      case 'indentLeftChars': case 'indentRightChars': case 'indentFirstChars': num(k, -1584, 1584); break;
      case 'spaceBefore': case 'spaceAfter': num(k, 0, 1584); break;
      case 'outlineLevel': if (!Number.isInteger(x) || x < 0 || x > 9) bad(k, '0–9'); out[k] = x; break;
      case 'dropCap': if (!Number.isInteger(x) || x < 0 || x > 10) bad(k, '0–10'); out[k] = x; break;
      case 'dropCapDistance': num(k, 0, 1584); break;
      case 'lineSpacing': {
        if (!x || typeof x !== 'object' || !['multiple', 'atLeast', 'exactly'].includes(x.rule) || typeof x.value !== 'number') bad(k, '{rule: multiple|atLeast|exactly, value}');
        const lim = x.rule === 'multiple' ? [0.06, 132] : x.rule === 'exactly' ? [0.7, 1584] : [0, 1584];
        out[k] = {rule: x.rule, value: clamp(x.value, lim[0], lim[1])};
        break;
      }
      case 'shading': { const c = readRgb(x); if (!c) bad(k, '"RRGGBB" or [r, g, b]'); out[k] = c; break; }
      case 'style': case 'dropCapFont': if (typeof x !== 'string' || !x.trim()) bad(k, 'a name'); out[k] = x; break;
      case 'numbering': if (!x || !Number.isInteger(x.num) || !Number.isInteger(x.level)) bad(k, '{num, level}'); out[k] = {num: x.num, level: clamp(x.level, 0, 8)}; break;
      case 'tabs': out[k] = readStops(x, 'props/tabs'); break;
      case 'borders': {
        if (typeof x !== 'object' || Array.isArray(x)) bad(k, '{top, left, bottom, right, between}');
        const bs = {};
        for (const [side, b] of Object.entries(x)) if (b !== null && b !== undefined) bs[side] = readBorder(b, `/props/borders/${side}`);
        out[k] = bs;
        break;
      }
      case 'contextualSpacing': case 'mirrorIndents': case 'keepNext': case 'keepLines': case 'pageBreakBefore': case 'widowControl':
      case 'suppressHyphens': case 'suppressLineNumbers': case 'dropCapMargin': case 'snapToGrid': case 'bidi': case 'spaceBeforeAuto': case 'spaceAfterAuto':
      case 'kinsoku': case 'wordWrap': case 'overflowPunct': case 'topLinePunct': case 'autoSpaceDE': case 'autoSpaceDN':
        if (typeof x !== 'boolean') bad(k, 'true or false'); out[k] = x; break;
      case 'frame': case 'numChange': case 'fmtChange': out[k] = x; break;
      default: bad(k, 'unknown paragraph property');
    }
  }
  return out;
}

/** Set Paragraph Formatting (the Paragraph dialog's OK as one undo step, #1346) (`set_props`). */
function setProps(ctx, p) {
  need(ctx);
  const props = readParaProps(p.props);
  const page = p.onPage ?? {};
  const align = page.align === undefined ? null : page.align === 'both' ? 'justify' : page.align;
  if (align !== null && !['left', 'center', 'right', 'justify', 'distribute'].includes(align)) {
    throw new CommandError('invalid_params', `unknown alignment \`${page.align}\``, {path: '/onPage/align'});
  }
  const ind = k => (typeof page[k] === 'number' ? clamp(page[k], -1584, 1584) : null);
  const left = ind('left'), right = ind('right');
  ctx.model.edit(ctx, d => {
    const [a] = ordered(ctx, d);
    for (const path of selectedPaths(ctx, d)) {
      const para = d.para(a.story, path);
      if (!para) continue;
      const rtl = resolvePara(d.styles, paraOverlaid(para.props ?? {}, props)).bidi;
      const m = d.paraMut(a.story, path);
      const next = paraOverlaid(m.props ?? {}, props);
      if (align !== null) next.align = alignVisual(align, rtl);
      const [start, end] = rtl ? [right, left] : [left, right];
      if (start !== null) next.indentLeft = start;
      if (end !== null) next.indentRight = end;
      m.props = next;
    }
  });
  return selResult(ctx);
}

/** `tog`: Line and Page Breaks check boxes. */
const tog = (id, label, key) => ({
  id, label, risk: 'edit',
  description: `${label} (Home › Paragraph › Line and Page Breaks).`,
  params: VALUE,
  state: ctx => withCur(ctx, r => ({checked: !!r[key]})),
  run(ctx, p) {
    need(ctx);
    const own = focusPara(ctx, peek(ctx))?.props?.[key];
    const on = p.value ?? !(own ?? false);
    return {...fmt(ctx, pp => { pp[key] = on; }), value: on};
  },
});

const lengthPt = s.number({description: 'points'});

export default defineCommands({
  family: 'para',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    alignCmd('para.alignLeft', 'Align Left', 'left', 'Mod+L'),
    alignCmd('para.alignCenter', 'Center', 'center', 'Mod+E'),
    alignCmd('para.alignRight', 'Align Right', 'right', 'Mod+R'),
    alignCmd('para.justify', 'Justify', 'justify', 'Mod+J'),
    alignCmd('para.distribute', 'Distributed', 'distribute', 'Mod+Shift+J'),
    {
      id: 'para.align', label: 'Alignment', risk: 'edit',
      description: 'Alignment (Home › Paragraph): left|center|right|justify|distribute as seen on the page, or start|end in the reading direction. Sets it (never toggles).',
      params: s.object({value: s.enum(['left', 'center', 'right', 'justify', 'both', 'distribute', 'start', 'end'])}),
      state: (ctx, p) => withCur(ctx, r => (p?.value ? {checked: alignVisual(r.align, r.bidi) === p.value} : {value: alignVisual(r.align, r.bidi)})),
      run(ctx, p) {
        need(ctx);
        if (p.value === 'start') return fmt(ctx, pp => { pp.align = 'left'; });
        if (p.value === 'end') return fmt(ctx, pp => { pp.align = 'right'; });
        return setAlign(ctx, p.value === 'both' ? 'justify' : p.value);
      },
    },
    {
      id: 'para.rtl', label: 'Right-to-Left Text Direction', risk: 'edit',
      description: 'Right-to-Left Text Direction (Home › Paragraph): only the direction changes; start-aligned text moves to the other side.',
      params: s.object({value: s.optional(s.boolean({description: 'false = left to right'}))}),
      state: ctx => withCur(ctx, r => ({checked: !!r.bidi})),
      run(ctx, p) { need(ctx); const want = p.value ?? true; return fmt(ctx, pp => { pp.bidi = want; }); },
    },
    {
      id: 'para.ltr', label: 'Left-to-Right Text Direction', risk: 'edit',
      description: 'Left-to-Right Text Direction (Home › Paragraph).',
      params: s.object({value: s.optional(s.boolean({description: 'false = right to left'}))}),
      state: ctx => withCur(ctx, r => ({checked: !r.bidi})),
      run(ctx, p) { need(ctx); const want = !(p.value ?? true); return fmt(ctx, pp => { pp.bidi = want; }); },
    },
    {id: 'para.indent', label: 'Increase Indent', shortcut: 'Mod+M', risk: 'edit',
      description: 'Increase Indent (Home › Paragraph): to the next default tab stop; a list item goes down one level.',
      params: NONE, state: ready, run: ctx => indentStep(ctx, true)},
    {id: 'para.outdent', label: 'Decrease Indent', shortcut: 'Mod+Shift+M', risk: 'edit',
      description: 'Decrease Indent (Home › Paragraph): to the previous default tab stop; a list item goes up one level.',
      params: NONE, state: ready, run: ctx => indentStep(ctx, false)},
    {
      id: 'para.hangingIndent', label: 'Hanging Indent', shortcut: 'Mod+T', risk: 'edit',
      description: 'Hanging Indent: the left indent half an inch further in, the first line hanging back to where it was.',
      params: NONE, state: ready,
      run: ctx => fmt(ctx, p => {
        p.indentLeft = (p.indentLeft ?? 0) + 36; p.indentFirst = -36;
        Object.assign(p, paraCancelCharIndents(p, true, false, true));
      }),
    },
    {
      id: 'para.removeHanging', label: 'Reduce Hanging Indent', shortcut: 'Mod+Shift+T', risk: 'edit',
      description: 'Reduce Hanging Indent.',
      params: NONE, state: ready,
      run: ctx => fmt(ctx, p => {
        p.indentLeft = Math.max(0, (p.indentLeft ?? 0) - 36); p.indentFirst = 0;
        Object.assign(p, paraCancelCharIndents(p, true, false, true));
      }),
    },
    {
      id: 'para.indents', label: 'Indents', risk: 'edit',
      description: 'Indents (Layout › Paragraph): left, right and first line (negative = hanging), points.',
      params: s.object({left: s.optional(lengthPt), right: s.optional(lengthPt), firstLine: s.optional(lengthPt)}),
      state: (ctx, p) => withCur(ctx, r => ({value: 'left' in (p ?? {}) ? r.indentLeft : 'right' in (p ?? {}) ? r.indentRight : r.indentFirst})),
      run(ctx, p) {
        need(ctx);
        return fmt(ctx, pp => {
          if (typeof p.left === 'number') pp.indentLeft = clamp(p.left, -1584, 1584);
          if (typeof p.right === 'number') pp.indentRight = clamp(p.right, -1584, 1584);
          if (typeof p.firstLine === 'number') pp.indentFirst = clamp(p.firstLine, -1584, 1584);
          Object.assign(pp, paraCancelCharIndents(pp, typeof p.left === 'number', typeof p.right === 'number', typeof p.firstLine === 'number'));
        });
      },
    },
    {
      id: 'para.lineSpacing', label: 'Line and Paragraph Spacing', risk: 'edit',
      description: 'Line and Paragraph Spacing (Home › Paragraph): {value} lines (a multiple), {atLeast} or {exactly} points.',
      params: s.object({value: s.optional(s.number()), atLeast: s.optional(s.number()), exactly: s.optional(s.number())}),
      state: lineSpacingState,
      run: lineSpacing,
    },
    {id: 'para.single', label: 'Single Spacing', shortcut: 'Mod+1', risk: 'edit', description: 'Single line spacing.', params: NONE,
      state: ctx => lineSpacingState(ctx, {value: 1}), run: ctx => { need(ctx); return ls(ctx, {rule: 'multiple', value: 1}); }},
    {id: 'para.double', label: 'Double Spacing', shortcut: 'Mod+2', risk: 'edit', description: 'Double line spacing.', params: NONE,
      state: ctx => lineSpacingState(ctx, {value: 2}), run: ctx => { need(ctx); return ls(ctx, {rule: 'multiple', value: 2}); }},
    {id: 'para.oneAndHalf', label: '1.5 Line Spacing', shortcut: 'Mod+5', risk: 'edit', description: '1.5 line spacing.', params: NONE,
      state: ctx => lineSpacingState(ctx, {value: 1.5}), run: ctx => { need(ctx); return ls(ctx, {rule: 'multiple', value: 1.5}); }},
    {
      id: 'para.spacing', label: 'Paragraph Spacing', risk: 'edit',
      description: 'Paragraph Spacing (Layout › Paragraph): before/after in points; beforeAuto/afterAuto for automatic (HTML-style, 14 pt). A number replaces automatic spacing.',
      params: s.object({before: s.optional(lengthPt), after: s.optional(lengthPt), beforeAuto: s.optional(s.boolean()), afterAuto: s.optional(s.boolean())}),
      state: (ctx, p) => withCur(ctx, r => ({value: 'after' in (p ?? {}) ? r.spaceAfter : r.spaceBefore})),
      run(ctx, p) {
        need(ctx);
        const r = curPara(ctx, peek(ctx));
        const bAuto = p.beforeAuto ?? (typeof p.before === 'number' && r.beforeAuto ? false : undefined);
        const aAuto = p.afterAuto ?? (typeof p.after === 'number' && r.afterAuto ? false : undefined);
        return fmt(ctx, pp => {
          if (typeof p.before === 'number') pp.spaceBefore = clamp(p.before, 0, 1584);
          if (typeof p.after === 'number') pp.spaceAfter = clamp(p.after, 0, 1584);
          if (bAuto !== undefined) pp.spaceBeforeAuto = bAuto;
          if (aAuto !== undefined) pp.spaceAfterAuto = aAuto;
        });
      },
    },
    {
      id: 'para.addSpaceBefore', label: 'Add Space Before Paragraph', shortcut: 'Mod+0', risk: 'edit',
      description: 'Add (or Remove) Space Before Paragraph: 12 pt before, or none when there is some.',
      params: NONE,
      state: ctx => withCur(ctx, r => ({checked: r.spaceBefore > 0})),
      run(ctx) {
        need(ctx);
        const r = curPara(ctx, peek(ctx));
        const has = r.spaceBefore > 0;
        return fmt(ctx, pp => { pp.spaceBefore = has ? 0 : 12; if (r.beforeAuto) pp.spaceBeforeAuto = false; });
      },
    },
    {
      id: 'para.removeSpaceAfter', label: 'Remove Space After Paragraph', risk: 'edit',
      description: 'Remove (or Add) Space After Paragraph: none, or 8 pt when there is none.',
      params: NONE,
      state: ctx => withCur(ctx, r => ({checked: r.spaceAfter > 0})),
      run(ctx) {
        need(ctx);
        const r = curPara(ctx, peek(ctx));
        const has = r.spaceAfter > 0;
        return fmt(ctx, pp => { pp.spaceAfter = has ? 0 : 8; if (r.afterAuto) pp.spaceAfterAuto = false; });
      },
    },
    {
      id: 'para.reset', label: 'Reset Paragraph Formatting', shortcut: 'Mod+Q', risk: 'edit',
      description: 'Reset Paragraph Formatting: back to the paragraph style; the style, list membership and drop cap stay.',
      params: NONE, state: ready,
      run: ctx => fmt(ctx, p => {
        const keep = {};
        for (const k of ['style', 'numbering', 'dropCap', 'dropCapMargin', 'dropCapDistance', 'dropCapFont']) if (p[k] !== undefined) keep[k] = p[k];
        return keep;
      }),
    },
    {
      id: 'para.bullets', label: 'Bullets', shortcut: 'Mod+Shift+L', risk: 'edit',
      description: 'Bullets (Home › Paragraph): toggles a bulleted list; `kind` is "bullet" or the bullet character; `off` removes the list.',
      params: s.object({kind: s.optional(s.string({min: 1, max: 16})), off: s.optional(s.boolean())}),
      state: listState('bullets'),
      run: (ctx, p) => listCmd(ctx, p, 'bullet'),
    },
    {
      id: 'para.numbering', label: 'Numbering', risk: 'edit',
      description: 'Numbering (Home › Paragraph): toggles a numbered list (numbered, numberedParen, upperLetter, lowerLetter, lowerRoman, outline); `off` removes it.',
      params: s.object({kind: s.optional(s.enum(['numbered', 'number', 'numberedParen', 'upperLetter', 'lowerLetter', 'lowerLetterDot', 'lowerRoman', 'outline'])),
        off: s.optional(s.boolean())}),
      state: listState('numbering'),
      run: (ctx, p) => listCmd(ctx, p, 'numbered'),
    },
    {
      id: 'para.multilevel', label: 'Multilevel List', risk: 'edit',
      description: 'Multilevel List (Home › Paragraph): a legal (1. 1.1. 1.1.1.) or outline (I. A. 1.) list.',
      params: s.object({kind: s.optional(s.enum(['legal', 'multilevel', 'outline']))}),
      state: listState('multilevel'),
      run: (ctx, p) => listCmd(ctx, p, 'legal'),
    },
    {
      id: 'para.listLevel', label: 'Change List Level', risk: 'edit',
      description: 'Change List Level (Home › Paragraph › Bullets): 0–8.',
      params: s.object({level: s.optional(s.integer({min: 0}))}),
      state: (ctx, p) => withCur(ctx, r => ({enabled: !!r.numbering, ...(r.numbering ? {} : {reason: 'not in a list'}),
        checked: typeof p?.level === 'number' && r.numbering?.level === p.level})),
      run(ctx, p) {
        need(ctx);
        const lvl = Math.min(8, p.level ?? 0);
        return fmt(ctx, pp => { if (pp.numbering) pp.numbering = {...pp.numbering, level: lvl}; });
      },
    },
    {
      id: 'para.restartNumbering', label: 'Restart at 1', risk: 'edit',
      description: 'Restart at 1 (Home › Paragraph › Numbering): this paragraph and the following ones of its list start again.',
      params: NONE,
      state: ctx => withCur(ctx, (r, d) => {
        const own = focusPara(ctx, d)?.props?.numbering;
        return own && own.num !== 0 ? {} : {enabled: false, reason: 'not in a numbered list'};
      }),
      run(ctx) {
        need(ctx);
        ctx.model.edit(ctx, d => restartNumbering(d, focusOf(ctx, d)));
        return selResult(ctx);
      },
    },
    {id: 'para.moveUp', label: 'Move Paragraph Up', shortcut: 'Alt+Shift+Up', risk: 'edit',
      description: 'Move Paragraph Up: the selected paragraphs swap with the one above, in their own container.', params: NONE, state: ready,
      run: ctx => moveParas(ctx, true)},
    {id: 'para.moveDown', label: 'Move Paragraph Down', shortcut: 'Alt+Shift+Down', risk: 'edit',
      description: 'Move Paragraph Down.', params: NONE, state: ready, run: ctx => moveParas(ctx, false)},
    {id: 'para.promote', label: 'Promote', shortcut: 'Alt+Shift+Left', risk: 'edit',
      description: 'Promote: a heading up one level; body text becomes a heading at the level of the one before; a list item up one level.',
      params: NONE, state: ready, run: ctx => outlineStep(ctx, true)},
    {id: 'para.demote', label: 'Demote', shortcut: 'Alt+Shift+Right', risk: 'edit',
      description: 'Demote: a heading down one level; a list item down one level.', params: NONE, state: ready, run: ctx => outlineStep(ctx, false)},
    {
      id: 'para.shading', label: 'Shading', risk: 'edit',
      description: 'Shading (Home › Paragraph): the paragraph\'s background colour, or null for none.',
      params: s.object({color: s.optional(s.nullable(s.string({max: 32})))}),
      state: ready,
      run(ctx, p) {
        need(ctx);
        const c = p.color === null || p.color === undefined ? null : parseRgb(String(p.color));
        return fmt(ctx, pp => { if (c) pp.shading = c; else delete pp.shading; });
      },
    },
    {
      id: 'para.borders', label: 'Borders', risk: 'edit',
      description: 'Borders (Home › Paragraph): bottom|top|left|right (toggle), none, all, outside, inside, horizontalLine; or `sides` for exactly those sides.',
      params: s.object({
        kind: s.optional(s.enum(BORDER_KINDS)),
        width: s.optional(s.number()), color: s.optional(s.string({max: 32})), style: s.optional(s.enum(BORDER_STYLES.filter(x => x !== 'none'))),
        sides: s.optional(s.record(s.any())),
      }),
      state: bordersState,
      run: borders,
    },
    {
      id: 'para.sort', label: 'Sort', risk: 'edit', dialog: 'dialog.sortText',
      description: 'Sort (Home › Paragraph): the selected paragraphs, numbers first, then text in the language\'s order.',
      params: s.object({descending: s.optional(s.boolean()), type: s.optional(s.enum(['text', 'number', 'date'])),
        header: s.optional(s.boolean({description: 'the first paragraph is a header row and stays first'}))}),
      state: ready,
      run: sortParas,
    },
    tog('para.keepNext', 'Keep with Next', 'keepNext'),
    tog('para.keepLines', 'Keep Lines Together', 'keepLines'),
    tog('para.pageBreakBefore', 'Page Break Before', 'pageBreakBefore'),
    {
      ...tog('para.widowControl', 'Widow/Orphan Control', 'widowControl'),
      run(ctx, p) {
        need(ctx);
        // The model's own flag; Word turns widow control on by default (resolved true).
        const own = focusPara(ctx, peek(ctx))?.props?.widowControl;
        const on = p.value ?? !(own ?? false);
        return {...fmt(ctx, pp => { pp.widowControl = on; }), value: on};
      },
    },
    {
      id: 'para.asianTypography', label: 'Asian Typography', risk: 'edit',
      description: 'Asian Typography (Paragraph dialog tab): kinsoku, wordWrap, overflowPunct, topLinePunct, autoSpaceDE, autoSpaceDN; flags left out stay; returns the flags at the caret.',
      params: s.object(Object.fromEntries(ASIAN.map(k => [k, s.optional(s.boolean())]))),
      state: ready,
      run: asianTypography,
    },
    {
      id: 'para.tabs', label: 'Tabs', risk: 'edit', dialog: 'dialog.tabs',
      description: 'Tabs: replace the direct stops (`tabs`), `set` and `clear` stops, `clearAll`, and the `default` interval, in one step.',
      params: s.object({
        tabs: s.optional(s.array(s.any())), set: s.optional(s.array(s.any())), clear: s.optional(s.array(s.number())),
        clearAll: s.optional(s.boolean()), default: s.optional(s.number()),
      }),
      state: ready,
      run: tabs,
    },
    {
      id: 'para.outlineLevel', label: 'Outline Level', risk: 'edit',
      description: 'Outline Level (Paragraph dialog): 0–8 for Level 1–9, 9 or omitted for Body Text.',
      params: s.object({level: s.optional(s.nullable(s.integer({min: 0})))}),
      state: ctx => withCur(ctx, r => ({value: r.outlineLevel})),
      run(ctx, p) {
        need(ctx);
        const l = typeof p.level === 'number' ? Math.min(9, p.level) : null;
        return fmt(ctx, pp => { if (l === null) delete pp.outlineLevel; else pp.outlineLevel = l; });
      },
    },
    {
      id: 'para.set', label: 'Set Paragraph Formatting', risk: 'edit',
      description: 'Set Paragraph Formatting (the Paragraph dialog\'s OK as one step): `props` on every selected paragraph, then `onPage` alignment and indents as seen on the page.',
      params: s.object({props: s.optional(s.record(s.any())), onPage: s.optional(s.object({
        align: s.optional(s.enum(['left', 'center', 'right', 'justify', 'both', 'distribute'])), left: s.optional(s.number()), right: s.optional(s.number())}))}),
      state: ready,
      run: setProps,
    },
    {
      id: 'para.dialog', label: 'Paragraph Settings', risk: 'read', dialog: 'dialog.paragraph',
      description: 'Paragraph Settings (Home › Paragraph): opens the Paragraph dialog in the window.',
      params: NONE, state: ready,
      run(ctx) { need(ctx); return {...selResult(ctx), open: 'paragraph'}; },
    },
  ],
});
