// The accessibility checker (Review > Accessibility > Check Accessibility; U:slate/rest).
//
// OneNote's checker lists, for the page, what makes it hard to use with a screen reader or low
// vision as Errors (pictures without alternative text, a page without a title), Warnings (a table
// without a header row, text with too little contrast, handwriting with no typed text) and Tips
// (links that show only their address, recordings with no transcript, empty rows or columns in a
// table). Each issue names its object and selecting it goes to that object. The rules are those of
// Office's Accessibility Checker for these objects. Not checked against upstream (there is none).
// No DOM, no Node built-ins.

import {nodeOf} from '../schema.mjs';

export const LEVELS = Object.freeze(['error', 'warning', 'tip']);
export const MIN_CONTRAST = 4.5;

/** #rgb, #rrggbb or rgb(r, g, b) as [r, g, b], or null. */
export function parseColor(text) {
  const t = String(text ?? '').trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(t);
  if (m) return [...m[1]].map(c => parseInt(c + c, 16));
  m = /^#([0-9a-f]{6})$/.exec(t);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
  m = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/.exec(t);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])].map(n => Math.min(255, n)) : null;
}
const channel = v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
export const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
/** WCAG contrast ratio of two colours (1 to 21). */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const RULES = {
  'missing-alt': {level: 'error', title: 'Missing alternative text', why: 'People who cannot see the picture hear its alternative text instead. Describe what it shows.'},
  'missing-title': {level: 'error', title: 'Missing page title', why: 'The page title is how a page is found and announced. Give the page a title.'},
  'table-header': {level: 'warning', title: 'No header row', why: 'A screen reader reads the first row of a table as its column headings. Turn on Header Row.'},
  'low-contrast': {level: 'warning', title: 'Hard-to-read text contrast', why: `Text should have a contrast ratio of at least ${MIN_CONTRAST}:1 against the page. Use a darker or lighter colour.`},
  'ink-only': {level: 'warning', title: 'Handwriting with no typed text', why: 'A screen reader cannot read ink. Add typed text that says what the handwriting says.'},
  'link-address': {level: 'tip', title: 'Link text is the address', why: 'Describe where the link goes ("Course schedule") instead of showing its address.'},
  'no-transcript': {level: 'tip', title: 'Recording with no transcript', why: 'People who cannot hear or see a recording need its words as text. Type a transcript on the page.'},
  'table-blank': {level: 'tip', title: 'Blank cells in a table', why: 'A blank row or column can be read as the end of the table. Delete it or fill it.'},
};
export const RULE_IDS = Object.freeze(Object.keys(RULES));
export const ruleInfo = rule => RULES[rule] ?? null;

const hasText = n => /\S/.test(n.textContent ?? '');

/**
 * What is wrong on a page: [{id, rule, level, title, message, address, name}], errors first, then in page order.
 * `page` is a page record; its paper colour (default white) is what text contrast is measured against.
 */
export function checkPage(page) {
  const out = [];
  const pid = page.id;
  const paper = parseColor(page.color) ?? [255, 255, 255];
  const add = (rule, address, name, message) => out.push({id: `${rule}:${out.length}`, rule, level: RULES[rule].level, title: RULES[rule].title, message: message ?? RULES[rule].why, address, name});
  if (!String(page.title ?? '').trim()) add('missing-title', `/pg:${pid}`, 'Page title');
  const doc = nodeOf(page.body);
  let typed = false;
  doc.descendants(node => {
    const t = node.type.name;
    if (node.isText) { if (/\S/.test(node.text)) typed = true; return true; }
    if (t === 'image' && !String(node.attrs.alt ?? '').trim()) add('missing-alt', `/pg:${pid}/media:${node.attrs.id}`, 'Picture');
    else if (t === 'media') add('no-transcript', `/pg:${pid}/media:${node.attrs.id}`, node.attrs.kind === 'video' ? 'Video recording' : 'Audio recording');
    else if (t === 'table') {
      if (node.attrs.headerRow !== true) add('table-header', `/pg:${pid}/b:${node.attrs.id}`, 'Table');
      const rows = [];
      node.forEach(r => { const cells = []; r.forEach(c => cells.push(hasText(c))); rows.push(cells); });
      const blankRow = rows.some(r => r.length && r.every(x => !x));
      const cols = Math.max(0, ...rows.map(r => r.length));
      let blankCol = false;
      for (let c = 0; c < cols; c++) if (rows.every(r => !r[c])) blankCol = true;
      if (rows.length > 1 && (blankRow || blankCol)) add('table-blank', `/pg:${pid}/b:${node.attrs.id}`, 'Table');
    }
    return true;
  });
  // Text colour and links: one issue for each paragraph that has them.
  doc.descendants(node => {
    if (!node.isTextblock) return true;
    let weak = null, link = null;
    node.forEach(child => {
      if (!child.isText) return;
      for (const m of child.marks) {
        if (m.type.name === 'textStyle' && m.attrs.color && /\S/.test(child.text)) {
          const c = parseColor(m.attrs.color);
          if (c && contrast(c, paper) < MIN_CONTRAST) weak ??= m.attrs.color;
        } else if (m.type.name === 'link') {
          const shown = child.text.trim().replace(/\/$/, '');
          if (/^[a-z][a-z0-9+.-]*:\/\/|^www\./i.test(shown) && shown === String(m.attrs.href).replace(/\/$/, '')) link ??= child.text.trim();
        }
      }
    });
    if (weak) add('low-contrast', `/pg:${pid}/b:${node.attrs.id}`, 'Text', `${RULES['low-contrast'].why} This text is ${weak}.`);
    if (link) add('link-address', `/pg:${pid}/b:${node.attrs.id}`, 'Link', `${RULES['link-address'].why} The link shows ${link}.`);
    return false;
  });
  if (!typed && Array.isArray(page.ink) && page.ink.length) add('ink-only', `/pg:${pid}`, 'Ink');
  return out.sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level));
}

/** The counts by level: {error, warning, tip}. */
export const countByLevel = issues => Object.fromEntries(LEVELS.map(l => [l, issues.filter(i => i.level === l).length]));
