// The accessibility checker (Review › Check Accessibility): what makes the body hard to use with a screen reader or hard to read, as
// `{kind: 'error'|'warning'|'tip', rule, issue, where, pos?, select?, fix?, action?}` items.
//
// Translated from wordcraft crates/engine/src/cmd/accessibility.rs (`check`, `Checker::run`, `blank_run`, `objects`, `speaks_for_itself`,
// `contrast`, `table`, `kind_of`, `luminance`, `contrast_ratio`) at ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// `where` is the paragraph (or table) path; `pos` a place to put the caret there; `select` the range that selects the object an issue is about;
// `action` a command ({label, command, params}) that fixes it, run with the caret at `pos` (or the object selected). The rules and their
// wording are upstream's own; the contrast rule uses the WCAG 2 contrast ratio. No DOM, no Node built-ins.

import * as P from '../model/para.mjs';
import {BODY} from '../model/document.mjs';
import {resolvePara, resolveChar} from '../model/styles.mjs';
import {cellSpan, vmergeOf} from '../model/table.mjs';

/** Most issues reported (a hostile document can't make the report huge). */
export const MAX_ISSUES = 500;
/** This many empty paragraphs in a row look like spacing made with Enter. */
export const BLANK_RUN = 3;

const WHITE = [255, 255, 255];
const at = (path, off) => ({story: BODY, path: [...path], off});

/** WCAG 2 relative luminance of an sRGB colour. */
function luminance([r, g, b]) {
  const ch = v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
/** WCAG 2 contrast ratio of two colours, 1 to 21. */
export function contrastRatio(a, b) {
  const [la, lb] = [luminance(a), luminance(b)];
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const kindOf = o => (o.type === 'image' ? (o.ole ? 'object' : 'picture') : o.type === 'graphic' ? 'chart' : o.type === 'shape' ? (o.story !== undefined && o.story !== null ? 'textBox' : 'shape') : o.type === 'group' ? 'group' : 'object');

const isEmptyCell = c => (c.blocks ?? []).every(b => b.kind === 'para' && b.text.trim() === '');

/** The checker's findings for `d` (a model Document), errors first, then warnings, then tips (each in document order). */
export function checkAccessibility(d) {
  const issues = [];
  const push = v => { if (issues.length < MAX_ISSUES * 2) issues.push(v); };
  const settings = d.c.settings ?? {};

  /** A text box with text in it is read out as that text. */
  const speaksForItself = o => {
    const id = P.textBoxOf(o);
    const part = id !== null && id !== undefined ? d.c.parts[id] : null;
    return !!part && (part.blocks ?? []).some(b => (b.kind === 'para' ? b.text.trim() !== '' : true));
  };

  /** Alt text and reading order of the drawings in the paragraph `p` at `path`. */
  const objects = (path, p) => {
    for (const [off, o] of P.objectsWithOffsets(p)) {
      if (!P.isDrawing(o)) continue;
      const pos = at(path, off);
      const select = {anchor: pos, focus: at(path, off + 1)};
      const frame = P.objectFrame(o);
      // Ink: every stroke is its own object, so asking about each would bury the report. A hidden drawing isn't shown, so nobody reads it.
      if (P.isDecorative(o) || (o.type === 'shape' && o.freeform?.ink) || frame?.[2]?.hidden) continue;
      const titled = String(frame?.[2]?.alt?.title ?? '').trim() !== '';
      const described = P.altTextOf(o).trim() !== '' || titled;
      if (!described && !speaksForItself(o)) {
        push({kind: 'error', rule: 'altText', issue: o.type === 'graphic' ? 'Chart or diagram has no alternative text' : 'Missing alternative text', what: kindOf(o), where: [...path], pos, select,
          fix: 'Describe it in the Alt Text pane, or mark it as decorative',
          action: {label: 'Mark as decorative', command: 'object.altText', params: {decorative: true}}});
      }
      if (P.isFloating(o)) {
        const v = {kind: 'tip', rule: 'floating', issue: "Object isn't in line with text, so its reading order is unclear", what: kindOf(o), where: [...path], pos, select, fix: 'Place it in line with text (Layout › Wrap Text)'};
        // Charts and diagrams keep their imported placement.
        if (o.type !== 'graphic') v.action = {label: 'In Line with Text', command: 'arrange.wrap', params: {wrap: 'inline'}};
        push(v);
      }
    }
  };

  /** Text whose colour is too close to what it's drawn on (WCAG 2: 4.5:1, 3:1 for large text). */
  const contrast = (path, p, paraShading) => {
    let cell = null;
    if (path.length >= 4) {
      const t = d.table(BODY, path.slice(0, path.length - 3));
      const [r, c] = [path[path.length - 3], path[path.length - 2]];
      cell = t?.rows[r]?.cells[c]?.props?.shading ?? t?.props?.shading ?? null;
    }
    const page = settings.pageColor ?? WHITE;
    let start = 0;
    for (const r of p.runs ?? []) {
      const text = p.text.slice(start, start + r.len);
      start += r.len;
      const props = r.props ?? r;
      if (text.trim() === '' || props.hidden === true) continue;
      const rc = resolveChar(d.c.styles, p.props?.style ?? null, props);
      const fg = rc.color?.Rgb ?? rc.color?.rgb;
      if (!Array.isArray(fg)) continue;
      const bg = rc.highlight ?? rc.shading ?? paraShading ?? cell ?? page;
      const ratio = contrastRatio(fg, bg);
      const large = rc.size >= 18 || (rc.bold && rc.size >= 14);
      const need = large ? 3 : 4.5;
      if (ratio < need) {
        push({kind: ratio < 3 ? 'warning' : 'tip', rule: 'contrast', issue: `Text is hard to read: contrast ${ratio.toFixed(1)}:1, ${need}:1 needed`, where: [...path], pos: at(path, 0),
          fix: 'Use a darker or lighter text colour, or change the shading behind it'});
        return;
      }
    }
  };

  const blankRun = blank => {
    if (blank.length >= BLANK_RUN) push({kind: 'tip', rule: 'blankParagraphs', issue: `${blank.length} empty paragraphs in a row`, where: [...blank[0]], pos: at(blank[0], 0),
      fix: 'Use Space Before/After (Layout › Paragraph) or a page break instead of empty paragraphs'});
  };

  const table = (tp, t) => {
    const cellPos = (r, c) => at([...tp, r, c, 0], 0);
    const blank = s => s === null || s === undefined || String(s).trim() === '';
    if (blank(t.props?.caption) && blank(t.props?.description)) push({kind: 'warning', rule: 'tableAltText', issue: 'Table has no alternative text', where: [...tp], pos: cellPos(0, 0), fix: 'Give it a title or description in Table Properties'});
    if (t.rows.length >= 2 && !t.rows[0]?.props?.header) {
      push({kind: 'warning', rule: 'tableHeader', issue: 'Table has no header row', where: [...tp], pos: cellPos(0, 0), fix: 'Repeat the first row as a header row',
        action: {label: 'Repeat Header Rows', command: 'table.repeatHeader', params: {value: true}}});
    }
    // A table with nothing in it yet is being filled in, not used for spacing.
    const filled = !t.rows.flatMap(r => r.cells).every(isEmptyCell);
    if (t.rows.length >= 2 && filled) {
      t.rows.forEach((row, r) => {
        if (row.cells.length && row.cells.every(isEmptyCell)) push({kind: 'warning', rule: 'blankRow', issue: `Row ${r + 1} of a table is empty: it looks like spacing`, where: [...tp], pos: cellPos(r, 0), fix: 'Delete the row and use cell margins or spacing instead'});
      });
    }
    const cols = Math.max(0, ...t.rows.map(r => r.cells.length));
    if (cols >= 2 && t.rows.length >= 2 && filled) {
      for (let c = 0; c < Math.min(cols, 63); c++) {
        if (t.rows.every(row => row.cells[c] === undefined || isEmptyCell(row.cells[c]))) push({kind: 'warning', rule: 'blankColumn', issue: `Column ${c + 1} of a table is empty: it looks like spacing`, where: [...tp], pos: cellPos(0, c), fix: 'Delete the column and use cell margins instead'});
      }
    }
    if (t.rows.flatMap(r => r.cells).some(c => cellSpan(c) > 1 || vmergeOf(c) !== 'none')) {
      push({kind: 'tip', rule: 'mergedCells', issue: 'Table has merged cells, which screen readers can lose track of', where: [...tp], pos: cellPos(0, 0), fix: 'Split the merged cells (Table Layout › Merge)'});
    }
  };

  let lastLevel = null;
  const tables = [];
  let blank = [];
  for (const path of d.paraPaths(BODY)) {
    const p = d.para(BODY, path);
    if (!p) continue;
    if (path.length >= 4) {
      const tp = path.slice(0, path.length - 3);
      if (!tables.some(t => t.length === tp.length && t.every((v, i) => v === tp[i]))) tables.push(tp);
    }
    objects(path, p);
    // Empty paragraphs in a row (top level, no section break): spacing made with Enter.
    const empty = path.length === 1 && p.text.trim() === '' && !p.section;
    const last = blank[blank.length - 1];
    const consecutive = !last || (last.length === 1 && path.length === 1 && last[0] + 1 === path[0]);
    if (empty && consecutive) blank.push(path);
    else {
      blankRun(blank);
      blank = empty ? [path] : [];
    }
    const rp = resolvePara(d.c.styles, p.props ?? {});
    if (rp.outlineLevel !== null && rp.outlineLevel !== undefined && P.plainText(p).trim() !== '') {
      const l = rp.outlineLevel;
      if (lastLevel !== null && l > lastLevel + 1) {
        push({kind: 'warning', rule: 'headingOrder', issue: `Heading level skipped (Heading ${l + 1} after Heading ${lastLevel + 1})`, where: [...path], pos: at(path, 0), fix: 'Use the next heading level down, so the outline has no gaps'});
      }
      lastLevel = l;
    }
    if ((p.runs ?? []).some(r => (r.props ?? r).link)) {
      if (P.plainText(p).toLowerCase().includes('click here')) push({kind: 'tip', rule: 'linkText', issue: 'Link text "click here" isn\'t descriptive', where: [...path], pos: at(path, 0)});
    }
    contrast(path, p, rp.shading);
  }
  blankRun(blank);
  for (const tp of tables) {
    const t = d.table(BODY, tp);
    if (t) table(tp, t);
  }
  if (String(d.c.core?.title ?? '').trim() === '') push({kind: 'tip', rule: 'docTitle', issue: 'Document has no title', fix: 'Add a title in the document properties'});
  const rank = v => (v.kind === 'error' ? 0 : v.kind === 'warning' ? 1 : 2);
  return issues.map((v, i) => [v, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([v]) => v).slice(0, MAX_ISSUES);
}
