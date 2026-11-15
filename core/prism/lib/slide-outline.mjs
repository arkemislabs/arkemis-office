// Slides from Outline: plain outline text (one slide per unindented line, tab- or two-space-
// indented lines its bullets) and Markdown outlines (headings are slides, list items bullets).
// Translated from deckcraft crates/format/src/lib.rs (`outline_to_slides`, `md_heading`,
// `md_list_item`, `markdown_to_slides`, `add_outline_slides`, `OutlineSlides`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// U:prism/slide. No DOM, no Node built-ins.

import {newSlide, layoutOfKind} from '../model/defaults.mjs';
import {bodyFromText} from '../model/text.mjs';

/** Rust `str::lines`: split on `\n`, dropping a trailing `\r` and a final empty line. */
const lines = text => {
  const out = String(text).split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (out.length && out[out.length - 1] === '') out.pop();
  return out;
};
const leading = (s, set) => { let n = 0; for (const c of s) { if (!set.includes(c)) break; n++; } return n; };

/** The outline as [title, [[level, text]...]] entries (deckcraft `outline_to_slides`' parse). */
export function parseOutline(text) {
  const slides = [];
  for (const raw of lines(text)) {
    if (!raw.trim()) continue;
    const tabs = leading(raw, '\t');
    const spaces = Math.floor(leading(raw, ' ') / 2);
    const level = Math.max(tabs, spaces);
    const t = raw.trim();
    let line = t;
    if ('-*•'.includes(t[0] ?? 'x') && t.length > 1 && (t[1] === ' ' || t[1] === '\t')) line = t.slice(1).trim();
    if (level === 0) slides.push([line, []]);
    else if (slides.length) slides[slides.length - 1][1].push([Math.min(level - 1, 8), line]);
  }
  return slides;
}

/** An ATX heading's text, or null (`md_heading`). */
export function mdHeading(line) {
  let t = line;
  for (const pre of ['   ', '  ', ' ']) if (t.startsWith(pre)) { t = t.slice(pre.length); break; }
  const hashes = leading(t, '#');
  const rest = t.slice(hashes);
  if (hashes < 1 || hashes > 6 || !(rest === '' || rest[0] === ' ' || rest[0] === '\t')) return null;
  const r = rest.trim();
  const closed = r.replace(/#+$/, '');
  return !closed || closed.endsWith(' ') || closed.endsWith('\t') ? closed.trimEnd() : r;
}

/** A list item's [level, text] or null (`md_list_item`). */
export function mdListItem(line) {
  let indent = 0;
  for (const c of line) { if (c === ' ') indent += 1; else if (c === '\t') indent += 2; else break; }
  const t = line.trimStart();
  let rest;
  if ('-*+'.includes(t[0] ?? 'x')) rest = t.slice(1);
  else {
    const digits = leading(t, '0123456789');
    if (digits === 0 || digits > 9) return null;
    const after = t.slice(digits);
    if (after[0] !== '.' && after[0] !== ')') return null;
    rest = after.slice(1);
  }
  return rest[0] === ' ' || rest[0] === '\t' ? [Math.min(Math.floor(indent / 2), 8), rest.trim()] : null;
}

/** The Markdown outline's entries; a text without headings is a plain outline. */
export function parseMarkdown(text) {
  const ls = lines(text);
  if (!ls.some(l => mdHeading(l) !== null)) return parseOutline(text);
  const slides = [];
  for (const line of ls) {
    if (!line.trim()) continue;
    const title = mdHeading(line);
    if (title !== null) slides.push([title, []]);
    else if (slides.length) slides[slides.length - 1][1].push(mdListItem(line) ?? [0, line.trim()]);
  }
  return slides;
}

/**
 * deckcraft `add_outline_slides`: a Title and Content slide per entry (title in the first
 * placeholder, bullets in the second). Returns {pres, slides} (new slide objects, not yet placed);
 * an exhausted id space stops early, keeping what fit.
 */
export function outlineSlides(presIn, entries) {
  let pres = presIn;
  const lay = layoutOfKind(pres, 'titleAndContent');
  const made = [];
  if (!lay) return {pres, slides: made};
  for (const [title, body] of entries) {
    const r = newSlide(pres, lay);
    if (!r) break;
    pres = r.pres;
    const s = r.slide;
    if (s.shapes[0]) s.shapes[0] = {...s.shapes[0], text: bodyFromText(title)};
    if (s.shapes[1]) {
      const tb = s.shapes[1].text ?? {body: {}, paragraphs: []};
      const paragraphs = [...(tb.paragraphs ?? [])];
      for (const [level, line] of body) paragraphs.push({level: Math.min(level, 8), runs: line ? [{text: line}] : []});
      s.shapes[1] = {...s.shapes[1], text: {...tb, paragraphs}};
    }
    made.push(s);
  }
  return {pres, slides: made};
}
