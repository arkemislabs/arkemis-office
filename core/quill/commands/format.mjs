// Character formatting (Home › Font), over the schema-2 model.
// Translated from wordcraft crates/engine/src/cmd/format.rs (every `format.*` command, `target`,
// `apply`, `resolved`, `toggle`, `underline`, `font`, `size`, `step_size`, `nudge_size`, `color`,
// `underline_color`, `highlight`, `change_case`, `clear`, `reset_char`, `char_style`, `set`,
// `state`, `enclose`) and crates/engine/src/cmd/tools/typing.rs (`is_turkic`, `upper_char`,
// `lower_char`) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The target is the selection, or the word around a collapsed caret; between words the change
// becomes the pending typing formatting (kernel view state, see lib/format-target.mjs), and an
// empty paragraph's mark takes it too, as in Word. Offsets are UTF-16 code units.
//
// Not translated here: a text box selected as an object and column selections (see
// lib/format-target.mjs); `format.enclose` and `format.changeCase` do not check content-control
// locks yet (cmd/controls.rs `check_edit` is the controls family's).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import * as P from '../model/para.mjs';
import {UNDERLINES, HIGHLIGHTS, highlightOoxml, highlightName, highlightRgb, parseTextColor, parseRgb, rgbHex, singleBorder,
  charCleared, charOverlaid, readTextColor, readRgb, BORDER_STYLES} from '../model/props.mjs';
import {findStyle, getStyle, resolveChar} from '../model/styles.mjs';
import {samePath, samePos} from '../model/document.mjs';
import {parseEnclosure, enclosureInstr, fitsEnclosure, parseEncloseShape, parseEncloseStyle} from '../model/eq.mjs';
import {UPSTREAM_COMMIT, ready, need, ordered, target, applyChar, resolvedRuns, peek, selResult, typingProps, setPending, focusOf,
  fmtParas, newRevision, author} from '../lib/format-target.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/format.rs', 'crates/engine/src/cmd/tools/typing.rs']};

/** Word's font size list (`SIZES`). */
export const SIZES = Object.freeze([8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72]);
/** The `style` values format.underline takes (upstream's params text). */
export const UNDERLINE_STYLES = Object.freeze(['single', 'double', 'thick', 'dotted', 'dash', 'dotDash', 'dotDotDash', 'wave', 'words']);
/** The highlight colours format.highlight offers (Word's 15 plus none). */
export const HIGHLIGHT_COLORS = Object.freeze(HIGHLIGHTS.filter(h => h !== 'white'));
export const CHANGE_CASE_MODES = Object.freeze(['sentence', 'lower', 'upper', 'title', 'toggle']);

const VALUE = s.object({value: s.optional(s.boolean({description: 'true sets it, false clears it; omitted toggles'}))});
const NONE = s.object({});

/** A run's resolved state, with the selection's runs every() of `get`. */
function stateOf(ctx, get) {
  const st = ready(ctx);
  if (!st.enabled) return st;
  try {
    const runs = resolvedRuns(ctx, peek(ctx));
    return {enabled: true, checked: runs.length > 0 && runs.every(get)};
  } catch { return {enabled: true, checked: false}; }
}

/** wordcraft `toggle`: `value` sets it; otherwise on unless every targeted run already has it. */
function toggle(id, label, path, get, set, shortcut, description) {
  return {
    id, label, risk: 'edit', ...(shortcut ? {shortcut} : {}),
    description: description ?? `${label} (${path}): on or off for the selection, or the word at the caret.`,
    params: VALUE,
    state: ctx => stateOf(ctx, get),
    run(ctx, p) {
      need(ctx);
      const on = p.value ?? !resolvedRuns(ctx, peek(ctx)).every(get);
      return {...applyChar(ctx, c => set(c, on)), value: on};
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Underline

/** wordcraft `underline`: value wins; a style alone turns it on; otherwise toggle. */
function underline(ctx, p) {
  need(ctx);
  const on = p.value ?? (p.style ? true : !resolvedRuns(ctx, peek(ctx)).every(r => r.underline !== 'none'));
  const u = on ? (p.style ?? 'single') : 'none';
  return {...applyChar(ctx, c => { c.underline = u; }), value: on, style: u};
}

// ---------------------------------------------------------------------------------------------
// Fonts and sizes

/**
 * East Asian (Chinese, Japanese, Korean) font families: choosing one in the Font box also sets the
 * East Asian text's font (`w:eastAsia`), as Word does (upstream asks wordcraft_fonts whether the
 * resolved face is East Asian; this is that face list).
 */
const EAST_ASIAN_FONT = /^(ms (p?mincho|p?gothic|ui gothic)|yu (gothic|mincho)( ui)?( light| medium| semibold)?|meiryo( ui)?|simsun|nsimsun|simhei|simkai|kaiti|fangsong|dengxian( light)?|microsoft (yahei|jhenghei)( ui)?( light)?|p?mingliu(-extb|_hkscs)?|dfkai-sb|malgun gothic( semilight)?|batang(che)?|gulim(che)?|dotum(che)?|gungsuh(che)?|hiragino .*|pingfang .*|heiti .*|songti .*|stsong|stheiti|stkaiti|stfangsong|apple sd gothic neo|applemyungjo|noto (sans|serif) (cjk|jp|sc|tc|hk|kr)( .*)?|source han (sans|serif)( .*)?|biz ud(p)?(gothic|mincho)|ud digi kyokasho.*|nanum.*)$/i;
export const isEastAsianFont = name => EAST_ASIAN_FONT.test(String(name ?? '').trim());

function fontArg(p, k) {
  if (p[k] === undefined) return null;
  const n = String(p[k] ?? '').trim();
  if (!n || n.length > 128) throw new CommandError('invalid_params', `bad font name \`${k}\``, {path: `/${k}`});
  return n;
}

function currentSize(ctx) { return resolvedRuns(ctx, peek(ctx))[0]?.size ?? 12; }

const setSize = n => c => { c.size = n; c.sizeCs = n; };

function stepSize(ctx, dir) {
  need(ctx);
  const cur = currentSize(ctx);
  let next = dir > 0 ? SIZES.find(x => x > cur + 0.01) ?? (Math.floor(cur / 10) + 1) * 10 : [...SIZES].reverse().find(x => x < cur - 0.01) ?? 1;
  next = Math.max(1, Math.min(1638, next));
  return {...applyChar(ctx, setSize(next)), size: next};
}

function nudgeSize(ctx, d) {
  need(ctx);
  const next = Math.max(1, Math.min(1638, currentSize(ctx) + d));
  return {...applyChar(ctx, setSize(next)), size: next};
}

// ---------------------------------------------------------------------------------------------
// Colours and highlight

const hexOf = rgb => (rgb ? `#${rgbHex(rgb)}` : null);
const colorText = c => (c === 'Auto' || !c ? 'auto' : c.Rgb ? hexOf(c.Rgb) : 'auto');

/** A highlight name from upstream's spellings (`yellow`, OOXML `cyan`, `Gray-25%`, Debug `Gray25`) or an exact palette hex. */
export function parseHighlight(c) {
  const t = String(c ?? '').trim();
  const squash = x => x.replace(/[- %]/g, '').toLowerCase();
  if (/^(auto|none|no ?color)$/i.test(t)) return 'none';
  const byName = HIGHLIGHT_COLORS.find(h => h.toLowerCase() === t.toLowerCase() || highlightOoxml(h).toLowerCase() === t.toLowerCase()
    || squash(highlightName(h)) === squash(t));
  if (byName) return byName;
  const rgb = parseRgb(t);
  if (rgb) return HIGHLIGHT_COLORS.find(h => highlightRgb(h)?.every((v, i) => v === rgb[i])) ?? null;
  return null;
}

/** Does every run (and fully covered paragraph mark) of the whole target have highlight `h` (`target_has_highlight`)? */
function targetHasHighlight(ctx, d, h) {
  const want = highlightRgb(h);
  const eq = r => (r.highlight === null ? want === null : !!want && r.highlight.every((v, i) => v === want[i]));
  const sheet = d.styles;
  const [a, b] = ordered(ctx, d);
  const t = target(d, a, b);
  let seen = false;
  if (t) {
    const [x, y] = t;
    for (const path of d.pathsBetween(x, y)) {
      const p = d.para(x.story, path);
      if (!p) continue;
      const from = samePath(path, x.path) ? x.off : 0;
      const to = samePath(path, y.path) ? y.off : p.text.length;
      const style = p.props?.style ?? null;
      if (to === p.text.length && (from === 0 || !samePath(path, x.path))) { seen = true; if (!eq(resolveChar(sheet, style, P.markOf(p)))) return false; }
      for (const [s0, e0, c] of P.runRanges(p)) if (e0 > from && s0 < to) { seen = true; if (!eq(resolveChar(sheet, style, c))) return false; }
    }
  }
  return seen || resolvedRuns(ctx, d).every(eq);
}

function highlight(ctx, p) {
  need(ctx);
  const last = ctx.view?.lastHighlight && HIGHLIGHT_COLORS.includes(ctx.view.lastHighlight) ? ctx.view.lastHighlight : 'yellow';
  let h = last;
  if (p.color !== undefined) {
    h = parseHighlight(p.color);
    if (!h) throw new CommandError('invalid_params', `unknown highlight colour \`${p.color}\` (one of ${HIGHLIGHT_COLORS.filter(x => x !== 'none').join(', ')} or none)`, {path: '/color'});
  }
  const remove = p.color === undefined && targetHasHighlight(ctx, peek(ctx), h);
  const value = remove ? 'none' : h;
  const r = applyChar(ctx, c => { c.highlight = value; });
  ctx.setView({lastHighlight: h});
  return {...r, highlight: value};
}

// ---------------------------------------------------------------------------------------------
// Change Case

const TURKIC = new Set(['tr', 'tur', 'az', 'aze', 'crh']);
/** Turkish, Azerbaijani and Crimean Tatar map i/İ and ı/I as pairs (`is_turkic`). */
export const isTurkic = lang => TURKIC.has(String(lang ?? '').trim().split(/[-_]/)[0].toLowerCase());
const upperChar = (c, turkic) => (turkic && c === 'i' ? 'İ' : c.toUpperCase());
const lowerChar = (c, turkic) => (c === 'I' && turkic ? 'ı' : c === 'İ' ? 'i' : c.toLowerCase());
const isLower = c => /\p{Lowercase}/u.test(c);
const isUpper = c => /\p{Uppercase}/u.test(c);
const isAlpha = c => /\p{Alphabetic}/u.test(c);
const isSpace = c => /\p{White_Space}/u.test(c);

const isTitle = t => t.split(/\p{White_Space}+/u).filter(Boolean).every(w => isUpper([...w][0]));

/**
 * The case-converted form of each character of `chars` (`convert_chars`): one entry per code
 * point, so a change of length (ß → SS) applies run by run. `turkic[i]` is true when that
 * character's run is Turkish, Azerbaijani or Crimean Tatar.
 */
export function convertChars(chars, mode, paraStart, turkic = []) {
  const lower = (i, c) => {
    const prev = i > 0 && isAlpha(chars[i - 1]);
    const next = i + 1 < chars.length && isAlpha(chars[i + 1]);
    if (c === 'Σ' && prev && !next) return 'ς';
    if (turkic[i]) return lowerChar(c, true);
    return c.toLowerCase();
  };
  let up = mode === 'title' || paraStart;
  const out = [];
  chars.forEach((c, i) => {
    const t = !!turkic[i];
    const upper = x => upperChar(x, t);
    let n;
    if (mode === 'upper') n = upper(c);
    else if (mode === 'lower') n = lower(i, c);
    else if (mode === 'toggle') n = isUpper(c) ? lower(i, c) : upper(c);
    else if (mode === 'title') {
      if (up && isAlpha(c)) { up = false; n = upper(c); } else n = lower(i, c);
      if (isSpace(c)) up = true;
    } else {
      if (up && isAlpha(c)) { up = false; n = upper(c); } else n = lower(i, c);
      const decimal = c === '.' && i > 0 && /[0-9]/.test(chars[i - 1]) && /[0-9]/.test(chars[i + 1] ?? '');
      if (c === '!' || c === '?' || (c === '.' && !decimal)) up = true;
    }
    out.push(n);
  });
  return out;
}

/** `convert` (upstream test helper): the converted string. */
export const convertCase = (src, mode, paraStart) => convertChars([...src], mode, paraStart).join('');

/** The characters of `p` in [from, to) that aren't tracked deletions: [offset, char][] (`live_chars`). */
function liveChars(p, from, to) {
  const out = [];
  for (const [rs, re, c] of P.runRanges(p)) {
    const x = Math.max(rs, from), y = Math.min(re, to);
    if ((c.del !== undefined && c.del !== null) || x >= y) continue;
    let i = x;
    for (const ch of p.text.slice(x, y)) { out.push([i, ch]); i += ch.length; }
  }
  return out;
}

/** Stretches of changed characters that stay inside one run: [start, end, replacement] (`case_groups`). */
function caseGroups(p, chars, conv) {
  const runs = P.runRanges(p);
  const runOf = off => runs.findIndex(([a, b]) => off >= a && off < b);
  const out = [];
  chars.forEach(([start, c], k) => {
    const nw = conv[k];
    if (nw === c) return;
    const end = start + c.length, run = runOf(start);
    const g = out[out.length - 1];
    if (g && g[1] === start && g[3] === run) { g[1] = end; g[2] += nw; } else out.push([start, end, nw, run]);
  });
  return out.map(([a, b, n]) => [a, b, n]);
}

/** Where `off` lands after the stretches [start, end, newLen] were replaced (`map_offset`). */
function mapOffset(spans, off) {
  let out = off;
  for (const [start, end, n] of spans) {
    if (end <= off) out = out - (end - start) + n;
    else if (start < off) out = out - (off - start) + n;
  }
  return out;
}

function changeCase(ctx, p) {
  need(ctx);
  let sel = null;
  ctx.model.edit(ctx, d => {
    let [a, b] = ordered(ctx, d);
    if (samePos(a, b)) [a, b] = target(d, a, b) ?? [a, b];
    if (samePos(a, b)) return;
    const paths = d.pathsBetween(a, b);
    const span = path => { const q = d.para(a.story, path); return [q, samePath(path, a.path) ? a.off : 0, samePath(path, b.path) ? b.off : q.text.length]; };
    const text = paths.map(path => { const [q, from, to] = span(path); return q ? liveChars(q, from, to).map(([, c]) => c).join('') : ''; }).join('\n');
    const mode = p.mode ?? (() => {
      // Shift+F3 cycles: lower → UPPER → Title → lower.
      const cs = [...text];
      if (cs.some(isLower) && cs.some(isUpper) && !isTitle(text)) return 'lower';
      if (!cs.some(isUpper)) return 'upper';
      if (cs.some(isLower)) return 'lower';
      return 'title';
    })();
    const tracked = !!d.settings?.trackChanges || !!ctx.view?.trackMine;
    const who = author(ctx.prefs);
    const ends = {anchor: null, focus: null};
    const all = ctx.model.selection(ctx);
    const r0 = all[ctx.selection?.primary ?? 0] ?? all[0];
    ends.anchor = d.clamp(r0.anchor); ends.focus = d.clamp(r0.focus);
    for (const path of paths) {
      const [q, from, to] = span(path);
      if (!q) continue;
      const chars = liveChars(q, from, to);
      const turkic = chars.map(([off]) => isTurkic(resolveChar(d.styles, q.props?.style ?? null, P.propsOfChar(q, off)).lang ?? ctx.prefs?.editingLanguage));
      const groups = caseGroups(q, chars, convertChars(chars.map(([, c]) => c), mode, from === 0, turkic));
      if (!groups.length) continue;
      const kinds = groups.map(([start]) => {
        const c = P.propsOfChar(q, start);
        const own = c.ins !== undefined && c.ins !== null && d.content.revisions?.[c.ins]?.author === who;
        return tracked && !own ? 'replace' : 'no';
      });
      const revs = kinds.includes('replace') ? [newRevision(ctx, d, 'delete'), newRevision(ctx, d, 'insert')] : null;
      const spans = [];
      // Each stretch keeps its own run's formatting (#421); right to left so offsets hold.
      for (let k = groups.length - 1; k >= 0; k--) {
        const [start, end, nw] = groups[k];
        const oldLen = end - start;
        const para = d.para(a.story, path);
        const props = {...P.propsOfChar(para, start)};
        if (kinds[k] === 'replace' && revs) {
          const [del, ins] = revs;
          d.formatRange({story: a.story, path, off: start}, {story: a.story, path, off: end}, c => { c.del = del; });
          const ip = {...props, ins};
          delete ip.del; delete ip.fmtChange;
          d.insertText({story: a.story, path, off: end}, nw, ip);
          spans.push([start, end, oldLen + nw.length]);
        } else {
          d.deleteRange({story: a.story, path, off: start}, {story: a.story, path, off: end});
          d.insertText({story: a.story, path, off: start}, nw, props);
          spans.push([start, end, nw.length]);
        }
      }
      spans.reverse();
      // The selection keeps covering the converted text when its length changed (#420).
      for (const k of ['anchor', 'focus']) if (ends[k].story === a.story && samePath(ends[k].path, path)) ends[k] = {...ends[k], off: mapOffset(spans, ends[k].off)};
    }
    sel = ends;
  });
  if (sel) ctx.model.setSelection(ctx, [sel]);
  return selResult(ctx);
}

// ---------------------------------------------------------------------------------------------
// Clear, reset, set, style

function clear(ctx) {
  need(ctx);
  ctx.model.edit(ctx, d => {
    const [a, b] = ordered(ctx, d);
    const t = target(d, a, b);
    if (t) {
      d.formatRange(t[0], t[1], c => charCleared(c));
      // Clear Formatting also resets the paragraph to Normal (and takes it out of a list).
      fmtParas(d, t[0].story, d.paraPathsIn(t[0], t[1]), () => ({}));
    } else {
      setPending(ctx, d, a, {});
      fmtParas(d, a.story, d.paraPathsIn(a, a), () => ({}));
    }
  });
  return selResult(ctx);
}

function resetChar(ctx) {
  need(ctx);
  ctx.model.edit(ctx, d => {
    const [a, b] = ordered(ctx, d);
    const t = target(d, a, b);
    if (t) d.formatRange(t[0], t[1], c => ({...charCleared(c), ...(c.style !== undefined ? {style: c.style} : {})}));
    else setPending(ctx, d, a, {});
  });
  return selResult(ctx);
}

/** A Border as upstream deserializes one, the colour as "RRGGBB" / "#RRGGBB" or [r, g, b] (#865). */
export function readBorder(x, where) {
  const bad = why => { throw new CommandError('invalid_params', `border: ${why}`, {path: where}); };
  if (!x || typeof x !== 'object' || Array.isArray(x)) bad('{style, width, color?, space?}');
  const style = x.style ?? 'single';
  if (!BORDER_STYLES.includes(style)) bad(`style: ${BORDER_STYLES.join('|')}`);
  const width = typeof x.width === 'number' && Number.isFinite(x.width) ? x.width : 0.5;
  let color = null;
  if (x.color !== undefined && x.color !== null) { color = readRgb(x.color); if (!color) bad('color: "RRGGBB"'); }
  const space = typeof x.space === 'number' && Number.isFinite(x.space) ? x.space : 0;
  return {style, width, color, space};
}

/** A CharProps object from the bridge or a dialog: upstream's serde shape, colours as "RRGGBB" too. */
export function readCharProps(v, where = '/props') {
  if (v === null || v === undefined) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new CommandError('invalid_params', 'props must be an object of character properties', {path: where});
  const out = {};
  const bad = (k, why) => { throw new CommandError('invalid_params', `${k}: ${why}`, {path: `${where}/${k}`}); };
  for (const [k, x] of Object.entries(v)) {
    if (x === null || x === undefined) continue;
    switch (k) {
      case 'bold': case 'italic': case 'strike': case 'doubleStrike': case 'caps': case 'smallCaps': case 'hidden': case 'outline': case 'shadow':
      case 'emboss': case 'engrave': case 'noProof': case 'rtl': case 'cs': case 'boldCs': case 'italicCs':
        if (typeof x !== 'boolean') bad(k, 'true or false'); out[k] = x; break;
      case 'size': case 'sizeCs':
        if (typeof x !== 'number' || !Number.isFinite(x)) bad(k, 'a number of points'); out[k] = Math.round(Math.max(1, Math.min(1638, x)) * 2) / 2; break;
      case 'spacing': if (typeof x !== 'number' || !Number.isFinite(x)) bad(k, 'points'); out[k] = Math.max(-100, Math.min(100, x)); break;
      case 'scale': if (typeof x !== 'number' || !Number.isFinite(x)) bad(k, 'percent'); out[k] = Math.max(1, Math.min(600, x)); break;
      case 'position': if (typeof x !== 'number' || !Number.isFinite(x)) bad(k, 'points'); out[k] = Math.max(-1584, Math.min(1584, x)); break;
      case 'kern': if (typeof x !== 'number' || !Number.isFinite(x)) bad(k, 'points'); out[k] = Math.max(0, Math.min(1638, x)); break;
      case 'font': case 'fontCs': case 'fontEa': case 'lang': case 'style':
        if (typeof x !== 'string' || !x.trim() || x.length > 253) bad(k, 'a name'); out[k] = x.trim(); break;
      case 'underline': if (!UNDERLINES.includes(x)) bad(k, UNDERLINES.join('|')); out[k] = x; break;
      case 'vertAlign': if (!['baseline', 'superscript', 'subscript'].includes(x)) bad(k, 'baseline|superscript|subscript'); out[k] = x; break;
      case 'highlight': { const h = parseHighlight(x); if (!h) bad(k, 'a highlight colour'); out[k] = h; break; }
      case 'color': { const c = readTextColor(x); if (!c) bad(k, '"Auto", "RRGGBB" or {"Rgb": [r, g, b]}'); out[k] = c; break; }
      case 'underlineColor': case 'shading': { const c = readRgb(x); if (!c) bad(k, '"RRGGBB" or [r, g, b]'); out[k] = c; break; }
      case 'border': out[k] = readBorder(x, `${where}/${k}`); break;
      case 'link': case 'ins': case 'del': case 'fmtChange': case 'symFont': case 'textEffects': case 'ligatures': case 'eastAsianLayout': case 'langBidi': case 'langEa':
        out[k] = x; break;
      default: bad(k, 'unknown character property');
    }
  }
  return out;
}

function setProps(ctx, p) {
  need(ctx);
  const props = readCharProps(p.props);
  // The font dialog and callers supplying one value format both scripts.
  if (props.sizeCs === undefined && props.size !== undefined) props.sizeCs = props.size;
  if (props.boldCs === undefined && props.bold !== undefined) props.boldCs = props.bold;
  if (props.italicCs === undefined && props.italic !== undefined) props.italicCs = props.italic;
  return applyChar(ctx, c => charOverlaid(c, props));
}

function charStyle(ctx, p) {
  need(ctx);
  const st = findStyle(ctx.doc.styles, p.style);
  if (!st) throw new CommandError('invalid_params', `no style \`${p.style}\``, {path: '/style'});
  return applyChar(ctx, c => { c.style = st.id; });
}

// ---------------------------------------------------------------------------------------------
// format.state

/** What the ribbon shows: the formatting at the selection (mixed values are null). */
export function formatState(ctx) {
  const d = peek(ctx);
  const all = resolvedRuns(ctx, d);
  const first = all[0];
  const same = f => { if (!first) return null; const v0 = JSON.stringify(f(first)); return all.every(r => JSON.stringify(f(r)) === v0) ? f(first) : null; };
  const at = focusOf(ctx, d);
  const style = d.paraAt(at)?.props?.style ?? 'Normal';
  const styleName = getStyle(d.styles, style)?.name ?? style;
  return {
    font: same(r => r.font), fontEastAsia: same(r => r.fontEa), size: same(r => r.size),
    bold: all.every(r => r.bold), italic: all.every(r => r.italic), underline: all.every(r => r.underline !== 'none'),
    underlineColor: same(r => (r.underlineColor ? rgbHex(r.underlineColor) : 'auto')),
    strike: all.every(r => r.strike), border: all.every(r => !!r.border),
    subscript: all.every(r => r.vertAlign === 'subscript'), superscript: all.every(r => r.vertAlign === 'superscript'),
    smallCaps: all.every(r => r.smallCaps), caps: all.every(r => r.caps), hidden: all.every(r => r.hidden),
    spacing: same(r => r.spacing), kern: same(r => r.kern),
    color: same(r => (r.color === 'Auto' || !r.color?.Rgb ? 'auto' : rgbHex(r.color.Rgb))),
    highlight: same(r => (r.highlight ? rgbHex(r.highlight) : null)),
    style, styleName, lang: same(r => r.lang), noProof: all.every(r => r.noProof),
  };
}

// ---------------------------------------------------------------------------------------------
// Enclose Characters

/** What Enclose Characters works on (`enclose_target`); throws why it can't be enclosed. */
export function encloseTarget(ctx, d) {
  const [a, b] = ordered(ctx, d);
  const fail = m => new CommandError('failed', m);
  if (a.story !== b.story || !samePath(a.path, b.path)) throw fail('select characters within one paragraph');
  const para = d.paraAt(a);
  if (!para) throw fail('no paragraph at the selection');
  const enclosed = off => {
    const o = P.objectAt(para, off);
    if (!o || o.type !== 'field') return null;
    const e = parseEnclosure(o.instr);
    if (!e) return null;
    return {from: {...a, off}, to: {...a, off: off + 1}, text: e.text, props: P.propsAt(para, off + 1), current: e};
  };
  if (a.off === b.off) {
    const before = a.off > 0 && para.text[a.off - 1] === P.OBJ ? enclosed(a.off - 1) : null;
    const got = before ?? enclosed(a.off);
    if (!got) throw fail('select the characters to enclose');
    return got;
  }
  const text = para.text.slice(a.off, b.off);
  if (text === P.OBJ) { const t = enclosed(a.off); if (t) return t; }
  if (!fitsEnclosure(text)) throw fail('select one full-width character or up to two half-width characters');
  const first = [...text][0]?.length ?? 0;
  return {from: a, to: b, text, props: P.propsAt(para, a.off + first), current: null};
}

function enclose(ctx, p) {
  need(ctx);
  if (!('shape' in p)) throw new CommandError('invalid_params', '`shape` is required: circle, square, triangle, diamond, or null to remove', {path: '/shape'});
  const shape = p.shape === null ? null : parseEncloseShape(p.shape);
  if (p.shape !== null && !shape) throw new CommandError('invalid_params', 'shape: circle|square|triangle|diamond|null', {path: '/shape'});
  const style = p.style === undefined ? null : parseEncloseStyle(p.style);
  if (p.style !== undefined && !style) throw new CommandError('invalid_params', 'style: shrink|enlarge', {path: '/style'});
  let given = null;
  if (typeof p.text === 'string' && shape) {
    if (!fitsEnclosure(p.text)) throw new CommandError('invalid_params', 'text: one full-width character or up to two half-width characters', {path: '/text'});
    given = p.text;
  }
  let sel;
  ctx.model.edit(ctx, d => {
    let t;
    try { t = encloseTarget(ctx, d); if (given !== null) t = {...t, text: given}; }
    catch (e) {
      const [a, b] = ordered(ctx, d);
      if (given === null || !samePos(a, b)) throw e;
      t = {from: a, to: a, text: given, props: typingProps(ctx, d), current: null};
    }
    if (!shape && !t.current) throw new CommandError('failed', 'no enclosed characters at the selection');
    const at = d.deleteRange(t.from, t.to);
    let end;
    if (shape) {
      const e = {shape, style: style ?? t.current?.style ?? 'shrink', text: t.text};
      end = d.insertObject(at, {type: 'field', instr: enclosureInstr(e), result: t.text, locked: false, dirty: false, code: false, form: ''}, t.props);
    } else end = d.insertText(at, t.text, t.props);
    sel = {anchor: at, focus: end};
  });
  ctx.model.setSelection(ctx, [sel]);
  return selResult(ctx);
}

// ---------------------------------------------------------------------------------------------

const colorParam = s.string({min: 1, max: 32, description: '"RRGGBB" (or "#RRGGBB") or "auto"'});

export default defineCommands({
  family: 'format',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    // The button formats both plain and complex-script text explicitly.
    toggle('format.bold', 'Bold', 'Home › Font', r => r.bold, (c, on) => { c.bold = on; c.boldCs = on; }, 'Mod+B'),
    toggle('format.italic', 'Italic', 'Home › Font', r => r.italic, (c, on) => { c.italic = on; c.italicCs = on; }, 'Mod+I'),
    {
      id: 'format.underline', label: 'Underline', shortcut: 'Mod+U', risk: 'edit',
      description: 'Underline (Home › Font): on or off, or a line style, for the selection or the word at the caret.',
      params: s.object({
        value: s.optional(s.boolean()),
        style: s.optional(s.enum(UNDERLINE_STYLES, {description: 'Line style; giving one turns underline on'})),
      }),
      state(ctx) {
        const st = ready(ctx);
        if (!st.enabled) return st;
        const runs = resolvedRuns(ctx, peek(ctx));
        const on = runs.length > 0 && runs.every(r => r.underline !== 'none');
        const styles = new Set(runs.map(r => r.underline));
        return {enabled: true, checked: on, value: on && styles.size === 1 ? runs[0].underline : null};
      },
      run: underline,
    },
    {
      id: 'format.doubleUnderline', label: 'Double Underline', shortcut: 'Mod+Shift+D', risk: 'edit',
      description: 'Double Underline (Home › Font › Underline).', params: NONE, state: ready,
      run: ctx => underline(ctx, {style: 'double'}),
    },
    {
      id: 'format.wordUnderline', label: 'Underline Words Only', shortcut: 'Mod+Shift+W', risk: 'edit',
      description: 'Underline Words Only (Home › Font › Underline): spaces stay plain.', params: NONE,
      state: ctx => stateOf(ctx, r => r.underline === 'words'),
      run: ctx => underline(ctx, {style: 'words'}),
    },
    toggle('format.strikethrough', 'Strikethrough', 'Home › Font', r => r.strike, (c, on) => { c.strike = on; }, 'Mod+Shift+X'),
    // Off clears the direct property only; a border inherited from a character style stays on.
    toggle('format.border', 'Character Border', 'Home › Font', r => !!r.border, (c, on) => { if (on) c.border = singleBorder(0.5); else delete c.border; }),
    toggle('format.doubleStrikethrough', 'Double Strikethrough', 'Home › Font › Font', r => r.doubleStrike, (c, on) => { c.doubleStrike = on; }),
    toggle('format.subscript', 'Subscript', 'Home › Font', r => r.vertAlign === 'subscript', (c, on) => { c.vertAlign = on ? 'subscript' : 'baseline'; }, 'Mod+='),
    toggle('format.superscript', 'Superscript', 'Home › Font', r => r.vertAlign === 'superscript', (c, on) => { c.vertAlign = on ? 'superscript' : 'baseline'; }, 'Mod+Shift+='),
    toggle('format.allCaps', 'All Caps', 'Home › Font › Font', r => r.caps, (c, on) => { c.caps = on; }, 'Mod+Shift+A'),
    toggle('format.smallCaps', 'Small Caps', 'Home › Font › Font', r => r.smallCaps, (c, on) => { c.smallCaps = on; }, 'Mod+Shift+K'),
    toggle('format.hidden', 'Hidden', 'Home › Font › Font', r => r.hidden, (c, on) => { c.hidden = on; }, 'Mod+Shift+H'),
    toggle('format.outline', 'Outline', 'Home › Font › Text Effects', r => r.outline, (c, on) => { c.outline = on; }),
    toggle('format.shadow', 'Shadow', 'Home › Font › Text Effects', r => r.shadow, (c, on) => { c.shadow = on; }),
    toggle('format.emboss', 'Emboss', 'Home › Font › Font', r => r.emboss, (c, on) => { c.emboss = on; }),
    toggle('format.engrave', 'Engrave', 'Home › Font › Font', r => r.engrave, (c, on) => { c.engrave = on; }),
    {
      id: 'format.font', label: 'Font', shortcut: 'Mod+Shift+F', risk: 'edit',
      description: 'Font (Home › Font): the font of the selection; `eastAsia` sets the East Asian text font on its own.',
      params: s.object({name: s.optional(s.string({min: 1, max: 128})), eastAsia: s.optional(s.string({min: 1, max: 128}))}),
      state(ctx) {
        const st = ready(ctx);
        if (!st.enabled) return st;
        const runs = resolvedRuns(ctx, peek(ctx));
        return {enabled: true, value: runs.every(r => r.font === runs[0]?.font) ? runs[0]?.font ?? null : null};
      },
      run(ctx, p) {
        need(ctx);
        const name = fontArg(p, 'name'), eastAsia = fontArg(p, 'eastAsia');
        if (!name && !eastAsia) throw new CommandError('invalid_params', '`name` or `eastAsia` (string) is required');
        // A Chinese, Japanese or Korean font is the East Asian text's font as well, as in Word.
        const ea = eastAsia ?? (name && isEastAsianFont(name) ? name : null);
        return applyChar(ctx, c => {
          if (name) { c.font = name; c.fontCs = name; }
          if (ea) c.fontEa = ea;
        });
      },
    },
    {
      id: 'format.size', label: 'Font Size', shortcut: 'Mod+Shift+P', risk: 'edit',
      description: 'Font Size (Home › Font): points, 1–1638, rounded to half points as Word does.',
      params: s.object({size: s.number({description: 'Points (1–1638)'})}),
      state(ctx) {
        const st = ready(ctx);
        if (!st.enabled) return st;
        const runs = resolvedRuns(ctx, peek(ctx));
        return {enabled: true, value: runs.every(r => r.size === runs[0]?.size) ? runs[0]?.size ?? null : null};
      },
      run(ctx, p) {
        need(ctx);
        if (!(p.size >= 1 && p.size <= 1638)) throw new CommandError('invalid_params', 'size must be between 1 and 1638', {path: '/size'});
        const n = Math.round(p.size * 2) / 2;
        return {...applyChar(ctx, setSize(n)), size: n};
      },
    },
    {id: 'format.growFont', label: 'Increase Font Size', shortcut: 'Mod+Shift+. / Mod+Shift+>', risk: 'edit',
      description: 'Increase Font Size (Home › Font): the next size in Word\'s list.', params: NONE, state: ready, run: ctx => stepSize(ctx, 1)},
    {id: 'format.shrinkFont', label: 'Decrease Font Size', shortcut: 'Mod+Shift+, / Mod+Shift+<', risk: 'edit',
      description: 'Decrease Font Size (Home › Font): the previous size in Word\'s list.', params: NONE, state: ready, run: ctx => stepSize(ctx, -1)},
    {id: 'format.growFont1', label: 'Grow Font 1 Point', shortcut: 'Mod+]', risk: 'edit',
      description: 'Grow Font 1 Point (Home › Font).', params: NONE, state: ready, run: ctx => nudgeSize(ctx, 1)},
    {id: 'format.shrinkFont1', label: 'Shrink Font 1 Point', shortcut: 'Mod+[', risk: 'edit',
      description: 'Shrink Font 1 Point (Home › Font).', params: NONE, state: ready, run: ctx => nudgeSize(ctx, -1)},
    {
      id: 'format.color', label: 'Font Color', risk: 'edit',
      description: 'Font Color (Home › Font): "RRGGBB" or "auto" (Automatic).',
      params: s.object({color: colorParam}),
      state: ready,
      run(ctx, p) {
        need(ctx);
        const tc = parseTextColor(String(p.color));
        if (!tc) throw new CommandError('invalid_params', 'color must be RRGGBB or auto', {path: '/color'});
        return {...applyChar(ctx, c => { c.color = tc; }), color: colorText(tc)};
      },
    },
    {
      id: 'format.underlineColor', label: 'Underline Color', risk: 'edit',
      description: 'Underline Color (Home › Font › Underline): the underline\'s own colour; "auto" follows the text colour. The underline style stays.',
      params: s.object({color: colorParam}),
      state: ready,
      run(ctx, p) {
        need(ctx);
        const tc = parseTextColor(String(p.color));
        if (!tc) throw new CommandError('invalid_params', 'color must be RRGGBB or auto', {path: '/color'});
        return applyChar(ctx, c => { if (tc === 'Auto') delete c.underlineColor; else c.underlineColor = tc.Rgb; });
      },
    },
    {
      id: 'format.highlight', label: 'Text Highlight Color', shortcut: 'Mod+Alt+H', risk: 'edit',
      description: 'Text Highlight Color (Home › Font): an explicit colour sets it; omitted toggles the last chosen colour (initially yellow).',
      params: s.object({color: s.optional(s.string({min: 1, max: 32, description: `${HIGHLIGHT_COLORS.join('|')} (or the colour's hex)`}))}),
      state(ctx) {
        const st = ready(ctx);
        if (!st.enabled) return st;
        const h = ctx.view?.lastHighlight && HIGHLIGHT_COLORS.includes(ctx.view.lastHighlight) ? ctx.view.lastHighlight : 'yellow';
        return {enabled: true, value: hexOf(highlightRgb(h))};
      },
      run: highlight,
    },
    {
      id: 'format.shading', label: 'Character Shading', risk: 'edit',
      description: 'Character Shading (Home › Font): a background colour behind the text, or null for none.',
      params: s.object({color: s.optional(s.nullable(s.string({max: 32})))}),
      state: ready,
      run(ctx, p) {
        need(ctx);
        const c = p.color === null || p.color === undefined ? null : parseRgb(String(p.color));
        return applyChar(ctx, x => { if (c) x.shading = c; else delete x.shading; });
      },
    },
    {
      id: 'format.changeCase', label: 'Change Case', shortcut: 'Shift+F3', risk: 'edit',
      description: 'Change Case (Home › Font): sentence, lower, upper, title or toggle; without a mode Shift+F3 cycles lower → UPPER → Title.',
      params: s.object({mode: s.optional(s.enum(CHANGE_CASE_MODES))}),
      state: ready,
      run: changeCase,
    },
    {id: 'format.clear', label: 'Clear All Formatting', risk: 'edit',
      description: 'Clear All Formatting (Home › Font): direct character formatting off and the paragraphs back to Normal; at a caret, for what is typed next.',
      params: NONE, state: ready, run: clear},
    {id: 'format.resetChar', label: 'Reset Character Formatting', shortcut: 'Mod+Space', risk: 'edit',
      description: 'Reset Character Formatting: removes direct character formatting, keeping the paragraph and any character style.',
      params: NONE, state: ready, run: resetChar},
    {
      id: 'format.spacing', label: 'Character Spacing', risk: 'edit',
      description: 'Character Spacing (Home › Font › Font › Advanced): points between characters, −100 to 100 (negative condenses).',
      params: s.object({points: s.number()}), state: ready,
      run(ctx, p) { need(ctx); const x = Math.max(-100, Math.min(100, p.points)); return applyChar(ctx, c => { c.spacing = x; }); },
    },
    {
      id: 'format.scale', label: 'Character Scale', risk: 'edit',
      description: 'Character Scale (Home › Font › Font › Advanced): width percent, 1–600.',
      params: s.object({percent: s.number()}), state: ready,
      run(ctx, p) { need(ctx); const x = Math.max(1, Math.min(600, p.percent)); return applyChar(ctx, c => { c.scale = x; }); },
    },
    {
      id: 'format.position', label: 'Character Position', risk: 'edit',
      description: 'Character Position (Home › Font › Font › Advanced): points raised (positive) or lowered (negative).',
      params: s.object({points: s.number()}), state: ready,
      run(ctx, p) { need(ctx); const x = Math.max(-1584, Math.min(1584, p.points)); return applyChar(ctx, c => { c.position = x; }); },
    },
    {
      id: 'format.charStyle', label: 'Apply Character Style', risk: 'edit',
      description: 'Apply Character Style (Home › Styles): by name or id.',
      params: s.object({style: s.string({min: 1, max: 253})}), state: ready, run: charStyle,
    },
    {
      id: 'format.set', label: 'Set Character Formatting', risk: 'edit',
      description: 'Set Character Formatting (the Font dialog\'s OK as one step): the CharProps given, over the selection.',
      params: s.object({props: s.record(s.any())}), state: ready, run: setProps,
    },
    {
      id: 'format.fontDialog', label: 'Font Dialog', shortcut: 'Mod+D', risk: 'read', dialog: 'dialog.font',
      description: 'Font Dialog (Home › Font): opens the Font dialog in the window.',
      params: NONE, state: ready,
      run(ctx) { need(ctx); return {...selResult(ctx), open: 'font'}; },
    },
    {
      id: 'format.enclose', label: 'Enclose Characters', risk: 'edit', dialog: 'dialog.enclose',
      description: 'Enclose Characters (Home › Font): put one full-width or up to two half-width characters in a circle, square, triangle or diamond, or (shape null) take them out.',
      params: s.object({
        shape: s.nullable(s.enum(['circle', 'square', 'triangle', 'diamond'])),
        style: s.optional(s.enum(['shrink', 'enlarge'])),
        text: s.optional(s.string({min: 1, max: 8})),
      }),
      state: ready,
      run: enclose,
    },
    {
      id: 'format.state', label: 'Formatting at Selection', risk: 'read',
      description: 'Formatting at Selection: what the Font group shows (mixed values are null).',
      params: NONE, state: ready,
      run(ctx) { need(ctx); return formatState(ctx); },
    },
  ],
});

