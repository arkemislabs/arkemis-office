// Home › Font and Paragraph, the Format menu, Shape Format › WordArt Styles' text fill, outline and
// transform, Review › Language, and the Format Painter: character, paragraph and text box
// formatting of the text being edited or the selected shapes' text.
// Translated from deckcraft crates/engine/src/cmd/format.rs (`specs`, `on_param`, `current_run`,
// `current_para`) and cmd/format/{font.rs, paragraph.rs, painter.rs, ruler.rs, text_effects.rs},
// with cmd/text/formatting.rs (`format_run`, `format_para`, `format_body`, in
// core/prism/lib/format-text.mjs) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Not registered (controls stay hidden): font.add — deckcraft loads font bytes into its own font
// database for the session; the renderer draws with the system's fonts and has no way to add one.
// Font dialog / Paragraph dialog / Tabs / Columns with no fields return {dialog, params} (deckcraft's
// `UiRequest::Dialog`); the shell opens the dialog itself when a control runs them without args.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {UPSTREAM_COMMIT, bad, hasDoc, hasText, hasTextOrShapes, num, str, colorValue, colorParam, editShapes, applyPainted, fillSolid,
  colorScheme, colorRgb, lineDefault} from '../lib/shape-common.mjs';
import {onParam, currentRun, currentPara, currentFamily, currentBody, formatRun, formatPara, formatBody, formatSpan, selectedShapes, resolveCtx}
  from '../lib/format-text.mjs';
import {bodyOf, textPositions, ordered, editText} from '../lib/text-session.mjs';
import {textSelection, selectedShapeIds, slideById, currentSlideId} from '../model/doc.mjs';
import {findShape} from '../model/presentation.mjs';
import {propsAt, wordAt, textRange, nextCase, changeCaseParts} from '../model/edit.mjs';
import {paraLen, runContent, isTextRun, listLevel, listSet} from '../model/text.mjs';
import {xfrm as resolveXfrm, body as resolveBody} from '../model/resolve.mjs';
import {hex as rgbHex} from '../model/color.mjs';
import {warpAdjustDefaults} from '../formats/pptx-read.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/format.rs', 'crates/engine/src/cmd/format/font.rs',
  'crates/engine/src/cmd/format/paragraph.rs', 'crates/engine/src/cmd/format/painter.rs', 'crates/engine/src/cmd/format/ruler.rs',
  'crates/engine/src/cmd/format/text_effects.rs', 'crates/engine/src/cmd/text/formatting.rs']};

const any = d => s.optional(s.any({description: d}));
const ID = s.union([s.string({min: 1, max: 64}), s.integer({min: 0})]);

// ---------------------------------------------------------------------------------------------
// font.rs

/** PowerPoint's font size list (grow/shrink steps through it). */
export const SIZES = Object.freeze([8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66]);
export function step(cur, up) {
  if (up) return SIZES.find(v => v > cur + 0.01) ?? Math.min(cur + 8, 4000);
  return [...SIZES].reverse().find(v => v < cur - 0.01) ?? Math.max(cur - 1, 1);
}
const clampN = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function withTransparency(c, t) {
  const mods = (c.mods ?? []).filter(m => m.op !== 'alpha');
  if (t > 0) mods.push({op: 'alpha', val: Math.round((1 - t) * 100000)});
  const out = {...c, mods};
  if (!mods.length) delete out.mods;
  return out;
}

/** The `lang` / `noProof` params of the language commands, checked: a run-props setter. */
function languageEdit(cmd, p) {
  const lang = str(p, 'lang');
  const noProof = typeof p.noProof === 'boolean' ? p.noProof : undefined;
  if (lang === undefined && noProof === undefined) throw bad(cmd, 'give `lang` or `noProof`');
  if (lang !== undefined && (!lang || lang.length > 35 || !/^[A-Za-z0-9-]+$/.test(lang))) throw bad(cmd, '`lang` is a language tag such as en-US');
  return r => {
    if (lang !== undefined) r.lang = lang;
    if (noProof !== undefined) { if (noProof) r.noProof = true; else delete r.noProof; }
    return r;
  };
}

/** `language_all`: every run in the deck and the text styles new text inherits, one undo step. */
function languageAll(ctx, p) {
  const f = languageEdit('format.languageAll', p);
  const body = t => {
    if (!t) return t;
    const out = {...t, paragraphs: (t.paragraphs ?? []).map(pa => ({...pa, runs: (pa.runs ?? []).map(r => ({...r, props: f({...(r.props ?? {})})})),
      endProps: f({...(pa.endProps ?? {})})}))};
    if (t.listStyle?.levels) out.listStyle = {...t.listStyle, levels: t.listStyle.levels.map(lv => (lv ? {...lv, run: f({...(lv.run ?? {})})} : lv))};
    return out;
  };
  const shapes = (list, depth = 0) => (depth > 64 ? list : (list ?? []).map(sh => {
    const n = {...sh};
    if (n.text) n.text = body(n.text);
    if (n.kind?.type === 'table') n.kind = {...n.kind, rows: (n.kind.rows ?? []).map(r => ({...r, cells: (r.cells ?? []).map(c => ({...c, text: body(c.text)}))}))};
    else if (n.kind?.type === 'group') n.kind = {...n.kind, children: shapes(n.kind.children, depth + 1)};
    return n;
  }));
  const styles = l => {
    let ls = l ?? {levels: []};
    if (!listLevel(ls, 0)) ls = listSet(ls, 0, {para: {}, run: {}});
    return {...ls, levels: ls.levels.map(lv => (lv ? {...lv, run: f({...(lv.run ?? {})})} : lv))};
  };
  const c = ctx.doc;
  c.slides.forEach((sl, i) => {
    ctx.change.set(['slides', i, 'shapes'], shapes(sl.shapes));
    if (sl.notes) ctx.change.set(['slides', i, 'notes'], body(sl.notes));
  });
  const master = m => ({...m, shapes: shapes(m.shapes), layouts: (m.layouts ?? []).map(l => ({...l, shapes: shapes(l.shapes)})),
    titleStyle: styles(m.titleStyle), bodyStyle: styles(m.bodyStyle), otherStyle: styles(m.otherStyle)});
  c.masters.forEach((m, i) => ctx.change.set(['masters', i], master(m)));
  if (c.notesMaster) ctx.change.set(['notesMaster'], master(c.notesMaster));
  if (c.handoutMaster) ctx.change.set(['handoutMaster'], master(c.handoutMaster));
  ctx.change.set(['defaultTextStyle'], styles(c.defaultTextStyle));
  return {};
}

const UNDERLINES = ['none', 'sng', 'dbl', 'heavy', 'dotted', 'dash', 'wavy'];
/** `font_edits`: the Font dialog's fields, checked (deckcraft's messages). */
export function fontEdits(p) {
  const C = 'format.fontDialog';
  const e = {};
  const b = k => { if (p[k] === undefined) return; if (typeof p[k] !== 'boolean') throw bad(C, `\`${k}\` must be a bool`); e[k] = p[k]; };
  const strOf = k => { if (p[k] === undefined) return undefined; if (typeof p[k] !== 'string') throw bad(C, `\`${k}\` must be a string`); return p[k]; };
  const fam = strOf('family');
  if (fam !== undefined) {
    const t = fam.trim();
    if (!t || [...t].length > 200) throw bad(C, '`family` must be 1–200 characters');
    e.family = t;
  }
  if (p.size !== undefined) {
    if (typeof p.size !== 'number' || !Number.isFinite(p.size)) throw bad(C, '`size` must be a finite number');
    e.size = clampN(p.size, 1, 4000);
  }
  b('bold'); b('italic');
  const u = strOf('underline');
  if (u !== undefined) { if (!UNDERLINES.includes(u)) throw bad(C, '`underline` must be none, sng, dbl, heavy, dotted, dash or wavy'); e.underline = u; }
  if (p.color !== undefined) { const c = colorValue(p.color); if (!c) throw bad(C, 'invalid `color`'); e.color = c; }
  const st = strOf('strike');
  if (st !== undefined) {
    const m = {none: 'none', sng: 'single', single: 'single', dbl: 'double', double: 'double'}[st];
    if (!m) throw bad(C, '`strike` must be none, sng or dbl');
    e.strike = m;
  }
  if (p.baseline !== undefined) {
    if (typeof p.baseline === 'string') {
      const m = {none: 0, super: 0.3, superscript: 0.3, sub: -0.25, subscript: -0.25}[p.baseline];
      if (m === undefined) throw bad(C, '`baseline` must be none, super, sub or a fraction');
      e.baseline = m;
    } else if (typeof p.baseline === 'number') {
      if (!Number.isFinite(p.baseline)) throw bad(C, '`baseline` must be finite');
      e.baseline = clampN(p.baseline, -1, 1);
    } else throw bad(C, '`baseline` must be none, super, sub or a fraction');
  }
  const cp = strOf('caps');
  if (cp !== undefined) { if (!['none', 'small', 'all'].includes(cp)) throw bad(C, '`caps` must be none, small or all'); e.caps = cp; }
  if (p.spacing !== undefined) {
    if (typeof p.spacing !== 'number' || !Number.isFinite(p.spacing)) throw bad(C, '`spacing` must be a finite number');
    e.spacing = clampN(p.spacing, -100, 400);
  }
  return e;
}
function writeFontEdits(e, r) {
  if (e.family !== undefined) r.font = e.family;
  for (const k of ['size', 'bold', 'italic', 'underline', 'strike', 'baseline', 'caps', 'spacing']) if (e[k] !== undefined) r[k] = e[k];
  if (e.color !== undefined) r.fill = fillSolid(e.color);
  return r;
}

/** `color_command_value`: a colour as a `format.color` / `format.fontDialog` parameter, transforms included. */
export function colorCommandValue(c) {
  const o = {};
  for (const m of c.mods ?? []) if (typeof m.val === 'number') o[m.op] = m.val;
  const base = c.base ?? {};
  if (base.kind === 'rgb') return Object.keys(o).length ? {...o, rgb: `#${rgbHex(base.rgb)}`} : `#${rgbHex(base.rgb)}`;
  if (base.kind === 'scheme') return {...o, scheme: base.slot};
  if (base.kind === 'preset') return base.name;
  if (base.kind === 'system') return `#${rgbHex(base.last)}`;
  return null;
}

/** `font_dialog_params`: the Font dialog's values for the selection. */
export function fontDialogParams(ctx) {
  const r = currentRun(ctx);
  const bl = r.baseline ?? 0;
  const v = {
    family: currentFamily(ctx, r), size: r.size ?? 18, bold: r.bold ?? false, italic: r.italic ?? false,
    underline: r.underline && r.underline !== 'none' ? r.underline : 'none',
    strike: r.strike === 'double' ? 'dbl' : r.strike === 'single' ? 'sng' : 'none',
    baseline: bl > 0 ? 'super' : bl < 0 ? 'sub' : 'none', caps: r.caps === 'small' ? 'small' : r.caps === 'all' ? 'all' : 'none', spacing: r.spacing ?? 0,
  };
  if (r.fill?.kind === 'solid') v.color = colorCommandValue(r.fill.color);
  return v;
}

// ---------------------------------------------------------------------------------------------
// paragraph.rs

const ALIGN_PARSE = {left: 'left', l: 'left', center: 'center', ctr: 'center', right: 'right', r: 'right', justify: 'justify', just: 'justify',
  justLow: 'justLow', distributed: 'distributed', dist: 'distributed'};
function alignLoose(a) {
  return {center: 'center', centre: 'center', ctr: 'center', right: 'right', r: 'right', justify: 'justify', just: 'justify', justifyLow: 'justLow',
    justLow: 'justLow', distributed: 'distributed', dist: 'distributed'}[a] ?? 'left';
}
const finiteKey = (p, cmd, key) => {
  if (p[key] === undefined) return undefined;
  if (typeof p[key] !== 'number' || !Number.isFinite(p[key])) throw bad(cmd, `\`${key}\` must be a finite number`);
  return p[key];
};
export const clampPt = v => clampN(v, 0, 1584);

function bullets(ctx, p) {
  const cur = currentPara(ctx).bullet?.kind === 'char';
  const on = onParam(p, cur);
  const ch = str(p, 'char') ?? '•';
  const col = colorParam(p, 'color');
  const size = num(p, 'size') !== undefined ? clampN(p.size / 100, 0.25, 4) : undefined;
  const explicit = p.char !== undefined;
  return formatPara(ctx, 'format.bullets', para => {
    const pp = para.props ?? {};
    const lvl = para.level ?? 0;
    if (on) {
      pp.bullet = {kind: 'char', char: ch};
      if (explicit) pp.bulletFont = 'Arial';
      if (col) pp.bulletColor = col;
      if (size !== undefined) pp.bulletSize = size;
      if ((pp.indent == null || pp.indent >= 0) && (pp.marginLeft == null || pp.marginLeft === 0)) {
        pp.marginLeft = 18 + 36 * lvl;
        pp.indent = -18;
      }
    } else {
      pp.bullet = {kind: 'none'};
      pp.indent = 0;
      pp.marginLeft = 36 * lvl;
    }
    return {...para, props: pp};
  });
}

export const NUMBER_SCHEMES = Object.freeze(['arabicPeriod', 'arabicParenR', 'romanUcPeriod', 'romanLcPeriod', 'alphaUcPeriod', 'alphaLcParenR', 'alphaLcPeriod']);
function numbering(ctx, p) {
  const cur = currentPara(ctx).bullet?.kind === 'autoNum';
  const on = onParam(p, cur);
  const scheme = str(p, 'scheme') ?? 'arabicPeriod';
  const start = Number.isSafeInteger(p.start) && p.start >= 0 ? clampN(p.start, 1, 32767) : 1;
  const col = colorParam(p, 'color');
  const size = num(p, 'size') !== undefined ? clampN(p.size / 100, 0.25, 4) : undefined;
  return formatPara(ctx, 'format.numbering', para => {
    const pp = para.props ?? {};
    const lvl = para.level ?? 0;
    if (on) {
      pp.bullet = {kind: 'autoNum', scheme, startAt: start};
      if (col) pp.bulletColor = col;
      if (size !== undefined) pp.bulletSize = size;
      pp.marginLeft = 27 + 36 * lvl;
      pp.indent = -27;
    } else {
      pp.bullet = {kind: 'none'};
      pp.indent = 0;
      pp.marginLeft = 36 * lvl;
    }
    return {...para, props: pp};
  });
}

function level(ctx, cmd, d) {
  return formatPara(ctx, cmd, para => {
    const cur = para.level ?? 0;
    const l = clampN(cur + d, 0, 8);
    if (l === cur) return para;
    const pp = {...(para.props ?? {})};
    if (pp.marginLeft != null) pp.marginLeft = Math.max(pp.marginLeft + 36 * d, 0);
    return {...para, level: l, props: pp};
  });
}

const setPara = (para, patch) => ({...para, props: {...(para.props ?? {}), ...patch}});

function paragraph(ctx, p) {
  const a = str(p, 'align') === undefined ? undefined : ({center: 'center', right: 'right', justify: 'justify', distributed: 'distributed'}[p.align] ?? 'left');
  const ml = num(p, 'indentLeft'), ind = num(p, 'indentFirst'), sb = num(p, 'spaceBefore'), sa = num(p, 'spaceAfter');
  const ls = num(p, 'lineSpacing'), lsp = num(p, 'lineSpacingPt');
  return formatPara(ctx, 'format.paragraph', para => {
    const patch = {};
    if (a !== undefined) patch.align = a;
    if (ml !== undefined) patch.marginLeft = Math.max(ml, 0);
    if (ind !== undefined) patch.indent = ind;
    if (sb !== undefined) patch.spaceBefore = {kind: 'pts', v: Math.max(sb, 0)};
    if (sa !== undefined) patch.spaceAfter = {kind: 'pts', v: Math.max(sa, 0)};
    if (ls !== undefined) patch.lineSpacing = {kind: 'pct', v: clampN(ls, 0, 9.99)};
    if (lsp !== undefined) patch.lineSpacing = {kind: 'pts', v: Math.max(lsp, 0)};
    return setPara(para, patch);
  });
}

const PARA_DIALOG_KEYS = ['align', 'indentLeft', 'indentRight', 'indentFirst', 'special', 'specialBy', 'spaceBefore', 'spaceAfter', 'lineSpacing', 'lineSpacingPt'];
const spacingParts = sp => (sp?.kind === 'pct' ? ['pct', sp.v] : sp?.kind === 'pts' ? ['pts', sp.v] : ['pts', 0]);

/** `paragraph_dialog_params`: the Paragraph dialog's values for the caret's paragraph. */
export function paragraphDialogParams(ctx) {
  const pp = currentPara(ctx);
  const indent = pp.indent ?? 0;
  const [special, by] = indent > 0.05 ? ['first', indent] : indent < -0.05 ? ['hanging', -indent] : ['none', 0];
  const [lineKind, lineValue] = pp.lineSpacing?.kind === 'pts' ? ['exactly', pp.lineSpacing.v] : pp.lineSpacing?.kind === 'pct' ? ['multiple', pp.lineSpacing.v] : ['multiple', 1];
  const [beforeKind, before] = spacingParts(pp.spaceBefore);
  const [afterKind, after] = spacingParts(pp.spaceAfter);
  return {align: pp.align ?? 'left', indentLeft: pp.marginLeft ?? 0, indentRight: pp.marginRight ?? 0, special, specialBy: by, spaceBefore: before,
    spaceBeforeKind: beforeKind, spaceAfter: after, spaceAfterKind: afterKind, lineKind, lineValue,
    tabs: (pp.tabs ?? []).map(t => ({pos: t.pos, align: t.align})), defaultTab: pp.defaultTab ?? 72};
}
const writeSpacing = (kind, v) => (kind === 'pct' ? {kind: 'pct', v: clampN(v, 0, 10)} : {kind: 'pts', v: clampPt(v)});

function paragraphDialog(ctx, p) {
  const C = 'format.paragraphDialog';
  if (!PARA_DIALOG_KEYS.some(k => p[k] !== undefined)) return {dialog: 'dialog.paragraph', params: paragraphDialogParams(ctx)};
  let align;
  if (p.align !== undefined) {
    if (typeof p.align !== 'string') throw bad(C, '`align` must be a string');
    align = ALIGN_PARSE[p.align];
    if (!align) throw bad(C, '`align` must be left, center, right, justify, justLow or distributed');
  }
  const indentLeft = finiteKey(p, C, 'indentLeft'), indentRight = finiteKey(p, C, 'indentRight');
  const specialBy = finiteKey(p, C, 'specialBy');
  const by = specialBy === undefined ? undefined : clampPt(Math.max(specialBy, 0));
  let indent;
  if (p.special === undefined) {
    const f = finiteKey(p, C, 'indentFirst');
    indent = f === undefined ? undefined : clampN(f, -1584, 1584);
  } else {
    const k = typeof p.special === 'string' ? p.special : null;
    if (k === 'none') indent = 0;
    else if (k === 'first' || k === 'firstLine') indent = by ?? 0;
    else if (k === 'hanging' || k === 'hang') indent = -(by ?? 0);
    else throw bad(C, '`special` must be none, first or hanging');
  }
  const sb = finiteKey(p, C, 'spaceBefore'), sa = finiteKey(p, C, 'spaceAfter');
  const bk = str(p, 'spaceBeforeKind'), ak = str(p, 'spaceAfterKind');
  for (const k of [bk, ak]) if (k !== undefined && k !== 'pts' && k !== 'pct') throw bad(C, 'spacing kind must be pts or pct');
  const lm = finiteKey(p, C, 'lineSpacing'), lpt = finiteKey(p, C, 'lineSpacingPt');
  return formatPara(ctx, C, para => {
    const patch = {};
    if (align !== undefined) patch.align = align;
    if (indentLeft !== undefined) patch.marginLeft = clampPt(indentLeft);
    if (indentRight !== undefined) patch.marginRight = clampPt(indentRight);
    if (indent !== undefined) patch.indent = indent;
    if (sb !== undefined) patch.spaceBefore = writeSpacing(bk, sb);
    if (sa !== undefined) patch.spaceAfter = writeSpacing(ak, sa);
    if (lm !== undefined) patch.lineSpacing = {kind: 'pct', v: clampN(lm, 0, 9.99)};
    if (lpt !== undefined) patch.lineSpacing = {kind: 'pts', v: clampPt(lpt)};
    return setPara(para, patch);
  });
}

export const tabAlign = a => ({l: 'l', left: 'l', ctr: 'ctr', center: 'ctr', r: 'r', right: 'r', dec: 'dec', decimal: 'dec'}[a] ?? null);
export const tabsParams = ctx => { const pp = currentPara(ctx); return {tabs: (pp.tabs ?? []).map(t => ({pos: t.pos, align: t.align})), defaultTab: pp.defaultTab ?? 72}; };

const ANCHOR = {middle: 'middle', center: 'middle', ctr: 'middle', bottom: 'bottom', b: 'bottom'};
const DIRS = {rotate90: 'vertical', vert: 'vertical', rotate270: 'vertical270', vert270: 'vertical270', stacked: 'stacked'};

/** The edited or first selected shape's columns as drawn: [count, spacing pt]. */
export function currentColumns(ctx) {
  const b = currentBody(ctx);
  if (!b) return [1, 0];
  return [clampN(b.columns ?? 1, 1, 16), Math.max(b.colSpacing ?? 0, 0)];
}

function columns(ctx, p) {
  const C = 'format.columns';
  let count;
  if (p.count !== undefined) {
    if (typeof p.count !== 'number' || !Number.isInteger(p.count) || p.count < 1 || p.count > 16) throw bad(C, '`count` must be a whole number from 1 to 16');
    count = p.count;
  }
  const sp = finiteKey(p, C, 'spacing');
  const spacing = sp === undefined ? undefined : clampPt(sp);
  if (count === undefined && spacing === undefined) {
    const [n, g] = currentColumns(ctx);
    return {dialog: 'dialog.columns', params: {count: n, spacing: g}};
  }
  return formatBody(ctx, C, b => {
    if (count !== undefined) b.columns = count;
    if (spacing !== undefined) b.colSpacing = spacing;
    return b;
  });
}

function margins(ctx, p) {
  const keys = [['left', 'insetL'], ['top', 'insetT'], ['right', 'insetR'], ['bottom', 'insetB']];
  return formatBody(ctx, 'format.margins', b => {
    for (const [k, f] of keys) if (num(p, k) !== undefined) b[f] = Math.max(p[k], 0);
    return b;
  });
}

// ---------------------------------------------------------------------------------------------
// ruler.rs

const MAX_TABS = 32;
function ruler(ctx) {
  const pp = currentPara(ctx);
  const t = textSelection(ctx.doc, ctx.selection);
  if (!t) throw bad('format.ruler', 'not editing text');
  let x = 0, y = 0, w = 0, rotated = true;
  const sl = slideById(ctx.doc, t.slide);
  const sh = !t.notes ? findShape(sl?.shapes, t.shape) : null;
  if (sh) {
    const rc = resolveCtx(ctx);
    const box = rc ? resolveXfrm(rc, sh) : sh.xfrm ?? {x: 0, y: 0, w: 0, h: 0};
    const body = rc ? resolveBody(rc, sh) : {...(sh.text?.body ?? {})};
    const l = body.insetL ?? 7.2, r = body.insetR ?? 7.2, tp = body.insetT ?? 3.6;
    x = box.x + l; y = box.y + tp; w = Math.max(box.w - l - r, 0);
    rotated = (box.rot ?? 0) !== 0 || (body.vert != null && body.vert !== 'horizontal');
  }
  return {x, y, width: w, rotated, marginLeft: pp.marginLeft ?? 0, indent: pp.indent ?? 0, tabs: (pp.tabs ?? []).map(s2 => ({pos: s2.pos, align: s2.align})),
    defaultTab: pp.defaultTab ?? 72};
}

function tabs(ctx, p) {
  const C = 'format.tabs';
  const fin = v => (typeof v === 'number' && Number.isFinite(v) ? clampN(v, 0, 4000) : undefined);
  const alignOf = v => ({ctr: 'ctr', center: 'ctr', r: 'r', right: 'r', dec: 'dec', decimal: 'dec'}[v?.align] ?? 'l');
  const add = p.add && fin(p.add.pos) !== undefined ? [fin(p.add.pos), alignOf(p.add)] : undefined;
  const mv = p.move && fin(p.move.from) !== undefined && fin(p.move.to) !== undefined ? [fin(p.move.from), fin(p.move.to)] : undefined;
  const remove = fin(p.remove);
  let set;
  if (p.set !== undefined) {
    if (!Array.isArray(p.set)) throw bad(C, '`set` must be an array');
    if (p.set.length > 64) throw bad(C, '`set` has more than 64 tab stops');
    set = [];
    p.set.forEach((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw bad(C, `tab stop ${i} must be an object`);
      if (typeof item.pos !== 'number' || !Number.isFinite(item.pos)) return;
      const pos = clampPt(item.pos);
      let align = 'l';
      if (item.align !== undefined) {
        align = typeof item.align === 'string' ? tabAlign(item.align) : null;
        if (!align) throw bad(C, `tab stop ${i} align must be l, ctr, r or dec`);
      }
      const prev = set.findIndex(t => Math.abs(t.pos - pos) < 0.05);
      if (prev >= 0) set[prev] = {pos, align}; else set.push({pos, align});
    });
  }
  const clear = p.clear === true;
  const dt = finiteKey(p, C, 'defaultTab');
  const defaultTab = dt === undefined ? undefined : clampN(dt, 1, 1584);
  const editsStops = set !== undefined || add !== undefined || mv !== undefined || remove !== undefined || clear;
  if (!editsStops && defaultTab === undefined) return {dialog: 'dialog.tabs', params: tabsParams(ctx)};
  const base = currentPara(ctx).tabs ?? [];
  const near = (a, b) => Math.abs(a - b) < 0.5;
  let stops = clear ? [] : (set ?? base).map(t => ({...t}));
  if (remove !== undefined) stops = stops.filter(t => !near(t.pos, remove));
  if (mv) { const t = stops.find(x => near(x.pos, mv[0])); if (t) t.pos = mv[1]; }
  if (add) { stops = stops.filter(t => !near(t.pos, add[0])); stops.push({pos: add[0], align: add[1]}); }
  stops.sort((a, b) => a.pos - b.pos);
  // Rust's dedup_by keeps the first of each run of near stops.
  stops = stops.filter((t, i) => i === 0 || !near(t.pos, stops[i - 1].pos));
  stops = stops.slice(0, MAX_TABS);
  return formatPara(ctx, C, para => {
    const patch = {};
    if (editsStops) patch.tabs = stops.map(t => ({...t}));
    if (defaultTab !== undefined) patch.defaultTab = defaultTab;
    return setPara(para, patch);
  });
}

// ---------------------------------------------------------------------------------------------
// text_effects.rs

const TEXT_SHADOW = () => ({color: {base: {kind: 'rgb', rgb: {r: 0, g: 0, b: 0, a: 255}}, mods: [{op: 'alpha', val: 43000}]}, blur: 3, dist: 2, dir: 45,
  inner: false, sx: 1, sy: 1, kx: 0, ky: 0, align: '', rotateWithShape: false});

/** The 36 Transform › Warp presets deckcraft draws, Follow Path first (crates/geom/src/warp.rs `PRESETS`). */
export const WARPS = Object.freeze([['textArchUp', 'Arch Up'], ['textArchDown', 'Arch Down'], ['textCircle', 'Circle'], ['textButton', 'Button'],
  ['textPlain', 'Plain'], ['textStop', 'Stop'], ['textTriangle', 'Triangle'], ['textTriangleInverted', 'Inverted Triangle'], ['textChevron', 'Chevron'],
  ['textChevronInverted', 'Inverted Chevron'], ['textRingInside', 'Ring Inside'], ['textRingOutside', 'Ring Outside'], ['textArchUpPour', 'Arch Up Pour'],
  ['textArchDownPour', 'Arch Down Pour'], ['textCirclePour', 'Circle Pour'], ['textButtonPour', 'Button Pour'], ['textCurveUp', 'Curve Up'],
  ['textCurveDown', 'Curve Down'], ['textCanUp', 'Can Up'], ['textCanDown', 'Can Down'], ['textInflate', 'Inflate'], ['textDeflate', 'Deflate'],
  ['textInflateBottom', 'Inflate Bottom'], ['textDeflateBottom', 'Deflate Bottom'], ['textInflateTop', 'Inflate Top'], ['textDeflateTop', 'Deflate Top'],
  ['textDeflateInflate', 'Deflate Inflate'], ['textDeflateInflateDeflate', 'Deflate Inflate Deflate'], ['textFadeRight', 'Fade Right'],
  ['textFadeLeft', 'Fade Left'], ['textFadeUp', 'Fade Up'], ['textFadeDown', 'Fade Down'], ['textSlantUp', 'Slant Up'], ['textSlantDown', 'Slant Down'],
  ['textCascadeUp', 'Cascade Up'], ['textCascadeDown', 'Cascade Down']]);
export const warpSupported = name => warpAdjustDefaults(name).length > 0;

function textWarp(ctx, p) {
  const C = 'format.textWarp';
  const preset = str(p, 'preset');
  if (preset === undefined) throw bad(C, 'missing `preset`');
  const clear = preset === 'none' || preset === 'textNoShape';
  if (!clear && !warpSupported(preset)) throw bad(C, `unknown text transform \`${preset}\``);
  let adj = [];
  if (p.adj !== undefined) {
    if (!Array.isArray(p.adj)) throw bad(C, '`adj` must be an array of numbers');
    if (p.adj.length > 8) throw bad(C, 'at most 8 adjust values');
    adj = p.adj.map(n => {
      if (typeof n !== 'number' || !Number.isFinite(n)) throw bad(C, 'adjust values must be finite numbers');
      return clampN(n, -2e9, 2e9);
    });
  }
  return formatBody(ctx, C, b => {
    if (clear) delete b.warp; else b.warp = preset;
    if (adj.length) b.warpAdj = adj; else delete b.warpAdj;
    return b;
  });
}

/** Rewrite the [from, to) text of paragraph `para` in `mode`, run by run (breaks and fields are read for context, not rewritten). */
function recaseParagraph(para, from, to, mode) {
  let pos = 0;
  const pieces = [];
  (para.runs ?? []).forEach((r, ri) => {
    const len = runContent(r).length;
    const rs = Math.max(from, pos) - pos, re = Math.min(to, pos + len) - pos;
    if (re > rs) pieces.push([ri, Math.max(rs, 0), re]);
    pos += len;
  });
  const mids = pieces.map(([ri, rs, re]) => runContent(para.runs[ri]).slice(rs, re));
  const changed = changeCaseParts(mids, mode);
  const runs = [...para.runs];
  pieces.forEach(([ri, rs, re], i) => {
    const r = runs[ri];
    if (!isTextRun(r)) return;
    runs[ri] = {...r, text: r.text.slice(0, rs) + changed[i] + r.text.slice(re)};
  });
  return {...para, runs};
}

function changeCase(ctx, p) {
  const mode = str(p, 'mode') ?? 'cycle';
  const t = textSelection(ctx.doc, ctx.selection);
  if (t) {
    const body = bodyOf(ctx.doc, t) ?? {body: {}, paragraphs: []};
    const {anchor, caret} = textPositions(body, t);
    let [a, b] = ordered(anchor, caret);
    const collapsed = a[0] === b[0] && a[1] === b[1];
    if (collapsed) {
      const [wa, wb] = wordAt(body, a);
      const isWord = /[\p{L}\p{N}]/u.test(textRange(body, wa, wb));
      if (!(isWord && wa[1] <= a[1] && a[1] < wb[1])) return {};
      a = wa; b = wb;
    }
    const m = mode === 'cycle' ? nextCase(textRange(body, a, b)) : mode;
    editText(ctx, 'format.case', (bd, sel) => {
      const paragraphs = [...bd.paragraphs];
      for (let pi = a[0]; pi <= Math.min(b[0], paragraphs.length - 1); pi++) {
        const n = paraLen(paragraphs[pi]);
        paragraphs[pi] = recaseParagraph(paragraphs[pi], pi === a[0] ? a[1] : 0, pi === b[0] ? b[1] : n, m);
      }
      if (collapsed) { sel.anchor = a; sel.caret = a; }
      return {body: {...bd, paragraphs}};
    });
    return {};
  }
  const m = mode === 'cycle'
    ? nextCase(selectedShapes(ctx).filter(sh => sh.text).map(sh => sh.text.paragraphs.map(pa => (pa.runs ?? []).map(runContent).join('')).join('\n')).join('\n'))
    : mode;
  editShapes(ctx, {}, 'format.case', sh => {
    if (!sh.text) return;
    sh.text = {...sh.text, paragraphs: sh.text.paragraphs.map(pa => {
      const changed = changeCaseParts((pa.runs ?? []).map(runContent), m);
      return {...pa, runs: (pa.runs ?? []).map((r, i) => (isTextRun(r) ? {...r, text: changed[i]} : r))};
    })};
  });
  return {};
}

// ---------------------------------------------------------------------------------------------
// painter.rs

/** `painter_pick`: the formatting the Format Painter carries. */
function painterPick(ctx, p) {
  // The ribbon button pressed while armed puts the painter down (deckcraft ribbon/home.rs).
  if (ctx.view?.painter && p.sticky === undefined && ctx.origin === 'ui') { ctx.setView({painter: null}); return {armed: false}; }
  const painted = {};
  const t = textSelection(ctx.doc, ctx.selection);
  if (t) {
    const b = bodyOf(ctx.doc, t);
    if (b) {
      const a = ordered(...Object.values(textPositions(b, t)))[0];
      painted.run = propsAt(b, [a[0], a[1] + 1]);
      if (b.paragraphs?.[a[0]]) painted.para = structuredClone(b.paragraphs[a[0]].props ?? {});
    }
  } else {
    const sh = selectedShapes(ctx)[0];
    if (sh) {
      painted.fill = sh.fill ?? null; painted.line = sh.line ?? null; painted.effects = sh.effects ?? null; painted.style = sh.style ?? null;
      const r = sh.text?.paragraphs?.[0]?.runs?.[0];
      if (r) painted.run = structuredClone(r.props ?? {});
    }
  }
  ctx.setView({painter: {painted, sticky: p.sticky === true}});
  return {armed: true};
}

/** `covered_paragraphs`: paragraphs the text selection covers whole. */
function coveredParagraphs(body, t) {
  const {anchor, caret} = textPositions(body, t);
  const [a, b] = ordered(anchor, caret);
  const out = [];
  for (let pi = a[0]; pi <= Math.min(b[0], (body.paragraphs?.length ?? 1) - 1); pi++) {
    const para = body.paragraphs?.[pi];
    if (!para) continue;
    const starts = pi > a[0] || a[1] === 0;
    const ends = pi < b[0] ? true : b[0] > a[0] && b[1] === 0 ? false : b[1] >= paraLen(para);
    if (starts && ends) out.push(pi);
  }
  return out;
}

function painterApply(ctx, p) {
  const armed = ctx.view?.painter;
  if (!armed) throw bad('format.painterApply', 'pick formatting with the Format Painter first');
  if (!armed.sticky) ctx.setView({painter: null});
  const painted = armed.painted ?? {};
  const t = textSelection(ctx.doc, ctx.selection);
  const isRange = t && (t.anchor !== t.caret);
  if (isRange && p.ids === undefined) {
    if (painted.run) formatRun(ctx, 'format.painterApply', () => ({...painted.run}));
    const t2 = textSelection(ctx.doc, ctx.selection);
    const body = t2 && bodyOf(ctx.doc, t2);
    const covered = body ? coveredParagraphs(body, t2) : [];
    if (painted.para && covered.length) {
      editText(ctx, 'format.painterApply', bd => ({body: {...bd, paragraphs: bd.paragraphs.map((pa, i) => (covered.includes(i) ? {...pa, props: structuredClone(painted.para)} : pa))}}));
    }
    return {};
  }
  editShapes(ctx, p, 'format.painterApply', sh => applyPainted(sh, painted));
  return {};
}

/** `state`: the effective formatting at the selection. */
function formatState(ctx) {
  const r = currentRun(ctx);
  const pp = currentPara(ctx);
  return {
    font: currentFamily(ctx, r), fontRef: r.font ?? null, size: r.size ?? null, bold: r.bold ?? false, italic: r.italic ?? false,
    underline: !!r.underline && r.underline !== 'none', strike: !!r.strike && r.strike !== 'none', superscript: (r.baseline ?? 0) > 0,
    subscript: (r.baseline ?? 0) < 0, align: pp.align ?? null, bullets: pp.bullet?.kind === 'char', numbering: pp.bullet?.kind === 'autoNum',
    lang: r.lang ?? null, lineSpacing: pp.lineSpacing ?? null, painter: !!ctx.view?.painter,
  };
}

// ---------------------------------------------------------------------------------------------
// Ribbon state helpers

const gate = f => (ctx, p) => { const st = hasTextOrShapes(ctx); return st.enabled ? {...st, ...f(ctx, p)} : st; };
const runOn = pred => gate(ctx => ({checked: pred(currentRun(ctx))}));
const alignOn = a => gate(ctx => ({checked: (currentPara(ctx).align ?? 'left') === a}));
const toggleSchema = extra => s.object({on: s.optional(s.boolean()), ...extra});

const alignTo = (id, label, shortcut, a) => ({id, label, shortcut, risk: 'edit', description: '{}', params: s.object({}), state: alignOn(a),
  run: ctx => formatPara(ctx, id, para => setPara(para, {align: a}))});

export default defineCommands({
  family: 'format',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {id: 'font.rescan', label: 'Rescan Installed Fonts', risk: 'read', needs: 'worker', description: '{} → {faces, families} (fonts installed since start-up)',
      params: s.object({}), state: () => ({enabled: true}),
      async run(ctx) {
        const list = (await ctx.host?.fonts?.()) ?? [];
        const families = new Set(list.map(f => f.family).filter(Boolean));
        return {faces: list.length, families: families.size};
      }},
    {id: 'format.bold', label: 'Bold', shortcut: 'Mod+B', risk: 'edit', description: '{on?: bool}', params: toggleSchema(), state: runOn(r => !!r.bold),
      run(ctx, p) { const v = onParam(p, currentRun(ctx).bold); return formatRun(ctx, 'format.bold', r => ({...r, bold: v})); }},
    {id: 'format.italic', label: 'Italic', shortcut: 'Mod+I', risk: 'edit', description: '{on?: bool}', params: toggleSchema(), state: runOn(r => !!r.italic),
      run(ctx, p) { const v = onParam(p, currentRun(ctx).italic); return formatRun(ctx, 'format.italic', r => ({...r, italic: v})); }},
    {id: 'format.underline', label: 'Underline', shortcut: 'Mod+U', risk: 'edit', description: '{on?: bool, style?: sng|dbl|heavy|dotted|dash|wavy}',
      params: toggleSchema({style: s.optional(s.string({max: 32}))}), state: runOn(r => !!r.underline && r.underline !== 'none'),
      run(ctx, p) {
        const cur = currentRun(ctx).underline;
        const v = onParam(p, !!cur && cur !== 'none');
        const style = p.style ?? 'sng';
        return formatRun(ctx, 'format.underline', r => ({...r, underline: v ? style : 'none'}));
      }},
    {id: 'format.strikethrough', label: 'Strikethrough', shortcut: 'Mod+Shift+X', risk: 'edit', description: '{on?: bool, double?: bool}',
      params: toggleSchema({double: s.optional(s.boolean())}), state: runOn(r => !!r.strike && r.strike !== 'none'),
      run(ctx, p) {
        const cur = currentRun(ctx).strike;
        const v = onParam(p, !!cur && cur !== 'none');
        return formatRun(ctx, 'format.strikethrough', r => ({...r, strike: !v ? 'none' : p.double ? 'double' : 'single'}));
      }},
    {id: 'format.superscript', label: 'Superscript', shortcut: 'Mod+Shift+=', risk: 'edit', description: '{on?: bool}', params: toggleSchema(),
      state: runOn(r => (r.baseline ?? 0) > 0),
      run(ctx, p) { const v = onParam(p, (currentRun(ctx).baseline ?? 0) > 0); return formatRun(ctx, 'format.superscript', r => ({...r, baseline: v ? 0.3 : 0})); }},
    {id: 'format.subscript', label: 'Subscript', shortcut: 'Mod+=', risk: 'edit', description: '{on?: bool}', params: toggleSchema(),
      state: runOn(r => (r.baseline ?? 0) < 0),
      run(ctx, p) { const v = onParam(p, (currentRun(ctx).baseline ?? 0) < 0); return formatRun(ctx, 'format.subscript', r => ({...r, baseline: v ? -0.25 : 0})); }},
    {id: 'format.font', label: 'Font', risk: 'edit', description: '{family}', params: s.object({family: s.string({min: 1, max: 256})}),
      // With nothing selected the box is off but shows the font new text gets: the theme's body font.
      state: (ctx, p) => { const st = hasTextOrShapes(ctx); return st.enabled ? {...st, value: currentFamily(ctx)} : {...st, value: ctx.doc?.masters?.[0]?.theme?.fonts?.minor?.latin || undefined}; },
      run: (ctx, p) => formatRun(ctx, 'format.font', r => ({...r, font: p.family}))},
    {id: 'format.size', label: 'Font Size', risk: 'edit', description: '{size: pt}', params: s.object({size: s.union([s.number(), s.string({max: 16})])}),
      state: (ctx, p) => { const st = hasTextOrShapes(ctx); return st.enabled ? {...st, value: currentRun(ctx).size ?? 18, items: SIZES} : {...st, value: 18, items: SIZES}; },
      run(ctx, p) {
        const n = typeof p.size === 'number' ? p.size : Number.parseFloat(p.size);
        if (!Number.isFinite(n)) throw bad('format.size', 'missing `size`');
        const v = clampN(n, 1, 4000);
        return formatRun(ctx, 'format.size', r => ({...r, size: v}));
      }},
    {id: 'format.grow', label: 'Increase Font Size', shortcut: 'Mod+Shift+.', risk: 'edit', description: '{}', params: s.object({}), state: gate(() => ({})),
      run(ctx) { const base = currentRun(ctx).size ?? 18; return formatRun(ctx, 'format.grow', r => ({...r, size: step(r.size ?? base, true)})); }},
    {id: 'format.shrink', label: 'Decrease Font Size', shortcut: 'Mod+Shift+,', risk: 'edit', description: '{}', params: s.object({}), state: gate(() => ({})),
      run(ctx) { const base = currentRun(ctx).size ?? 18; return formatRun(ctx, 'format.shrink', r => ({...r, size: step(r.size ?? base, false)})); }},
    {id: 'format.color', label: 'Font Color', risk: 'edit', description: '{color: #RRGGBB|accent1..6|tx1…|{scheme, lumMod…}}',
      params: s.object({color: s.any({description: 'colour'})}),
      state: gate(ctx => { const f = currentRun(ctx).fill; return {value: f?.kind === 'solid' ? colorCommandValue(f.color) : null}; }),
      run(ctx, p) {
        const c = colorValue(p.color);
        if (!c) throw bad('format.color', 'missing or invalid `color`');
        // A selected chart has no runs: Font Color colours its text (title, axes, legend, labels).
        if (!textSelection(ctx.doc, ctx.selection)) {
          const sel = selectedShapes(ctx);
          const charts = sel.filter(sh => sh.kind?.type === 'chart').map(sh => sh.id);
          if (charts.length) {
            editShapes(ctx, {ids: charts}, 'format.color', sh => { sh.kind = {...sh.kind, textColor: c}; delete sh.kind.raw; }, charts);
            if (charts.length === sel.length) return {};
          }
        }
        return formatRun(ctx, 'format.color', r => ({...r, fill: fillSolid(c)}));
      }},
    {id: 'format.textTransparency', label: 'Text Transparency', risk: 'edit',
      description: '{value: 0..1} — 0 opaque, 1 invisible; keeps the text\'s colour (inherited colours included)',
      params: s.object({value: s.number()}),
      state: gate(ctx => { const f = currentRun(ctx).fill; const c = f?.kind === 'solid' ? f.color : f?.kind === 'gradient' ? f.stops?.[0]?.color : null;
        const a = (c?.mods ?? []).find(m => m.op === 'alpha'); return {value: a ? 1 - a.val / 100000 : 0}; }),
      run(ctx, p) {
        if (!Number.isFinite(p.value)) throw bad('format.textTransparency', '`value` must be a number from 0 to 1');
        const v = clampN(p.value, 0, 1);
        const cur = currentRun(ctx).fill;
        const shown = cur?.kind === 'solid' || cur?.kind === 'gradient' ? cur : fillSolid(colorScheme('tx1'));
        return formatRun(ctx, 'format.textTransparency', r => {
          if (r.fill?.kind === 'none') return r;
          const f = structuredClone(r.fill?.kind === 'solid' || r.fill?.kind === 'gradient' ? r.fill : shown);
          if (f.kind === 'solid') f.color = withTransparency(f.color, v);
          else f.stops = f.stops.map(st => ({...st, color: withTransparency(st.color, v)}));
          return {...r, fill: f};
        });
      }},
    {id: 'format.language', label: 'Language', risk: 'edit', dialog: 'dialog.language',
      description: '{lang?, noProof?: bool} (proofing language of the selected text, and Do Not Check Spelling)',
      params: s.object({lang: s.optional(s.string({max: 64})), noProof: s.optional(s.boolean())}),
      state: gate(ctx => ({value: currentRun(ctx).lang ?? null})),
      run: (ctx, p) => formatRun(ctx, 'format.language', languageEdit('format.language', p))},
    {id: 'format.languageAll', label: 'Language for All Text', risk: 'edit',
      description: '{lang?, noProof?: bool} (proofing language of every text in the presentation: slides, tables, notes, masters and layouts, and the default for new text; one undo step)',
      params: s.object({lang: s.optional(s.string({max: 64})), noProof: s.optional(s.boolean())}), state: hasDoc, run: languageAll},
    {id: 'format.highlight', label: 'Text Highlight Color', risk: 'edit', description: '{color? (absent = none)}',
      params: s.object({color: any('colour; absent = no highlight'), none: s.optional(s.boolean())}),
      state: gate(ctx => { const h = currentRun(ctx).highlight; return {value: h ? colorCommandValue(h) : null}; }),
      run(ctx, p) {
        const c = p.none ? null : colorParam(p, 'color');
        return formatRun(ctx, 'format.highlight', r => { const o = {...r}; if (c) o.highlight = c; else delete o.highlight; return o; });
      }},
    {id: 'format.case', label: 'Change Case', shortcut: 'Shift+F3', risk: 'edit',
      description: '{mode?: cycle|sentence|lower|upper|title|toggle} — cycle (Shift+F3, the default) goes lowercase → Capitalize Each Word → UPPERCASE; a caret in a word changes that word',
      params: s.object({mode: s.optional(s.enum(['cycle', 'sentence', 'lower', 'upper', 'title', 'toggle']))}), state: gate(() => ({})), run: changeCase},
    {id: 'format.caps', label: 'Caps', risk: 'edit', description: '{caps: none|small|all}', params: s.object({caps: s.optional(s.string({max: 16}))}),
      state: gate(ctx => ({value: currentRun(ctx).caps ?? 'none'})),
      run(ctx, p) { const c = p.caps === 'small' ? 'small' : p.caps === 'all' ? 'all' : 'none'; return formatRun(ctx, 'format.caps', r => ({...r, caps: c})); }},
    {id: 'format.spacing', label: 'Character Spacing', risk: 'edit', description: '{pt} (veryTight -3, tight -1.5, normal 0, loose 3, veryLoose 6)',
      params: s.object({pt: s.optional(s.number())}), state: gate(ctx => ({value: currentRun(ctx).spacing ?? 0})),
      run(ctx, p) { const v = clampN(p.pt ?? 0, -100, 400); return formatRun(ctx, 'format.spacing', r => ({...r, spacing: v})); }},
    {id: 'format.clear', label: 'Clear All Formatting', shortcut: 'Mod+Space', risk: 'edit', description: '{}', params: s.object({}), state: gate(() => ({})),
      run: ctx => formatRun(ctx, 'format.clear', r => { const o = {}; if (r.lang != null) o.lang = r.lang; if (r.link != null) o.link = r.link; return o; })},
    {id: 'format.fontDialog', label: 'Font…', shortcut: 'Mod+T', risk: 'edit', dialog: 'dialog.font',
      description: '{family?, size?: pt, bold?: bool, italic?: bool, underline?: none|sng|dbl|heavy|dotted|dash|wavy, color?, strike?: none|sng|dbl, baseline?: none|super|sub|<fraction>, caps?: none|small|all, spacing?: pt} — with none of these, opens the Font dialog',
      params: s.object({family: any('font family'), size: any('pt'), bold: any('bool'), italic: any('bool'), underline: any('none|sng|dbl|heavy|dotted|dash|wavy'),
        color: any('colour'), strike: any('none|sng|dbl'), baseline: any('none|super|sub|<fraction>'), caps: any('none|small|all'), spacing: any('pt')}),
      state: gate(() => ({})),
      run(ctx, p) {
        const e = fontEdits(p);
        if (!Object.keys(e).length) return {dialog: 'dialog.font', params: fontDialogParams(ctx)};
        return formatRun(ctx, 'format.fontDialog', r => writeFontEdits(e, r));
      }},
    {id: 'format.textShadow', label: 'Text Shadow', risk: 'edit', description: '{on?: bool}', params: toggleSchema(), state: runOn(r => !!r.shadow),
      run(ctx, p) { const v = onParam(p, !!currentRun(ctx).shadow); return formatRun(ctx, 'format.textShadow', r => { const o = {...r}; if (v) o.shadow = TEXT_SHADOW(); else delete o.shadow; return o; }); }},
    {id: 'format.textOutline', label: 'Text Outline', risk: 'edit', description: '{color?, width?: pt} (no color = none)',
      params: s.object({color: any('colour; absent = no outline'), width: s.optional(s.number({min: 0, max: 1584})), none: s.optional(s.boolean())}),
      state: gate(ctx => { const o = currentRun(ctx).outline; return {value: o?.fill?.kind === 'solid' ? colorCommandValue(o.fill.color) : null}; }),
      run(ctx, p) {
        const c = p.none ? null : colorParam(p, 'color');
        const w = num(p, 'width') ?? 0.75;
        return formatRun(ctx, 'format.textOutline', r => { const o = {...r}; if (c) o.outline = {...lineDefault(), fill: fillSolid(c), width: w}; else delete o.outline; return o; });
      }},
    {id: 'format.textWarp', label: 'Text Transform', risk: 'edit',
      description: '{preset: a prstTxWarp name or none, adj?: [finite raw guide values, at most 8]} — none clears the transform; omitted adj uses the preset\'s defaults',
      params: s.object({preset: s.string({max: 64}), adj: any('[numbers]')}),
      state: gate(ctx => ({value: currentBody(ctx)?.warp ?? 'none', items: WARPS.map(([id, label]) => ({id, label, value: id}))})), run: textWarp},
    {id: 'format.align', label: 'Align', risk: 'edit', description: '{align: left|center|right|justify|justifyLow|distributed}',
      params: s.object({align: s.optional(s.string({max: 32}))}), state: gate(ctx => ({value: currentPara(ctx).align ?? 'left'})),
      run(ctx, p) { const a = alignLoose(p.align ?? 'left'); return formatPara(ctx, 'format.align', para => setPara(para, {align: a})); }},
    {id: 'format.rtl', label: 'Right-to-Left Text Direction', risk: 'edit', description: '{on?: bool} (off = left-to-right; switching mirrors left/right alignment)',
      params: toggleSchema(), state: gate(ctx => ({checked: !!currentPara(ctx).rtl})),
      run(ctx, p) {
        const on = onParam(p, currentPara(ctx).rtl);
        return formatPara(ctx, 'format.rtl', para => {
          const pp = {...(para.props ?? {})};
          if ((pp.rtl ?? false) !== on) pp.align = pp.align == null || pp.align === 'left' ? 'right' : pp.align === 'right' ? 'left' : pp.align;
          pp.rtl = on;
          return {...para, props: pp};
        });
      }},
    alignTo('format.alignLeft', 'Align Left', 'Mod+L', 'left'),
    alignTo('format.alignCenter', 'Center', 'Mod+E', 'center'),
    alignTo('format.alignRight', 'Align Right', 'Mod+R', 'right'),
    alignTo('format.justify', 'Justify', 'Mod+J', 'justify'),
    {id: 'format.bullets', label: 'Bullets', risk: 'edit', description: '{on?: bool, char?: •|○|■|□|◆|➢|✓|–, color?, size?: % of text}',
      params: toggleSchema({char: s.optional(s.string({min: 1, max: 8})), color: any('colour'), size: s.optional(s.number())}),
      state: gate(ctx => ({checked: currentPara(ctx).bullet?.kind === 'char'})), run: bullets},
    {id: 'format.numbering', label: 'Numbering', risk: 'edit',
      description: '{on?: bool, scheme?: arabicPeriod|arabicParenR|romanUcPeriod|romanLcPeriod|alphaUcPeriod|alphaLcParenR|alphaLcPeriod, start?: n, color?, size?: % of text}',
      params: toggleSchema({scheme: s.optional(s.string({max: 32})), start: s.optional(s.integer({min: 0})), color: any('colour'), size: s.optional(s.number())}),
      state: gate(ctx => ({checked: currentPara(ctx).bullet?.kind === 'autoNum'})), run: numbering},
    {id: 'format.indent', label: 'Increase List Level', shortcut: 'Tab', risk: 'edit', description: '{}', params: s.object({}), state: gate(() => ({})),
      run: ctx => level(ctx, 'format.indent', 1)},
    {id: 'format.outdent', label: 'Decrease List Level', shortcut: 'Shift+Tab', risk: 'edit', description: '{}', params: s.object({}), state: gate(() => ({})),
      run: ctx => level(ctx, 'format.outdent', -1)},
    {id: 'format.lineSpacing', label: 'Line Spacing', risk: 'edit', description: '{lines?: 1.0|1.5|2.0…, pt?: exactly}',
      params: s.object({lines: s.optional(s.number()), pt: s.optional(s.number())}),
      state: gate(ctx => { const l = currentPara(ctx).lineSpacing; return {value: l?.kind === 'pct' ? l.v : l?.kind === 'pts' ? null : 1}; }),
      run(ctx, p) {
        const sp = p.pt !== undefined ? {kind: 'pts', v: clampN(p.pt, 0, 1584)} : {kind: 'pct', v: clampN(p.lines ?? 1, 0, 9.99)};
        return formatPara(ctx, 'format.lineSpacing', para => setPara(para, {lineSpacing: sp}));
      }},
    {id: 'format.paragraph', label: 'Paragraph…', risk: 'edit',
      description: '{align?, indentLeft?: pt, indentFirst?: pt (negative = hanging), spaceBefore?: pt, spaceAfter?: pt, lineSpacing?: lines}',
      params: s.object({align: s.optional(s.string({max: 32})), indentLeft: s.optional(s.number()), indentFirst: s.optional(s.number()), spaceBefore: s.optional(s.number()),
        spaceAfter: s.optional(s.number()), lineSpacing: s.optional(s.number()), lineSpacingPt: s.optional(s.number())}),
      state: gate(() => ({})), run: paragraph},
    {id: 'format.ruler', label: 'Ruler', risk: 'read',
      description: '{} → {x, y, width, rotated, marginLeft, indent, tabs: [{pos, align}], defaultTab} for the paragraph with the caret (x, y: the text area\'s top-left in slide pt)',
      params: s.object({}), state: hasText, run: ruler},
    {id: 'format.paragraphDialog', label: 'Paragraph…', risk: 'edit', dialog: 'dialog.paragraph',
      description: '{align?: left|center|right|justify|justLow|distributed, indentLeft?: pt, indentRight?: pt, special?: none|first|hanging, specialBy?: pt, indentFirst?: pt, spaceBefore?: pt, spaceAfter?: pt, spaceBeforeKind?: pts|pct, spaceAfterKind?: pts|pct, lineSpacing?: lines, lineSpacingPt?: pt} — with none of these, opens the Paragraph dialog',
      params: s.object(Object.fromEntries([...PARA_DIALOG_KEYS, 'spaceBeforeKind', 'spaceAfterKind'].map(k => [k, any(k)]))),
      state: gate(() => ({})), run: paragraphDialog},
    {id: 'format.tabs', label: 'Tabs…', risk: 'edit', dialog: 'dialog.tabs',
      description: '{set?: [{pos, align?}] (replaces all), add?: {pos, align?: l|ctr|r|dec}, move?: {from, to}, remove?: pos, clear?: bool, defaultTab?: pt} on the selected paragraphs; with none of them, opens the Tabs dialog (pos in pt from the text area\'s left)',
      params: s.object({set: any('[{pos, align?}]'), add: any('{pos, align?}'), move: any('{from, to}'), remove: any('pos'), clear: any('bool'), defaultTab: any('pt')}),
      state: gate(() => ({})), run: tabs},
    {id: 'format.anchor', label: 'Align Text', risk: 'edit', description: '{anchor: top|middle|bottom}', params: s.object({anchor: s.optional(s.string({max: 16}))}),
      state: gate(ctx => ({value: currentBody(ctx)?.anchor ?? 'top'})),
      run(ctx, p) { const a = ANCHOR[p.anchor] ?? 'top'; return formatBody(ctx, 'format.anchor', b => ({...b, anchor: a})); }},
    {id: 'format.direction', label: 'Text Direction', risk: 'edit', description: '{dir: horizontal|rotate90|rotate270|stacked}',
      params: s.object({dir: s.optional(s.string({max: 16}))}), state: gate(ctx => ({value: currentBody(ctx)?.vert ?? 'horizontal'})),
      run(ctx, p) { const d = DIRS[p.dir] ?? 'horizontal'; return formatBody(ctx, 'format.direction', b => ({...b, vert: d})); }},
    {id: 'format.columns', label: 'Columns', risk: 'edit', dialog: 'dialog.columns',
      description: '{count?: 1-16, spacing?: pt between columns}; a key left out keeps the shape\'s value, and with neither the Columns dialog opens',
      params: s.object({count: any('1-16'), spacing: any('pt')}), state: gate(ctx => ({value: currentColumns(ctx)[0]})), run: columns},
    {id: 'format.autofit', label: 'Autofit', risk: 'edit', description: '{mode: none|shrink|resize}', params: s.object({mode: s.optional(s.string({max: 16}))}),
      state: gate(ctx => { const k = currentBody(ctx)?.autofit?.kind; return {value: k === 'shape' ? 'resize' : k === 'shrink' ? 'shrink' : 'none'}; }),
      run(ctx, p) {
        const m = p.mode === 'shrink' ? {kind: 'shrink', fontScale: 1, lineReduction: 0} : p.mode === 'resize' || p.mode === 'shape' ? {kind: 'shape'} : {kind: 'none'};
        return formatBody(ctx, 'format.autofit', b => ({...b, autofit: m}));
      }},
    {id: 'format.wrap', label: 'Wrap Text in Shape', risk: 'edit', description: '{on: bool}', params: s.object({on: s.optional(s.boolean())}),
      state: gate(ctx => ({checked: currentBody(ctx)?.wrap !== false})),
      run(ctx, p) { const on = p.on ?? true; return formatBody(ctx, 'format.wrap', b => ({...b, wrap: on})); }},
    {id: 'format.margins', label: 'Text Box Margins', risk: 'edit', description: '{left?: pt, top?: pt, right?: pt, bottom?: pt}',
      params: s.object({left: s.optional(s.number()), top: s.optional(s.number()), right: s.optional(s.number()), bottom: s.optional(s.number())}),
      state: gate(() => ({})), run: margins},
    {id: 'format.painter', label: 'Format Painter', shortcut: 'Mod+Shift+C', risk: 'read', effect: 'view', description: '{sticky?: bool}',
      params: s.object({sticky: s.optional(s.boolean())}), state: gate(ctx => ({checked: !!ctx.view?.painter})), run: painterPick},
    {id: 'format.painterApply', label: 'Paste Formatting', risk: 'edit', description: '{ids?}',
      // deckcraft also lists Cmd+Shift+V, but its key dispatch reaches edit.pasteText (listed first) for it.
      params: s.object({ids: s.optional(s.array(ID, {max: 5000}))}),
      state: hasTextOrShapes, run: painterApply},
    {id: 'format.state', label: 'Formatting State', risk: 'read', description: '{} → the effective formatting at the selection (font, size, bold, …)',
      params: s.object({}), state: hasDoc, run: formatState},
  ],
});
