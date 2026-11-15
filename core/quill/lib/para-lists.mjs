// Lists and heading styles shared by the para and lists families (U:quill/format).
// Translated from wordcraft crates/engine/src/cmd/para/lists.rs (`list`, `restart_numbering`,
// `manage_list`, `own_format`, `list_buttons`), crates/engine/src/cmd/para/outline.rs
// (`ensure_heading_style`, `set_heading`) and crates/engine/src/cmd/lists.rs (`level_json`,
// `level_from`, `levels_of`, `caret_list`, `preset_levels`) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {levelsFor, levelOf, numOf, abstractOf, addList, addLevels, restartList, findKind, parseListKind, listKindIsBullet, level as newLevel}
  from '../model/numbering.mjs';
import {isNumFormat} from '../model/numfmt.mjs';
import {builtinStyleSheet, getStyle, upsertStyle, resolvePara, gallery} from '../model/styles.mjs';
import {parseRgb, rgbHex} from '../model/props.mjs';
import {samePath, cmpPath} from '../model/document.mjs';

/** The most levels a list has (Word's nine). */
export const LEVELS = 9;

/** `ListKind` keys as the Bullets / Numbering / Multilevel galleries name them. */
const kindKey = k => (typeof k === 'object' ? `bullet:${k.bulletChar}` : k);

/** `levels_for(kind)` level `i`. */
const want = (kind, i) => levelsFor(kind)[i] ?? null;

/** Take a paragraph out of its list, as list toggling and `leave_list` do (indents back to the style's). */
function clearListIndents(p) {
  delete p.indentLeft; delete p.indentFirst; delete p.indentLeftChars; delete p.indentFirstChars;
}

/**
 * Bullets / Numbering / Multilevel List (`list`): toggle `kind` on the selected paragraphs, by
 * their effective numbering; `off` removes it. `paths`: the selected paragraph paths in `story`.
 */
export function toggleList(d, story, paths, firstPath, kindParam, off, defaultKind) {
  let kind = defaultKind;
  if (kindParam !== undefined && kindParam !== null) {
    const k = parseListKind(kindParam);
    if (!k) throw new CommandError('invalid_params', `unknown list kind \`${kindParam}\``, {path: '/kind'});
    kind = k;
  }
  const sheet = () => d.styles;
  const current = paths.map(path => {
    const x = d.para(story, path);
    const n = x ? resolvePara(sheet(), x.props ?? {}).numbering : null;
    return n && n.num !== 0 ? n : null;
  });
  const sameKind = n => {
    const l = levelOf(d.numbering, n.num, n.level);
    const w = want(kind, n.level);
    if (!l || !w) return false;
    return (w.format === 'bullet') === (l.format === 'bullet') && (kindParam === undefined || kindParam === null || w.text === l.text);
  };
  const remove = !!off || (current.length > 0 && current.every(n => n && sameKind(n)));
  if (remove) {
    const keepListStyle = !!resolvePara(sheet(), {style: 'ListParagraph'}).numbering;
    for (const path of paths) {
      const para = d.paraMut(story, path);
      const p = {...(para.props ?? {}), numbering: {num: 0, level: 0}};
      clearListIndents(p);
      if (p.style === 'ListParagraph' && !keepListStyle) delete p.style;
      para.props = p;
    }
    return {removed: true};
  }
  // Continue the list of the previous paragraph if it has the same kind; else a new list.
  const prevPath = firstPath ? d.prevPara(story, firstPath) : null;
  const prevNum = prevPath ? d.para(story, prevPath)?.props?.numbering : null;
  let num = prevNum && prevNum.num !== 0 && sameKind({...prevNum, level: 0}) ? prevNum.num : null;
  if (num === null) {
    const existing = listKindIsBullet(kind) ? findKind(d.numbering, kind) : null;
    if (existing !== null) num = existing;
    else {
      const r = addList(d.numbering, kind);
      d.setField('numbering', r.numbering);
      num = r.num;
    }
  }
  for (const path of paths) {
    const para = d.paraMut(story, path);
    const p = {...(para.props ?? {})};
    const lvl = p.numbering && p.numbering.num !== 0 ? p.numbering.level : 0;
    p.numbering = {num, level: lvl};
    clearListIndents(p);
    if (!p.style || p.style === 'Normal') p.style = 'ListParagraph';
    para.props = p;
  }
  return {removed: false, num, kind: kindKey(kind)};
}

/**
 * Which Home › Paragraph list buttons show as on for a paragraph with resolved `numbering`
 * (`list_buttons`): its level decides Bullets or Numbering; Multilevel is on too when some level's
 * label shows another level's number (`1.1.`) or uses legal numbering.
 */
export function listButtons(numbering, n) {
  const none = {bullets: false, numbering: false, multilevel: false};
  if (!n || n.num === 0) return none;
  const l = levelOf(numbering, n.num, n.level);
  if (!l) return none;
  const bullets = l.format === 'bullet';
  const joined = i => {
    const x = levelOf(numbering, n.num, i);
    if (!x) return false;
    if (x.legal) return true;
    const own = i + 1;
    return String(x.text ?? '').split('%').slice(1).some(t => { const k = Number(t[0]); return Number.isInteger(k) && t[0] >= '0' && t[0] <= '9' && k !== own; });
  };
  let multilevel = false;
  for (let i = 0; i < LEVELS; i++) if (joined(i)) { multilevel = true; break; }
  return {bullets, numbering: !bullets, multilevel};
}

/** Restart at 1 (`restart_numbering`) from the paragraph at `at`. */
export function restartNumbering(d, at) {
  const n = d.paraAt(at)?.props?.numbering;
  if (!n || n.num === 0) throw new CommandError('failed', 'not in a numbered list');
  const r = restartList(d.numbering, n.num);
  if (!r) throw new CommandError('failed', 'bad list');
  d.setField('numbering', r.numbering);
  for (const path of d.paraPaths(at.story).filter(p => cmpPath(p, at.path) >= 0)) {
    const para = d.para(at.story, path);
    const x = para.props?.numbering;
    if (x && x.num === n.num) {
      const m = d.paraMut(at.story, path);
      m.props = {...m.props, numbering: {num: r.num, level: x.level}};
    } else if (!x && para.text.length) break;
  }
  return r.num;
}

/** Set Numbering Value (tools/specs.rs `para.setNumberingValue`): a new instance starting at `value` from the caret's paragraph. */
export function setNumberingValue(d, at, value) {
  const n = d.paraAt(at)?.props?.numbering;
  if (!n || n.num === 0) throw new CommandError('failed', 'not in a numbered list');
  const r = restartList(d.numbering, n.num);
  if (!r) throw new CommandError('failed', 'bad list');
  const nums = r.numbering.nums.map(x => (x.id === r.num ? {...x, startOverrides: [[n.level, value]]} : x));
  d.setField('numbering', {...r.numbering, nums});
  for (const path of d.paraPaths(at.story).filter(p => cmpPath(p, at.path) >= 0)) {
    const x = d.para(at.story, path).props?.numbering;
    if (!x || x.num !== n.num) break;
    const m = d.paraMut(at.story, path);
    m.props = {...m.props, numbering: {num: r.num, level: x.level}};
  }
  return r.num;
}

/** Make sure the built-in `Heading{n}` style (and its linked character style) is in the document (`ensure_heading_style`). */
export function ensureHeadingStyle(d, n) {
  const id = `Heading${n}`;
  if (!getStyle(d.styles, id)) {
    const builtin = builtinStyleSheet();
    let sheet = d.styles;
    for (const sid of [id, `${id}Char`]) {
      const st = getStyle(builtin, sid);
      if (!getStyle(sheet, sid) && st) sheet = upsertStyle(sheet, structuredClone(st));
    }
    d.setField('styles', sheet);
  }
  return id;
}

/** The heading level (1–9) a paragraph's style gives it, if it is a heading. */
export function headingLevel(sheet, props) {
  const l = resolvePara(sheet, props ?? {}).outlineLevel;
  return l !== null && l < 9 ? l + 1 : null;
}

// ---------------------------------------------------------------------------------------------
// List definitions (cmd/lists.rs)

/** A level as `list.define` takes it (`level_json`). */
export function levelJson(l) {
  const c = l.chr ?? {};
  const color = c.color && c.color !== 'Auto' && c.color.Rgb ? rgbHex(c.color.Rgb) : null;
  return {
    format: l.format, text: l.text, start: l.start,
    restartAfter: l.restart ? (l.restartAfter ?? null) : 0,
    style: l.style ?? null,
    align: l.align === 'center' ? 'center' : l.align === 'right' ? 'right' : 'left',
    alignedAt: l.indent - l.hanging, indentAt: l.indent,
    follow: l.suffix === 'space' ? 'space' : l.suffix === 'nothing' ? 'nothing' : 'tab',
    tabAt: l.tab ?? null, font: c.font ?? null, bold: c.bold ?? false, italic: c.italic ?? false, color, legal: !!l.legal,
  };
}

const clampPt = x => (typeof x === 'number' && Number.isFinite(x) ? Math.max(-1584, Math.min(1584, x)) : null);

/** `base` changed by the fields `v` gives (`level_from`); `i` is the level's index. */
export function levelFrom(base, i, v) {
  const l = structuredClone(base);
  l.chr = {...(l.chr ?? {})};
  if (typeof v.format === 'string') l.format = isNumFormat(v.format) ? v.format : 'decimal';
  if (typeof v.text === 'string') l.text = [...v.text].slice(0, 64).join('');
  if (Number.isInteger(v.start) && v.start >= 0) l.start = Math.min(v.start, 32_767);
  if ('restartAfter' in v) {
    if (v.restartAfter === null) { l.restart = true; delete l.restartAfter; }
    else if (Number.isInteger(v.restartAfter) && v.restartAfter >= 0) {
      const k = v.restartAfter;
      l.restart = k !== 0;
      // Restarting after the level just above is the default.
      const r = Math.min(k, 8);
      if (r !== 0 && r !== i) l.restartAfter = r; else delete l.restartAfter;
    }
  }
  if ('style' in v) {
    if (v.style === null) l.style = null;
    else if (typeof v.style === 'string') { const st = [...v.style].slice(0, 253).join(''); l.style = st || null; }
  }
  if (typeof v.align === 'string') l.align = v.align === 'center' ? 'center' : v.align === 'right' ? 'right' : 'left';
  const aligned = clampPt(v.alignedAt) ?? l.indent - l.hanging;
  const ind = clampPt(v.indentAt);
  if (ind !== null) l.indent = ind;
  l.hanging = l.indent - aligned;
  if (typeof v.follow === 'string') l.suffix = v.follow === 'space' ? 'space' : v.follow === 'nothing' ? 'nothing' : 'tab';
  if ('tabAt' in v) {
    if (v.tabAt === null) delete l.tab;
    else { const t = clampPt(v.tabAt); if (t !== null) l.tab = t; }
  }
  if ('font' in v) {
    if (v.font === null) delete l.chr.font;
    else if (typeof v.font === 'string') { const f = [...v.font].slice(0, 64).join(''); if (f.trim()) l.chr.font = f; else delete l.chr.font; }
  }
  if (typeof v.bold === 'boolean') l.chr.bold = v.bold;
  if (typeof v.italic === 'boolean') l.chr.italic = v.italic;
  if ('color' in v) {
    if (v.color === null) delete l.chr.color;
    else if (typeof v.color === 'string') { const c = parseRgb(v.color); if (c) l.chr.color = {Rgb: c}; }
  }
  if (typeof v.legal === 'boolean') l.legal = v.legal;
  return l;
}

/** Level `i` of a new multilevel list: 1. a. i. (`default_level`). */
export const defaultLevel = i => levelsFor('numbered')[i] ?? newLevel();

/** The nine levels list `num` shows (`levels_of`), or null when there is no such list. */
export function levelsOf(numbering, num) {
  if (!numOf(numbering, num)) return null;
  const out = [];
  for (let i = 0; i < LEVELS; i++) out.push(levelOf(numbering, num, i) ?? defaultLevel(i));
  return out;
}

/** The caret's list (`caret_list`), or null. */
export function caretList(d, at) {
  const p = d.paraAt(at);
  if (!p) return null;
  const n = p.props?.numbering ?? resolvePara(d.styles, p.props ?? {}).numbering;
  return n && n.num !== 0 ? n.num : null;
}

/** The heading-linked lists of the Multilevel List library, by preset id (`preset_levels`): level i ↔ Heading i+1. */
export function presetLevels(preset) {
  const out = [];
  for (let i = 0; i < LEVELS; i++) {
    const n = i + 1;
    const at = indent => newLevel({indent, hanging: indent, style: `Heading${n}`});
    let format, text, indent;
    if (preset === 'headings') {
      format = 'decimal'; text = Array.from({length: n}, (_, k) => `%${k + 1}`).join('.'); indent = 21.6 + 7.2 * i;
    } else if (preset === 'article') {
      if (i === 0) { format = 'upperRoman'; text = 'Article %1.'; indent = 0; }
      else if (i === 1) { format = 'decimalZero'; text = 'Section %1.%2'; indent = 0; }
      else {
        format = ['lowerLetter', 'lowerRoman', 'decimal', 'lowerLetter', 'lowerRoman', 'lowerLetter', 'lowerRoman'][i - 2] ?? 'decimal';
        text = i < 4 ? `(%${n})` : i < 7 ? `%${n})` : `%${n}.`;
        indent = 36 + 7.2 * (i - 2);
      }
    } else if (preset === 'outlineHeadings') {
      format = ['upperRoman', 'upperLetter', 'decimal', 'lowerLetter', 'decimal', 'lowerLetter', 'lowerRoman', 'lowerLetter', 'lowerRoman'][i] ?? 'decimal';
      text = i <= 2 ? `%${n}.` : i === 3 ? `%${n})` : `(%${n})`;
      indent = 36 * n;
    } else if (preset === 'chapter') {
      if (i === 0) { format = 'decimal'; text = 'Chapter %1'; indent = 0; } else { format = 'none'; text = ''; indent = 0; }
    } else return null;
    // "Section 1.01" shows the article number in digits (legal numbering).
    out.push({...at(indent), format, text, legal: preset === 'article' && i === 1});
  }
  return out;
}

/** Add a list definition with `levels` (`try_add_levels`); returns the new num id. */
export function addListLevels(d, name, levels) {
  const r = addLevels(d.numbering, name ?? null, levels);
  d.setField('numbering', r.numbering);
  return r.num;
}

/** Point every level linked to a paragraph style at list `num` (the style carries the number). */
export function linkLevelStyles(d, num, levels) {
  const linked = [];
  let sheet = d.styles;
  levels.forEach((l, i) => {
    if (!l.style) return;
    const st = sheet.styles.find(x => x.id === l.style) ?? sheet.styles.find(x => x.name.toLowerCase() === String(l.style).toLowerCase());
    if (!st) return;
    sheet = upsertStyle(sheet, {...st, para: {...(st.para ?? {}), numbering: {num, level: i}}});
    linked.push(st.id);
  });
  if (linked.length) d.setField('styles', sheet);
  return linked;
}

// ---------------------------------------------------------------------------------------------
// Manage Styles' list (`manage_list`, `own_format`)

/** The formatting a style sets itself (not what it inherits), for its description. */
export function ownFormat(st) {
  const f = {};
  const c = st.chr ?? {};
  if (c.font !== undefined) f.font = c.font;
  if (c.size !== undefined) f.size = c.size;
  for (const k of ['bold', 'italic', 'caps', 'smallCaps']) if (typeof c[k] === 'boolean') f[k] = c[k];
  if (c.color && c.color !== 'Auto' && c.color.Rgb) f.color = rgbHex(c.color.Rgb);
  const pp = st.para ?? {};
  if (pp.align !== undefined) f.align = pp.align;
  if (pp.spaceBefore !== undefined) f.spaceBefore = pp.spaceBefore;
  if (pp.spaceAfter !== undefined) f.spaceAfter = pp.spaceAfter;
  if (pp.indentLeft !== undefined) f.indentLeft = pp.indentLeft;
  if (pp.lineSpacing?.rule === 'multiple') f.lineSpacing = pp.lineSpacing.value;
  return f;
}

/** Table styles Word ships (upstream `is_builtin_table_style`: the built-in flag or a built-in table style id). */
const BUILTIN_TABLE = new Set(builtinStyleSheet().styles.filter(s => s.kind === 'table').map(s => s.id));

/** Manage Styles' list: paragraph, character, linked and table styles, sorted as recommended or alphabetically. */
export function manageList(sheet, alphabetical) {
  const get = id => sheet.styles.find(s => s.id === id) ?? null;
  const linksBack = (a, b) => get(b)?.linked === a.id;
  const list = sheet.styles.filter(st => {
    if (st.kind === 'numbering') return false;
    if (st.kind === 'character') return !(st.linked && get(st.linked)?.kind === 'paragraph' && linksBack(st, st.linked));
    return true;
  });
  const lower = s => String(s.name).toLowerCase();
  const byName = (a, b) => (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0);
  list.sort(alphabetical ? byName : (a, b) => (a.priority ?? 99) - (b.priority ?? 99) || byName(a, b));
  return list.map(st => {
    let type;
    if (st.kind === 'paragraph' && st.linked && (!get(st.linked) || (get(st.linked).kind === 'character' && linksBack(st, st.linked)))) type = 'linked';
    else if (st.kind === 'paragraph') type = 'paragraph';
    else if (st.kind === 'character') type = 'character';
    else type = 'table';
    return {
      id: st.id, name: st.name, type,
      builtIn: !!st.builtin || (st.kind === 'table' && BUILTIN_TABLE.has(st.id)),
      inGallery: !!st.quick && !st.hidden && st.kind !== 'table', hidden: !!st.hidden,
      basedOn: st.basedOn ? get(st.basedOn)?.name ?? null : null, priority: st.priority ?? null, format: ownFormat(st),
    };
  });
}

/** The Styles gallery's items (Quick Styles in priority order) with what their tiles draw. */
export function galleryItems(sheet) {
  return gallery(sheet).map(st => ({id: st.id, label: st.name, value: st.id, kind: st.kind}));
}

export {samePath, numOf, abstractOf, levelOf};
